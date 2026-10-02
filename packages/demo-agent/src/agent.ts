/**
 * SigilKit demo agent — an autonomous treasury bot exercising the full stack:
 *
 *   owner grants scoped session key → agent evaluates a strategy each tick →
 *   when a signal fires, the agent SIGNS an ActionRequest with its session key
 *   (zero-gas local policy pre-check) → a relayer submits executeWithSessionKey →
 *   the contract enforces caps/whitelist on-chain and emits ActionLogged.
 *
 * ── SEC-06 · role separation ────────────────────────────────────────────────────────
 * This process holds exactly TWO hot keys, and they are unrelated to each other:
 *
 *   sessionSigner  the agent's own identity. Signs EIP-712 ActionRequests and nothing
 *                  else. It is not the owner, so it can never call grantSessionKey /
 *                  revokeSessionKey / withdraw — on-chain `onlyOwner` enforces that even
 *                  if this file were wrong, so the two agree by construction.
 *   relayer        pays gas for ALREADY-SIGNED calldata. It needs no owner rights: the
 *                  contract recovers the SESSION key from the EIP-712 signature, not the
 *                  relayer's. A relayer therefore needs to hold no balance at all — the
 *                  SessionKeyManager contract holds the funds, not the relayer.
 *
 * There is deliberately **no owner key anywhere in this file**. The claim "the blast
 * radius of a compromised agent is the granted scope, never the wallet balance" is only
 * true because the owner key is absent: an attacker who owns this process can drain the
 * *granted scope* and burn the relayer's gas money, and nothing else.
 *
 * The owner grants scope from a SEPARATE process / Safe / HSM. This process learns of
 * the grant only as an already-mined transaction hash — see {@link TreasuryAgent.adoptGrant}.
 * That is the whole point: the authority to grant lives where the agent cannot reach it.
 */
import {
  SigilKitClient,
  SESSION_KEY_MANAGER_ABI,
  merkleProof,
  targetLeaf,
  type ActionRequest,
  type Scope,
} from "@sigilkit/core";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
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

/**
 * The agent's signing identity, narrowed to the single capability it needs.
 *
 * Deliberately NOT viem's `LocalAccount`/`PrivateKeyAccount`: a full account can
 * `signTransaction`, which is strictly more authority than an agent ever needs. Requiring
 * only `sign({hash})` means a caller cannot smuggle an owner-capable account in here
 * even by accident.
 */
export interface SessionSigner {
  readonly address: Address;
  sign(args: { hash: Hash }): Promise<Hex>;
}

/** Wraps a private key as a {@link SessionSigner} — signs hashes, nothing else. */
export function sessionSignerFromKey(privateKey: Hex): SessionSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: async ({ hash }: { hash: Hash }) => account.sign({ hash }),
  };
}

/** The minimal account shape SigilKitClient expects from a signing key. */
const signerAccount = (s: SessionSigner) => ({ address: s.address, sign: s.sign });

export interface TreasuryAgentConfig {
  chain: Chain;
  rpcUrl: string;
  managerAddress: Address;
  /**
   * The agent's session key — its identity, and the ONLY key that signs actions.
   * Accepts either a raw private key (hot, short-lived: rotate it, and treat a leak as
   * a scope-sized incident, not a treasury-sized one) or an already-built
   * {@link SessionSigner} (e.g. a remote signer / KMS that never exposes the key).
   */
  sessionSigner: Hex | SessionSigner;
  /**
   * Gas-only key that submits already-signed calldata. Optional: omit it and the agent
   * signs but never broadcasts, which is the right shape when a separate relayer service
   * does the sending. It is NOT an owner key and must never be given owner rights.
   */
  relayer?: Hex;
  /** Scope granted for this run. Mirrored for the local pre-check; the chain is the authority. */
  scope: Scope;
  /**
   * The scope's whitelist leaves, required whenever `scope.merkleRoot` is non-zero.
   *
   * A non-zero root is enforced on-chain against a sorted-pair Merkle proof, and the local
   * pre-flight refuses an action with no proof ("target not whitelisted"). The agent
   * therefore has to carry the leaf set its scope was built from, exactly as the owner-side
   * grant did. Omit it only for an allow-all scope (root 0), where no proof is consulted.
   */
  whitelistLeaves?: Hash[];
  /** Strategy: given the tick number, return the action to take or null to idle. */
  strategy: (tick: number, state: AgentState) => StrategyAction | null;
}

/** Proof that the OWNER — not the agent — granted this key its scope. */
export interface GrantRecord {
  /** Hash of the owner's `grantSessionKey` transaction. */
  grantTxHash: Hash;
}

export interface AgentState {
  tick: number;
  actionsExecuted: number;
  lastTxHash?: Hash;
  /** Last signed-but-not-broadcast payload, when running without a relayer. */
  lastPrepared?: PreparedRelay;
}

/** A signed payload awaiting submission by whoever holds the gas key. */
export interface PreparedRelay {
  to: Address;
  data: Hex;
}

/** Outcome of one tick: idle, or a fired action in either delivery mode. */
export type TickResult =
  | { executed: false }
  | { executed: true; broadcast: true; txHash: Hash }
  | { executed: true; broadcast: false; prepared: PreparedRelay };

/**
 * Consecutive failed ticks tolerated before {@link TreasuryAgent.run} gives up.
 *
 * Per-tick errors stay swallowed — a transient outage must not kill a long-running agent —
 * but a run that has failed this many ticks in a row is not recovering on its own (dead
 * RPC, revoked grant, exhausted window), and grinding out the remaining ticks at the
 * strategy's own rate turns a dead endpoint into a busy loop that still "succeeds".
 */
const MAX_CONSECUTIVE_TICK_FAILURES = 5;

export class TreasuryAgent {
  private config: TreasuryAgentConfig;
  private client: SigilKitClient;
  private readonly sessionSigner: SessionSigner;
  private readonly relayer?: ReturnType<typeof privateKeyToAccount>;
  /** Owner-issued grant this run is operating under; undefined until adoptGrant(). */
  private grant?: GrantRecord;
  state: AgentState = { tick: 0, actionsExecuted: 0 };

  constructor(config: TreasuryAgentConfig) {
    this.config = config;
    this.sessionSigner =
      typeof config.sessionSigner === "string"
        ? sessionSignerFromKey(config.sessionSigner)
        : config.sessionSigner;
    this.client = new SigilKitClient({
      managerAddress: config.managerAddress,
      chain: config.chain,
      rpcUrl: config.rpcUrl,
    });
    // A relayer is a gas payer, not an authority. `privateKeyToAccount` here is the ONLY
    // account this process derives, and it derives it from `relayer`, never from an owner key.
    this.relayer = config.relayer ? privateKeyToAccount(config.relayer) : undefined;
  }

  /** The session-key address actions are signed for (public, safe to log). */
  get sessionKeyAddress(): Address {
    return this.sessionSigner.address;
  }

  /** True once an owner-issued grant has been adopted; see {@link adoptGrant}. */
  get isGranted(): boolean {
    return this.grant !== undefined;
  }

  /**
   * Adopts a grant that the OWNER already executed, and verifies it on-chain.
   *
   * This replaces the old `grantScope()`, which held the owner private key and could
   * therefore grant itself any scope it liked — the exact SEC-06 defect. The agent no
   * longer has the authority to grant; it can only *observe* a grant, and it verifies
   * that observation rather than trusting the caller's word for it:
   *
   *   - the tx is mined and successful;
   *   - it called the configured manager;
   *   - it emitted `SessionKeyGranted` for THIS agent's session key.
   *
   * Failing any check throws, so a caller cannot hand the agent an unrelated tx hash and
   * have it proceed on the assumption that a scope exists.
   */
  async adoptGrant(grant: GrantRecord): Promise<void> {
    const publicClient = createPublicClient({
      chain: this.config.chain,
      transport: http(this.config.rpcUrl),
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: grant.grantTxHash });
    if (receipt.status !== "success") {
      throw new Error(`grant transaction ${grant.grantTxHash} reverted — no scope was granted`);
    }
    if (receipt.to?.toLowerCase() !== this.config.managerAddress.toLowerCase()) {
      throw new Error(
        `grant transaction ${grant.grantTxHash} targeted ${receipt.to ?? "no contract"}, ` +
          `not the configured manager ${this.config.managerAddress}`,
      );
    }

    const key = this.sessionSigner.address;
    const granted = receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== this.config.managerAddress.toLowerCase()) return false;
      if (log.topics[0]?.toLowerCase() !== SESSION_KEY_GRANTED_TOPIC.toLowerCase()) return false;
      // An indexed `address` topic is the 20-byte address LEFT-PADDED to a full 32-byte
      // word, so it must be padded before comparison — `0x7099…79c8` never equals
      // `0x000…7099…79c8`. Both sides are lowercased: keccak256 emits mixed-case hex.
      if (log.topics[1]?.toLowerCase() !== padAddress(key)) return false;
      return true;
    });
    if (!granted) {
      throw new Error(
        `grant transaction ${grant.grantTxHash} did not emit SessionKeyGranted for this agent's ` +
          `session key ${key} — it was not granted this scope`,
      );
    }

    // The adopted grant is the authority for this run; keep the caller's hash for the
    // receipt/audit trail so the run can be tied back to the owner's transaction.
    this.grant = { grantTxHash: grant.grantTxHash };
  }

  /** Owner-issued grant backing the current run, or undefined before adoptGrant(). */
  grantRecord(): GrantRecord | undefined {
    return this.grant;
  }

  /** Runs one strategy tick; executes and audits if the strategy returns an action. */
  async tick(): Promise<TickResult> {
    const tick = this.state.tick++;
    const action = this.config.strategy(tick, this.state);
    if (!action) return { executed: false };

    // prepareExecution performs the zero-gas local policy check + EIP-712 signing.
    const prepared = await this.client.prepareExecution({
      account: signerAccount(this.sessionSigner),
      request: action,
      scope: this.config.scope,
      // A pinned scope can only be executed with a proof of membership; without this the
      // local pre-flight rejects every action before a signature is ever spent.
      merkleProof: this.proofFor(action),
    });

    if (!this.relayer) {
      // Sign-only mode: hand the relayer-ready payload back instead of broadcasting, so
      // this process never needs a gas key. An external relayer submits it.
      const payload: PreparedRelay = { to: prepared.to, data: prepared.data };
      this.state.lastPrepared = payload;
      this.state.actionsExecuted += 1;
      return { executed: true, broadcast: false, prepared: payload };
    }

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
    return { executed: true, broadcast: true, txHash };
  }

  /**
   * Sorted-pair proof of `request`'s leaf in the configured whitelist, or undefined when the
   * scope is allow-all.
   *
   * The candidates are tried in the same order the contract's `_targetAllowed` tries them:
   * the pinned leaf (commits this calldata) first, then the wildcard leaf. An action outside
   * the granted set is a bug in the strategy, not a tick to retry, so it throws.
   */
  private proofFor(request: StrategyAction): Hex[] | undefined {
    const leaves = this.config.whitelistLeaves;
    if (leaves === undefined || leaves.length === 0) return undefined;
    // Core's merkleProof matches by EXACT string equality, so the element taken FROM the set
    // is what gets proven, not a freshly computed hash of the same leaf.
    const inSet = (leaf: Hash): Hash | undefined =>
      leaves.find((l) => l.toLowerCase() === leaf.toLowerCase());
    const pinned = inSet(targetLeaf(request.target, request.selector, request.data));
    const leaf = pinned ?? inSet(targetLeaf(request.target, request.selector));
    if (leaf === undefined) {
      throw new Error(
        `strategy produced an action outside the granted whitelist (target ${request.target}, ` +
          `selector ${request.selector}) — add it to whitelistLeaves, or grant a zero merkleRoot`,
      );
    }
    return merkleProof(leaves, leaf);
  }

  /** Runs `n` ticks with `delayMs` between them. */
  async run(n: number, delayMs = 1_000): Promise<AgentState> {
    let consecutiveFailures = 0;
    for (let i = 0; i < n; i++) {
      try {
        await this.tick();
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        console.error(`[tick ${i}] failed:`, err instanceof Error ? err.message : err);
        if (consecutiveFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
          throw new Error(
            `aborting the run after ${consecutiveFailures} consecutive failed ticks: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Back off while ticks keep failing (capped at 64x), so a dead endpoint is not
      // hammered at the strategy's steady-state rate. A clean tick resets the delay.
      const backoff = consecutiveFailures === 0 ? 1 : 2 ** Math.min(consecutiveFailures, 6);
      await new Promise((r) => setTimeout(r, delayMs * backoff));
    }
    return this.state;
  }
}

/** keccak256("SessionKeyGranted(address,uint48)") — the owner-side grant event. */
const SESSION_KEY_GRANTED_TOPIC = keccak256(
  toHex("SessionKeyGranted(address,uint48)"),
) as Hash;

/** Left-pads an address to a 32-byte log topic, lowercased for comparison. */
function padAddress(address: Address): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
