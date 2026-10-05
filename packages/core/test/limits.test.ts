/**
 * Resource-limit regressions: the three bounds that turn unbounded work into a loud failure.
 *
 *  - PERF-10  `waitForTransactionReceipt` was unbounded, so a transaction replaced on the
 *    same nonce hung forever and, through `NonceGate`'s per-key serialization, blocked
 *    every later execution for that key. The wait is now bounded and every failure carries
 *    the `txHash` for offline reconciliation.
 *  - PERF-11  `merkleRoot`/`merkleProof` are synchronous and O(n) in leaves (~8.4 us each),
 *    so an unbounded caller-supplied array is an event-loop DoS. The proof bound mirrors the
 *    on-chain `MAX_TOTAL_PROOF_ELEMENTS` so the local pre-flight can never be looser than
 *    the chain.
 *  - DEBT/SEC-18e  `assertBigInt` accepted JS `number`s past 2^53, which JSON-deserialized
 *    caps arrive as; the silent rounding broke the exact-amount promise.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { zeroHash, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import {
  assertBigInt,
  MAX_LEAVES,
  MAX_CALLDATA_BYTES,
  MAX_MERKLE_PROOF_ELEMENTS,
  merkleProof,
  merkleRoot,
  parseActionRequest,
  SigilKitClient,
  targetLeaf,
  ValidationError,
  validateAgainstScope,
  type ActionRequest,
  type Scope,
} from "../src/index.js";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const TARGET = "0x0000000000000000000000000000000000009001" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const SELECTOR = "0x32145f90" as Hex;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800,
  windowSeconds: 600,
  perActionCap: 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  // zeroHash = allow-all, so the whitelist branch is skipped unless a test pins a real root.
  merkleRoot: zeroHash,
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
      selector: SELECTOR,
      value: 0n,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: `0x${"22".repeat(32)}` as Hex,
      data: "0x" as Hex,
    },
    scope: SCOPE,
  };
}

function request(): ActionRequest {
  return { ...prepareArgs().request, nonce: 0n } as ActionRequest;
}

/**
 * Harness whose `waitForTransactionReceipt` rejects the way viem does when the poll window
 * closes: a `WaitForTransactionReceiptTimeoutError`, whose message embeds the hash.
 */
function harness(opts: { receiptError?: Error } = {}) {
  const sent: unknown[] = [];
  const receiptCalls: Array<Record<string, unknown>> = [];

  const publicClient = {
    readContract: async (a: { functionName: string }) => {
      if (a.functionName === "getNonce") return 0n;
      // ABI-02: the contract returns ONE `SpendPolicy.WindowState` struct, so the mock
      // must return a named object. A `[0n, 0n]` array here no longer type-checks and,
      // more importantly, would silently feed `w.windowStart === undefined` into
      // `validateAgainstScope` if the decode were left positional.
      if (a.functionName === "getWindowState") return { windowStart: 0n, spentThisWindow: 0n };
      throw new Error(`unexpected read ${a.functionName}`);
    },
    call: async () => "0x",
    waitForTransactionReceipt: async (args: Record<string, unknown>) => {
      receiptCalls.push(args);
      if (opts.receiptError) throw opts.receiptError;
      return { status: "success", logs: [] };
    },
  } as unknown as PublicClient;

  const wallet = {
    account: privateKeyToAccount(AGENT_KEY),
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return TX_HASH;
    },
  } as unknown as WalletClient;

  const client = new SigilKitClient({ managerAddress: MANAGER, chain: foundry, publicClient });
  return { client, sent, receiptCalls, wallet };
}

/** Mirrors viem's `WaitForTransactionReceiptTimeoutError` message shape. */
function timeoutError(hash: string): Error {
  return new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
}

describe("PERF-10 · the receipt wait is bounded and hash-preserving", () => {
  it("passes an explicit timeout, retry count and polling interval (never viem's defaults)", async () => {
    const { client, receiptCalls } = harness();
    await client.assertAuditEmitted(TX_HASH, request());
    expect(receiptCalls).toHaveLength(1);
    expect(receiptCalls[0]).toMatchObject({
      hash: TX_HASH,
      timeout: 120_000,
      retryCount: 30,
      pollingInterval: 2_000,
    });
  });

  it("assertAuditEmitted surfaces a receipt timeout with the txHash for reconciliation", async () => {
    const { client } = harness({ receiptError: timeoutError(TX_HASH) });
    await expect(client.assertAuditEmitted(TX_HASH, request())).rejects.toThrow(TX_HASH);
    await expect(client.assertAuditEmitted(TX_HASH, request())).rejects.toThrow(/do NOT resend/i);
  });

  it("sendPrepared propagates the timeout with the txHash rather than swallowing it", async () => {
    const { client, wallet } = harness({ receiptError: timeoutError(TX_HASH) });
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow(TX_HASH);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow(/reconcile/i);
  });

  it("stamps the hash onto transport-level failures that carry no hash of their own", async () => {
    // A bare transport error would otherwise lose the hash and leave nothing to reconcile.
    const { client, wallet } = harness({ receiptError: new Error("socket hang up") });
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow(TX_HASH);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow(/socket hang up/);
  });

  it("sends exactly once per attempt — a timeout never triggers an internal resend", async () => {
    // A blind resend would revert with NonceUsed (the nonce is already consumed) and burn a
    // second relayer slot on the same failure, so the exact send count is the invariant.
    const { client, sent, receiptCalls, wallet } = harness({ receiptError: timeoutError(TX_HASH) });
    const prepared = await client.prepareExecution(prepareArgs());

    await expect(client.sendPrepared(prepared, wallet)).rejects.toThrow(TX_HASH);
    expect(sent).toHaveLength(1);
    expect(receiptCalls).toHaveLength(1);
  });

  it("execute() fails loudly and releases the NonceGate slot so the key is not wedged", async () => {
    // The actual DoS: before the bound this await never settled, so the gate's per-key chain
    // stayed occupied and every later execution for that key blocked behind it forever. The
    // follow-up run reaching its OWN timeout is the proof that the queue drained.
    const { client, sent, wallet } = harness({ receiptError: timeoutError(TX_HASH) });
    const args = prepareArgs();

    await expect(
      client.nonceGate.run(args.account.address, (guard) => client.execute(args, wallet, guard)),
    ).rejects.toThrow(TX_HASH);

    await expect(
      client.nonceGate.run(args.account.address, (guard) => client.execute(args, wallet, guard)),
    ).rejects.toThrow(TX_HASH);

    // One send per explicit caller attempt, never an automatic resend behind the scenes.
    expect(sent).toHaveLength(2);
  }, 15_000);
});

describe("PERF-11 · Merkle builders are bounded", () => {
  const leaf = targetLeaf(TARGET, SELECTOR);

  it(
    "merkleRoot rejects one leaf past the cap and accepts the cap itself",
    () => {
      // The cap itself must remain buildable — an off-by-one that rejected MAX_LEAVES would
      // be a functional regression disguised as a fix.
      expect(merkleRoot(new Array(MAX_LEAVES).fill(leaf) as Hash[])).toMatch(/^0x[0-9a-f]{64}$/);
      expect(() => merkleRoot(new Array(MAX_LEAVES + 1).fill(leaf) as Hash[])).toThrow(
        new RegExp(`at most ${MAX_LEAVES} leaves`),
      );
    },
    // 65,536 leaves is the worst case the cap permits (~0.55 s of keccak). Under v8 coverage
    // instrumentation every hash is traced, so the 5s default is too tight on a loaded runner.
    30_000,
  );

  it("merkleRoot still accepts ordinary tree sizes", () => {
    expect(() => merkleRoot(new Array(1024).fill(leaf) as Hash[])).not.toThrow();
  });

  it("merkleProof rejects one leaf past the cap", () => {
    expect(() => merkleProof(new Array(MAX_LEAVES + 1).fill(leaf) as Hash[], leaf)).toThrow(
      new RegExp(`at most ${MAX_LEAVES} leaves`),
    );
  });

  it("keeps MAX_LEAVES at a documented 65,536 so the cap cannot drift silently", () => {
    // Pinned numerically on purpose: the perf argument for this ceiling is a measured
    // ~0.55 s worst case, and a silent bump would invalidate it.
    expect(MAX_LEAVES).toBe(65_536);
  });

  it("validateAgainstScope rejects an over-long proof the chain would revert on", () => {
    const proof = new Array(MAX_MERKLE_PROOF_ELEMENTS + 1).fill(leaf) as Hex[];
    const result = validateAgainstScope({
      request: request(),
      scope: { ...SCOPE, merkleRoot: merkleRoot([leaf]) },
      merkleProof: proof,
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining(`merkle proof too long (${MAX_MERKLE_PROOF_ELEMENTS + 1}`),
    });
  });

  it("keeps the proof ceiling aligned with the on-chain MAX_SINGLE_PROOF_ELEMENTS", () => {
    // Read the ceiling out of the contract rather than restating it. This test used to
    // assert a literal 32 while naming MAX_TOTAL_PROOF_ELEMENTS — the batch aggregate. A
    // single execution carries ONE proof, and the module caps that at
    // MAX_SINGLE_PROOF_ELEMENTS = 8, so the literal was 4x looser than the constraint it
    // claimed to track: proofs of 9..32 elements passed the local pre-flight, consumed a
    // signature, and reverted on-chain. Parsing the source makes the alignment structural —
    // if either side changes, this fails.
    const src = readFileSync(
      join(ROOT, "contracts", "src", "SessionKey7579Module.sol"),
      "utf8",
    );
    const single = /MAX_SINGLE_PROOF_ELEMENTS\s*=\s*(\d+)/.exec(src);
    expect(single, "MAX_SINGLE_PROOF_ELEMENTS not found in SessionKey7579Module.sol").not.toBeNull();
    expect(MAX_MERKLE_PROOF_ELEMENTS).toBe(Number(single![1]));
  });
});

describe("validateAgainstScope never throws, as its docblock promises", () => {
  // The docblock states it plainly: "Never throws: every rejection comes back as
  // `{ ok: false, reason }`, so a caller can branch without a try/catch." A non-string
  // merkleProof element arriving from JSON made `sortedPairHash` call `.toLowerCase()` on a
  // number or null, and the TypeError propagated straight out — so a caller following the
  // documented contract got an exception instead of a policy decision.
  const now = Math.floor(Date.now() / 1000);
  const request = {
    agentId: ("0x" + "22".repeat(32)) as Hash,
    target: ("0x" + "33".repeat(20)) as Address,
    selector: "0xdeadbeef" as Hex,
    value: 0n, nonce: 0n, expiry: now + 600,
    rationaleHash: ("0x" + "44".repeat(32)) as Hash,
    data: "0x" as Hex,
  };
  // A REAL two-leaf tree, so the walk actually reaches every element rather than
  // short-circuiting on a root mismatch.
  const leaf = targetLeaf(request.target, request.selector);
  const sibling = ("0x" + "ee".repeat(32)) as Hash;
  const scope: Scope = {
    expiresAt: now + 3600, windowSeconds: 600, perActionCap: 1000n, perWindowCap: 1000n,
    merkleRoot: merkleRoot([leaf, sibling]), countersignAbove: 0n,
    enforceNativeDelta: false, tokenWatchlist: [],
  };
  const good = merkleProof([leaf, sibling], leaf);

  it("still accepts a valid proof", () => {
    expect(validateAgainstScope({ request, scope, merkleProof: good }).ok).toBe(true);
  });

  it("returns ok:false — never throws — for a non-string proof element", () => {
    for (const bad of [[7], [null], [undefined], [{}], [1n], [true]]) {
      const result = validateAgainstScope({
        request, scope, merkleProof: bad as unknown as Hex[],
      });
      // String(), not JSON.stringify(): one of the cases is a BigInt, and JSON.stringify
      // throws on BigInt — which would fail the test for the wrong reason.
      expect(result.ok, String(bad)).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/merkle proof element 0 is not a hex string/);
    }
  });

  it("names the offending index, not just the fact", () => {
    const result = validateAgainstScope({
      request, scope, merkleProof: [good[0]!, 5] as unknown as Hex[],
    });
    expect(result.ok === false && result.reason).toMatch(/element 1/);
  });

  it("does not throw when the proof itself is absent or empty", () => {
    expect(validateAgainstScope({ request, scope }).ok).toBe(false);
    expect(validateAgainstScope({ request, scope, merkleProof: [] }).ok).toBe(false);
  });
});

describe("SEC-13 · calldata is bounded at the parse boundary", () => {
  // `data` was the only unbounded field on ActionRequest, and `actionRequestDigest` keccaks
  // the whole payload. Measured on this toolchain, 512 KB hashed in ~30 ms and 1 MB in
  // ~60 ms, so an unbounded field let one request stall the caller's event loop for a
  // minute — before any scope check, because hashing is what the digest does.
  const base = {
    agentId: ("0x" + "11".repeat(32)) as Hash,
    target: ("0x" + "22".repeat(20)) as Address,
    selector: "0xdeadbeef" as Hex,
    value: 0n,
    nonce: 0n,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    rationaleHash: ("0x" + "33".repeat(32)) as Hash,
  };
  const withData = (bytes: number) => ({ ...base, data: ("0x" + "ab".repeat(bytes)) as Hex });

  it("accepts calldata exactly at the bound", () => {
    expect(parseActionRequest(withData(MAX_CALLDATA_BYTES)).data).toHaveLength(2 + MAX_CALLDATA_BYTES * 2);
  });

  it("rejects calldata one byte over the bound", () => {
    expect(() => parseActionRequest(withData(MAX_CALLDATA_BYTES + 1))).toThrow(/calldata bound/);
  });

  it("rejects a grossly oversized payload rather than hashing it", () => {
    // 1 MiB — the size the review measured at ~60 ms of keccak per call.
    expect(() => parseActionRequest(withData(1024 * 1024))).toThrow(/calldata bound/);
  });

  it("does not reject realistic agent calldata", () => {
    // The bound must be a DoS backstop, not a policy limit: an approve/swap/permit is
    // hundreds of bytes. If this ever fails, MAX_CALLDATA_BYTES has been set too low.
    for (const bytes of [0, 4, 68, 100, 512, 4096]) {
      expect(parseActionRequest(withData(bytes)).data).toBeDefined();
    }
  });

  it("still rejects malformed hex before considering the size", () => {
    expect(() => parseActionRequest({ ...base, data: "0xzz" as Hex })).toThrow(/even-length hex/);
  });
});

describe("DEBT/SEC-18e · assertBigInt refuses unsafe integers", () => {
  it("rejects a number past the safe-integer range", () => {
    expect(() => assertBigInt(2 ** 53, "perActionCap")).toThrow(ValidationError);
    expect(() => assertBigInt(2 ** 53, "perActionCap")).toThrow(
      /number exceeds safe integer range; pass a decimal string/,
    );
  });

  it("accepts the same value as a decimal string — the documented workaround", () => {
    expect(assertBigInt((2 ** 53).toString(), "perActionCap")).toBe(2n ** 53n);
    expect(assertBigInt("9007199254740993", "perActionCap")).toBe(9007199254740993n);
  });

  it("still accepts every value inside the safe-integer boundary", () => {
    // Off-by-one check: 2^53-1 is exactly representable and must keep working. Note the
    // safe range is +/-(2^53-1), so -(2^53) is NOT safe either.
    expect(assertBigInt(2 ** 53 - 1, "v")).toBe(9007199254740991n);
    expect(assertBigInt(-(2 ** 53 - 1), "v")).toBe(-9007199254740991n);
    expect(assertBigInt(5, "v")).toBe(5n);
  });

  it("rejects a JSON-round-tripped cap that would otherwise be silently rounded", () => {
    // The realistic path: an LLM emits 9007199254740993 as a JSON number. JSON.parse hands
    // back 9007199254740992 — one wei short, with nothing thrown, which is precisely the
    // silent one-directional error that broke the exact-quota promise.
    const requested = 9007199254740993n;
    const roundTripped: number = JSON.parse(JSON.stringify({ cap: Number("9007199254740993") })).cap;
    expect(BigInt(roundTripped)).not.toBe(requested);
    expect(() => assertBigInt(roundTripped, "cap")).toThrow(ValidationError);
  });
});
