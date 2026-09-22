import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import {
  parseActionRequest,
  signActionRequest,
  validateAgainstScope,
  type HashSigner,
} from "./signing.js";
import { decodeSigilKitError, decorateWithDecodedRevert } from "./errors.js";
import { ACTION_LOGGER_ABI } from "./abis.js";
import { createLogger, type Logger } from "./logger.js";
import { assertAddress } from "./validation.js";
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
    name: "getWindowState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "address" }],
    outputs: [
      { name: "windowStart", type: "uint48" },
      { name: "spentThisWindow", type: "uint256" },
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
}

/** Arguments accepted by {@link SigilKitClient.prepareExecution}. */
export type PrepareExecutionArgs = Parameters<SigilKitClient["prepareExecution"]>[0];

/**
 * The signed, relayer-ready payload produced by `prepareExecution`. Pass this straight
 * to `sendPrepared` / `simulateExecution` to avoid re-running the pre-flight (PERF-3):
 * the recommended simulate-then-execute flow used to fetch the nonce and window state
 * twice, doubling pre-flight RPC cost and widening the nonce race between the two reads.
 */
export type PreparedExecution = ExecuteArgs & { to: Address; data: Hex };

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

/** Optional single-process owned lease store; the default gate uses only a local queue. */
export class InMemoryLeaseStore implements LeaseStore {
  readonly version = 2 as const;
  private held = new Map<Address, { id: string; epoch: number; expires: number }>();

  acquire(key: Address, ttlMs: number): LeaseToken | null {
    assertLeaseTtl(ttlMs);
    key = assertAddress(key, "key").toLowerCase() as Address;
    const now = leaseNow(ttlMs);
    const cur = this.held.get(key);
    if (cur && cur.expires > now) return null;
    if (cur && cur.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("SigilKit: lease epoch exhausted");
    const token: LeaseToken = Object.freeze({
      key,
      id: crypto.randomUUID(),
      epoch: (cur?.epoch ?? 0) + 1,
    });
    this.held.set(key, { id: token.id, epoch: token.epoch, expires: now + ttlMs });
    return token;
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
    // Tombstone: keep the epoch so a stale token can never match a later holder.
    this.held.set(key, { id: "", epoch: cur.epoch, expires: 0 });
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

type GuardState = { gate: NonceGate; submitted: boolean };
const guardStates = new WeakMap<ExecutionGuard, GuardState>();

export class LeaseLostError extends Error {
  constructor(key: Address, options?: ErrorOptions) {
    super(SUPERSEDED(key), options);
    this.name = "LeaseLostError";
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
      throw new Error(
        "SigilKit NonceGate: lease store must implement the v2 token API (version: 2) — " +
          "key-only acquire/release cannot prove ownership and is rejected",
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
            if (controller.signal.aborted) throw new Error("SigilKit: execution guard used after its run finished");
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
        throw new Error(`SigilKit NonceGate: key ${key} is busy in another worker`);
      }
      if (typeof token !== "object" || token.key !== key || typeof token.id !== "string" ||
        !token.id || !Number.isSafeInteger(token.epoch) || token.epoch < 1) {
        throw new Error("SigilKit: invalid v2 lease token");
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
          if (finished) throw new Error("SigilKit: execution guard used after its run finished");
          if (loss) throw loss;
          try {
            if (await store.isCurrent(owned) !== true) throw lose();
          } catch (error) { throw lose(error); }
          if (finished) throw new Error("SigilKit: execution guard used after its run finished");
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
          throw new Error("SigilKit: SDK submission attempted; inspect transaction outcome before retrying", { cause: failure });
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
    this.managerAddress = config.managerAddress;
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
   */
  async prepareExecution(
    args: {
      account: HashSigner & { address: Address };
      request: Omit<ActionRequest, "nonce"> & { nonce?: bigint };
      scope: Scope;
      merkleProof?: Hex[];
      /** E10: owner countersignature, required when value exceeds scope.countersignAbove. */
      ownerApproval?: Hex;
    },
    guard?: ExecutionGuard,
  ): Promise<ExecuteArgs & { to: Address; data: Hex }> {
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
          (w) => ({ windowStart: Number(w[0]), spentThisWindow: w[1] }),
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
      throw new Error(`SigilKit policy rejection (pre-signature): ${check.reason}`);
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

    const data = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "executeWithSessionKey",
      args: [request, signature, args.merkleProof ?? [], args.ownerApproval ?? "0x"],
    });

    const prepared: PreparedExecution = {
      request,
      signature,
      merkleProof: args.merkleProof ?? [],
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
   * Throws on revert or ambiguous evidence. This client does not confirm 7579 executor paths.
   */
  async assertAuditEmitted(txHash: Hash, request?: AuditRequestIdentity): Promise<boolean> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`SigilKit: transaction ${txHash} reverted; nothing was executed or audited`);
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
   * produce no checks.
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
        checks.push({
          kind,
          token: request.target,
          ok: true, // advisory only — a failed read never blocks; on-chain enforcement applies
          detail: `read failed (non-standard token?): ${err instanceof Error ? err.message : err}`,
        });
      }
    };

    const pending: Array<Promise<void>> = [];

    if (request.selector === "0xa9059cbb" && request.data.length >= 66 + 64) {
      // transfer(address,uint256): the manager is msg.sender, so its balance is debited.
      const amount = BigInt("0x" + request.data.slice(2 + 64, 2 + 128));
      pending.push(readAmount("balance", this.managerAddress, amount));
    } else if (request.selector === "0x23b872dd" && request.data.length >= 2 + 96 * 2) {
      // transferFrom(address from, address to, uint256 amount)
      const from = ("0x" + request.data.slice(2 + 24, 2 + 64)) as Address;
      const amount = BigInt("0x" + request.data.slice(2 + 128, 2 + 192));
      // `from`'s balance is debited regardless of who submits.
      pending.push(readAmount("balance", from, amount));
      // An allowance is only needed when the manager is spending SOMEONE ELSE's tokens.
      if (from.toLowerCase() !== this.managerAddress.toLowerCase()) {
        pending.push(readAmount("allowance", from, amount, this.managerAddress));
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
   */
  async simulateExecution(
    argsOrPrepared: PrepareExecutionArgs | PreparedExecution,
    from?: Address,
    guard?: ExecutionGuard,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
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
      const data = (err as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x")) {
        return { ok: false, reason: decodeSigilKitError(data as Hex).message };
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
      throw new Error(`SigilKit simulation rejection (no gas spent): ${sim.reason}`);
    }
    return this.sendPrepared(prepared, wallet, guard);
  }

  /**
   * SK-09 fail-closed guard check: when a lease store is configured, every sign/send
   * boundary must carry the guard issued by the enclosing `nonceGate.run` — an unguarded
   * call would silently bypass the configured coordination. The guard's key must be the
   * signing session key (never the relayer), and the lease must still be current.
   */
  private async assertGuard(signer: Address, guard?: ExecutionGuard): Promise<void> {
    if (this.leases && !guard) {
      throw new Error(
        "SigilKit: a lease store is configured — run executions inside nonceGate.run and pass its guard to execute/sendPrepared",
      );
    }
    if (!guard) return;
    if (guardStates.get(guard)?.gate !== this.nonceGate) {
      throw new Error("SigilKit: execution guard must originate from this client's nonceGate.run");
    }
    if (guard.key.toLowerCase() !== assertAddress(signer, "signer").toLowerCase()) {
      throw new Error("SigilKit: execution guard key does not match the signing session key");
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
        throw new Error("SigilKit: prepared payload must retain its original run guard and provenance");
      }
      await this.assertGuard(origin.signer, guard);
    }
    const expectedRequest = { ...prepared.request };
    let txHash: Hash;
    try {
      if (guard) guardStates.get(guard)!.submitted = true;
      txHash = await wallet.sendTransaction({
        account: wallet.account,
        chain: this.chain,
        to: prepared.to,
        data: prepared.data,
      });
    } catch (err) {
      throw decorateWithDecodedRevert(err);
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (err) {
      throw decorateWithDecodedRevert(err);
    }
    if (receipt.status !== "success") {
      throw new Error(`SigilKit: transaction ${txHash} reverted; nothing was executed or audited`);
    }
    const audit = parseActionLogged(receipt.logs, {
      emitter: this.managerAddress,
      request: expectedRequest,
      txHash,
    });
    if (!audit) {
      throw new Error(`SigilKit: ActionLogged missing in successful tx ${txHash} — INV-3 violated`);
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
    if (match) throw new Error("SigilKit: ambiguous ActionLogged audit evidence");
    match = record;
  }
  return match;
}

/** keccak256("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)") — event signature topic. */
export const ACTION_LOGGED_TOPIC = keccak256(
  toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"),
);
