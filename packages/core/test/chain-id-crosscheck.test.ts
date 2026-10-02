/**
 * `expectedChainId` — the EIP-712 domain cannot be silently built from the wrong chain.
 *
 * `prepareExecution` signs with `chain.id` (`client.ts`), and the deployed contract compares
 * that digest against ITS `DOMAIN_SEPARATOR`, which is bound to the chain the manager was
 * deployed on. So if a caller's viem `Chain` object disagrees with the chain id the operator
 * configured (`SIGILKIT_CHAIN_ID`, surfaced by `loadServiceConfig(env).chainId`), every
 * signature the SDK produces is well-formed and wrong: the request reverts on-chain with
 * `InvalidSignature` AFTER gas is spent, and nothing in the SDK reports a problem.
 *
 * The two values come from different places — a `Chain` literal in code versus the
 * environment — so nothing else in the process would ever have compared them. These tests
 * pin the guard, and pin that it is OPT-IN: a caller who never heard of the option keeps
 * the previous behaviour exactly.
 */
import { describe, expect, it } from "vitest";
import { foundry, mainnet } from "viem/chains";
import { SigilKitClient, type SigilKitClientConfig } from "../src/index.js";
import type { Address, PublicClient } from "viem";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;

/** A client never used here — every test throws before any RPC would be needed. */
function baseConfig(overrides: Partial<SigilKitClientConfig> = {}): SigilKitClientConfig {
  return {
    managerAddress: MANAGER,
    chain: foundry,
    // A stub keeps the constructor's client wiring honest if the guard ever moves.
    publicClient: {} as unknown as PublicClient,
    ...overrides,
  };
}

describe("SigilKitClient chain-id cross-check", () => {
  it("accepts a matching chain id", () => {
    expect(() => new SigilKitClient(baseConfig({ expectedChainId: foundry.id }))).not.toThrow();
  });

  it("rejects a mismatched chain id, naming both values", () => {
    // foundry.id is 31337; mainnet.id is 1. The message must carry BOTH so an operator can
    // tell which side is wrong without reading the SDK source.
    let caught: Error | undefined;
    try {
      new SigilKitClient(baseConfig({ chain: foundry, expectedChainId: mainnet.id }));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain(String(mainnet.id));
    expect(caught!.message).toContain(String(foundry.id));
    expect(caught!.name).toBe("ValidationError");
  });

  it("fails at CONSTRUCTION, before any signature can be produced", () => {
    // The whole point is that no gas is ever spent. If the guard ran later (at prepare or
    // send time) the mis-signing would already have happened.
    expect(() => new SigilKitClient(baseConfig({ expectedChainId: mainnet.id }))).toThrow();
  });

  it("stays opt-in: omitting expectedChainId preserves the previous behaviour", () => {
    // Back-compat guard. A cross-check that were mandatory would break every existing
    // caller, so "no expectedChainId" must construct successfully on its own.
    expect(() => new SigilKitClient(baseConfig())).not.toThrow();
  });

  it("treats an explicit undefined as 'not supplied'", () => {
    expect(() => new SigilKitClient(baseConfig({ expectedChainId: undefined }))).not.toThrow();
  });

  it("rejects 0 as a chain id rather than accepting it as falsy", () => {
    // Guards against an `if (expectedChainId && …)` implementation, which would silently
    // skip the check for 0. 0 is never a real chain id, so this must be a mismatch.
    expect(() => new SigilKitClient(baseConfig({ expectedChainId: 0 }))).toThrow();
  });
});
