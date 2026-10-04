import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpAgentRunner } from "../src/agent-runner.js";
import { StubBrain } from "../src/brain/stub-brain.js";
import type { AgentContext, DecisionProvider } from "../src/types.js";
import type { ActionRequest, Scope } from "@sigilkit/core";
import type { Address, Hash } from "viem";

/**
 * McpAgentRunner is the package's orchestration layer: it is where SEC-06 role separation
 * is enforced (the runner never holds owner keys) and where a brain's proposal is turned
 * into a zero-gas pre-flight. It had no test at all before this file, which meant the
 * guardrail logic below — the whole safety story of the package — was unexercised.
 *
 * `tick()` talks to a live chain in `buildContext`, so these cases drive `runTick`'s
 * decision path through a stub brain plus a stubbed `publicClient`. The pieces tested
 * here are the ones that are pure: guardrail rejection, the tick counter, the Merkle
 * whitelist binding, and adoptGrant's receipt checks.
 */

const MANAGER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x3333333333333333333333333333333333333333" as Address;
const RPC = "http://127.0.0.1:59999";

const SCOPE: Scope = {
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  windowSeconds: 3600,
  perActionCap: 10n ** 18n,
  perWindowCap: 10n ** 19n,
  merkleRoot: `0x${"0".repeat(64)}` as Hash,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function proposal(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    agentId: `0x${"11".repeat(32)}` as Hash,
    target: TARGET,
    selector: "0xdeadbeef",
    value: 0n,
    nonce: 0n,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    rationaleHash: `0x${"22".repeat(32)}` as Hash,
    data: "0x",
    ...over,
  } as ActionRequest;
}

/** A brain that always returns the same proposal, so the guardrail under test is decisive. */
function fixedBrain(req: ActionRequest | null): DecisionProvider {
  return { name: "fixed", propose: async (_ctx: AgentContext) => req };
}

/**
 * A real secp256k1 keypair, so `prepareExecution`'s signature-recovery check passes and the
 * "accepts at the cap" case exercises the true signing path rather than tripping over a
 * stub. Fixed so addresses are stable across runs.
 */
const SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;


function makeRunner(brain: DecisionProvider, over: Partial<ConstructorParameters<typeof McpAgentRunner>[0]> = {}) {
  const r = new McpAgentRunner({
    managerAddress: MANAGER,
    sessionSigner: SIGNER_PK,
    scope: SCOPE,
    brain,
    rpcUrl: RPC,
    ...over,
  });
  // `tick()` opens with `buildContext()`, which does two RPC reads (getBalance and the
  // manager's getNonce). Without a stub those hit the dead RPC URL above and the case
  // fails on a fetch error rather than on the behaviour under test. Answering both by
  // method name keeps the runner's real code path — only the transport is replaced.
  stubRpc(r, { balance: 10n ** 24n, nonce: 7n });
  return r;
}

/** Replace the runner's publicClient with one that answers getBalance/getNonce locally. */
function stubRpc(runner: McpAgentRunner, answers: { balance: bigint; nonce: bigint }): void {
  const fake = {
    getBalance: async () => answers.balance,
    readContract: async () => answers.nonce,
    getTransactionCount: async () => 0,
    waitForTransactionReceipt: async () => {
      throw new Error("not stubbed");
    },
  };
  (runner as unknown as { publicClient: unknown }).publicClient = fake;
}

describe("McpAgentRunner — guardrails reject before any signature", () => {
  it("rejects a proposal whose value exceeds perActionCap", async () => {
    const runner = makeRunner(fixedBrain(proposal({ value: SCOPE.perActionCap + 1n })));
    const result = await runner.tick();
    expect(result).toEqual({ executed: false, reason: "guardrail-rejected" });
  });

  it("accepts a proposal exactly at the cap (boundary is inclusive)", async () => {
    const runner = makeRunner(fixedBrain(proposal({ value: SCOPE.perActionCap })));
    const result = await runner.tick();
    // `executed: true, broadcast: false` is the no-relayer path, which returns the prepared
    // payload instead of broadcasting — still proves the guardrail let it through.
    expect(result.executed).toBe(true);
  });

  it("rejects an already-expired proposal", async () => {
    const runner = makeRunner(fixedBrain(proposal({ expiry: Math.floor(Date.now() / 1000) - 1 })));
    const result = await runner.tick();
    expect(result).toEqual({ executed: false, reason: "guardrail-rejected" });
  });

  it("rejects when merkleRoot is non-zero but no leaves were supplied", async () => {
    // A non-zero root with no leaf set means the whitelist cannot be proven. Failing closed
    // here is the point: the alternative is executing an unproven target.
    const runner = makeRunner(fixedBrain(proposal()), {
      scope: { ...SCOPE, merkleRoot: `0x${"ab".repeat(32)}` as Hash },
    });
    const result = await runner.tick();
    expect(result).toEqual({ executed: false, reason: "guardrail-rejected" });
  });

  it("reports idle when the brain declines to propose", async () => {
    const runner = makeRunner(fixedBrain(null));
    const result = await runner.tick();
    expect(result).toEqual({ executed: false, reason: "idle" });
  });
});

describe("McpAgentRunner — the tick counter advances on attempts, not successes", () => {
  // The regression this pins: `state.tick` was read by `buildContext` and initialised to 0
  // but never assigned anywhere. A brain that gates on phase (`tick % period === offset`)
  // therefore saw a frozen counter and could never reach its fire phase.
  let brain: DecisionProvider;
  let runner: McpAgentRunner;

  beforeEach(() => {
    let n = 0;
    brain = {
      name: "phase",
      propose: async (ctx: AgentContext) => {
        n++;
        // Fire only on the 3rd attempt. With a counter frozen at 0 this never fires.
        return n >= 3 ? proposal() : null;
      },
    };
    runner = makeRunner(brain);
  });

  it("advances state.tick on every iteration, including declined ones", async () => {
    await runner.tick();
    expect(runner.state.tick).toBe(1);
    await runner.tick();
    expect(runner.state.tick).toBe(2);
    await runner.tick();
    expect(runner.state.tick).toBe(3);
  });

  it("hands the brain a context whose tick tracks the attempt count", async () => {
    const seen: number[] = [];
    const observer: DecisionProvider = {
      name: "observer",
      propose: async (ctx: AgentContext) => {
        seen.push(ctx.tick);
        return null;
      },
    };
    const r = makeRunner(observer);
    await r.tick();
    await r.tick();
    await r.tick();
    // First attempt observes 0, second 1, third 2 — strictly increasing, never frozen.
    expect(seen).toEqual([0, 1, 2]);
  });

  it("advances state.tick even when the tick throws", async () => {
    const thrower: DecisionProvider = {
      name: "thrower",
      propose: async () => {
        throw new Error("brain exploded");
      },
    };
    const r = makeRunner(thrower);
    await expect(r.tick()).rejects.toThrow("brain exploded");
    // The `finally` must still advance it, or one failed iteration wedges the schedule.
    expect(r.state.tick).toBe(1);
  });
});

describe("McpAgentRunner — Merkle whitelist binding", () => {
  it("rejects a target that is not in the whitelist", async () => {
    const runner = makeRunner(fixedBrain(proposal()), { whitelistLeaves: [`0x${"cd".repeat(32)}` as Hash] });
    // `proofFor` throws rather than returning a wrong proof, so the failure surfaces here.
    await expect(runner.tick()).rejects.toThrow(/outside whitelist/);
  });
});

describe("McpAgentRunner — adoptGrant validates the grant receipt", () => {
  // A forged "grant" transaction is the way an operator convinces the runner it holds a
  // scope it does not. Every one of these checks must fail closed.
  const GRANT_TOPIC = "0x" + "00".repeat(32);

  function stubReceipt(over: Record<string, unknown> = {}) {
    return {
      status: "success",
      to: MANAGER,
      logs: [{ topics: [GRANT_TOPIC], data: "0x" }],
      ...over,
    } as never;
  }

  let waitSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    waitSpy = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runnerWithReceipt(receipt: unknown) {
    const r = makeRunner(fixedBrain(null));
    waitSpy.mockResolvedValue(receipt);
    (r as unknown as { publicClient: { waitForTransactionReceipt: unknown } }).publicClient = {
      waitForTransactionReceipt: waitSpy,
    };
    return r;
  }

  it("rejects a reverted grant transaction", async () => {
    const r = runnerWithReceipt(stubReceipt({ status: "reverted" }));
    await expect(r.adoptGrant(`0x${"01".repeat(32)}` as Hash)).rejects.toThrow(/reverted/);
    expect(r.isGranted).toBe(false);
  });

  it("rejects a grant that did not target the configured manager", async () => {
    const r = runnerWithReceipt(stubReceipt({ to: "0x9999999999999999999999999999999999999999" }));
    await expect(r.adoptGrant(`0x${"01".repeat(32)}` as Hash)).rejects.toThrow(/did not target manager/);
    expect(r.isGranted).toBe(false);
  });

  it("rejects a grant that emitted no SessionKeyGranted log", async () => {
    const r = runnerWithReceipt(stubReceipt({ logs: [] }));
    await expect(r.adoptGrant(`0x${"01".repeat(32)}` as Hash)).rejects.toThrow(/did not emit SessionKeyGranted/);
    expect(r.isGranted).toBe(false);
  });
});

describe("StubBrain — guardrails are ordered and total", () => {
  it("declines when the balance is below its threshold", async () => {
    const brain = new StubBrain({
      targetAddress: TARGET,
      transferSelector: "0xdeadbeef",
      amountWhenFires: 10n ** 18n,
      period: 1,
      offset: 0,
      minBalanceThreshold: 10n ** 20n,
      maxActionsPerRun: 5,
    } as never);
    const c: AgentContext = {
      tick: 0,
      managerAddress: MANAGER,
      balance: 1n,
      windowSpendRemaining: 10n ** 20n,
      perActionCap: 10n ** 18n,
      nonce: 0n,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      actionsExecuted: 0,
    };
    expect(await brain.propose(c)).toBeNull();
  });

  it("declines once maxActionsPerRun is reached", async () => {
    const brain = new StubBrain({
      targetAddress: TARGET,
      transferSelector: "0xdeadbeef",
      amountWhenFires: 1n,
      period: 1,
      offset: 0,
      minBalanceThreshold: 0n,
      maxActionsPerRun: 0,
    } as never);
    const c: AgentContext = {
      tick: 0,
      managerAddress: MANAGER,
      balance: 10n ** 20n,
      windowSpendRemaining: 10n ** 20n,
      perActionCap: 10n ** 18n,
      nonce: 0n,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      actionsExecuted: 0,
    };
    expect(await brain.propose(c)).toBeNull();
  });

  it("throws rather than proposing above perActionCap", async () => {
    // Fail-loud: a brain that would exceed the cap must not silently clamp, because a
    // silent clamp hides a misconfigured strategy from the operator.
    const brain = new StubBrain({
      targetAddress: TARGET,
      transferSelector: "0xdeadbeef",
      amountWhenFires: 10n ** 30n,
      period: 1,
      offset: 0,
      minBalanceThreshold: 0n,
      maxActionsPerRun: 5,
    } as never);
    const c: AgentContext = {
      tick: 0,
      managerAddress: MANAGER,
      balance: 10n ** 30n,
      windowSpendRemaining: 10n ** 30n,
      perActionCap: 10n ** 18n,
      nonce: 0n,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      actionsExecuted: 0,
    };
    await expect(brain.propose(c)).rejects.toThrow();
  });
});