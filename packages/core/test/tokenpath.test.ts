/**
 * checkTokenPath unit tests (BUG-4 / CQ-2 / PERF-1 regression pins).
 *
 * The pre-check is advisory, but it was wrong on its primary branch: it queried
 * `allowance(from, token)` instead of `allowance(from, manager)`, so a correctly
 * approved ERC-20 reported a spurious warning — and it only ran that check in the
 * one case where no allowance is needed at all (`from == manager`). A `as never`
 * cast suppressed the type error that would have caught it.
 *
 * These tests use a stubbed PublicClient (no node required) so they assert the exact
 * arguments sent on the wire.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { SigilKitClient } from "../src/index.js";
import type { ActionRequest } from "../src/index.js";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN = "0x00000000000000000000000000000000000000bb" as Address;
const ALICE = "0x00000000000000000000000000000000000000cc" as Address;

type Recorded = { functionName: string; args: readonly unknown[] };

function stubClient(opts: {
  balance?: bigint;
  allowance?: bigint;
  fail?: boolean;
}): { client: SigilKitClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const stub = {
    readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
      calls.push({ functionName: a.functionName, args: a.args ?? [] });
      if (opts.fail) throw new Error("execution reverted: non-standard token");
      if (a.functionName === "balanceOf") return opts.balance ?? 0n;
      if (a.functionName === "allowance") return opts.allowance ?? 0n;
      throw new Error(`unexpected read: ${a.functionName}`);
    },
  } as unknown as PublicClient;

  const client = new SigilKitClient({ managerAddress: MANAGER, chain: foundry, publicClient: stub });
  return { client, calls };
}

function request(selector: Hex, args: readonly unknown[]): ActionRequest {
  let data: Hex = "0x";
  if (selector === "0xa9059cbb") {
    const abi = [
      { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
    ] as const;
    data = ("0x" + encodeFunctionData({ abi, functionName: "transfer", args: args as never }).slice(10)) as Hex;
  } else if (selector === "0x23b872dd") {
    const abi = [
      { name: "transferFrom", type: "function", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
    ] as const;
    data = ("0x" + encodeFunctionData({ abi, functionName: "transferFrom", args: args as never }).slice(10)) as Hex;
  }
  return {
    agentId: `0x${"11".repeat(32)}` as Hex,
    target: TOKEN,
    selector,
    value: 0n,
    nonce: 0n,
    expiry: Math.floor(Date.now() / 1000) + 300,
    rationaleHash: `0x${"22".repeat(32)}` as Hex,
    data,
  };
}

describe("checkTokenPath", () => {
  it("transfer: checks the manager's balance and never probes decimals()", async () => {
    const { client, calls } = stubClient({ balance: 100n });
    const report = await client.checkTokenPath(request("0xa9059cbb", [ALICE, 50n]));

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ kind: "balance", ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.functionName).toBe("balanceOf");
    expect(calls[0]!.args[0]).toBe(MANAGER);
    // PERF-1: the previous implementation issued an extra, discarded decimals() read.
    expect(calls.some((c) => c.functionName === "decimals")).toBe(false);
  });

  it("transferFrom (spender is the manager): allowance is read with the MANAGER as spender", async () => {
    const { client, calls } = stubClient({ balance: 100n, allowance: 100n });
    const report = await client.checkTokenPath(request("0x23b872dd", [ALICE, MANAGER, 50n]));

    const allowanceCall = calls.find((c) => c.functionName === "allowance");
    expect(allowanceCall, "an allowance check must run when from != manager").toBeDefined();
    // The regression: this used to be TOKEN (the token contract as its own spender).
    expect(allowanceCall!.args[0]).toBe(ALICE);
    expect(allowanceCall!.args[1]).toBe(MANAGER);

    const kinds = report.checks.map((c) => c.kind).sort();
    expect(kinds).toEqual(["allowance", "balance"]);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("transferFrom with from == manager: no allowance check is emitted", async () => {
    const { client, calls } = stubClient({ balance: 100n });
    const report = await client.checkTokenPath(request("0x23b872dd", [MANAGER, ALICE, 50n]));

    expect(calls.some((c) => c.functionName === "allowance")).toBe(false);
    expect(report.checks.map((c) => c.kind)).toEqual(["balance"]);
  });

  it("warns (ok: false) when the allowance is genuinely short", async () => {
    const { client } = stubClient({ balance: 100n, allowance: 10n });
    const report = await client.checkTokenPath(request("0x23b872dd", [ALICE, MANAGER, 50n]));
    const allowance = report.checks.find((c) => c.kind === "allowance")!;
    expect(allowance.ok).toBe(false);
    expect(allowance.detail).toContain("allowance(");
  });

  it("is advisory only: a failed read never throws and reports ok: false with the error text", async () => {
    const { client } = stubClient({ fail: true });
    const report = await client.checkTokenPath(request("0xa9059cbb", [ALICE, 50n]));
    expect(report.checks).toHaveLength(1);
    // A read that threw leaves the balance UNKNOWN, never "sufficient". The pre-check is
    // still advisory (it never throws), but an unverifiable token must surface as a
    // warning, not as a silent pass with the error discarded.
    expect(report.checks[0]!.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("read failed");
    expect(report.checks[0]!.detail).toContain("execution reverted: non-standard token");
  });

  it("unknown selectors produce no checks at all", async () => {
    const { client, calls } = stubClient({});
    const report = await client.checkTokenPath(request("0xdeadbeef", []));
    expect(report.checks).toEqual([]);
    expect(calls).toEqual([]);
  });
});
