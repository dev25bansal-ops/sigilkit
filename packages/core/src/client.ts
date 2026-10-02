import type {
  ActionRequest,
  PreparedExecutionFields,
  Scope,
  SigilKitCheck,
} from "./types.js";
import {
  parseActionRequest,
  signActionRequest,
  validateAgainstScope,
  type HashSigner,
} from "./signing.js";
import {
  decodeSigilKitError,
  decorateWithDecodedRevert,
  walkRevertData,
  AuditAmbiguousError,
  AuditMissingError,
  ExecutionRevertedError,
  GuardMissingError,
  LeaseBusyError,
  LeaseInvalidError,
  PolicyRejectedError,
  ReceiptTimeoutError,
  SigilKitError,
  SimulationRevertedError,
} from "./errors.js";
import { ACTION_LOGGER_ABI } from "./abis.js";
import { createLogger, type Logger } from "./logger.js";
import { assertAddress, ValidationError } from "./validation.js";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";

/**
 * Receipt-wait bound (PERF-10). viem's `waitForTransactionReceipt` polls
 * `eth_getTransactionReceipt` **forever** unless a `timeout` is supplied, and a pending
 * poll never rejects — so a transaction replaced by another one on the same nonce (exactly
 * the failure mode this SDK's strictly-increasing session-key nonces invite) would hang the
 * await indefinitely. `sendPrepared`'s catch only sees rejections, so a hang would never
 * surface: the relayer slot stays occupied and, because `NonceGate` serializes per key, every
 * later execution for that key blocks behind it.
 *
 * The wait is therefore bounded. Note the ceiling is the timeout, not the counts: `pollingInterval`
 * sets the block-polling cadence, while `retryCount` feeds viem's EXPONENTIAL backoff
 * (`~~(1 << count) * 200` ms) applied to the replacement-detection lookups.
 */
const RECEIPT_TIMEOUT_MS = 120_000;
const RECEIPT_RETRY_COUNT = 30;
const RECEIPT_POLLING_INTERVAL_MS = 2_000;

/** Minimal ABI surface of SessionKeyManager used by the SDK. */
export const SESSION_KEY_MANAGER_ABI = [
  {
    name: "executeWithSessionKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "agentId", type: "bytes32" },
          { name: "target", type: "address" },
          { name: "selector", type: "bytes4" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint48" },
          { name: "rationaleHash", type: "bytes32" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "merkleProof", type: "bytes32[]" },
      { name: "ownerApproval", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "grantSessionKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "address" },
      {
        name: "scope",
        type: "tuple",
        components: [
          { name: "expiresAt", type: "uint48" },
          { name: "windowSeconds", type: "uint48" },
          { name: "perActionCap", type: "uint256" },
          { name: "perWindowCap", type: "uint256" },
          { name: "merkleRoot", type: "bytes32" },
          { name: "countersignAbove", type: "uint256" },
          { name: "enforceNativeDelta", type: "bool" },
          { name: "tokenWatchlist", type: "address[]" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    // ABI-02: this must be ONE tuple output, not two flat ones. The contract is
    //   `function getWindowState(address key) external view returns (SpendPolicy.WindowState memory)`
    //   (SessionKeyManager.sol:503) — a single `struct SpendPolicy.WindowState` with the
    //   two fields below, which is exactly what `abis/SessionKeyManager.json` declares.
    //
    //   The two shapes happen to be byte-compatible for a 2-field struct, so the wrong
    //   declaration "worked" and nothing caught it. But viem's struct decoding is
    //   LENGTH-TOLERANT: if `WindowState` ever gains a field, the extra word is silently
    //   ignored and BOTH shapes still decode without error — so this comment is a
    //   correctness fix, NOT a drift detector. The real guard is `abi-drift.test.ts`,
    //   which must include this hand-written fragment (subset-containment form).
    //
    //   Do NOT "simplify" this back to two flat outputs. The other getWindowState in the
    //   repo (`SessionKey7579Module.sol:523`) really does return (uint48, uint256) — that
    //   is the shape this one was mistakenly copied from, and they are different functions.
    name: "getWindowState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct SpendPolicy.WindowState",
        components: [
          { name: "windowStart", type: "uint48" },
          { name: "spentThisWindow", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "DOMAIN_SEPARATOR",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

export interface SigilKitClientConfig {
  /** Deployed SessionKeyManager address. */
  managerAddress: Address;
  chain: Chain;
  /** Optional custom RPC URL; defaults to the chain's public RPCs. */
  rpcUrl?: string;
  /**
   * Optional pre-built viem PublicClient. When supplied it is used verbatim, which
   * lets callers provide a batching/fallback transport (see `fallback([...])`) or a
   * stubbed client in tests. Takes precedence over `rpcUrl`.
   */
  publicClient?: PublicClient;
  /**
   * Optional cross-process lease store backing {@link NonceGate} (ARCH-6). Supply one when
   * several processes on the same host may share a session key — see
   * `@sigilkit/core/lease-fs` for a dependency-free implementation. For a distributed
   * fleet, implement {@link LeaseStore} over a real lock service. When set, executions
   * MUST run inside `nonceGate.run` and forward its guard (fail-closed at the sign/send
   * boundaries).
   */
  leaseStore?: LeaseStore;
  /**
   * Lease TTL in ms used by {@link NonceGate} for owned stores (default 30_000, renewed
   * at half-TTL). This is an operator ceiling, not a derived bound: a holder that cannot
   * renew within it loses the lease to a waiting worker.
   */
  leaseTtlMs?: number;
  /**
   * Where advisory diagnostics go (a degraded window pre-check, a swallowed decode
   * failure). Defaults to a console logger at `info`; pass `silentLogger()` to keep
   * library use quiet.
   */
  logger?: Logger;
  /**
   * Chain id the caller believes it is talking to, typically
   * `loadServiceConfig(env).chainId` (the `SIGILKIT_CHAIN_ID` variable). When supplied it
   * is compared against `chain.id` and a mismatch throws at construction.
   *
   * Why this exists: `chain.id` is what `prepareExecution` puts in the EIP-712 domain, and
   * the chain is the sole authority on the domain separator. A `chain` object whose `id`
   * disagrees with the operator's configured `SIGILKIT_CHAIN_ID` therefore produced a
   * perfectly well-formed signature over the WRONG domain — the request is rejected on-chain
   * (`InvalidSignature`) after the gas is spent, with no error anywhere in the SDK. The two
   * values come from different places (a viem `Chain` literal vs. the environment), so
   * nothing else in the process would ever have compared them.
   *
   * Optional and off by default, so an existing caller is unaffected; supply it to turn a
   * silent mis-signing into a startup failure.
   */
  expectedChainId?: number;
}

/** Arguments accepted by {@link SigilKitClient.prepareExecution}. */
/**
 * Arguments for {@link SigilKitClient.prepareExecution}.
 *
 * Named explicitly rather than derived with `Parameters<…>[0]`: the derived form
 * printed as an anonymous structural type in editor tooltips and in generated docs,
 * which made the shape impossible to reference, alias, or extend. Deriving it also
 * coupled the public type to the method signature, so any change to the method
 * silently changed the type other packages import.
 */
export interface PrepareExecutionArgs {
  /** The session key that will sign. Needs `sign` plus its own `address` (used as the on-chain key). */
  account: HashSigner & { address: Address };
  /**
   * The action to authorize. `nonce` may be omitted, in which case the current
   * on-chain `getNonce` is fetched at prepare time — the recommended form, because a
   * stale cached nonce is the one mistake that costs gas.
   */
  request: Omit<ActionRequest, "nonce"> & { nonce?: bigint };
  /** The granted scope to check against. Treated as read-only. */
  scope: Scope;
  /** Sorted-pair Merkle proof; required when `scope.merkleRoot` is non-zero. */
  merkleProof?: Hex[];
  /** E10: owner countersignature, required when value exceeds `scope.countersignAbove`. */
  ownerApproval?: Hex;
}

/**
 * The signed, relayer-ready payload produced by `prepareExecution`. Pass this straight
 * to `sendPrepared` / `simulateExecution` to avoid re-running the pre-flight (PERF-3):
 * the recommended simulate-then-execute flow used to fetch the nonce and window state
 * twice, doubling pre-flight RPC cost and widening the nonce race between the two reads.
 */
export type PreparedExecution = PreparedExecutionFields & { to: Address; data: Hex };

/** True when a value is an already-prepared payload rather than fresh prepare args. */
function isPreparedExecution(v: PrepareExecutionArgs | PreparedExecution): v is PreparedExecution {
  const o = v as Partial<PreparedExecution>;
  return typeof o.to === "string" && typeof o.data === "string" && o.signature !== undefined;
}

/**
 * Per-key execution serialization (issues catalog P1: strictly-sequential on-chain
 * nonces mean two concurrent executions from one session key both fetch the same
 * nonce and the loser reverts on-chain after gas is spent).
 *
 * Queue every step that must not interleave — prepare, sign, relay, confirm — for a
 * given key:
 *
 *   await client.nonceGate.run(args.account.address, (guard) =>
 *     client.execute(args, wallet, guard));
 *
 * Coordination is in-process only (the client stays stateless across machines); for
 * multi-process fleets, serialize per key upstream or use distinct keys per agent.
 * Failures do not poison the queue — the next run proceeds regardless.
 *
 * For MULTIPLE processes sharing one key, inject a cross-process {@link LeaseStore} via
 * `SigilKitClientConfig.leaseStore`: the gate then rejects runs that cannot take the lease
 * instead of racing, renews the lease at half-TTL while the callback runs, and hands the
 * callback an {@link ExecutionGuard} — call `await guard.assertCurrent()` immediately
 * before signing and again immediately before sending so a superseded holder refuses its
 * side effects. Two implementations ship today —
 *
 *  - `FileLeaseStore` (`@sigilkit/core/lease-fs`): SQLite-backed owner/epoch leases for
 *    several workers on ONE host, with TTL recovery after a crashed holder. Requires
 *    Node >= 24. Stop all v1 workers and start from an empty directory — v1 `.lock`
 *    directories are rejected, not migrated.
 *  - anything you write against this interface for a distributed fleet (Redis `SET key owner
 *    NX PX ttl` + check-and-delete release, etcd, orchestrator leader election). A shared
 *    filesystem is NOT a reliable cross-host mutex — use a real lock service.
 *
 * Limits (documented, not hidden): the guard is cooperative — it cannot preempt arbitrary
 * callback code, and once `sendTransaction` has been invoked a lost lease cannot unsend;
 * the on-chain nonce monotonicity remains an independent defense. Epochs increase
 * within the retained store, but are not distributed fencing tokens. Renewal requires
 * scheduler and I/O progress within TTL; a live process alone is insufficient.
 *
 * The documented default remains one distinct key per agent process.
 */
/** Capability for one acquisition. Never log the id; epochs are local to the store. */
export interface LeaseToken {
  readonly key: Address;
  readonly id: string;
  readonly epoch: number;
}

/** Version 2: adapters must implement atomic owner/epoch-conditioned operations. */
export interface LeaseStore {
  readonly version: 2;
  acquire(key: Address, ttlMs: number): LeaseToken | null | Promise<LeaseToken | null>;
  renew(token: LeaseToken, ttlMs: number): boolean | Promise<boolean>;
  isCurrent(token: LeaseToken): boolean | Promise<boolean>;
  release(token: LeaseToken): boolean | Promise<boolean>;
}

export function assertLeaseTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10 || ttlMs > 2_147_483_647) {
    throw new Error("SigilKit: lease TTL must be an integer between 10 and 2147483647 ms");
  }
}

function leaseNow(ttlMs = 0): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlMs)) {
    throw new Error("SigilKit: invalid lease time arithmetic");
  }
  return now;
}

/**
 * Hard ceiling on the number of distinct session keys {@link InMemoryLeaseStore} will
 * remember an epoch for (P0-2). The epoch counter is what makes a released lease's token
 * permanently inert, so the counter must outlive the lease — but it must not be an
 * unbounded leak. This bounds it, and the bound is deliberately a CONFIGURED number with
 * a documented cost, not a silent growth curve.
 *
 * What is actually traded at the ceiling: the per-key epoch counter is forgotten, so a
 * token issued for that key *before* the eviction could, in principle, match a token
 * re-issued after it — but only after `maxKeys` OTHER distinct keys have been acquired
 * since. The nonce is a per-key counter with no such reset, so this is a strictly weaker
 * guarantee than the on-chain monotonicity that backs it, and it is why the default is
 * generous and why the option exists at all.
 *
 * 0 disables the bound (previous behaviour, unbounded).
 */
export const DEFAULT_MAX_LEASE_KEYS = 100_000;

/** Optional single-process owned lease store; the default gate uses only a local queue. */
export class InMemoryLeaseStore implements LeaseStore {
  readonly version = 2 as const;
  private held = new Map<Address, { id: string; epoch: number; expires: number }>();
  /**
   * Per-key epoch high-water mark, deliberately SEPARATE from {@link held} (P0-2).
   *
   * `held` is O(leases in flight) and is the only thing that should shrink on release.
   * This map is O(keys ever seen) and only ever grows. Keeping the counter here — rather
   * than as a tombstone row inside `held` — is what lets `release` delete its `held` row
   * outright, so `held` stops tracking released keys while the stale-token defence
   * survives. Any eviction bound applies HERE, to a plain number, not to a lease record.
   */
  private epochs = new Map<Address, number>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    const max = options.maxKeys ?? DEFAULT_MAX_LEASE_KEYS;
    if (!Number.isSafeInteger(max) || max < 0) {
      throw new Error("SigilKit: maxKeys must be a non-negative safe integer (0 = unbounded)");
    }
    this.maxKeys = max;
  }

  acquire(key: Address, ttlMs: number): LeaseToken | null {
    assertLeaseTtl(ttlMs);
    key = assertAddress(key, "key").toLowerCase() as Address;
    const now = leaseNow(ttlMs);
    const cur = this.held.get(key);
    if (cur && cur.expires > now) return null;
    // The epoch comes from the separate high-water map, NOT from `held`: that is what
    // lets a released lease delete its `held` row and still stay permanently superseded.
    const prior = this.epochs.get(key) ?? 0;
    if (prior >= Number.MAX_SAFE_INTEGER) throw new Error("SigilKit: lease epoch exhausted");
    const epoch = prior + 1;
    const token: LeaseToken = Object.freeze({
      key,
      id: crypto.randomUUID(),
      epoch,
    });
    this.rememberEpoch(key, epoch);
    this.held.set(key, { id: token.id, epoch, expires: now + ttlMs });
    return token;
  }

  /**
   * Records the per-key epoch high-water mark, evicting the oldest key once `maxKeys`
   * is reached.
   *
   * Recency is expressed by Map insertion order rather than a parallel array: `acquire`
   * is on the hot path of every execution, and an `indexOf`/`every` over a separate
   * ordering array would make each acquire O(maxKeys) — a far worse regression than the
   * leak this fixes. `Map` iterates in insertion order and `delete`+`set` moves a key to
   * the end in O(1), so a key that stays busy is never evicted out from under its own
   * live lease, and the whole method stays O(1) amortized.
   */
  private rememberEpoch(key: Address, epoch: number): void {
    this.epochs.delete(key); // re-insert below => newest position
    this.epochs.set(key, epoch);
    if (this.maxKeys === 0) return;
    while (this.epochs.size > this.maxKeys) {
      const oldest = this.epochs.keys().next();
      if (oldest.done) break;
      const k = oldest.value;
      if (this.held.has(k)) {
        // A key with a live lease must keep its counter: dropping it would let the next
        // acquire reuse an epoch that an in-flight token still carries. Rotate it to the
        // back and look at the next-oldest instead.
        const v = this.epochs.get(k) as number;
        this.epochs.delete(k);
        this.epochs.set(k, v);
        let anyIdle = false;
        for (const candidate of this.epochs.keys()) {
          if (!this.held.has(candidate)) { anyIdle = true; break; }
        }
        // Every remaining key is live: the bound cannot be honoured without evicting an
        // active lease, so exceed it rather than weaken the stale-token defence.
        if (!anyIdle) break;
        continue;
      }
      this.epochs.delete(k);
    }
  }

  renew(token: LeaseToken, ttlMs: number): boolean {
    assertLeaseTtl(ttlMs);
    const now = leaseNow(ttlMs);
    const cur = this.held.get(assertAddress(token.key, "token.key").toLowerCase() as Address);
    if (!cur || cur.id !== token.id || cur.epoch !== token.epoch || cur.expires <= now) {
      return false;
    }
    cur.expires = now + ttlMs;
    return true;
  }

  isCurrent(token: LeaseToken): boolean {
    const cur = this.held.get(assertAddress(token.key, "token.key").toLowerCase() as Address);
    return !!cur && cur.id === token.id && cur.epoch === token.epoch && cur.expires > Date.now();
  }

  release(token: LeaseToken): boolean {
    const key = assertAddress(token.key, "token.key").toLowerCase() as Address;
    const cur = this.held.get(key);
    if (!cur || cur.id !== token.id || cur.epoch !== token.epoch) return false;
    // P0-2: delete the `held` row outright. The stale-token defence does NOT live here —
    // it lives in `epochs`, which `release` never touches. A released token stays inert
    // because its epoch is below this key's high-water mark, so every later acquire gets
    // a strictly greater epoch and `isCurrent`/`renew`/`release` all reject it.
    //
    // This is what makes `held` O(leases in flight) instead of O(keys ever seen). The
    // previous tombstone ({ id: "", epoch, expires: 0 }) was the leak: nothing ever
    // removed those rows, so a long-lived process rotating session keys grew without limit.
    this.held.delete(key);
    return true;
  }
}

/**
 * Pre-side-effect fence handed to the {@link NonceGate.run} callback. Call
 * `await guard.assertCurrent()` immediately before signing and again immediately
 * before sending; it throws when the run's lease was lost (superseded by another
 * worker) or the run has already finished. This narrows the send window — it cannot
 * cancel a transaction that has already left the wallet.
 */
export interface ExecutionGuard {
  /** The canonical key the lease was acquired for (the session-key address). */
  readonly key: Address;
  /** Aborted on lease loss or run completion; cancellation is cooperative. */
  readonly signal: AbortSignal;
  /** Throws when the lease is no longer current. */
  assertCurrent(): Promise<void>;
}

export interface NonceGateOptions {
  /** Lease TTL in ms for owned stores. Default 30_000; renewed at half-TTL. */
  ttlMs?: number;
}

const SUPERSEDED = (key: string): string =>
  `SigilKit NonceGate: lease for key ${key} was lost (superseded by another worker); refusing further side effects`;

/**
 * One shared instance for "this guard outlived its run". A fresh error per call would
 * make `expect(...).rejects.toThrow(GuardMissingError)` needlessly unable to compare
 * identity, and the message is constant, so a single frozen instance is both cheaper
 * and easier to assert on.
 */
const GUARD_FINISHED = new GuardMissingError("SigilKit: execution guard used after its run finished");

type GuardState = { gate: NonceGate; submitted: boolean };
const guardStates = new WeakMap<ExecutionGuard, GuardState>();

/**
 * The run's cross-worker lease was lost (superseded by another worker), so the
 * SDK refused to produce further side effects.
 *
 * A {@link SigilKitError} (`code: "LEASE_LOST"`). Cancellation is cooperative: a
 * lease lost *after* `sendTransaction` has been invoked cannot unsend the
 * transaction, and the on-chain nonce monotonicity remains an independent defense.
 */
export class LeaseLostError extends SigilKitError {
  /** The session key whose lease was lost. */
  readonly key: Address;

  constructor(key: Address, options?: ErrorOptions) {
    super("LEASE_LOST", SUPERSEDED(key), options);
    this.name = "LeaseLostError";
    this.key = key;
  }
}

export class NonceGate {
  private chains = new Map<Address, Promise<unknown>>();

  constructor(
    private readonly leases?: LeaseStore,
    private readonly opts: NonceGateOptions = {},
  ) {
    // Fail closed BEFORE any callback can run: a key-only (v1) adapter cannot prove
    // which acquisition a release belongs to, so it must never be accepted silently.
    assertLeaseTtl(opts.ttlMs ?? 30_000);
    if (leases && (leases.version !== 2 ||
      [leases.acquire, leases.renew, leases.isCurrent, leases.release].some((method) => typeof method !== "function"))) {
      throw new LeaseInvalidError(
        "SigilKit NonceGate: lease store must implement the v2 token API (version: 2) — " +
          "key-only acquire/release cannot prove ownership and is rejected",
        { version: leases.version },
      );
    }
  }

  private ttl(): number {
    const ttl = this.opts.ttlMs ?? 30_000;
    assertLeaseTtl(ttl);
    return ttl;
  }

  run<T>(key: Address, fn: (guard: ExecutionGuard) => Promise<T>): Promise<T> {
    key = assertAddress(key, "key").toLowerCase() as Address;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const exec = async (): Promise<T> => {
      if (!this.leases) {
        const controller = new AbortController();
        const guard: ExecutionGuard = Object.freeze({
          key, signal: controller.signal,
          assertCurrent: async () => {
            if (controller.signal.aborted) {
              throw new GuardMissingError("SigilKit: execution guard used after its run finished");
            }
          },
        });
        guardStates.set(guard, { gate: this, submitted: false });
        try { return await fn(guard); }
        finally { controller.abort(); }
      }
      const store = this.leases;
      const ttl = this.ttl();
      // A lease that cannot be taken promptly is a real cross-worker concurrency
      // violation, not a transient state — fail loudly rather than race.
      const token = await store.acquire(key, ttl);
      if (!token) {
        throw new LeaseBusyError(key);
      }
      if (typeof token !== "object" || token.key !== key || typeof token.id !== "string" ||
        !token.id || !Number.isSafeInteger(token.epoch) || token.epoch < 1) {
        throw new LeaseInvalidError("SigilKit: invalid v2 lease token", token);
      }
      const owned = Object.freeze({ ...token });
      const controller = new AbortController();
      let loss: LeaseLostError | undefined;
      let finished = false;
      let stopped = false;
      let cancelSleep: (() => void) | undefined;
      const lose = (cause?: unknown): LeaseLostError => {
        loss ??= new LeaseLostError(key, { cause });
        controller.abort(loss);
        return loss;
      };
      const heartbeat = async (): Promise<void> => {
        while (!stopped && !loss) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              cancelSleep = undefined;
              resolve();
            }, Math.floor(ttl / 2));
            cancelSleep = () => {
              clearTimeout(timer);
              cancelSleep = undefined;
              resolve();
            };
          });
          if (stopped || loss) break;
          try {
            if (await store.renew(owned, ttl) !== true) lose();
          } catch (error) { lose(error); }
        }
      };
      const hb = heartbeat().catch((error: unknown) => { lose(error); });
      const guard: ExecutionGuard = Object.freeze({
        key, signal: controller.signal,
        assertCurrent: async (): Promise<void> => {
          if (finished) throw GUARD_FINISHED;
          if (loss) throw loss;
          try {
            if (await store.isCurrent(owned) !== true) throw lose();
          } catch (error) { throw lose(error); }
          if (finished) throw GUARD_FINISHED;
          if (loss) throw loss;
        },
      });
      const state: GuardState = { gate: this, submitted: false };
      guardStates.set(guard, state);
      let result!: T;
      let failed = false;
      let failure: unknown;
      try {
        result = await fn(guard);
        if (!state.submitted) await guard.assertCurrent();
      } catch (error) { failed = true; failure = error; }
      finally {
        finished = true;
        stopped = true;
        controller.abort();
        cancelSleep?.();
        await hb;
        try {
          if (await store.release(owned) !== true && !state.submitted && !failed) {
            failed = true; failure = lose();
          }
        } catch (error) {
          if (!failed) { failed = true; failure = error; }
        }
      }
      if (failed) {
        if (state.submitted) {
          // "attempted", not "sent": the flag is set before `sendTransaction` is awaited,
          // so this also covers a relayer that rejected locally (insufficient funds, bad
          // params) and therefore broadcast nothing. The SDK cannot tell those apart from a
          // relayer that DID broadcast and then failed to return a hash, and the asymmetry
          // matters: assuming "sent" only costs a wasted nonce, assuming "not sent" can
          // double-execute. Check `err.cause` for the relayer's own reason before retrying.
          throw new Error(
            "SigilKit: transaction submission was attempted but failed, so the outcome is unknown — " +
              "inspect the transaction/receipt state before retrying; the original error is the `cause`",
            { cause: failure },
          );
        }
        throw failure;
      }
      if (loss && !state.submitted) throw loss;
      return result;
    };
    const next = prev.then(exec, exec); // run regardless of the previous run's outcome
    const cleanup = (): void => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    };
    const settled = next.then(cleanup, cleanup);
    this.chains.set(key, settled);
    return next;
  }
}

/**
 * High-level client for driving a session key against a SessionKeyManager.
 * Stateless by design: holds no keys, caches no state — safe across a fleet of agents.
 */
export class SigilKitClient {
  readonly managerAddress: Address;
  readonly chain: Chain;
  private readonly publicClient: PublicClient;
  private readonly leases?: LeaseStore;
  private readonly preparations = new WeakMap<PreparedExecution, { guard: ExecutionGuard; signer: Address; data: Hex }>();

  /**
   * Per-key execution queue — see {@link NonceGate}. Wrap prepare + send + confirm in
   * `client.nonceGate.run(key, …)` when one key may have concurrent in-flight actions.
   */
  readonly nonceGate: NonceGate;

  /** Advisory diagnostics sink (never used for control flow). */
  private readonly log: Logger;

  constructor(config: SigilKitClientConfig) {
    // The manager address is the EIP-712 `verifyingContract` and the tx destination, so a
    // malformed one produces a signature for the wrong domain. Validated once, here, at the only
    // place the client's identity is established — every downstream digest then uses a value
    // that is known to be 20 bytes.
    this.managerAddress = assertAddress(config.managerAddress, "managerAddress");
    // Fail fast on a domain that disagrees with the operator's configured chain id, BEFORE
    // any signature can be produced against it. See `expectedChainId` in the config docs.
    if (config.expectedChainId !== undefined && config.expectedChainId !== config.chain.id) {
      throw new ValidationError(
        "expectedChainId",
        `does not match the configured chain: expected ${config.expectedChainId}, but \`chain.id\` is ${config.chain.id} ` +
          `(chain.name: ${config.chain.name}). The EIP-712 domain would be built from \`chain.id\`, so every ` +
          `signature would be rejected on-chain as InvalidSignature after gas is spent. Fix the mismatch ` +
          `between the chain object and SIGILKIT_CHAIN_ID.`,
      );
    }
    this.chain = config.chain;
    this.publicClient =
      config.publicClient ??
      createPublicClient({
        chain: config.chain,
        transport: config.rpcUrl ? http(config.rpcUrl) : http(),
      });
    this.leases = config.leaseStore;
    this.nonceGate = new NonceGate(config.leaseStore, { ttlMs: config.leaseTtlMs });
    this.log = config.logger ?? createLogger({ scope: "sigilkit", level: "info" });
  }

  /**
   * Builds, signs, and locally validates an action request, then returns the
   * calldata for executeWithSessionKey ready to be sent by any relayer/wallet.
   *
   * Local validation runs BEFORE signing (zero-gas rejection path).
   *
   * @param args the action, the session key, and the scope to check against.
   * @param guard the {@link ExecutionGuard} from the enclosing `nonceGate.run`. Required
   *   whenever the client was configured with a `leaseStore`; omitting it there throws
   *   rather than silently bypassing cross-worker coordination.
   * @returns a {@link PreparedExecution} — signature, request, and the `to`/`data`
   *   calldata. Pass it to {@link sendPrepared} or {@link simulateExecution} instead of
   *   re-preparing, so the nonce the caller simulated is the nonce that gets sent.
   * @throws {@link PolicyRejectedError} (`code: "POLICY_REJECTED"`, message
   *   `"SigilKit policy rejection (pre-signature): …"`) when the local pre-flight rejects the
   *   request — no signature is produced, no gas is spent. The `reason` string is on
   *   `err.reason`. For a typed result with no throw at all, call `validateAgainstScope`
   *   yourself and branch on its return value.
   * @throws {@link ValidationError} (`code: "VALIDATION"`) when the request or the
   *   EIP-712 domain is malformed.
   * @throws {@link LeaseLostError} (`code: "LEASE_LOST"`) when the guard's lease was lost
   *   before signing.
   * @example
   * ```ts
   * const prepared = await client.prepareExecution({ account, request, scope });
   * const sim = await client.simulateExecution(prepared);
   * if (sim.ok) await client.sendPrepared(prepared, wallet);
   * ```
   * @remarks Cost: 1 RPC round-trip (the nonce and window-state reads are issued in
   *   parallel) plus one `account.sign`. The `merkleProof` array is copied, not aliased,
   *   so mutating the caller's array afterwards cannot desynchronise the returned
   *   payload from the calldata that was signed.
   */
  async prepareExecution(
    args: PrepareExecutionArgs,
    guard?: ExecutionGuard,
  ): Promise<PreparedExecution> {
    // Normalize/validate the request up front so deserialized (e.g. JSON-round-tripped)
    // inputs fail loudly here instead of TypeError-ing mid-encode or hashing garbage.
    // A placeholder nonce satisfies the parser; the real one is fetched right after
    // and overrides it.
    const normalized = parseActionRequest({ ...args.request, nonce: args.request.nonce ?? 0n });

    // The nonce fetch and the window-state fetch are independent — one RPC round-trip
    // instead of two (P5). A failed window read degrades the pre-check to
    // per-action-only — logged so fleet operators can see it (Q1); on-chain
    // enforcement still applies.
    const [nonce, windowState] = await Promise.all([
      args.request.nonce !== undefined
        ? Promise.resolve(args.request.nonce)
        : this.publicClient.readContract({
            address: this.managerAddress,
            abi: SESSION_KEY_MANAGER_ABI,
            functionName: "getNonce",
            args: [args.account.address],
          }),
      this.publicClient
        .readContract({
          address: this.managerAddress,
          abi: SESSION_KEY_MANAGER_ABI,
          functionName: "getWindowState",
          args: [args.account.address],
        })
        .then(
          // ABI-02: the contract returns ONE `WindowState` struct, so viem hands back a
          // named object. `windowStart` is ABI-typed uint48 but `validateAgainstScope`
          // compares it against a JS `number` (unix seconds), hence the Number() cast —
          // same widening the pre-existing code did, now reading the correct field.
          (w) => ({ windowStart: Number(w.windowStart), spentThisWindow: w.spentThisWindow }),
          (err: unknown): undefined => {
            this.log.warn(
              "getWindowState unavailable — skipping the local per-window pre-check (on-chain enforcement still applies)",
              { reason: err instanceof Error ? err.message : String(err) },
            );
            return undefined;
          },
        ),
    ]);

    const request: ActionRequest = { ...normalized, nonce } as ActionRequest;

    const check = validateAgainstScope({
      request,
      scope: args.scope,
      windowState,
      merkleProof: args.merkleProof,
    });
    if (!check.ok) {
      throw new PolicyRejectedError(check.reason);
    }

    // SK-09 fence: after the awaited nonce/window reads, immediately before signing —
    // a superseded holder must not produce a fresh signature.
    await this.assertGuard(args.account.address, guard);

    const signature = await signActionRequest({
      account: args.account,
      request,
      chainId: this.chain.id,
      verifyingContract: this.managerAddress,
    });

    // Own the proof array rather than aliasing the caller's (API-IMM-1). Two problems
    // with the alias, both observed here: a caller could mutate `prepared.merkleProof`
    // after signing and silently desynchronise the documented output from the calldata
    // that was actually signed and encoded; and the guarded path below calls
    // `Object.freeze` on it, which would deep-freeze an array the caller still owns
    // and may legitimately reuse for a later action. A fresh array costs one small
    // copy and removes both.
    const merkleProof = [...(args.merkleProof ?? [])];

    const data = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "executeWithSessionKey",
      args: [request, signature, merkleProof, args.ownerApproval ?? "0x"],
    });

    const prepared: PreparedExecution = {
      request,
      signature,
      merkleProof,
      ownerApproval: args.ownerApproval ?? "0x",
      to: this.managerAddress,
      data,
    };
    if (guard) {
      Object.freeze(request);
      Object.freeze(prepared.merkleProof);
      Object.freeze(prepared);
      this.preparations.set(prepared, { guard, signer: args.account.address, data });
    }
    return prepared;
  }

  /**
   * Waits for an execution receipt and confirms the mandatory audit event fired (INV-3).
   *
   * Requires a unique decoded event from the configured manager. Supply the request
   * to bind its emitted fields; omitting it confirms emitter-only evidence.
   * This client does not confirm 7579 executor paths.
   *
   * **Despite the name, this method does not throw when the event is simply absent.** A
   * mined, successful transaction with no matching `ActionLogged` resolves to `false`; only
   * a revert, an ambiguous match, or a receipt-wait failure throws. `false` therefore means
   * "executed but unaudited" — an INV-3 violation you must treat as a failure, not as a
   * benign absence. Use {@link SigilKitClient.sendPrepared} (or `execute`) if you would
   * rather have that case throw; they do.
   *
   * @returns `true` when `request` was supplied and exactly one `ActionLogged` event from
   *   `managerAddress` matched; `false` when a successful transaction contained none.
   *   **`false` means "executed but unaudited"** — an INV-3 violation you must treat as a
   *   failure, not a benign absence. Note the emitter-only form (omitting `request`) cannot
   *   prove which action was audited, so it returns `true` for the first match and cannot
   *   report ambiguity at all.
   *
   * **What a `true` does and does not prove (INV-3 scope).** `true` proves *an* action was
   * logged for this agent/target/selector/value — it says nothing about what the action
   * *did*. `ActionLogged` carries `(agentId, target, selector, value, rationaleHash,
   * timestamp)` and **no token amounts, no balance deltas and no return data**. So under E11
   * balance-delta enforcement, a passing call is observable only as "this action happened";
   * whether the inner call moved the tokens it was supposed to move is not recoverable from
   * this event. Use `(agentId, target, selector, value)` as the audit key and reconcile
   * token movement against `tokenWatchlist` balances separately if you need that dimension.
   * @throws An `Error` reading `"SigilKit: transaction 0x… reverted; nothing was executed
   *   or audited"` when the receipt has `status !== "success"`. Safe to treat as "no state
   *   change" — unlike a receipt timeout, which emphatically is not.
   * @throws {@link AuditAmbiguousError} (`code: "AUDIT_AMBIGUOUS"`, message
   *   `"SigilKit: ambiguous ActionLogged audit evidence"`) when more than one log matched.
   * @throws An `Error` reading `"SigilKit: no receipt for 0x… within 120000ms … do NOT
   *   resend …"` when no receipt arrived within the bounded wait. This is NOT a "safe to
   *   retry" signal — the nonce may already be consumed, so a blind resend reverts with
   *   `NonceUsed`. Reconcile the `txHash` named in the message against the chain instead.
   * @example
   * ```ts
   * const audited = await client.assertAuditEmitted(txHash, prepared.request);
   * if (!audited) throw new Error("executed but unaudited — do not treat as success");
   * ```
   */
  async assertAuditEmitted(txHash: Hash, request?: AuditRequestIdentity): Promise<boolean> {
    const receipt = await this.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      throw new ExecutionRevertedError(txHash);
    }
    return parseActionLogged(receipt.logs, {
      emitter: this.managerAddress,
      ...(request ? { request } : {}),
      txHash,
    }) !== null;
  }

  /**
   * Token-path pre-check (enhancement E8): when the request targets a standard
   * ERC-20 transfer/transferFrom, decode the amount and verify the wallet can cover
   * it (balance, and allowance for transferFrom) — the concrete "planned" mitigation
   * from SECURITY.md, made possible by argument-bound (v2) leaves. Returns checks
   * with `ok: false` advisory warnings; NEVER throws — unknown selectors simply
   * produce no checks, and a balance/allowance read that throws is reported as
   * `ok: false` (unverifiable), never as a pass.
   *
   * Spender semantics (BUG-4): the manager performs the inner call, so at the token
   * contract `msg.sender == managerAddress`. A `transferFrom(from, …)` therefore needs
   * `allowance(from, managerAddress)` — NOT `allowance(from, token)`. When `from` IS the
   * manager, no allowance is required at all, so no allowance check is emitted.
   *
   * Cost (PERF-1): no `decimals()` probe (the result was unused), and the checks run
   * concurrently rather than serially — at most 2 round-trips in parallel.
   */
  async checkTokenPath(request: ActionRequest): Promise<TokenPathReport> {
    const checks: TokenPathCheck[] = [];

    const readAmount = async (
      kind: "balance" | "allowance",
      holder: Address,
      amount: bigint,
      spender?: Address,
    ): Promise<void> => {
      try {
        const have =
          kind === "balance"
            ? await this.publicClient.readContract({
                address: request.target,
                abi: ERC20_BALANCE_OF_ABI,
                functionName: "balanceOf",
                args: [holder],
              })
            : await this.publicClient.readContract({
                address: request.target,
                abi: ERC20_ALLOWANCE_ABI,
                functionName: "allowance",
                args: [holder, spender ?? this.managerAddress],
              });
        checks.push({
          kind,
          token: request.target,
          ok: have >= amount,
          detail:
            kind === "balance"
              ? `wallet balance ${have} vs amount ${amount}`
              : `allowance(${holder} → ${spender ?? this.managerAddress}) ${have} vs amount ${amount}`,
        });
      } catch (err) {
        // A read that threw leaves the balance/allowance UNKNOWN, not "sufficient".
        // Reporting `ok: true` here made this the one fail-open branch in an advisory
        // check: a caller that read `ok` saw a clean pass for a token whose funds were
        // never actually verified. Still advisory — it never throws and never substitutes
        // for on-chain enforcement — but `ok: false` routes it into the warning path, and
        // the underlying error text is carried in `detail` rather than discarded.
        checks.push({
          kind,
          token: request.target,
          ok: false,
          detail: `read failed (non-standard token?): ${err instanceof Error ? err.message : err}`,
        });
      }
    };

    const pending: Array<Promise<void>> = [];

    // Hand-rolled calldata slicing: everything below reads fixed ABI word offsets out of
    // `request.data`, and `data` is caller-supplied. Three preconditions are therefore checked
    // ONCE, up front, before any slice is taken:
    //
    //   1. `data` is `0x`-prefixed, even-length, hex-only. `BigInt("0x" + …)` does NOT validate
    //      its input, so a single non-hex character anywhere in a 128-char window reaches
    //      `BigInt` and throws a raw `SyntaxError: Cannot convert 0xzz… to a BigInt`. Measured
    //      against the previous code: `checkTokenPath` — documented as "NEVER throws" — threw
    //      on `{ selector: "0xa9059cbb", data: "0x" + "zz".repeat(64) + "00".repeat(64) }`. That
    //      is a contract violation of the method's own contract, and it is reachable from any
    //      agent/MCP surface that hands a model-produced request straight to the SDK.
    //   2. `selector` is compared case-insensitively. `parseActionRequest` accepts a checksummed
    //      (mixed/upper) case selector because it only checks the length, so `0xA9059CBB` was
    //      silently unmatched and the advisory check was skipped for a request that really is a
    //      transfer — a fail-open on the one branch that is supposed to warn.
    //   3. The word count is at least what the layout needs. The previous bounds compared a
    //      *character* length against a *character* length that was itself written as if it
    //      were bytes (`>= 66 + 64` accepts 65 hex chars = 32.5 bytes), so the guard was fuzzy;
    //      it is now stated in characters, exactly, from the number of words.
    const data = request.data;
    const wellFormed =
      typeof data === "string" &&
      /^0x[0-9a-fA-F]*$/.test(data) &&
      data.length >= 2 &&
      data.length % 2 === 0;
    if (wellFormed) {
      const selector = request.selector.toLowerCase();
      // An ABI word is 32 bytes = 64 hex chars. An `address` argument occupies a whole word
      // and is RIGHT-aligned (12 zero bytes then 20 address bytes), so it is read from the
      // low 40 hex chars of its word — the offsets below are in hex characters, measured from
      // after the "0x", and each is written as `wordStart + offsetInWord`.
      const word = 64;
      const addressAt = (wordIndex: number): Address => {
        const start = 2 + word * wordIndex;
        return ("0x" + data.slice(start + 24, start + 64)) as Address;
      };
      const uintAt = (wordIndex: number): bigint => {
        return BigInt("0x" + data.slice(2 + word * wordIndex, 2 + word * (wordIndex + 1)));
      };
      if (selector === "0xa9059cbb" && data.length >= 2 + word * 2) {
        // transfer(address to, uint256 amount): word 0 = to, word 1 = amount. The manager is
        // msg.sender, so its balance is debited.
        pending.push(readAmount("balance", this.managerAddress, uintAt(1)));
      } else if (selector === "0x23b872dd" && data.length >= 2 + word * 3) {
        // transferFrom(address from, address to, uint256 amount): words 0/1/2.
        const from = addressAt(0);
        const amount = uintAt(2);
        // `from`'s balance is debited regardless of who submits.
        pending.push(readAmount("balance", from, amount));
        // An allowance is only needed when the manager is spending SOMEONE ELSE's tokens.
        if (from.toLowerCase() !== this.managerAddress.toLowerCase()) {
          pending.push(readAmount("allowance", from, amount, this.managerAddress));
        }
      }
    }

    await Promise.all(pending);
    return { checks };
  }

  /**
   * Simulation mode (enhancement E12): eth_call the prepared execution against the
   * live node BEFORE any gas is spent, surfacing state-dependent failures (target
   * state, router conditions) that the zero-gas local policy check cannot see. Run
   * AFTER signing (the contract must recover the signer) and BEFORE sending.
   *
   * Accepts EITHER fresh prepare args OR an already-{@link PreparedExecution} payload.
   * Passing the prepared payload is the cheap path (PERF-3): it performs a single
   * pre-flight instead of two, so the nonce the simulation saw is the nonce that gets
   * sent. Prefer {@link executeSimulated}, which wires this together correctly.
   *
   * @param argsOrPrepared fresh prepare args, or a payload already returned by
   *   {@link prepareExecution} (preferred — skips the duplicate pre-flight).
   * @param from the `from` address for the `eth_call`. Defaults to `managerAddress`,
   *   which is the address that actually executes on chain.
   * @param guard the {@link ExecutionGuard} from the enclosing `nonceGate.run`; only
   *   used on the fresh-args path, since an already-prepared payload carries its own.
   * @returns {@link SigilKitCheck} — `{ ok: false, reason }` carries the decoded
   *   SigilKit revert reason when the node returned recognisable revert data.
   * @example
   * ```ts
   * const prepared = await client.prepareExecution({ account, request, scope });
   * const sim = await client.simulateExecution(prepared);
   * if (!sim.ok) console.warn("would revert:", sim.reason); // nothing sent, no gas
   * ```
   * @remarks Cost: 1 `eth_call`, no gas. Never throws for a revert — a failing
   *   simulation is a returned value, not an exception.
   */
  async simulateExecution(
    argsOrPrepared: PrepareExecutionArgs | PreparedExecution,
    from?: Address,
    guard?: ExecutionGuard,
  ): Promise<SigilKitCheck> {
    const prepared = isPreparedExecution(argsOrPrepared)
      ? argsOrPrepared
      : await this.prepareExecution(argsOrPrepared, guard);
    try {
      await this.publicClient.call({
        account: from ?? this.managerAddress,
        to: prepared.to,
        data: prepared.data,
      });
      return { ok: true };
    } catch (err) {
      // viem does NOT put revert data on the error it throws from `eth_call`. Its
      // `getRevertErrorData` pulls `data` off the node error, uses it for the CCIP-Read and
      // counterfactual checks, and then throws `CallExecutionError` — which carries only
      // `cause` (viem/_esm/errors/contract.js:44-50 sets `cause` and nothing else). So
      // reading `err.data` here finds `undefined` on every real revert and the decoded
      // reason is silently replaced by the wrapper's class name.
      //
      // `walkRevertData` is the single place that knows how to dig it out, and it is the
      // SAME walk `decorateWithDecodedRevert` uses, so the two paths cannot disagree about
      // which revert produced which message.
      const data = walkRevertData(err);
      if (data) {
        return { ok: false, reason: decodeSigilKitError(data).message };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One-call execution (enhancement E3): prepare + sign + locally validate, send via
   * the provided wallet (the relayer), wait for the receipt, and return the TYPED
   * audit record. Throws on revert (with the decoded SigilKit reason when available,
   * E4) and when a successful execution somehow lacks ActionLogged (INV-3 violation).
   *
   * Wrap in `client.nonceGate.run(key, …)` when the same session key may have
   * concurrent in-flight actions.
   */
  async execute(
    args: PrepareExecutionArgs,
    wallet: WalletClient,
    guard?: ExecutionGuard,
  ): Promise<{ receipt: TransactionReceipt; audit: ActionLogRecord }> {
    return this.sendPrepared(await this.prepareExecution(args, guard), wallet, guard);
  }

  /**
   * Simulate-then-execute in one call (PERF-3): prepares ONCE, eth_calls the exact
   * payload, and only then sends it. Rejects with the decoded reason when the
   * simulation fails, so no gas is spent on a transaction the chain would revert.
   */
  async executeSimulated(
    args: PrepareExecutionArgs,
    wallet: WalletClient,
    from?: Address,
    guard?: ExecutionGuard,
  ): Promise<{ receipt: TransactionReceipt; audit: ActionLogRecord }> {
    const prepared = await this.prepareExecution(args, guard);
    const sim = await this.simulateExecution(prepared, from);
    if (!sim.ok) {
      throw new SimulationRevertedError(sim.reason);
    }
    return this.sendPrepared(prepared, wallet, guard);
  }

  /**
   * Bounded, hash-preserving receipt wait shared by {@link assertAuditEmitted} and
   * {@link sendPrepared} (PERF-10).
   *
   * Two properties this wrapper exists to guarantee, which a bare viem call does not:
   *
   *  1. **Bounded.** An unbounded poll never rejects, so it would hang the caller — and, via
   *     `NonceGate`, every later execution queued for that key — forever. The `timeout` here
   *     is the real ceiling; `pollingInterval` is only the block-polling cadence.
   *  2. **Reconciliation-safe.** The hash is attached to every failure because the operator
   *     cannot resolve the outcome offline without it. A timeout is deliberately NOT retried
   *     and never triggers a resend: the nonce is already consumed, so a blind resend reverts
   *     with `NonceUsed` and burns a second relayer slot on the same failure.
   */
  private async waitForReceipt(txHash: Hash): Promise<TransactionReceipt> {
    try {
      return await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: RECEIPT_TIMEOUT_MS,
        retryCount: RECEIPT_RETRY_COUNT,
        pollingInterval: RECEIPT_POLLING_INTERVAL_MS,
      });
    } catch (err) {
      // viem's own timeout message already embeds the hash, but not every rejection path
      // does (a transport failure, an RPC-level error), and the hash is mandatory for
      // offline reconciliation — so it is stamped onto every error unconditionally.
      const error = decorateWithDecodedRevert(err);
      throw new ReceiptTimeoutError(txHash, RECEIPT_TIMEOUT_MS, error.message, { cause: error });
    }
  }

  /**
   * SK-09 fail-closed guard check: when a lease store is configured, every sign/send
   * boundary must carry the guard issued by the enclosing `nonceGate.run` — an unguarded
   * call would silently bypass the configured coordination. The guard's key must be the
   * signing session key (never the relayer), and the lease must still be current.
   */
  private async assertGuard(signer: Address, guard?: ExecutionGuard): Promise<void> {
    if (this.leases && !guard) {
      throw new GuardMissingError(
        "SigilKit: a lease store is configured — run executions inside nonceGate.run and pass its guard to execute/sendPrepared",
      );
    }
    if (!guard) return;
    if (guardStates.get(guard)?.gate !== this.nonceGate) {
      throw new GuardMissingError("SigilKit: execution guard must originate from this client's nonceGate.run");
    }
    if (guard.key.toLowerCase() !== assertAddress(signer, "signer").toLowerCase()) {
      throw new GuardMissingError("SigilKit: execution guard key does not match the signing session key");
    }
    await guard.assertCurrent();
  }

  /**
   * Sends an already-prepared payload through `wallet` and confirms the audit event.
   * Public so a prepared payload can be re-sent by a different relayer, or after a
   * simulation, without repeating the nonce/window pre-flight.
   */
  async sendPrepared(
    prepared: PreparedExecution,
    wallet: WalletClient,
    guard?: ExecutionGuard,
  ): Promise<{ receipt: TransactionReceipt; audit: ActionLogRecord }> {
    if (!wallet.account) {
      throw new Error("SigilKit execute: wallet client must carry an account (the relayer)");
    }
    if (assertAddress(prepared.to, "prepared.to").toLowerCase() !== this.managerAddress.toLowerCase()) {
      throw new Error("SigilKit execute: prepared destination must match the configured manager");
    }
    const origin = this.preparations.get(prepared);
    if (this.leases || guard || origin) {
      if (!origin || origin.guard !== guard || origin.data !== prepared.data) {
        throw new GuardMissingError(
          "SigilKit: prepared payload must retain its original run guard and provenance",
        );
      }
      await this.assertGuard(origin.signer, guard);
    }
    const expectedRequest = { ...prepared.request };
    let txHash: Hash;
    try {
      // Mark the guard as "handed to the relayer" BEFORE awaiting, deliberately: a relayer
      // that is slow, times out or drops the connection may still have broadcast, and only
      // the relayer knows. `submitted` therefore means "the send was attempted and the
      // outcome is now unknowable from here" — not "a transaction definitely exists".
      if (guard) guardStates.get(guard)!.submitted = true;
      txHash = await wallet.sendTransaction({
        account: wallet.account,
        chain: this.chain,
        to: prepared.to,
        data: prepared.data,
      });
    } catch (err) {
      // The guard is already flagged above, so NonceGate.run will re-wrap this as
      // "SDK submission attempted". That is the safe default: for a pre-broadcast rejection
      // (bad params, insufficient funds, an unreachable relayer) nothing was sent, but this
      // layer cannot tell those apart from a relayer that broadcast and then failed to
      // return a hash. Callers who need the distinction should read `err.cause`.
      throw decorateWithDecodedRevert(err);
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await this.waitForReceipt(txHash);
    } catch (err) {
      throw decorateWithDecodedRevert(err);
    }
    if (receipt.status !== "success") {
      throw new ExecutionRevertedError(txHash);
    }
    const audit = parseActionLogged(receipt.logs, {
      emitter: this.managerAddress,
      request: expectedRequest,
      txHash,
    });
    if (!audit) {
      throw new AuditMissingError(txHash);
    }
    return { receipt, audit };
  }
}

/**
 * Minimal ERC-20 read surfaces for the token-path pre-check (E8).
 *
 * Declared as two SEPARATE, correctly-shaped fragments. Previously a single
 * `balanceOf`-shaped fragment (one `address` input) was reused for `allowance` and
 * force-cast with `as never`, which suppressed the type error that would have caught
 * the wrong-spender bug below (BUG-4 / CQ-2).
 */
const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "holder", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** One advisory token-path check result (enhancement E8). */
export interface TokenPathCheck {
  kind: "balance" | "allowance";
  token: Address;
  ok: boolean;
  detail: string;
}

export interface TokenPathReport {
  checks: TokenPathCheck[];
}

/** A decoded ActionLogged audit record (enhancement E3). */
export interface ActionLogRecord {
  agentId: Hash;
  target: Address;
  selector: Hex;
  value: bigint;
  rationaleHash: Hash;
  /** Seconds (uint48) — the block timestamp of the audit event. */
  timestamp: number;
  txHash: Hash;
  blockNumber: bigint;
  /**
   * Index of the log within its transaction. Together with `txHash` this is the
   * natural key for a lossless audit store: two actions emitted in the same
   * transaction share a txHash, block number and timestamp, so any key that omits
   * the log index silently collapses them (BUG-5).
   */
  logIndex: number;
}

/** Request fields represented by ActionLogged; nonce, expiry and calldata are not emitted. */
export type AuditRequestIdentity = Pick<ActionRequest, "agentId" | "target" | "selector" | "value" | "rationaleHash">;

/** Trusted expectations supplied by the caller, never derived from receipt logs. */
export interface AuditExpectation {
  emitter: Address;
  request?: AuditRequestIdentity;
  txHash?: Hash;
}

/**
 * Exact byte length of `ActionLogged`'s NON-indexed payload (`uint256 value`, `bytes32
 * rationaleHash`, `uint48 timestamp`) = 3 × 32 words.
 *
 * `decodeEventLog({ strict: true })` only rejects data that is too SHORT for the declared
 * parameters. A payload of 3 words **or more** is accepted, and the first three words are read
 * while the rest is silently discarded. A log whose `data` is one word short of a full three
 * therefore decodes to a record whose `timestamp` is actually the high bytes of
 * `rationaleHash` — i.e. the three fields are read from *shifted* positions. Measured against
 * viem 2.55.19: a 96-byte `data` of all zeros "successfully" decodes to
 * `{ value: 0n, rationaleHash: 0x00…00, timestamp: 0 }` even though only two of the three
 * words were present, and `parseActionLogged` returned that as a genuine audit record.
 *
 * On the audit-confirmation path (INV-3) that is fabricated evidence, so the length is pinned
 * here rather than relying on the decoder's lower bound. Anything other than exactly 96 bytes
 * is not a well-formed `ActionLogged` and is skipped.
 */
const ACTION_LOGGED_DATA_BYTES = 96;

/**
 * Cheap upper bound on a log's `data` before it is handed to the decoder.
 *
 * `log.data` comes from an RPC response — a node the operator may not control, carrying an
 * event a contract can pad arbitrarily. Walking a megabyte of it costs memory and time for
 * nothing, so the size is rejected on a string-length comparison before any decode. Set far
 * above the real 96 bytes so it can never reject a legitimate event.
 */
const MAX_DECODED_LOG_DATA_BYTES = 4096;

/**
 * Without expectations, decodes the first event for low-level ingestion only;
 * this is NOT audit confirmation. With expectations, returns the unique matching
 * mined record, null for absence, and throws on ambiguity. A matching event cannot
 * prove nonce, expiry, calldata, signer, or account compatibility.
 */
export function parseActionLogged(logs: Log[], expected?: AuditExpectation): ActionLogRecord | null {
  const emitter = expected ? assertAddress(expected.emitter, "audit.emitter").toLowerCase() : undefined;
  let match: ActionLogRecord | null = null;
  for (const log of logs) {
    if (log.topics.length !== 4 || log.topics[0]?.toLowerCase() !== ACTION_LOGGED_TOPIC) continue;
    if (expected && (
      log.address.toLowerCase() !== emitter || log.removed ||
      log.transactionHash === null || log.blockNumber === null || log.logIndex === null ||
      (expected.txHash !== undefined && log.transactionHash.toLowerCase() !== expected.txHash.toLowerCase())
    )) continue;
    // Length gate BEFORE the decode (see ACTION_LOGGED_DATA_BYTES): a payload that is not
    // exactly 3 words is not a well-formed ActionLogged, and `decodeEventLog` would otherwise
    // accept an over-long one while reading the first three words of a short one at shifted
    // positions. Cheap to check, and it keeps a hostile `data` from being walked at all.
    if (typeof log.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(log.data) || log.data.length % 2 !== 0) continue;
    const dataBytes = (log.data.length - 2) / 2;
    // The cheap upper bound is tested FIRST, because it is the only half of this guard
    // that can do work on its own: it is what stops a hostile multi-megabyte `data` from
    // being walked at all. Written second it was unreachable — `dataBytes !== 96` already
    // excludes every larger payload, so the bound could never be the reason a log was
    // skipped, and MAX_DECODED_LOG_DATA_BYTES did nothing. Same accepted set either way
    // (both operands are side-effect free), but only this order makes the bound load-bearing.
    if (dataBytes > MAX_DECODED_LOG_DATA_BYTES || dataBytes !== ACTION_LOGGED_DATA_BYTES) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: ACTION_LOGGER_ABI,
        eventName: "ActionLogged",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      continue;
    }
    const a = decoded.args;
    const request = expected?.request;
    if (request && (
      a.agentId.toLowerCase() !== request.agentId.toLowerCase() ||
      a.target.toLowerCase() !== request.target.toLowerCase() ||
      a.selector.toLowerCase() !== request.selector.toLowerCase() ||
      a.value !== request.value ||
      a.rationaleHash.toLowerCase() !== request.rationaleHash.toLowerCase()
    )) continue;
    const record: ActionLogRecord = {
      agentId: a.agentId,
      target: a.target,
      selector: a.selector,
      value: a.value,
      rationaleHash: a.rationaleHash,
      timestamp: Number(a.timestamp),
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber as bigint,
      logIndex: Number(log.logIndex ?? 0),
    };
    if (!expected) return record;
    if (match) throw new AuditAmbiguousError();
    match = record;
  }
  return match;
}

/** keccak256("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)") — event signature topic. */
export const ACTION_LOGGED_TOPIC = keccak256(
  toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"),
);
