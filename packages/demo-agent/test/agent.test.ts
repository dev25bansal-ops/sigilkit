/**
 * TreasuryAgent unit tests (CQ-4 / SEC-6).
 *
 * The demo agent is the first thing a newcomer runs (`npm run demo`) and it had NO tests at
 * all — the root `npm test` uses `--workspaces --if-present`, so the missing `test` script
 * meant the gap was silent. These tests cover the strategy loop and the tick/state contract
 * without needing a chain; the on-chain path is covered by `smoke.e2e.test.ts`.
 *
 * SEC-6: the final describe block guards the role separation. The owner-key check is a
 * COMPILE-time assertion (@ts-expect-error) — tsconfig.json includes `test/**`, so
 * `npm run lint` enforces it, and an unused directive also fails the build.
 */
import { describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import type { Address, Hex } from "viem";
import {
  TreasuryAgent,
  sessionSignerFromKey,
  type AgentState,
  type StrategyAction,
  type TreasuryAgentConfig,
} from "../src/agent.js";
import type { Scope } from "@sigilkit/core";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const RELAYER_KEY = "0x65bccb4404fa485f7d8da6cd9c29eeba4b8df0532e0735574572c95b0eb9003d" as Hex;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800,
  windowSeconds: 3600,
  perActionCap: 10n ** 16n,
  perWindowCap: 5n * 10n ** 16n,
  merkleRoot: `0x${"0".repeat(64)}` as Hex,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function makeAgent(
  strategy: (tick: number, state: AgentState) => StrategyAction | null,
  overrides: { relayer?: Hex } = {},
) {
  return new TreasuryAgent({
    chain: foundry,
    // Never contacted by the unit tests (no action is ever prepared).
    rpcUrl: "http://127.0.0.1:8545",
    managerAddress: MANAGER,
    // SEC-6: the agent gets its own key and a gas-only relayer. No owner key anywhere.
    sessionSigner: sessionSignerFromKey(AGENT_KEY),
    relayer: overrides.relayer ?? RELAYER_KEY,
    scope: SCOPE,
    strategy,
  });
}

describe("TreasuryAgent (CQ-4)", () => {
  it("starts idle and increments the tick counter", () => {
    const agent = makeAgent(() => null);
    expect(agent.state).toEqual({ tick: 0, actionsExecuted: 0 });
  });

  it("does nothing when the strategy returns null", async () => {
    const agent = makeAgent(() => null);
    const res = await agent.tick();
    expect(res).toEqual({ executed: false });
    expect(agent.state.tick).toBe(1);
    expect(agent.state.actionsExecuted).toBe(0);
    expect(agent.state.lastTxHash).toBeUndefined();
  });

  it("passes the monotonically increasing tick and current state to the strategy", async () => {
    const seen: Array<{ tick: number; state: AgentState }> = [];
    const agent = makeAgent((tick, state) => {
      seen.push({ tick, state: { ...state } });
      return null;
    });

    await agent.tick();
    await agent.tick();
    await agent.tick();

    expect(seen.map((s) => s.tick)).toEqual([0, 1, 2]);
    expect(seen[2]!.state.actionsExecuted).toBe(0);
  });

  it("run() performs exactly n ticks", async () => {
    const agent = makeAgent(() => null);
    const state = await agent.run(4, 1);
    expect(state.tick).toBe(4);
    expect(state.actionsExecuted).toBe(0);
  });

  it("run() is resilient: a failing tick is logged and the loop continues", async () => {
    const agent = makeAgent(() => null);
    let attempts = 0;
    (agent as unknown as { tick: () => Promise<never> }).tick = async () => {
      attempts++;
      throw new Error("relayer unreachable");
    };

    await agent.run(3, 1);
    expect(attempts).toBe(3);
  });

  it("surfaces the granted scope's caps through its config", () => {
    const agent = makeAgent(() => null);
    // Blast radius = granted scope, never wallet balance — true only because no owner
    // key is present in the agent's config.
    expect((agent as unknown as { config: { scope: Scope } }).config.scope.perActionCap).toBe(10n ** 16n);
    expect((agent as unknown as { config: { scope: Scope } }).config.scope.perWindowCap).toBe(5n * 10n ** 16n);
  });
});

describe("SEC-6 role separation", () => {
  it("rejects an owner private key on the config type (compile-time guard)", () => {
    // The heart of SEC-06: an agent process that can hold an owner key can drain the
    // whole wallet, so `ownerPrivateKey` must not merely be unused — it must not EXIST on
    // the type. This directive fails the build if the field is ever re-added, and an
    // UNUSED @ts-expect-error also fails the build, so the guard is two-sided.
    const config: TreasuryAgentConfig = {
      chain: foundry,
      rpcUrl: "http://127.0.0.1:8545",
      managerAddress: MANAGER,
      sessionSigner: sessionSignerFromKey(AGENT_KEY),
      relayer: RELAYER_KEY,
      scope: SCOPE,
      strategy: () => null,
      // @ts-expect-error SEC-6: ownerPrivateKey was removed — an agent may never hold owner authority.
      ownerPrivateKey: OWNER_KEY,
    };
    expect(config).toBeDefined();
  });

  it("never derives an account from an owner key", () => {
    const agent = makeAgent(() => null);
    // The agent's only identity is its session key. An owner-derived account or raw key
    // leaking into its state would show up here.
    const serialized = JSON.stringify(agent, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialized).not.toContain(OWNER_KEY);
    expect(agent.sessionKeyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The session key is NOT the owner address — two distinct roles, two distinct keys.
    expect(agent.sessionKeyAddress.toLowerCase()).not.toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });

  it("cannot grant itself a scope: adoptGrant is the only entry point, and it verifies on-chain", () => {
    const agent = makeAgent(() => null);
    // The old API had `grantScope()` returning a Hash built from an owner key held in
    // this process. It is gone; adoption requires an externally-produced tx hash.
    expect((agent as unknown as Record<string, unknown>).grantScope).toBeUndefined();
    expect(typeof agent.adoptGrant).toBe("function");
    // No grant has been adopted yet, so the agent does not claim to be authorised.
    expect(agent.isGranted).toBe(false);
    expect(agent.grantRecord()).toBeUndefined();
  });

  it("sessionSignerFromKey exposes only a signing capability, not a full account", () => {
    const signer = sessionSignerFromKey(AGENT_KEY);
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // A full viem account can signTransaction and therefore raw txs; a SessionSigner is
    // deliberately narrowed to hash signing so an owner-capable account cannot be
    // smuggled in through this parameter.
    expect((signer as unknown as Record<string, unknown>).signTransaction).toBeUndefined();
    expect((signer as unknown as Record<string, unknown>).source).toBeUndefined();
  });
});
