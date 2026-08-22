import type { ActionRequest, ExecuteArgs, Scope } from "./types.js";
import { validateAgainstScope, type HashSigner } from "./signing.js";
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
] as const;

export interface SigilKitClientConfig {
  /** Deployed SessionKeyManager address. */
  managerAddress: Address;
  chain: Chain;
  /** Optional custom RPC URL; defaults to the chain's public RPCs. */
  rpcUrl?: string;
}

/**
 * High-level client for driving a session key against a SessionKeyManager.
 * Stateless by design: holds no keys, caches no state — safe across a fleet of agents.
 */
export class SigilKitClient {
  readonly managerAddress: Address;
  readonly chain: Chain;
  private readonly publicClient: PublicClient;

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
    const nonce =
      args.request.nonce ??
      (await this.publicClient.readContract({
        address: this.managerAddress,
        abi: SESSION_KEY_MANAGER_ABI,
        functionName: "getNonce",
        args: [args.account.address],
      }));

    const request: ActionRequest = { ...args.request, nonce } as ActionRequest;

    // Zero-gas local policy check before signing.
    let windowState: { windowStart: number; spentThisWindow: bigint } | undefined;
    try {
      const w = await this.publicClient.readContract({
        address: this.managerAddress,
        abi: SESSION_KEY_MANAGER_ABI,
        functionName: "getWindowState",
        args: [args.account.address],
      });
      windowState = {
        windowStart: Number(w[0]),
        spentThisWindow: w[1],
      };
    } catch {
      // View may be unavailable on some transports; on-chain enforcement still applies.
    }

    const check = validateAgainstScope({ request, scope: args.scope, windowState });
    if (!check.ok) {
      throw new Error(`SigilKit policy rejection (pre-signature): ${check.reason}`);
    }

    const { signActionRequest } = await import("./signing.js");
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

  /** Waits for an execution receipt and confirms the mandatory audit event fired. */
  async assertAuditEmitted(txHash: Hash): Promise<boolean> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return false;
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

/** Converts a TS ActionRequest into the ABI tuple order expected by the contract. */
function toTuple(request: ActionRequest): [
  agentId: `0x${string}`,
  target: `0x${string}`,
  selector: `0x${string}`,
  value: bigint,
  nonce: bigint,
  expiry: number,
  rationaleHash: `0x${string}`,
  data: `0x${string}`,
] {
  return [
    request.agentId,
    request.target,
    request.selector,
    request.value,
    request.nonce,
    request.expiry,
    request.rationaleHash,
    request.data,
  ];
}
