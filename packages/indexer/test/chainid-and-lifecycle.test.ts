/**
 * Chain identity (SEC-15) and indexing lifecycle (BUG-16, BUG-17).
 *
 * These three defects shared a theme: *silent* misbehaviour on the path that produces
 * audit rows. A cross-chain `--rpc` mismatch stored rows under the wrong chain id, an
 * explicit `--to` skipped the short-chain guard, and `stop()` could not interrupt an
 * in-flight sleep. In each case the process reported success while the audit trail was
 * wrong, empty, or still running.
 *
 * The stubs here are the "misconfigured operator" made executable: a client whose
 * `eth_chainId` disagrees with the indexer's configured chain, and a chain too short for
 * the requested range. Assertions therefore target *absence of effect* — no rows, no cursor
 * movement, a bounded shutdown — rather than just the thrown message.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex, type Address, type Hash, type Hex, type Log, type PublicClient } from "viem";
import { SigilIndexer, isCanonicalInt64Decimal } from "../src/indexer.js";
// P0-3: `silentLogger` and `Logger` are both logger symbols -> `/logger` subpath.
import { silentLogger, type Logger } from "@sigilkit/core/logger";

const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const TARGET = "0x0000000000000000000000000000000000009001" as const;
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const MANAGER = "0x0000000000000000000000000000000000000042" as Address;
/** Anvil's default — the value that makes a mis-pointed `--rpc` hardest to notice. */
const CHAIN = 31337;
/** Base mainnet, the chain the SEC-15 report used as the "wrong chain" example. */
const OTHER_CHAIN = 8453;

/** Deterministic, self-describing block hash for a height (distinct per block). */
function blockHashFor(n: bigint): Hash {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hash;
}

/** A log shaped exactly like ActionLogger.ActionLogged's on-chain output. */
function actionLog(opts: { value: bigint; ts: number; txHash: string; blockNumber: bigint }): Log {
  return {
    address: MANAGER,
    topics: [
      keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")),
      pad(AGENT),
      pad(TARGET),
      pad(SELECTOR),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [opts.value, RATIONALE, BigInt(opts.ts)],
    ),
    blockNumber: opts.blockNumber,
    transactionHash: opts.txHash as Hash,
    blockHash: blockHashFor(opts.blockNumber),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as Log;
}

interface StubOptions {
  /** What this endpoint reports over `eth_chainId` — the value SEC-15 reads. */
  chainId?: number;
  /** Throw from `eth_chainId` instead of answering (an endpoint that cannot identify itself). */
  chainIdThrows?: boolean;
  /** Record every `eth_chainId` call, to assert *where* the check happens. */
  onChainId?: (n: number) => void;
}

/**
 * A PublicClient double that serves a self-consistent chain.
 *
 * Deliberately, every log it returns matches the header at its own height and the end
 * header is stable across a fetch — i.e. it passes every pre-existing integrity check in
 * `fetchRangeWithStableEnd`. That is the whole point: it isolates chain *identity* as the
 * only thing that can still reject it. A stub that were merely broken would prove nothing,
 * since the existing hash/membership checks would reject it for unrelated reasons.
 */
function stubChain(logs: Log[], head: bigint, opts: StubOptions = {}): PublicClient {
  return {
    getChainId: async () => {
      opts.onChainId?.(opts.chainId ?? CHAIN);
      if (opts.chainIdThrows) throw new Error("eth_chainId not supported by this endpoint");
      return opts.chainId ?? CHAIN;
    },
    getBlockNumber: async () => head,
    getBlock: async (a: { blockNumber?: bigint }) => {
      const n = a.blockNumber ?? head;
      return { number: n, hash: blockHashFor(n), parentHash: blockHashFor(n > 0n ? n - 1n : 0n) } as unknown;
    },
    getLogs: async (a: { fromBlock?: bigint; toBlock?: bigint }) =>
      logs.filter(
        (l) =>
          (l.blockNumber ?? 0n) >= (a.fromBlock ?? 0n) && (l.blockNumber ?? 0n) <= (a.toBlock ?? head),
      ),
  } as unknown as PublicClient;
}

/** Records every `warn`/`error` call so "did it say anything?" is an assertion, not a vibe. */
function recordingLogger(): { log: Logger; warns: string[]; texts: () => string } {
  const warns: string[] = [];
  const record = (message: string, fields?: Record<string, unknown>): void => {
    warns.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const log: Logger = {
    level: "info",
    scope: "test",
    debug: () => {},
    info: () => {},
    warn: record,
    error: record,
    child: () => log,
  };
  return { log, warns, texts: () => warns.join("\n") };
}

// ── SEC-15: cross-chain misconfiguration must fail closed ──────────────────────

describe("SEC-15 — a mis-pointed RPC cannot write rows under the wrong chain", () => {
  it("refuses to index when the endpoint's chain id is not the configured one", async () => {
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    try {
      // The attack from the report: --rpc points at Base, --chain-id stays at Anvil's
      // default. The logs are internally consistent *for Base*, so every hash check below
      // would have passed and stamped 31337 onto Base's events.
      const logs = [actionLog({ value: 10n ** 16n, ts: 1_700_000_000, txHash: "0x" + "a1".repeat(32), blockNumber: 5n })];
      const client = stubChain(logs, 10n, { chainId: OTHER_CHAIN });

      await expect(ix.backfill(client, MANAGER)).rejects.toThrow(
        new RegExp(`RPC endpoint reports chain id ${OTHER_CHAIN}.*configured for chain ${CHAIN}`),
      );

      // Fail-closed means *no effect*, not just an error message: not one row, and the
      // cursor must not have been created — otherwise the next run would skip blocks.
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.spendByAgent(AGENT)).toBe(0n);
      expect(ix.chainIds()).toEqual([]);
      expect(ix.getCursor(MANAGER)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("does not misattribute rows that were already indexed from the right chain", async () => {
    // The dangerous shape is a *silent* misattribution inside an existing database: the
    // audit store holds genuine chain-8453 events, then a run points at a 8453 endpoint
    // while the store is keyed to 31337. The new rows would be invisible to the very
    // query an auditor runs. Nothing new may be written.
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    try {
      const logs = [actionLog({ value: 3n, ts: 1, txHash: "0x" + "b1".repeat(32), blockNumber: 1n })];
      expect(await ix.backfill(stubChain(logs, 1n, { chainId: CHAIN }), MANAGER, 1n, 1n)).toBe(1);
      const cursorBefore = ix.getCursor(MANAGER);

      const more = [...logs, actionLog({ value: 99n, ts: 2, txHash: "0x" + "b2".repeat(32), blockNumber: 2n })];
      await expect(ix.backfill(stubChain(more, 2n, { chainId: OTHER_CHAIN }), MANAGER)).rejects.toThrow(/chain id/);

      // Only the legitimate chain-31337 row survives, still under 31337.
      expect(ix.actionsForAgent(AGENT)).toHaveLength(1);
      expect(ix.spendByAgent(AGENT)).toBe(3n);
      expect(ix.chainIds()).toEqual([CHAIN]);
      // The false-negative auditor would have run: it must still come back empty.
      expect(ix.actionsForAgent(AGENT, OTHER_CHAIN)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toEqual(cursorBefore);
    } finally {
      ix.close();
    }
  });

  it("refuses an endpoint that cannot report its chain id", async () => {
    // Fail-closed includes "unknown". An endpoint that will not answer eth_chainId cannot
    // be shown to be the intended chain, and assuming it matches is the exact assumption
    // SEC-15 exists to remove.
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    try {
      const logs = [actionLog({ value: 1n, ts: 1, txHash: "0x" + "c1".repeat(32), blockNumber: 1n })];
      await expect(
        ix.backfill(stubChain(logs, 1n, { chainIdThrows: true }), MANAGER, 1n, 1n),
      ).rejects.toThrow(/cannot determine the chain identity/);
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("asks the endpoint before any log is fetched, and only once it agrees", async () => {
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    try {
      // Ordering matters: identity must be settled *before* the (expensive, ambiguous) log
      // fetch, so a mismatch costs one round trip instead of a full range scan.
      const asked: number[] = [];
      const logs = [actionLog({ value: 1n, ts: 1, txHash: "0x" + "d1".repeat(32), blockNumber: 1n })];
      const client = stubChain(logs, 1n, { chainId: CHAIN, onChainId: (n) => asked.push(n) });
      expect(await ix.backfill(client, MANAGER, 1n, 1n)).toBe(1);
      expect(asked).toEqual([CHAIN]);

      // A later run against a mis-pointed endpoint is refused. The range is given
      // explicitly so the call is guaranteed to reach the fetch path: with the cursor
      // already at the head, an omitted range would be a legitimate empty no-op and would
      // never ask the endpoint anything.
      const mismatched = stubChain(logs, 10n, { chainId: OTHER_CHAIN, onChainId: (n) => asked.push(n) });
      await expect(ix.backfill(mismatched, MANAGER, 2n, 10n)).rejects.toThrow(/chain id/);
      expect(asked).toEqual([CHAIN, OTHER_CHAIN]);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(1);
    } finally {
      ix.close();
    }
  });

  it("checks identity on every watch tick, so a mid-run chain swap cannot land", async () => {
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, backoffMs: 1, logger: silentLogger() });
    let stop: (() => Promise<void>) | undefined;
    try {
      const logs = [actionLog({ value: 7n, ts: 1, txHash: "0x" + "e1".repeat(32), blockNumber: 1n })];
      // A watch loop must not become a bypass for the check backfill performs: the same
      // mis-pointed endpoint is refused on every tick that would fetch logs.
      const client = stubChain(logs, 5n, { chainId: OTHER_CHAIN });
      stop = ix.watch(client, MANAGER, 5);
      await vi.advanceTimersByTimeAsync(50);

      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.spendByAgent(AGENT)).toBe(0n);
      // The cursor must not have advanced either: a refused tick writes nothing, so a
      // later run still starts from the same place rather than skipping the range.
      expect(ix.getCursor(MANAGER)).toBeNull();
    } finally {
      await stop?.();
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      ix.close();
    }
  });
});

// ── BUG-16: an explicit --to must not skip the short-chain guard ────────────────

describe("BUG-16 — a short chain is refused whether or not --to was passed", () => {
  it("throws on an explicit --to above the head instead of silently storing nothing", async () => {
    // Before the fix the guard was conditioned on `toBlock === undefined`, so `--to 100`
    // on a head-5 chain walked straight past it: the run reported "stored 0 event(s)", a
    // normal summary, and exit code 0.
    const ix = new SigilIndexer(":memory:", CHAIN); // default confirmations: 12
    try {
      const logs = [actionLog({ value: 1n, ts: 1, txHash: "0x" + "f1".repeat(32), blockNumber: 4n })];
      await expect(ix.backfill(stubChain(logs, 5n), MANAGER, 0n, 100n)).rejects.toThrow(
        /chain head 5 is at or below confirmations \(12\)/,
      );
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("says so in the error when the operator pinned --to, naming both ids", async () => {
    const ix = new SigilIndexer(":memory:", CHAIN); // default confirmations: 12
    try {
      await expect(ix.backfill(stubChain([], 5n), MANAGER, 0n, 100n)).rejects.toThrow(
        /Requested --to 100/,
      );
    } finally {
      ix.close();
    }
  });

  it("still honours an explicit --to on a chain long enough to support it", async () => {
    // The fix must not turn a legitimate explicit range into a refusal: with the default
    // confirmations of 12, head 100 comfortably clears the guard, so `--to 40` proceeds.
    const ix = new SigilIndexer(":memory:", CHAIN, { logger: silentLogger() });
    try {
      const logs = [
        actionLog({ value: 2n, ts: 1, txHash: "0x" + "1a".repeat(32), blockNumber: 10n }),
        actionLog({ value: 3n, ts: 2, txHash: "0x" + "1b".repeat(32), blockNumber: 20n }),
      ];
      expect(await ix.backfill(stubChain(logs, 100n), MANAGER, 0n, 40n)).toBe(2);
      expect(ix.spendByAgent(AGENT)).toBe(5n);
      expect(ix.getCursor(MANAGER)?.lastBlock).toBe(40);
    } finally {
      ix.close();
    }
  });

  it("warns loudly about an inverted range instead of returning 0 in silence", async () => {
    // `return 0` with no log is what the report called "silent": the operator saw
    // "backfill stored 0 event(s)" plus a summary and exit code 0, with nothing to tell
    // them the range was nonsense.
    const { log, texts } = recordingLogger();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: log });
    try {
      const stored = await ix.backfill(stubChain([], 200n), MANAGER, 100n, 50n);
      expect(stored).toBe(0);
      const warnings = texts();
      expect(warnings).toMatch(/range is empty/i);
      expect(warnings).toMatch(/below the start/i);
      // The actual from/to must be present so the operator can see which flag was wrong.
      expect(warnings).toContain('"from":"100"');
      expect(warnings).toContain('"to":"50"');
      // Still no rows and no cursor movement — a warning is a diagnosis, not a licence.
      expect(ix.actionsForAgent(AGENT)).toHaveLength(0);
      expect(ix.getCursor(MANAGER)).toBeNull();
    } finally {
      ix.close();
    }
  });

  it("still explains a range clipped by confirmations, without claiming a --to", async () => {
    // The pre-existing branch is preserved, so an operator on a short local chain is still
    // told about confirmations rather than being sent to debug a --to they never passed.
    // Head 30 clears the short-chain guard (30 > 20) but `from` sits high enough that
    // start + confirmations > head, which is the distinct "clipped" case.
    const { log, texts } = recordingLogger();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 20, logger: log });
    try {
      expect(await ix.backfill(stubChain([], 30n), MANAGER, 25n, undefined)).toBe(0);
      const warnings = texts();
      expect(warnings).toMatch(/head is below start \+ confirmations/i);
      expect(warnings).toMatch(/--confirmations 0/);
      // The clipped case must not borrow the explicit-range wording.
      expect(warnings).not.toMatch(/below the start/i);
    } finally {
      ix.close();
    }
  });
});

// ── BUG-17: stop() must interrupt an in-flight sleep ───────────────────────────

describe("BUG-17 — stop() interrupts the in-flight poll interval", () => {
  it("exits far sooner than pollMs when stopped during a sleep", async () => {
    // The regression, stated as a bound: pollMs is 60s, so a loop that cannot be
    // interrupted keeps the process alive for a minute. The fix must make the observable
    // shutdown time a small fraction of the interval. Real timers are used on purpose —
    // fake timers would advance the very sleep whose cancellation is under test.
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, backoffMs: 1, logger: silentLogger() });
    const stop = ix.watch(stubChain([], 10n), MANAGER, 60_000);
    try {
      // Let the first tick complete so the loop is parked inside its 60s sleep.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const started = Date.now();
      await stop();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await stop();
      ix.close();
    }
  });

  it("is idempotent and safe to call without awaiting, as the CLI does", async () => {
    // `cli.ts` calls `stop()` fire-and-forget and then immediately resolves into
    // `finally { indexer.close() }`. The disposer must therefore tolerate a bare call,
    // repeated calls, and being called before the loop has even started a tick.
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    const stop = ix.watch(stubChain([], 10n), MANAGER, 60_000);
    try {
      stop();
      stop();
      await expect(stop()).resolves.toBeUndefined();
    } finally {
      await stop();
      ix.close();
    }
  });

  it("stays stopped once asked, instead of restarting on the next tick", async () => {
    // The original defect was a `stopped` flag read only at the loop edge. The loop must
    // not resume polling after a stop, even if a tick was already past its sleep.
    // `getBlockNumber` runs on *every* tick, so its call count is the direct measure of
    // "is the loop still turning?".
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, logger: silentLogger() });
    let stop: (() => Promise<void>) | undefined;
    try {
      let ticks = 0;
      const base = stubChain([], 10n, { chainId: CHAIN });
      const client = {
        ...base,
        getBlockNumber: async () => {
          ticks++;
          return base.getBlockNumber();
        },
      } as unknown as PublicClient;

      stop = ix.watch(client, MANAGER, 5);
      await vi.advanceTimersByTimeAsync(30);
      const whileRunning = ticks;
      expect(whileRunning).toBeGreaterThan(0);

      await stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(ticks).toBe(whileRunning);
    } finally {
      await stop?.();
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      ix.close();
    }
  });

  it("actually waits pollMs between ticks instead of spinning", async () => {
    // The regression this pins: `sleep(ms)` was written as `setTimeout(resolveFn)` with
    // the delay argument never passed, so every poll fired at 0ms and the watch loop
    // hammered the RPC endpoint ~pollMs times faster than configured. The earlier cases
    // above cannot catch it — they use pollMs of 5-60_000 and pass under a spinning loop
    // too. The distinguishing measurement is tick COUNT in a window shorter than pollMs.
    vi.useFakeTimers();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, backoffMs: 1, logger: silentLogger() });
    let stop: (() => Promise<void>) | undefined;
    try {
      let ticks = 0;
      const base = stubChain([], 10n, { chainId: CHAIN });
      const client = {
        ...base,
        getBlockNumber: async () => {
          ticks++;
          return base.getBlockNumber();
        },
      } as unknown as PublicClient;

      const POLL_MS = 60_000;
      stop = ix.watch(client, MANAGER, POLL_MS);
      // Let the first tick land, so the loop is parked inside its sleep.
      await vi.advanceTimersByTimeAsync(10);
      const afterFirstTick = ticks;
      expect(afterFirstTick).toBeGreaterThan(0);

      // Half of one poll interval: a loop that honours pollMs cannot have ticked again.
      await vi.advanceTimersByTimeAsync(POLL_MS / 2);
      expect(ticks).toBe(afterFirstTick);
    } finally {
      await stop?.();
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      ix.close();
    }
  });

  it("does not report a stop-in-progress as a poll failure", async () => {
    // The catch-all in the loop logs and backs off. If shutdown raced an in-flight tick,
    // a Ctrl+C would produce a scary "poll failed; backing off" line and then wait out the
    // backoff before exiting. A stop must short-circuit that path.
    const { log, texts } = recordingLogger();
    const ix = new SigilIndexer(":memory:", CHAIN, { confirmations: 0, backoffMs: 60_000, logger: log });
    const stop = ix.watch(stubChain([], 10n), MANAGER, 60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stop();
      expect(texts()).not.toMatch(/poll failed/i);
    } finally {
      await stop();
      ix.close();
    }
  });
});

// ── the SQL aggregation precondition (PERF-02) ────────────────────────────────────────────

describe("isCanonicalInt64Decimal — the predicate SQLite cannot express", () => {
  // Each rejection below is a shape SQLite's own coercions ACCEPT. Verified against
  // node:sqlite: `'1e3' GLOB '[0-9]*'` is true, `'0x10' GLOB '[0-9]*'` is true, and
  // `CAST('007' AS INTEGER) = 7` compares EQUAL. A probe built on any of those lets a
  // store holding such a value take the SUM path and report a number nobody wrote.
  it.each([
    ["leading zeros", "007"],
    ["exponent form", "1e3"],
    ["hex form", "0x10"],
    ["trailing junk", "9a"],
    ["digit separators", "1_000"],
    ["negative", "-5"],
    ["empty", ""],
    ["whitespace padded", " 10"],
    ["plus-signed", "+10"],
    ["past INT64_MAX", "9223372036854775808"],
    ["far past INT64_MAX", "18446744073709551616"],
  ])("rejects %s", (_label, value) => {
    expect(isCanonicalInt64Decimal(value)).toBe(false);
  });

  it.each([
    ["zero", "0"],
    ["small", "7"],
    ["ordinary wei", "1000000000000000000"],
    ["1 ETH", "1000000000000000000"],
    ["INT64_MAX exactly", "9223372036854775807"],
  ])("accepts %s", (_label, value) => {
    expect(isCanonicalInt64Decimal(value)).toBe(true);
  });

  // The specific regression: a digit-count ceiling (the earlier `length(value) > 18`)
  // classified every legitimate value at or above 1 ETH as unsafe, permanently routing
  // high-spend agents — the ones this aggregation exists to serve — onto the slow path.
  it("does not reject legitimate values at or above 1 ETH", () => {
    expect(isCanonicalInt64Decimal("1000000000000000000")).toBe(true);
    expect(isCanonicalInt64Decimal("5000000000000000000")).toBe(true);
  });
});
