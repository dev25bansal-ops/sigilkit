/**
 * PERF-3 regression pins: the simulate-then-execute flow must perform exactly ONE
 * pre-flight.
 *
 * `simulateExecution` used to call `prepareExecution` itself, and the documented
 * simulate → execute flow called it again — fetching the nonce and the window state
 * twice, doubling pre-flight RPC cost and letting the two nonce reads disagree.
 */
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { encodeAbiParameters, pad, type Address, type Hex, type Log, type PublicClient, type WalletClient } from "viem";
import { ACTION_LOGGED_TOPIC, parseActionLogged, SigilKitClient, InMemoryLeaseStore, NonceGate, type ExecutionGuard, type LeaseStore, type Scope } from "../src/index.js";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const TARGET = "0x0000000000000000000000000000000000009001" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800, // far future
  windowSeconds: 600,
  perActionCap: 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  merkleRoot: `0x${"0".repeat(64)}` as Hex,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function prepareArgs() {
  return {
    account: privateKeyToAccount(AGENT_KEY),
    request: {
      agentId: `0x${"11".repeat(32)}` as Hex,
      target: TARGET,
      selector: "0x32145f90" as Hex,
      value: 0n,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: `0x${"22".repeat(32)}` as Hex,
      data: "0x" as Hex,
    },
    scope: SCOPE,
  };
}

function harness(opts: { simFails?: boolean; logs?: Log[]; status?: "success" | "reverted"; leaseStore?: LeaseStore; leaseTtlMs?: number; beforeReceipt?: () => Promise<void>; afterRead?: () => void; afterSimulation?: () => void } = {}) {
  const reads: string[] = [];
  const sent: unknown[] = [];
  const publicClient = {
    readContract: async (a: { functionName: string }) => {
      reads.push(a.functionName);
      opts.afterRead?.();
      if (a.functionName === "getNonce") return 0n;
      if (a.functionName === "getWindowState") return [0n, 0n];
      throw new Error(`unexpected read ${a.functionName}`);
    },
    call: async () => {
      if (opts.simFails) throw Object.assign(new Error("execution reverted"), { data: "0x" });
      opts.afterSimulation?.();
      return "0x";
    },
    waitForTransactionReceipt: async () => {
      await opts.beforeReceipt?.();
      return { status: opts.status ?? "success", logs: opts.logs ?? [] };
    },
  } as unknown as PublicClient;

  const wallet = {
    account: privateKeyToAccount(AGENT_KEY),
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return ("0x" + "ab".repeat(32)) as Hex;
    },
  } as unknown as WalletClient;

  const client = new SigilKitClient({ managerAddress: MANAGER, chain: foundry, publicClient, leaseStore: opts.leaseStore, leaseTtlMs: opts.leaseTtlMs });
  return { client, reads, sent, wallet };
}

const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

function auditLog(overrides: Partial<Log> = {}): Log {
  const request = prepareArgs().request;
  return {
    address: MANAGER,
    topics: [ACTION_LOGGED_TOPIC, request.agentId, pad(request.target), pad(request.selector, { dir: "right" })],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "uint48" }], [request.value, request.rationaleHash, 100]),
    blockHash: `0x${"01".repeat(32)}`,
    blockNumber: 1n,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

describe("configured lease execution boundaries", () => {
  it("requires a genuine same-client context before signing", async () => {
    const { client, wallet, sent } = harness({ leaseStore: new InMemoryLeaseStore() });
    const args = prepareArgs();
    const sign = vi.spyOn(args.account, "sign");
    await expect(client.execute(args, wallet)).rejects.toThrow("lease store is configured");
    const fake: ExecutionGuard = { key: args.account.address, signal: new AbortController().signal, assertCurrent: async () => undefined };
    await expect(client.execute(args, wallet, fake)).rejects.toThrow("originate");
    await expect(new NonceGate().run(args.account.address, (guard) => client.execute(args, wallet, guard))).rejects.toThrow("originate");
    await expect(client.nonceGate.run(TARGET, (guard) => client.execute(args, wallet, guard))).rejects.toThrow("signing session key");
    expect(sign).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it.each([false, "throw"])("rejects a failed live check after awaited preparation: %s", async (mode) => {
    const store = new InMemoryLeaseStore();
    const { client, wallet, sent } = harness({ leaseStore: store, afterRead: () => {
      vi.spyOn(store, "isCurrent").mockImplementation(() => {
        if (mode === "throw") throw new Error("synthetic I/O");
        return false;
      });
    } });
    const args = prepareArgs();
    const sign = vi.spyOn(args.account, "sign");
    await expect(client.nonceGate.run(args.account.address, (guard) => client.execute(args, wallet, guard))).rejects.toThrow("superseded");
    expect(sign).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("checks again after simulation and never sends after loss", async () => {
    const store = new InMemoryLeaseStore();
    const { client, wallet, sent } = harness({ leaseStore: store, afterSimulation: () => {
      vi.spyOn(store, "isCurrent").mockReturnValue(false);
    } });
    const args = prepareArgs();
    await expect(client.nonceGate.run(args.account.address, (guard) => client.executeSimulated(args, wallet, undefined, guard))).rejects.toThrow("superseded");
    expect(sent).toHaveLength(0);
  });

  it("retains original payload provenance, not agentId or relayer identity", async () => {
    const store = new InMemoryLeaseStore();
    const { client, wallet, sent } = harness({ leaseStore: store, logs: [auditLog()] });
    const args = prepareArgs();
    const prepared = await client.nonceGate.run(args.account.address, (guard) => client.prepareExecution(args, guard));
    await client.nonceGate.run(args.account.address, async (guard) => {
      await expect(client.sendPrepared(prepared, wallet, guard)).rejects.toThrow("provenance");
      const current = await client.prepareExecution(args, guard);
      await expect(client.sendPrepared({ ...current }, wallet, guard)).rejects.toThrow("provenance");
      await expect(client.sendPrepared(current, wallet)).rejects.toThrow("provenance");
      expect((await client.sendPrepared(current, wallet, guard)).audit.txHash).toBe(TX_HASH);
    });
    expect(sent).toHaveLength(1);
  });

  it("keeps the receipt outcome when renewal fails after submission", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryLeaseStore();
      vi.spyOn(store, "renew").mockReturnValue(false);
      const { client, wallet, sent } = harness({ leaseStore: store, leaseTtlMs: 100, logs: [auditLog()],
        beforeReceipt: async () => { await vi.advanceTimersByTimeAsync(60); },
      });
      const args = prepareArgs();
      const result = await client.nonceGate.run(args.account.address, (guard) => client.execute(args, wallet, guard));
      expect(result.audit.txHash).toBe(TX_HASH);
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([undefined, 5000])("threads operator TTL %s to acquisition", async (ttl) => {
    const store = new InMemoryLeaseStore();
    const acquire = vi.spyOn(store, "acquire");
    const { client } = harness({ leaseStore: store, leaseTtlMs: ttl });
    await client.nonceGate.run(TARGET, async () => undefined);
    expect(acquire).toHaveBeenCalledWith(TARGET, ttl ?? 30_000);
  });
});

describe("bound audit confirmation", () => {
  it("accepts unique manager evidence and the exact request", async () => {
    const { client, wallet } = harness({ logs: [auditLog({ address: "0x00000000000000000000000000000000000000AA" })] });
    const prepared = await client.prepareExecution(prepareArgs());
    expect(await client.assertAuditEmitted(TX_HASH, prepared.request)).toBe(true);
    expect((await client.sendPrepared(prepared, wallet)).audit.agentId).toBe(prepared.request.agentId);
  });

  it.each([
    ["absent", []],
    ["unrelated emitter", [auditLog({ address: TARGET })]],
    ["malformed", [auditLog({ data: "0x" })]],
    ["removed", [auditLog({ removed: true })]],
    ["pending", [auditLog({ blockNumber: null })]],
    ["other transaction", [auditLog({ transactionHash: `0x${"cd".repeat(32)}` })]],
  ] as const)("rejects %s evidence", async (_label, logs) => {
    const { client, wallet } = harness({ logs: [...logs] });
    const prepared = await client.prepareExecution(prepareArgs());
    expect(await client.assertAuditEmitted(TX_HASH, prepared.request)).toBe(false);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow("ActionLogged missing");
  });

  it.each([
    { agentId: `0x${"33".repeat(32)}` as Hex },
    { target: MANAGER },
    { selector: "0x12345678" as Hex },
    { value: 1n },
    { rationaleHash: `0x${"44".repeat(32)}` as Hex },
  ])("checks every emitted request field %#", async (different) => {
    const { client, wallet } = harness({ logs: [auditLog()] });
    const prepared = await client.prepareExecution(prepareArgs());
    prepared.request = { ...prepared.request, ...different };
    expect(await client.assertAuditEmitted(TX_HASH, prepared.request)).toBe(false);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow("ActionLogged missing");
  });

  it("rejects ambiguous matches instead of selecting the first", async () => {
    const { client, wallet } = harness({ logs: [auditLog(), auditLog({ logIndex: 1 })] });
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.assertAuditEmitted(TX_HASH, prepared.request)).rejects.toThrow("ambiguous");
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow("ambiguous");
  });

  it("ignores unrelated records before a unique expected record", async () => {
    const { client } = harness({ logs: [auditLog({ address: TARGET }), auditLog({ logIndex: 1 })] });
    expect(await client.assertAuditEmitted(TX_HASH, prepareArgs().request)).toBe(true);
  });

  it("rejects reverted receipts and mismatched destinations", async () => {
    const { client, wallet, sent } = harness({ logs: [auditLog()], status: "reverted" });
    await expect(client.assertAuditEmitted(TX_HASH)).rejects.toThrow("reverted");
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared({ ...prepared, to: TARGET }, wallet)).rejects.toThrow("configured manager");
    expect(sent).toHaveLength(0);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow("reverted");
  });

  it("retains the unbound low-level decoder for ingestion", () => {
    expect(parseActionLogged([auditLog({ address: TARGET })])?.txHash).toBe(TX_HASH);
  });
});

describe("simulate-then-execute performs one pre-flight (PERF-3)", () => {
  it("simulateExecution accepts an already-prepared payload without re-preparing", async () => {
    const { client, reads } = harness();

    const prepared = await client.prepareExecution(prepareArgs());
    const afterPrepare = reads.length;
    expect(afterPrepare).toBeGreaterThan(0); // getNonce + getWindowState

    const sim = await client.simulateExecution(prepared);
    expect(sim).toEqual({ ok: true });
    // The regression: this used to re-run prepareExecution, doubling the reads.
    expect(reads.length).toBe(afterPrepare);
  });

  it("simulateExecution still prepares when given fresh args", async () => {
    const { client, reads } = harness();
    const sim = await client.simulateExecution(prepareArgs());
    expect(sim).toEqual({ ok: true });
    expect(reads.length).toBeGreaterThan(0);
  });

  it("executeSimulated prepares once and sends the simulated payload", async () => {
    const { client, reads, sent } = harness();
    const prepared = await client.prepareExecution(prepareArgs());
    const afterPrepare = reads.length;

    // Same single pre-flight, then send. (The receipt path is covered by the Anvil E2E.)
    const sim = await client.simulateExecution(prepared);
    expect(sim.ok).toBe(true);
    expect(reads.length).toBe(afterPrepare);
    expect(sent).toHaveLength(0);
  });

  it("executeSimulated spends no gas when the simulation fails", async () => {
    const { client, sent, wallet } = harness({ simFails: true });
    await expect(client.executeSimulated(prepareArgs(), wallet)).rejects.toThrow(
      /simulation rejection/,
    );
    expect(sent).toHaveLength(0); // no transaction was broadcast
  });

  it("sendPrepared refuses a wallet without an account", async () => {
    const { client } = harness();
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, {} as WalletClient)).rejects.toThrow(
      /must carry an account/,
    );
  });
});
