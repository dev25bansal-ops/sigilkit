/**
 * StubBrain: a deterministic decision provider for testing and demo purposes.
 *
 * Proposes actions when tick % period === offset AND balance exceeds threshold.
 * Never proposes out-of-policy actions: guardrails are applied at proposal time
 * so rejected decisions never reach zero-gas validation.
 */

import type { DecisionProvider, AgentContext } from "../types.js";
import type { ActionRequest } from "@sigilkit/core";
import type { Address, Hash } from "viem";

export class StubBrain implements DecisionProvider {
  readonly name = "StubBrain (deterministic demo)";

  constructor(
    private readonly config: {
      targetAddress: Address;
      transferSelector: string; // bytes4("transfer(address,uint256)")
      amountWhenFires: bigint;
      period: number; // propose every N ticks
      offset: number; // first fire at tick %period == offset
      minBalanceThreshold: bigint; // require balance >= this to propose
      maxActionsPerRun: number; // hard cap on total actions
    },
  ) {}

  async propose(context: AgentContext): Promise<ActionRequest | null> {
    const { tick, perActionCap, expiresAt, managerAddress, nonce, lastTxHash } = context;

    // Guardrail 1: check if this tick should fire
    if (tick % this.config.period !== this.config.offset) {
      return null;
    }

    // Guardrail 2: don't exceed balance threshold
    if (context.balance < this.config.amountWhenFires) {
      return null;
    }

    // Guardrail 3: enforce per-action cap
    if (this.config.amountWhenFires > perActionCap) {
      throw new Error(
        `StubBrain guardrail failed: proposed amount ${this.config.amountWhenFires} exceeds perActionCap ${perActionCap}`,
      );
    }

    // Guardrail 4: hard action count limit
    if (context.actionsExecuted >= this.config.maxActionsPerRun) {
      console.warn(`StubBrain hitting maxActionsPerRun=${this.config.maxActionsPerRun}`);
      return null;
    }

    // All guardrails pass — build the request
    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = Math.min(expiresAt, nowSec + 3600); // never expire more than 1 hour ahead

    return {
      agentId: `0x${"ab".padEnd(64, "0")}` as Hash,
      target: this.config.targetAddress,
      selector: `0x${this.config.transferSelector.padEnd(8, "0")}` as Address,
      value: this.config.amountWhenFires,
      nonce,
      expiry,
      rationaleHash: `0x${"cd".padEnd(64, "0")}` as Hash,
      data: "0x",
    };
  }
}
