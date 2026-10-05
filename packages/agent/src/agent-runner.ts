/**
 * McpAgentRunner: orchestrates the real agent loop — observe state, ask a decision provider
 * for proposals, validate against on-chain scope with zero-gas checks, sign if valid, relay
 * to chain, verify audit event landed.
 *
 * SEC-06 role separation enforced throughout: the runner never holds owner keys. All scope
 * validation uses the same zero-gas pre-flight logic as @sigilkit/core to ensure identical
 * acceptance/rejection. The model is advisory only; hard guardrails always veto.
 */

import { createPublicClient, http, type PublicClient, type Address, type Hash, type Hex } from "viem";
import { foundry, type Chain } from "viem/chains";
import type { ActionRequest, Scope } from "@sigilkit/core";
import { SigilKitClient, targetLeaf, merkleProof, SESSION_KEY_MANAGER_ABI } from "@sigilkit/core";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import type { DecisionProvider, AgentContext } from "./types.js";
import { createLogger } from "@sigilkit/core/logger";

/** Local agent runner state machine. */
interface RunnerState {
  tick: number;
  actionsExecuted: number;
  lastTxHash?: Hash;
  lastPrepared?: { to: Address; data: Hex };
}

const log = createLogger({ scope: "mcp-agent", level: "info" });

export interface RunnerConfig {
  managerAddress: Address;
  sessionSigner: Hex | { address: Address; sign: (args: { hash: Hash }) => Promise<Hex> };
  relayer?: Hex;
  scope: Scope;
  whitelistLeaves?: Hash[];
  brain: DecisionProvider;
  /** A real viem Chain object (e.g., foundry). Defaults to foundry for local test. */
  chain?: Chain;
  rpcUrl: string;
  /**
   * Optional pre-built viem PublicClient, used for EVERY read this runner makes.
   *
   * Without it the runner builds its own `publicClient` here AND a second, independent one
   * inside `SigilKitClient`, both pointed at `rpcUrl`. A test can only reach the first by
   * assigning a private field, so `prepareExecution`'s per-window read still went to the
   * network: the window check was skipped (core logs "getWindowState unavailable"), and
   * whether the case passed depended on whether anything was listening on that port.
   *
   * Supplying one client makes both reads addressable, so a test can drive them without a
   * socket. Takes precedence over `rpcUrl`.
   */
  publicClient?: PublicClient;
}

export type TickResult =
  | { executed: false; reason: "idle" | "guardrail-rejected" }
  | { executed: true; broadcast: true; txHash: Hash; audited: boolean }
  | { executed: true; broadcast: false; prepared: { to: Address; data: Hex } };

function padAddress(address: Address): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export class McpAgentRunner {
  private config: Required<Pick<RunnerConfig, "managerAddress" | "scope" | "brain" | "chain" | "rpcUrl">> &
    Pick<RunnerConfig, "sessionSigner" | "relayer" | "whitelistLeaves" | "publicClient">;
  private client: SigilKitClient;
  private sessionSigner: { address: Address; sign: (args: { hash: Hash }) => Promise<Hex> };
  private relayer?: ReturnType<typeof privateKeyToAccount>;
  private grantTxHash?: Hash;
  private publicClient: PublicClient;
  state: RunnerState = { tick: 0, actionsExecuted: 0 };

  constructor(config: RunnerConfig) {
    this.config = { ...config, chain: config.chain ?? foundry };
    this.client = new SigilKitClient({
      managerAddress: this.config.managerAddress,
      chain: this.config.chain,
      rpcUrl: this.config.rpcUrl,
      // Injectable so BOTH transports in this class can be driven from one stub. The runner
      // reads the nonce and window state on `publicClient` and `prepareExecution` makes
      // its own reads through `client`; a test that stubbed only the former left the
      // latter talking to a real RPC URL. `validateAgainstScope` then silently SKIPPED its
      // per-window check (core logs "getWindowState unavailable"), so the boundary case
      // passed for the wrong reason — and turned red if anything happened to be listening
      // on that port. `SigilKitClient` already accepted `publicClient`; the runner simply
      // never passed it through.
      publicClient: this.config.publicClient,
    });
    // Honour an injected client for the runner's OWN reads too, not just the SigilKitClient
    // one above. Creating a fresh client here regardless is what made the injection appear
    // to do nothing: `buildContext` kept dialling rpcUrl and the stub was never called.
    this.publicClient =
      this.config.publicClient ??
      createPublicClient({
        chain: this.config.chain,
        transport: http(this.config.rpcUrl),
      });

    if (typeof config.sessionSigner === "string") {
      const account = privateKeyToAccount(config.sessionSigner);
      this.sessionSigner = { address: account.address, sign: async ({ hash }) => account.sign({ hash }) };
    } else {
      this.sessionSigner = config.sessionSigner;
    }

    if (config.relayer) {
      this.relayer = privateKeyToAccount(config.relayer);
    }
  }

  get sessionKeyAddress(): Address {
    return this.sessionSigner.address;
  }

  get isGranted(): boolean {
    return !!this.grantTxHash;
  }

  async adoptGrant(grantTxHash: Hash): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: grantTxHash });
    if (receipt.status !== "success") {
      throw new Error(`grant transaction ${grantTxHash} reverted`);
    }
    if (receipt.to?.toLowerCase() !== this.config.managerAddress.toLowerCase()) {
      throw new Error(`grant did not target manager ${this.config.managerAddress}`);
    }

    const topic = keccak256(toHex("SessionKeyGranted(address,uint48)")) as Hash;
    const paddedKey = padAddress(this.sessionKeyAddress);
    const found = receipt.logs.some((log) => {
      if ((log.topics[0] as Hash | undefined)?.toLowerCase() !== topic.toLowerCase()) return false;
      if ((log.topics[1] as string | undefined)?.toLowerCase() !== paddedKey) return false;
      return true;
    });

    if (!found) {
      throw new Error(`grant did not emit SessionKeyGranted for this session key`);
    }

    this.grantTxHash = grantTxHash;
  }

  async buildContext(): Promise<AgentContext> {
    const balance = await this.publicClient.getBalance({ address: this.config.managerAddress });
    // The nonce must come from the MANAGER's per-key counter, not the session key's own
    // EOA transaction count. They diverge from the first action onward (the manager starts
    // at 0 and increments once per accepted action, while the EOA count includes every
    // unrelated transaction the session key has ever sent), so reading the EOA count makes
    // every request replay-rejected on-chain. Same source `SigilKitClient.prepareExecution`
    // uses when the caller does not supply a nonce.
    const [nonce, windowState] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.managerAddress,
        abi: SESSION_KEY_MANAGER_ABI,
        functionName: "getNonce",
        args: [this.sessionKeyAddress],
      }),
      this.readWindowState(),
    ]);
    const perActionCap = this.config.scope.perActionCap || 0n;
    return {
      tick: this.state.tick,
      managerAddress: this.config.managerAddress,
      balance,
      // Real remaining headroom, not a hardcoded 0. This field used to be a literal, which
      // silently capped every policy-engine decision to zero (`safeAmountWei` takes the
      // minimum of cap, window remaining and balance) and is part of why the advisory
      // LocalModelBrain could never propose.
      windowSpendRemaining: windowState,
      perActionCap,
      nonce: BigInt(nonce),
      expiresAt: this.config.scope.expiresAt || Infinity,
      lastTxHash: this.state.lastTxHash,
      actionsExecuted: this.state.actionsExecuted,
    };
  }

  /**
   * Remaining spend in the CURRENT fixed window, in wei.
   *
   * Mirrors the SDK's own rollover rule (`signing.ts`): a window is live only while
   * `windowStart != 0` and `block.timestamp < windowStart + windowSeconds`; outside it the
   * whole `perWindowCap` is available again. A read failure returns 0 — the conservative
   * direction, since the on-chain cap still applies at execution and the local number only
   * ever sizes a proposal.
   */
  private async readWindowState(): Promise<bigint> {
    const perWindowCap = this.config.scope.perWindowCap || 0n;
    if (perWindowCap === 0n) return 0n;
    try {
      const state = (await this.publicClient.readContract({
        address: this.config.managerAddress,
        abi: SESSION_KEY_MANAGER_ABI,
        functionName: "getWindowState",
        args: [this.sessionKeyAddress],
      })) as { windowStart: number; spentThisWindow: bigint };

      const windowSeconds = BigInt(this.config.scope.windowSeconds || 0);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const windowStart = BigInt(state.windowStart ?? 0);
      const live = windowStart !== 0n && nowSec < windowStart + windowSeconds;
      const spent = live ? BigInt(state.spentThisWindow ?? 0n) : 0n;
      return spent >= perWindowCap ? 0n : perWindowCap - spent;
    } catch (err) {
      log.warn("getWindowState unavailable — reporting zero remaining window spend", {
        reason: err instanceof Error ? err.message : String(err),
      });
      return 0n;
    }
  }

  private validateAgainstGuardrails(proposal: ActionRequest): { ok: boolean; reason?: string } {
    const nowSec = Math.floor(Date.now() / 1000);
    if (proposal.expiry <= nowSec) {
      return { ok: false, reason: "proposal expired" };
    }
    if (proposal.value > this.config.scope.perActionCap) {
      return { ok: false, reason: "exceeds per-action cap" };
    }
    if (this.config.scope.merkleRoot !== "0x" + "0".repeat(64)) {
      if (!this.config.whitelistLeaves || this.config.whitelistLeaves.length === 0) {
        return { ok: false, reason: "merkleRoot non-zero but no whitelistLeaves provided" };
      }
    }
    return { ok: true };
  }

  private proofFor(request: ActionRequest): Hex[] | undefined {
    if (!this.config.whitelistLeaves || this.config.whitelistLeaves.length === 0) return undefined;
    const pinnedLeaf = targetLeaf(request.target, request.selector, request.data);
    const wildcardLeaf = targetLeaf(request.target, request.selector);
    const pinned = pinnedLeaf && this.config.whitelistLeaves.find((l) => l.toLowerCase() === pinnedLeaf.toLowerCase());
    const leaf = pinned ?? (wildcardLeaf && this.config.whitelistLeaves.find((l) => l.toLowerCase() === wildcardLeaf.toLowerCase()));
    if (!leaf) {
      throw new Error(`strategy produced an action outside whitelist (target=${request.target}, selector=${request.selector})`);
    }
    return merkleProof(this.config.whitelistLeaves, leaf);
  }

  async tick(): Promise<TickResult> {
    // `state.tick` advances once per loop iteration, in a `finally`, so it counts
    // ATTEMPTS rather than successes. Brains gate on it as a schedule
    // (`tick % period === offset`), and a brain that returns null — the common case —
    // would otherwise never advance the phase, so a tick-gated brain could never fire.
    try {
      return await this.runTick();
    } finally {
      this.state.tick += 1;
    }
  }

  private async runTick(): Promise<TickResult> {
    const context = await this.buildContext();
    const proposal = await this.config.brain.propose(context);
    if (!proposal) {
      return { executed: false, reason: "idle" };
    }

    const guarded = this.validateAgainstGuardrails(proposal);
    if (!guarded.ok) {
      console.warn(`brain proposal rejected by guardrail: ${guarded.reason}`);
      return { executed: false, reason: "guardrail-rejected" };
    }

    let prepared;
    try {
      prepared = await this.client.prepareExecution({
        account: this.sessionSigner,
        request: proposal,
        scope: this.config.scope,
        merkleProof: this.proofFor(proposal),
      });
    } catch (err) {
      console.error(`prepareExecution failed:`, err instanceof Error ? err.message : err);
      throw err;
    }

    if (!this.relayer) {
      const payload = { to: prepared.to, data: prepared.data };
      this.state.lastPrepared = payload;
      this.state.actionsExecuted += 1;
      return { executed: true, broadcast: false, prepared: payload };
    }

    const relayerWallet = createWalletClient({ account: this.relayer, chain: this.config.chain, transport: http(this.config.rpcUrl) });
    const txHash = await relayerWallet.sendTransaction({ account: this.relayer, chain: this.config.chain, to: prepared.to, data: prepared.data });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`execution reverted: ${txHash}`);
    }

    const audited = await this.client.assertAuditEmitted(txHash, {
      agentId: proposal.agentId,
      target: proposal.target,
      selector: proposal.selector,
      value: proposal.value,
      rationaleHash: proposal.rationaleHash,
    });
    if (!audited) {
      throw new Error("INV-3 violated: ActionLogged missing after successful execution");
    }

    this.state.actionsExecuted += 1;
    this.state.lastTxHash = txHash;
    return { executed: true, broadcast: true, txHash, audited: true };
  }
}
