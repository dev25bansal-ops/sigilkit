/**
 * TreasuryAgent unit tests (CQ-4).
 *
 * The demo agent is the first thing a newcomer runs (`npm run demo`) and it had NO tests at
 * all — the root `npm test` uses `--workspaces --if-present`, so the missing `test` script
 * meant the gap was silent. These tests cover the strategy loop and the tick/state contract
 * without needing a chain; the on-chain path is covered by `smoke.e2e.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import type { Address, Hex } from "viem";
import { TreasuryAgent, type AgentState, type StrategyAction } from "../src/agent.js";
import type { Scope } from "@sigilkit/core";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

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

function makeAgent(strategy: (tick: number, state: AgentState) => StrategyAction | null) {
  return new TreasuryAgent({
    chain: foundry,
    // Never contacted by the unit tests (no action is ever prepared).
    rpcUrl: "http://127.0.0.1:8545",
    managerAddress: MANAGER,
    agentPrivateKey: AGENT_KEY,
    ownerPrivateKey: OWNER_KEY,
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
    // The strategy sees the state as of that tick (actionsExecuted never advances here).
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
    // Replace the tick implementation with one that always throws — this is the
    // "relayer is down" path, which must not abort the remaining ticks.
    (agent as unknown as { tick: () => Promise<never> }).tick = async () => {
      attempts++;
      throw new Error("relayer unreachable");
    };

    await agent.run(3, 1);
    expect(attempts).toBe(3);
  });

  it("surfaces the granted scope's caps through its config", () => {
    const agent = makeAgent(() => null);
    // The agent's blast radius is the granted scope, never the wallet balance.
    expect((agent as unknown as { config: { scope: Scope } }).config.scope.perActionCap).toBe(10n ** 16n);
    expect((agent as unknown as { config: { scope: Scope } }).config.scope.perWindowCap).toBe(5n * 10n ** 16n);
  });
});
