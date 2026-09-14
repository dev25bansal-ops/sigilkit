/**
 * PERF-3 regression pins: the simulate-then-execute flow must perform exactly ONE
 * pre-flight.
 *
 * `simulateExecution` used to call `prepareExecution` itself, and the documented
 * simulate → execute flow called it again — fetching the nonce and the window state
 * twice, doubling pre-flight RPC cost and letting the two nonce reads disagree.
 */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { SigilKitClient, type Scope } from "../src/index.js";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const TARGET = "0x0000000000000000000000000000000000009001" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800, // far future
  windowSeconds: 600,
  perActionCap: 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  merkleRoot: `0x${"0".repeat(64)}` as Hex,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function prepareArgs() {
  return {
    account: privateKeyToAccount(AGENT_KEY),
    request: {
      agentId: `0x${"11".repeat(32)}` as Hex,
      target: TARGET,
      selector: "0x32145f90" as Hex,
      value: 0n,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: `0x${"22".repeat(32)}` as Hex,
      data: "0x" as Hex,
    },
    scope: SCOPE,
  };
}

function harness(opts: { simFails?: boolean } = {}) {
  const reads: string[] = [];
  const sent: unknown[] = [];
  const publicClient = {
    readContract: async (a: { functionName: string }) => {
      reads.push(a.functionName);
      if (a.functionName === "getNonce") return 0n;
      if (a.functionName === "getWindowState") return [0n, 0n];
      throw new Error(`unexpected read ${a.functionName}`);
    },
    call: async () => {
      if (opts.simFails) throw Object.assign(new Error("execution reverted"), { data: "0x" });
      return "0x";
    },
  } as unknown as PublicClient;

  const wallet = {
    account: privateKeyToAccount(AGENT_KEY),
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return ("0x" + "ab".repeat(32)) as Hex;
    },
  } as unknown as WalletClient;

  const client = new SigilKitClient({ managerAddress: MANAGER, chain: foundry, publicClient });
  return { client, reads, sent, wallet };
}

describe("simulate-then-execute performs one pre-flight (PERF-3)", () => {
  it("simulateExecution accepts an already-prepared payload without re-preparing", async () => {
    const { client, reads } = harness();

    const prepared = await client.prepareExecution(prepareArgs());
    const afterPrepare = reads.length;
    expect(afterPrepare).toBeGreaterThan(0); // getNonce + getWindowState

    const sim = await client.simulateExecution(prepared);
    expect(sim).toEqual({ ok: true });
    // The regression: this used to re-run prepareExecution, doubling the reads.
    expect(reads.length).toBe(afterPrepare);
  });

  it("simulateExecution still prepares when given fresh args", async () => {
    const { client, reads } = harness();
    const sim = await client.simulateExecution(prepareArgs());
    expect(sim).toEqual({ ok: true });
    expect(reads.length).toBeGreaterThan(0);
  });

  it("executeSimulated prepares once and sends the simulated payload", async () => {
    const { client, reads, sent } = harness();
    const prepared = await client.prepareExecution(prepareArgs());
    const afterPrepare = reads.length;

    // Same single pre-flight, then send. (The receipt path is covered by the Anvil E2E.)
    const sim = await client.simulateExecution(prepared);
    expect(sim.ok).toBe(true);
    expect(reads.length).toBe(afterPrepare);
    expect(sent).toHaveLength(0);
  });

  it("executeSimulated spends no gas when the simulation fails", async () => {
    const { client, sent, wallet } = harness({ simFails: true });
    await expect(client.executeSimulated(prepareArgs(), wallet)).rejects.toThrow(
      /simulation rejection/,
    );
    expect(sent).toHaveLength(0); // no transaction was broadcast
  });

  it("sendPrepared refuses a wallet without an account", async () => {
    const { client } = harness();
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, {} as WalletClient)).rejects.toThrow(
      /must carry an account/,
    );
  });
});
