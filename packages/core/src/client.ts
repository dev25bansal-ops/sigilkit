import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import {
  parseActionRequest,
  signActionRequest,
  validateAgainstScope,
  type HashSigner,
} from "./signing.js";
import { decodeSigilKitError, decorateWithDecodedRevert } from "./errors.js";
import { ACTION_LOGGER_ABI } from "./abis.js";
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
}

/**
 * Per-key execution serialization (issues catalog P1: strictly-sequential on-chain
 * nonces mean two concurrent executions from one session key both fetch the same
 * nonce and the loser reverts on-chain after gas is spent).
 *
 * Queue every step that must not interleave — prepare, sign, relay, confirm — for a
 * given key:
 *
 *   await client.nonceGate.run(agentAddress, async () => {
 *     const prepared = await client.prepareExecution({ ... });
 *     const hash = await relayer.sendTransaction(prepared);
 *     return client.assertAuditEmitted(hash);
 *   });
 *
 * Coordination is in-process only (the client stays stateless across machines); for
 * multi-process fleets, serialize per key upstream or use distinct keys per agent.
 * Failures do not poison the queue — the next run proceeds regardless.
 *
 * For MULTIPLE processes sharing one key, inject a cross-process {@link LeaseStore}
 * (e.g. a Redis SETNX adapter — acquire = `SET key owner NX PX ttl`, release = a
 * check-and-del): the gate then rejects runs that cannot take the lease instead of
 * racing. The documented default remains one key per agent process — zero
 * coordination is better than coordination.
 */
export interface LeaseStore {
  /** Returns true when the lease is held by this caller; false when busy. */
  acquire(key: Address, ttlMs: number): boolean | Promise<boolean>;
  release(key: Address): void | Promise<void>;
}

/** Single-process lease store (the default when none is injected). */
export class InMemoryLeaseStore implements LeaseStore {
  private held = new Map<Address, number>(); // key -> expiry ms

  acquire(key: Address, ttlMs: number): boolean {
    const now = Date.now();
    const until = this.held.get(key) ?? 0;
    if (until > now) return false;
    this.held.set(key, now + ttlMs);
    return true;
  }

  release(key: Address): void {
    this.held.delete(key);
  }
}

export class NonceGate {
  private chains = new Map<Address, Promise<unknown>>();

  constructor(private readonly leases?: LeaseStore) {}

  run<T>(key: Address, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const exec = async (): Promise<T> => {
      if (this.leases) {
        // A lease that cannot be taken promptly is a real cross-worker concurrency
        // violation, not a transient state — fail loudly rather than race.
        if (!(await this.leases.acquire(key, 30_000))) {
          throw new Error(`SigilKit NonceGate: key ${key} is busy in another worker`);
        }
        try {
          return await fn();
        } finally {
          await this.leases.release(key);
        }
      }
      return fn();
    };
    const next = prev.then(exec, exec); // run regardless of the previous run's outcome
    this.chains.set(
      key,
      next.catch(() => undefined), // keep the chain alive on errors
    );
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

  /**
   * Per-key execution queue — see {@link NonceGate}. Wrap prepare + send + confirm in
   * `client.nonceGate.run(key, …)` when one key may have concurrent in-flight actions.
   */
  readonly nonceGate = new NonceGate();

  constructor(config: SigilKitClientConfig) {
    this.managerAddress = config.managerAddress;
    this.chain = config.chain;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: config.rpcUrl ? http(config.rpcUrl) : http(),
    });
  }

  /**
   * Builds, signs, and locally validates an action request, then returns the
   * calldata for executeWithSessionKey ready to be sent by any relayer/wallet.
   *
   * Local validation runs BEFORE signing (zero-gas rejection path).
   */
  async prepareExecution(args: {
    account: HashSigner & { address: Address };
    request: Omit<ActionRequest, "nonce"> & { nonce?: bigint };
    scope: Scope;
    merkleProof?: Hex[];
    /** E10: owner countersignature, required when value exceeds scope.countersignAbove. */
    ownerApproval?: Hex;
  }): Promise<ExecuteArgs & { to: Address; data: Hex }> {
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
            console.warn(
              "SigilKit: getWindowState unavailable — skipping the local per-window pre-check " +
                "(on-chain enforcement still applies):",
              err instanceof Error ? err.message : err,
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

    return {
      request,
      signature,
      merkleProof: args.merkleProof ?? [],
      ownerApproval: args.ownerApproval ?? "0x",
      to: this.managerAddress,
      data,
    };
  }

  /**
   * Waits for an execution receipt and confirms the mandatory audit event fired (INV-3).
   *
   * Returns `true` only when the tx succeeded AND an ActionLogged event was emitted.
   * Throws if the transaction reverted — a revert is an error, not merely "not audited".
   */
  async assertAuditEmitted(txHash: Hash): Promise<boolean> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`SigilKit: transaction ${txHash} reverted; nothing was executed or audited`);
    }
    return receipt.logs.some(
      (log) =>
        log.topics.length === 4 && log.topics[0] === ACTION_LOGGED_TOPIC,
    );
  }

  /**
   * Token-path pre-check (enhancement E8): when the request targets a standard
   * ERC-20 transfer/transferFrom, decode the amount and verify the wallet can cover
   * it (balance, and allowance for transferFrom) — the concrete "planned" mitigation
   * from SECURITY.md, made possible by argument-bound (v2) leaves. Returns checks
   * with `ok: false` advisory warnings; NEVER throws — unknown selectors simply
   * produce no checks.
   */
  async checkTokenPath(request: ActionRequest): Promise<TokenPathReport> {
    const checks: TokenPathCheck[] = [];
    const push = async (kind: "balance" | "allowance", holder: Address, amount: bigint) => {
      try {
        const [token, decoded] = await Promise.all([
          this.publicClient.readContract({
            address: request.target,
            abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const,
            functionName: "decimals",
          }).catch(() => 18),
          this.publicClient.readContract({
            address: request.target,
            abi: [
              { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "holder", type: "address" }], outputs: [{ type: "uint256" }] },
            ] as const,
            functionName: kind === "balance" ? "balanceOf" : "allowance",
            args: kind === "balance" ? [holder] : [holder, request.target],
          } as never),
        ]);
        void token;
        const have = decoded as bigint;
        checks.push({
          kind,
          token: request.target,
          ok: have >= amount,
          detail: kind === "balance"
            ? `wallet balance ${have} vs amount ${amount}`
            : `allowance ${have} vs amount ${amount}`,
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

    if (request.selector === "0xa9059cbb" && request.data.length >= 66 + 64) {
      // transfer(address,uint256): amount is the 2nd arg
      const amount = BigInt("0x" + request.data.slice(2 + 64, 2 + 128));
      await push("balance", this.managerAddress, amount);
    } else if (request.selector === "0x23b872dd" && request.data.length >= 2 + 96 * 2) {
      // transferFrom(address from, address to, uint256 amount)
      const from = ("0x" + request.data.slice(2 + 24, 2 + 64)) as Address;
      const amount = BigInt("0x" + request.data.slice(2 + 128, 2 + 192));
      await push("balance", from, amount);
      if (from.toLowerCase() === this.managerAddress.toLowerCase()) {
        await push("allowance", from, amount);
      }
    }
    return { checks };
  }

  /**
   * Simulation mode (enhancement E12): eth_call the prepared execution against the
   * live node BEFORE any gas is spent, surfacing state-dependent failures (target
   * state, router conditions) that the zero-gas local policy check cannot see. Run
   * AFTER signing (the contract must recover the signer) and BEFORE sending.
   */
  async simulateExecution(
    args: Parameters<SigilKitClient["prepareExecution"]>[0],
    from?: Address,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const prepared = await this.prepareExecution(args);
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
    args: Parameters<SigilKitClient["prepareExecution"]>[0],
    wallet: WalletClient,
  ): Promise<{ receipt: TransactionReceipt; audit: ActionLogRecord }> {
    const prepared = await this.prepareExecution(args);
    if (!wallet.account) {
      throw new Error("SigilKit execute: wallet client must carry an account (the relayer)");
    }
    let txHash: Hash;
    try {
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
    const audit = parseActionLogged(receipt.logs);
    if (!audit) {
      throw new Error(`SigilKit: ActionLogged missing in successful tx ${txHash} — INV-3 violated`);
    }
    return { receipt, audit };
  }
}

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
export interface ActionLogRecord {  agentId: Hash;
  target: Address;
  selector: Hex;
  value: bigint;
  rationaleHash: Hash;
  /** Seconds (uint48) — the block timestamp of the audit event. */
  timestamp: number;
  txHash: Hash;
  blockNumber: bigint;
}

/**
 * Extracts and decodes the ActionLogged record from a set of logs. Returns null when
 * no ActionLogged event is present (the INV-3 violation signal for callers).
 */
export function parseActionLogged(logs: Log[]): ActionLogRecord | null {
  for (const log of logs) {
    if (log.topics.length !== 4 || log.topics[0] !== ACTION_LOGGED_TOPIC) continue;
    let decoded: { args: Record<string, unknown> };
    try {
      decoded = decodeEventLog({
        abi: ACTION_LOGGER_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { args: Record<string, unknown> };
    } catch {
      continue;
    }
    return {
      agentId: decoded.args.agentId as Hash,
      target: decoded.args.target as Address,
      selector: decoded.args.selector as Hex,
      value: decoded.args.value as bigint,
      rationaleHash: decoded.args.rationaleHash as Hash,
      timestamp: Number(decoded.args.timestamp),
      // Receipt logs are always mined; null is only possible on pending log objects.
      txHash: log.transactionHash as Hash,
      blockNumber: log.blockNumber as bigint,
    };
  }
  return null;
}

/** keccak256("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)") — event signature topic. */
export const ACTION_LOGGED_TOPIC = keccak256(
  toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"),
);
