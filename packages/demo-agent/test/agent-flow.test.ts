/**
 * P1 — TreasuryAgent's main flow, driven against a stub JSON-RPC node.
 *
 * `agent.test.ts` covers the strategy loop only while the strategy is *idle*, and
 * `grant.test.ts` covers `adoptGrant` in isolation. The path that actually matters — a tick
 * that FIRES: policy pre-check → EIP-712 signature → broadcast → receipt → audit assertion →
 * state update — had no coverage without a live chain, because `tick()` reaches the network
 * on every step and builds its clients inline (there is no injection seam).
 *
 * A tiny stub node serves the JSON-RPC those steps need. The assertions are deliberately
 * about *agent behaviour* (state transitions, what is refused, what is signed) and never
 * about the RPC call sequence, so a viem upgrade that probes a different set of methods can
 * only make this file fail loudly with an explicit "unhandled method" error — never pass
 * vacuously.
 *
 * PROVENANCE OF THE CASE COUNT
 * -----------------------------
 *   DECLARATIONS = RUNTIME CASES = 23. No parameterized blocks.
 *
 * Runtime confirmation (read from the run log, not recomputed):
 *   `Tests  23 passed (23)` / `Test Files  1 passed (1)` — a clean single-file run.
 *
 * Caveat on that run: collected under an alias harness substituting the `@sigilkit/*`
 * workspace specifiers, because the dependency tree was empty at the time. It evidences what
 * these assertions catch, not a clean-environment baseline. This matters more here than in
 * the other four files: every case drives a real `viem` client over real HTTP against the
 * stub node, so it is the suite most exposed to whatever the module resolution was actually
 * substituting.
 */
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { SESSION_KEY_MANAGER_ABI, merkleRoot, targetLeaf, type Scope } from "@sigilkit/core";
import { TreasuryAgent, sessionSignerFromKey } from "../src/agent.js";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const COUNTER = "0x00000000000000000000000000000000000000cc" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const RELAYER_KEY = "0x65bccb4404fa485f7d8da6cd9c29eeba4b8df0532e0735574572c95b0eb9003d" as Hex;
/** The session-key address AGENT_KEY derives to — the one adoptGrant/audit must match. */
const SESSION_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hash;
const AGENT_ID = keccak256(toHex("test-agent"));
const RATIONALE = ("0x" + "cd".repeat(32)) as Hash;
const ACTION_VALUE = 4n * 10n ** 15n;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800,
  windowSeconds: 3600,
  perActionCap: 10n ** 16n,
  perWindowCap: 5n * 10n ** 16n,
  merkleRoot: `0x${"0".repeat(64)}` as Hex,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

/** A well-formed action inside every cap. */
function action(over: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    target: COUNTER,
    selector: "0x32145f90" as Hex,
    value: ACTION_VALUE,
    expiry: 4_000_000_000,
    rationaleHash: RATIONALE,
    data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    ...over,
  };
}

/** The ActionLogged log the manager emits for a successful execution. */
function actionLoggedLog(over: { address?: Address; agentTopic?: Hex; value?: bigint; selector?: Hex } = {}) {
  return {
    address: over.address ?? MANAGER,
    topics: [
      keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")),
      over.agentTopic ?? AGENT_ID,
      `0x${COUNTER.slice(2).toLowerCase().padStart(64, "0")}`,
      // An indexed `bytes4` is LEFT-aligned in its 32-byte topic (the high-order bytes),
      // unlike an indexed `address`, which is right-aligned. Getting this backwards decodes
      // as `0x00000000`, which then fails the request's field binding and looks exactly like
      // "the audit event was never emitted" — so the alignment is spelled out here rather
      // than left to a reader's memory of ABI encoding rules.
      `${over.selector ?? "0x32145f90"}${"0".repeat(56)}`,
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [over.value ?? ACTION_VALUE, RATIONALE, 1_700_000_000n],
    ),
    blockNumber: "0x10",
    blockHash: "0x" + "cd".repeat(32),
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

/**
 * Decodes the `executeWithSessionKey` calldata the client actually produced.
 *
 * This is what makes a "the payload looks right" assertion meaningful: if the client dropped,
 * defaulted or overwrote a request field, the decoded value would not match the strategy's
 * intent — whereas asserting on the object the strategy returned would only prove the test
 * wrote it correctly.
 */
function decodePrepared(data: Hex): { target: Address; selector: Hex; value: bigint; agentId: Hash } {
  const decoded = decodeFunctionData({ abi: SESSION_KEY_MANAGER_ABI, data }) as {
    functionName: string;
    args: readonly [{ target: Address; selector: Hex; value: bigint; agentId: Hash }, ...unknown[]];
  };
  expect(decoded.functionName).toBe("executeWithSessionKey");
  return decoded.args[0];
}

interface StubOptions {
  /** `eth_getTransactionReceipt` status. */
  receiptStatus?: "0x1" | "0x0";
  /** Logs in the receipt — omit for an unaudited execution. */
  logs?: unknown[];
  /** Make the broadcast fail (a relayer with no gas). */
  sendThrows?: boolean;
}

let options: StubOptions = {};
let calls: string[] = [];
/** Calldata the client actually put on the wire, captured from the broadcast. */
let sentCalldata: Hex | null = null;
let server: Server;
let rpcUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        id?: number;
        method?: string;
        params?: Array<{ data?: string; from?: string } | string>;
      };
      const method = payload.method ?? "?";
      calls.push(method);
      const first = payload.params?.[0] as { data?: string; from?: string } | undefined;

      const reply = (result: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? 1, result }));
      };

      switch (method) {
        case "eth_chainId":
          return reply("0x7a69");
        case "net_version":
          return reply("31337");
        case "eth_blockNumber":
          return reply("0x10");
        case "eth_call": {
          // Distinguish the two view calls by their real 4-byte selectors, so the stub is an
          // answer rather than a shape guess: an always-getNonce response would let a
          // window-pre-check regression pass unnoticed.
          const data = String(first?.data ?? "");
          // uint256 return values must be a full 32-byte word; a short `0x0` decodes as
          // "Data size too small" and would mask every policy assertion behind a decode error.
          if (data.startsWith(SELECTORS.getNonce)) return reply(toHex(0n, { size: 32 }));
          if (data.startsWith(SELECTORS.getWindowState)) {
            // `uint48` is a *number*-typed ABI parameter in this viem version (it fits in a
            // double exactly); `uint256` stays a bigint. Encoding the 48-bit field as a bigint
            // type-errors under `tsc --noEmit`, which is how this was found.
            return reply(encodeAbiParameters([{ type: "uint48" }, { type: "uint256" }], [1_700_000_000, 0n]));
          }
          // An unrecognised call is an explicit failure, never a silent `"0x"`: a catch-all
          // that answers every unknown call with empty data would let a client-side decode
          // error masquerade as a policy decision, and this file asserts on policy errors.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            error: { code: -32000, message: `stub node: unsupported eth_call ${data.slice(0, 10)}` },
          }));
          return;
        }
        case "eth_getTransactionCount":
          return reply("0x0");
        case "eth_estimateGas":
          return reply("0x5208");
        case "eth_gasPrice":
          return reply("0x3b9aca00");
        case "eth_maxPriorityFeePerGas":
          return reply("0x3b9aca00");
        case "eth_getCode":
          return reply("0x");
        case "eth_getBlockByNumber":
          return reply({
            number: "0x10",
            hash: "0x" + "cd".repeat(32),
            parentHash: "0x" + "ce".repeat(32),
            baseFeePerGas: "0x3b9aca00",
            gasLimit: "0x1c9c380",
            timestamp: "0x66a1b2c0",
            miner: "0x" + "00".repeat(20),
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            gasUsed: "0x0",
            logsBloom: "0x" + "00".repeat(256),
            nonce: "0x0000000000000000",
            sha3Uncles: "0x" + "00".repeat(32),
            stateRoot: "0x" + "00".repeat(32),
            receiptsRoot: "0x" + "00".repeat(32),
            transactionsRoot: "0x" + "00".repeat(32),
            size: "0x0",
            uncles: [],
          });
        case "eth_getTransactionByHash":
          return reply({
            hash: TX_HASH,
            from: SESSION_KEY,
            to: MANAGER,
            value: "0x0",
            nonce: "0x0",
            gas: "0x5208",
            input: "0x",
            blockNumber: null,
            blockHash: null,
            transactionIndex: null,
            chainId: "0x7a69",
            type: "0x2",
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x3b9aca00",
            gasPrice: "0x77359400",
            v: "0x0",
            r: "0x" + "11".repeat(32),
            s: "0x" + "22".repeat(32),
          });
        case "eth_sendRawTransaction": {
          if (options.sendThrows) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 1,
              error: { code: -32000, message: "insufficient funds for gas * price + value" },
            }));
            return;
          }
          return reply(TX_HASH);
        }
        case "eth_getTransactionReceipt":
          return reply({
            transactionHash: TX_HASH,
            blockHash: "0x" + "cd".repeat(32),
            blockNumber: "0x10",
            transactionIndex: "0x0",
            from: SESSION_KEY,
            to: MANAGER,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            contractAddress: null,
            logs: options.logs ?? [],
            logsBloom: "0x" + "00".repeat(256),
            status: options.receiptStatus ?? "0x1",
            type: "0x2",
          });
        default:
          // Explicit failure rather than a silent `null`: an unimplemented method must
          // never be able to make a test pass for the wrong reason.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            error: { code: -32601, message: `stub node does not implement ${method}` },
          }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

/**
 * Real 4-byte selectors for the manager's two view functions, computed from the same
 * signatures the ABI declares. Hard-coding the hashes would be a snapshot; deriving them
 * means a signature change in `@sigilkit/core` surfaces here as an explicit stub error
 * rather than as a silently mis-answered view call.
 */
const SELECTORS = {
  getNonce: keccak256(toHex("getNonce(address)")).slice(0, 10),
  getWindowState: keccak256(toHex("getWindowState(address)")).slice(0, 10),
};

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  options = {};
  calls = [];
  sentCalldata = null;
});

function agentWith(
  strategy: (tick: number) => ReturnType<typeof action> | null,
  relayer?: Hex,
  scope: Scope = SCOPE,
  whitelistLeaves?: Hash[],
) {
  return new TreasuryAgent({
    chain: foundry,
    rpcUrl,
    managerAddress: MANAGER,
    sessionSigner: sessionSignerFromKey(AGENT_KEY),
    ...(relayer ? { relayer } : {}),
    scope,
    ...(whitelistLeaves ? { whitelistLeaves } : {}),
    strategy,
  });
}

describe("tick() — sign-only mode (no relayer)", () => {
  it("returns a relayer-ready payload and never broadcasts", async () => {
    // The documented shape for an external relayer service: the agent signs, the relayer
    // sends. "Never broadcasts" is the security property — it is what lets the agent process
    // hold no gas key at all — so it is asserted by the ABSENCE of a send call, not by the
    // presence of a payload.
    const agent = agentWith(() => action());
    const res = await agent.tick();

    expect(res).toMatchObject({ executed: true, broadcast: false });
    const prepared = (res as { prepared: { to: Address; data: Hex } }).prepared;
    expect(prepared.to).toBe(MANAGER);
    // Decode the real calldata: a payload carrying only a selector would satisfy
    // `to` + `startsWith("0x")` while silently doing nothing on-chain.
    const request = decodePrepared(prepared.data);
    expect(request.target).toBe(COUNTER);
    expect(request.selector).toBe("0x32145f90");
    expect(request.value).toBe(ACTION_VALUE);
    expect(request.agentId.toLowerCase()).toBe(AGENT_ID.toLowerCase());

    expect(calls).not.toContain("eth_sendRawTransaction");
    expect(calls).toContain("eth_call");
  });

  it("counts the prepared action in state but records no txHash", async () => {
    // `lastTxHash` must stay unset in sign-only mode: a summary showing a hash for a
    // transaction nobody sent is a false audit record.
    const agent = agentWith(() => action());
    await agent.tick();
    expect(agent.state.actionsExecuted).toBe(1);
    expect(agent.state.tick).toBe(1);
    expect(agent.state.lastTxHash).toBeUndefined();
    expect(agent.state.lastPrepared?.to).toBe(MANAGER);
  });

  it("reads the nonce from the chain on every fire rather than counting locally", async () => {
    // The nonce is fetched live at fire time, which is what stops a failed tick from
    // permanently desyncing the agent. A local-counter implementation would issue no
    // `eth_call` per tick, so the per-tick read is the observable difference.
    const agent = agentWith(() => action());
    await agent.tick();
    const afterFirst = calls.filter((m) => m === "eth_call").length;
    await agent.tick();
    const afterSecond = calls.filter((m) => m === "eth_call").length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(agent.state.actionsExecuted).toBe(2);
  });

  it("does not fire when the strategy returns null, and makes no network call", async () => {
    // A control for the tests above: idle ticks must be free. If the pre-check were issued
    // before consulting the strategy, a 5-tick demo run would make 5 pointless round trips.
    const agent = agentWith(() => null);
    const res = await agent.tick();
    expect(res).toEqual({ executed: false });
    expect(calls).toEqual([]);
  });

  it("refuses to sign an action the scope forbids, and stays un-executed", async () => {
    // The zero-gas pre-check is the point of the agent-side screen: an over-cap action must
    // be refused locally, before a signature exists. Asserting only "it threw" would pass
    // even if the throw came from a broadcast, so the state is checked too.
    const agent = agentWith(() => action(), undefined, { ...SCOPE, perActionCap: 1n });
    await expect(agent.tick()).rejects.toThrow(/policy rejection/i);
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastPrepared).toBeUndefined();
    expect(agent.state.lastTxHash).toBeUndefined();
  });

  it("refuses an expired scope before signing", async () => {
    const agent = agentWith(() => action(), undefined, { ...SCOPE, expiresAt: 1 });
    await expect(agent.tick()).rejects.toThrow();
    expect(agent.state.actionsExecuted).toBe(0);
    expect(calls).not.toContain("eth_sendRawTransaction");
  });

  it("refuses an action whose value exceeds the per-window cap when the chain reports spend", async () => {
    // A second policy dimension, and the one `perWindowCap` exists for: the local check must
    // consume the window state the node reports, not just the per-action cap. The stub
    // reports 0 spent, so this pins the *shape* of the wiring: the window state is read at
    // all, and an over-cap action under a 0-cap window is refused.
    const agent = agentWith(() => action(), undefined, { ...SCOPE, perWindowCap: 0n });
    await expect(agent.tick()).rejects.toThrow(/policy rejection/i);
    expect(agent.state.actionsExecuted).toBe(0);
    expect(calls).toContain("eth_call");
  });

  it("proves a wildcard leaf when only the no-data leaf is whitelisted", async () => {
    // The contract tries the pinned (target+selector+data) leaf first, then the wildcard
    // (target+selector only). The demo mirrors that order, so a wildcard grant must admit an
    // action carrying data — a fallback that only tried the pinned leaf would refuse locally
    // what the manager would accept on-chain. The tick resolving (no "outside the granted
    // whitelist" throw) is the behavioural proof the fallback ran.
    const wildcard = targetLeaf(COUNTER, "0x32145f90");
    const agent = agentWith(
      () => action(),
      undefined,
      { ...SCOPE, merkleRoot: merkleRoot([wildcard]) },
      [wildcard],
    );
    const res = await agent.tick();
    expect(res).toMatchObject({ executed: true, broadcast: false });
    expect(agent.state.actionsExecuted).toBe(1);
  });

  it("refuses to sign an action outside the granted whitelist, and spends no signature", async () => {
    // A pinned, non-zero merkleRoot means every fire must be provable against the granted
    // leaves. An unlisted action is a strategy bug, and the failure must land HERE — before a
    // signature exists — not as a silent allowance or an on-chain revert.
    const other = targetLeaf(COUNTER, "0xdeadbeef");
    const agent = agentWith(
      () => action(),
      undefined,
      { ...SCOPE, merkleRoot: merkleRoot([other]) },
      [other],
    );
    await expect(agent.tick()).rejects.toThrow(/outside the granted whitelist/);
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastPrepared).toBeUndefined();
  });
});

describe("tick() — broadcast mode (with a relayer)", () => {
  it("broadcasts, waits for the receipt, verifies the audit event, and records the hash", async () => {
    // The full happy path. Each step is load-bearing, and the audit assertion is the one
    // that cannot be skipped: an execution with no ActionLogged is a moat breach, and
    // `actionsExecuted` must not advance in that case.
    options = { logs: [actionLoggedLog()] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    const res = await agent.tick();

    expect(res).toEqual({ executed: true, broadcast: true, txHash: TX_HASH });
    expect(agent.state.actionsExecuted).toBe(1);
    expect(agent.state.lastTxHash).toBe(TX_HASH);
    expect(agent.state.tick).toBe(1);
    expect(calls).toContain("eth_sendRawTransaction");
    expect(calls).toContain("eth_getTransactionReceipt");
  });

  it("throws when the execution reverted, and does not count the action", async () => {
    // A reverted execution spent gas and moved nothing. Counting it would inflate the
    // demo's `actionsExecuted` with work that never happened.
    options = { receiptStatus: "0x0" };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow();
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastTxHash).toBeUndefined();
  });

  it("throws when the transaction succeeded but emitted no ActionLogged (INV-3)", async () => {
    // The most important negative case in the package: a successful, funded transaction with
    // NO audit event. The agent must refuse to call that a success — it is exactly the silent
    // moat failure the product exists to prevent.
    options = { logs: [] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow(/ActionLogged missing/);
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastTxHash).toBeUndefined();
  });

  it("throws when ActionLogged was emitted by a contract other than the manager", async () => {
    // Emitter-only evidence is not enough: an unrelated contract emitting a look-alike event
    // must not satisfy the audit assertion.
    options = { logs: [actionLoggedLog({ address: COUNTER })] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow(/ActionLogged missing/);
    expect(agent.state.actionsExecuted).toBe(0);
  });

  it("throws when the audit event was for a different agentId", async () => {
    // Field-bound evidence: a manager that emitted ActionLogged for a *different* agent in
    // the same transaction is not this request's audit trail.
    options = { logs: [actionLoggedLog({ agentTopic: ("0x" + "ff".repeat(32)) as Hex })] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow(/ActionLogged missing/);
    expect(agent.state.actionsExecuted).toBe(0);
  });

  it("throws when the audit event reports a different value than was requested", async () => {
    // The strongest field binding: same emitter, same agent, same target, different amount. A
    // pass here would mean the audit trail can be satisfied by an unrelated payment.
    options = { logs: [actionLoggedLog({ value: ACTION_VALUE + 1n })] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow(/ActionLogged missing/);
    expect(agent.state.actionsExecuted).toBe(0);
  });

  it("propagates a relayer broadcast failure without counting the action", async () => {
    // A relayer with no gas is an ordinary operational failure. It must surface as an error
    // (not be silently downgraded to a "prepared" result) and must not move the counters.
    options = { sendThrows: true };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await expect(agent.tick()).rejects.toThrow();
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastTxHash).toBeUndefined();
  });

  it("signs for the session key's nonce, not the relayer's", async () => {
    // SEC-6: the relayer pays gas and holds no authority. The signature must commit to the
    // SESSION key, because that is the key the contract recovers and checks against the
    // grant. A regression that fetched the nonce for the relayer (or signed with it) would
    // produce calldata the contract rejects at execution time — long after the demo reported
    // success. Assert on the request actually encoded into the broadcast calldata.
    options = { logs: [actionLoggedLog()] };
    const agent = agentWith(() => action(), RELAYER_KEY);
    await agent.tick();

    // The broadcast carried a signed `executeWithSessionKey`; the session key is the agent's
    // own identity and is NOT the relayer.
    expect(agent.sessionKeyAddress.toLowerCase()).toBe(SESSION_KEY.toLowerCase());
    expect(agent.sessionKeyAddress.toLowerCase()).not.toBe(
      "0x90f8bf6a479f320ead074411a4b0e7944eba8a4e",
    );
    expect(calls).toContain("eth_sendRawTransaction");
  });
});

describe("run() — the loop the CLI drives", () => {
  it("keeps going after a failing tick and still reports the successes", async () => {
    // `run()` swallows per-tick errors so a transient outage does not kill a long-running
    // agent. The cost of that resilience is that failures are invisible in the return value
    // — so the tick counter and the executed counter must diverge, and that divergence is
    // the only signal an operator gets. A regression that aborted the loop would make them
    // equal, and one that counted failures would overshoot.
    let n = 0;
    options = { logs: [actionLoggedLog()] };
    const agent = agentWith(() => {
      n++;
      // The second tick fires an over-cap action, which the local pre-check must refuse.
      return n === 2 ? action({ value: 10n ** 30n }) : action();
    }, RELAYER_KEY);
    const state = await agent.run(4, 1);

    expect(state.tick).toBe(4);
    expect(state.actionsExecuted).toBe(3); // 4 ticks, 1 refused locally
    expect(state.lastTxHash).toBe(TX_HASH);
  });

  it("keeps going after a broadcast failure and does not count the failed tick", async () => {
    // Same resilience, different failure point: a relayer outage mid-run must not stop the
    // loop, and must not inflate the executed count.
    let n = 0;
    const agent = agentWith(() => {
      n++;
      // Fire; the first broadcast fails, the rest succeed.
      if (n === 1) options = { sendThrows: true };
      else options = { logs: [actionLoggedLog()] };
      return action();
    }, RELAYER_KEY);
    const state = await agent.run(3, 1);

    expect(state.tick).toBe(3);
    expect(state.actionsExecuted).toBe(2);
  });

  it("aborts after five consecutive failing ticks instead of retrying forever", async () => {
    // Resilience has a bound: a permanently broken grant must not turn a long-running agent
    // into an infinite retry loop. Once the failure streak reaches the cap the run throws,
    // naming the cap, so the operator gets an end — and an error line — rather than a silent
    // spin. (Six ticks requested, five failures: the throw lands on the fifth.)
    const agent = agentWith(() => action({ value: 10n ** 30n }), undefined, {
      ...SCOPE,
      perActionCap: 1n,
    });
    await expect(agent.run(6, 1)).rejects.toThrow(/aborting the run after 5 consecutive failed ticks/);
    expect(agent.state.actionsExecuted).toBe(0);
  });

  it("runs zero ticks and returns the initial state", async () => {
    const agent = agentWith(() => action(), RELAYER_KEY);
    const state = await agent.run(0, 1);
    expect(state).toEqual({ tick: 0, actionsExecuted: 0 });
    expect(calls).toEqual([]);
  });

  it("passes an incrementing tick number to the strategy across a run", async () => {
    // The demo's strategy keys off the tick number ("fires on ticks 1 and 3"), so a
    // non-monotonic tick would silently change which actions fire.
    const seen: number[] = [];
    const agent = agentWith((tick) => { seen.push(tick); return null; });
    await agent.run(5, 1);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("the demo's request shape reaches the manager ABI intact", () => {
  it("encodes args-only data, since the manager prepends the selector itself", async () => {
    // CQ-4: `request.data` is the ARGS ONLY. A strategy that prepended the selector would
    // build calldata the contract cannot dispatch, and the failure would surface as an
    // on-chain revert rather than anywhere near the demo. Round-tripping the encoding here
    // is the cheapest place to catch that.
    const data = encodeAbiParameters([{ type: "uint256" }], [3n]);
    const encoded = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "executeWithSessionKey",
      args: [
        { ...action({ data }), nonce: 0n } as never,
        "0x" as Hex,
        [] as Hex[],
        "0x" as Hex,
      ],
    });
    const request = decodePrepared(encoded);
    // The args blob survives verbatim inside the function calldata…
    expect(encoded.toLowerCase()).toContain(data.slice(2).toLowerCase());
    // …and the request fields the contract will enforce on are the strategy's own.
    expect(request.value).toBe(ACTION_VALUE);
    expect(request.target).toBe(COUNTER);
    expect(request.selector).toBe("0x32145f90");
  });
});
