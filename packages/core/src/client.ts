import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import {
  parseActionRequest,
  signActionRequest,
  validateAgainstScope,
  type HashSigner,
} from "./signing.js";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
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
 */
export class NonceGate {
  private chains = new Map<Address, Promise<unknown>>();

  run<T>(key: Address, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the previous run's outcome
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
      args: [request, signature, args.merkleProof ?? []],
    });

    return {
      request,
      signature,
      merkleProof: args.merkleProof ?? [],
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
}

/** keccak256("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)") — event signature topic. */
export const ACTION_LOGGED_TOPIC = keccak256(
  toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)"),
);
