/**
 * SigilKit demo agent — an autonomous treasury bot exercising the full stack:
 *
 *   owner grants scoped session key → agent evaluates a strategy each tick →
 *   when a signal fires, the agent SIGNS an ActionRequest with its session key
 *   (zero-gas local policy pre-check) → a relayer submits executeWithSessionKey →
 *   the contract enforces caps/whitelist on-chain and emits ActionLogged.
 *
 * The blast radius of a compromised agent is the granted scope, never the wallet balance.
 */
import {
  SigilKitClient,
  SESSION_KEY_MANAGER_ABI,
  type ActionRequest,
  type Scope,
} from "@sigilkit/core";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Strategy action. `nonce` may be omitted — SigilKitClient.prepareExecution then
 * fetches the current on-chain getNonce at fire time, so a failed or reverted
 * tick can never permanently desync the agent's nonces.
 */
export type StrategyAction = Omit<ActionRequest, "nonce"> & { nonce?: bigint };

export interface TreasuryAgentConfig {
  chain: Chain;
  rpcUrl: string;
  managerAddress: Address;
  /** Session key private key (the agent's identity — treat as hot, short-lived). */
  agentPrivateKey: Hex;
  /** Owner key used ONLY to grant/revoke scopes (ideally a Safe, here a plain key). */
  ownerPrivateKey: Hex;
  /** Scope to grant for this run. */
  scope: Scope;
  /** Strategy: given the tick number, return the action to take or null to idle. */
  strategy: (tick: number, state: AgentState) => StrategyAction | null;
}

export interface AgentState {
  tick: number;
  actionsExecuted: number;
  lastTxHash?: Hash;
}

export class TreasuryAgent {
  private config: TreasuryAgentConfig;
  private client: SigilKitClient;
  private relayer: ReturnType<typeof privateKeyToAccount>;
  state: AgentState = { tick: 0, actionsExecuted: 0 };

  constructor(config: TreasuryAgentConfig) {
    this.config = config;
    this.client = new SigilKitClient({
      managerAddress: config.managerAddress,
      chain: config.chain,
      rpcUrl: config.rpcUrl,
    });
    this.relayer = privateKeyToAccount(config.ownerPrivateKey);
  }

  /** Owner grants the agent its scoped session key. */
  async grantScope(): Promise<Hash> {
    const wallet = createWalletClient({
      account: this.relayer,
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    });
    const s = this.config.scope;
    const data = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "grantSessionKey",
      args: [privateKeyToAccount(this.config.agentPrivateKey).address, s],
    });
    return wallet.sendTransaction({ to: this.config.managerAddress, data });
  }

  /** Runs one strategy tick; executes and audits if the strategy returns an action. */
  async tick(): Promise<{ executed: boolean; txHash?: Hash }> {
    const tick = this.state.tick++;
    const action = this.config.strategy(tick, this.state);
    if (!action) return { executed: false };

    const agentKey = privateKeyToAccount(this.config.agentPrivateKey);
    const agentAccount = {
      address: agentKey.address,
      sign: async ({ hash }: { hash: `0x${string}` }) => agentKey.sign({ hash }),
    };

    // prepareExecution performs the zero-gas local policy check + EIP-712 signing.
    const prepared = await this.client.prepareExecution({
      account: agentAccount,
      request: action,
      scope: this.config.scope,
    });

    const relayerWallet = createWalletClient({
      account: this.relayer,
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    });
    const txHash = await relayerWallet.sendTransaction({
      to: prepared.to,
      data: prepared.data,
    });

    const publicClient = createPublicClient({
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`execution reverted: ${txHash}`);
    }
    const audited = await this.client.assertAuditEmitted(txHash, prepared.request);
    if (!audited) throw new Error("ActionLogged missing — INV-3 violated");

    this.state.actionsExecuted += 1;
    this.state.lastTxHash = txHash;
    return { executed: true, txHash };
  }

  /** Runs `n` ticks with `delayMs` between them. */
  async run(n: number, delayMs = 1_000): Promise<AgentState> {
    for (let i = 0; i < n; i++) {
      try {
        await this.tick();
      } catch (err) {
        console.error(`[tick ${i}] failed:`, err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return this.state;
  }
}
