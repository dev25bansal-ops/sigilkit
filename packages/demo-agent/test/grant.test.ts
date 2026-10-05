/**
 * adoptGrant verification tests (SEC-6).
 *
 * `adoptGrant` is the only way an agent can come to believe it holds a scope, so its
 * REJECTION paths matter more than its happy path: the e2e test covers acceptance, and
 * this file proves the agent will not be fooled by a plausible-but-wrong transaction.
 *
 * A live chain is not needed to test rejection. `adoptGrant` reads a receipt over
 * JSON-RPC, so a tiny stub server returns exactly the receipt the test wants to assert
 * against — including receipts a real chain could never produce. That keeps these tests
 * fast and covers the "successful tx, but it granted someone else" case that a live
 * chain would make expensive to set up.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { TreasuryAgent, sessionSignerFromKey } from "../src/agent.js";
import type { Scope } from "@sigilkit/core";

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER_MANAGER = "0x00000000000000000000000000000000000000bb" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SESSION_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const OTHER_KEY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const GRANT_TX = ("0x" + "ab".repeat(32)) as Hex;
const RECIPIENT = ("0x" + "cd".repeat(20)) as Address;

const TOPIC = keccak256(toHex("SessionKeyGranted(address,uint48)")).toLowerCase();
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

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

/** What the stub node returns for the next receipt request. */
let nextReceipt: unknown = null;
let server: Server;
let rpcUrl: string;

function receipt(over: Record<string, unknown> = {}) {
  return {
    transactionHash: GRANT_TX,
    blockHash: "0x" + "11".repeat(32),
    blockNumber: "0x1",
    transactionIndex: "0x0",
    from: RECIPIENT,
    to: MANAGER,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    status: "0x1",
    type: "0x2",
    ...over,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const result =
        payload.method === "eth_getTransactionReceipt"
          ? nextReceipt
          : payload.method === "eth_chainId"
            ? "0x7a69"
            : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? 1, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function agentAt(manager: Address = MANAGER) {
  return new TreasuryAgent({
    chain: foundry,
    rpcUrl,
    managerAddress: manager,
    sessionSigner: sessionSignerFromKey(AGENT_KEY),
    scope: SCOPE,
    strategy: () => null,
  });
}

describe("adoptGrant acceptance", () => {
  it("accepts a real SessionKeyGranted for this agent's key", async () => {
    nextReceipt = receipt({
      logs: [{ address: MANAGER, topics: [TOPIC, pad(SESSION_KEY)], data: "0x" }],
    });
    const agent = agentAt();
    await agent.adoptGrant({ grantTxHash: GRANT_TX });
    expect(agent.isGranted).toBe(true);
    expect(agent.grantRecord()).toEqual({ grantTxHash: GRANT_TX });
  });

  it("accepts a rotation grant, which emits the same event for the new key", async () => {
    // rotateSessionKey emits SessionKeyGranted(newKey, …) as well, so a rotated-in key
    // is a legitimate grant and must not be rejected.
    nextReceipt = receipt({
      logs: [
        { address: MANAGER, topics: [TOPIC, pad(OTHER_KEY)], data: "0x" },
        { address: MANAGER, topics: [TOPIC, pad(SESSION_KEY)], data: "0x" },
      ],
    });
    await agentAt().adoptGrant({ grantTxHash: GRANT_TX });
  });
});

describe("adoptGrant rejection (SEC-6 — never trust the caller's word)", () => {
  it("rejects a reverted grant", async () => {
    nextReceipt = receipt({ status: "0x0" });
    await expect(agentAt().adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow(/reverted/i);
  });

  it("rejects a grant sent to a different contract", async () => {
    nextReceipt = receipt({ to: OTHER_MANAGER });
    await expect(agentAt().adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow(/not the configured manager/i);
  });

  it("rejects a successful tx that granted a DIFFERENT key", async () => {
    // The dangerous case: a perfectly valid grantSessionKey, just not for this agent.
    nextReceipt = receipt({
      logs: [{ address: MANAGER, topics: [TOPIC, pad(OTHER_KEY)], data: "0x" }],
    });
    await expect(agentAt().adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow(
      /did not emit SessionKeyGranted/i,
    );
  });

  it("rejects a tx that emitted no grant event at all", async () => {
    nextReceipt = receipt();
    await expect(agentAt().adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow(
      /did not emit SessionKeyGranted/i,
    );
  });

  it("rejects the right event emitted by the wrong contract", async () => {
    // A contract that is not the configured manager must not be able to satisfy the
    // grant check by emitting a look-alike event.
    nextReceipt = receipt({
      to: MANAGER,
      logs: [{ address: OTHER_MANAGER, topics: [TOPIC, pad(SESSION_KEY)], data: "0x" }],
    });
    await expect(agentAt().adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow(
      /did not emit SessionKeyGranted/i,
    );
  });

  it("leaves the agent unauthorised after any rejection", async () => {
    nextReceipt = receipt({ status: "0x0" });
    const agent = agentAt();
    await expect(agent.adoptGrant({ grantTxHash: GRANT_TX })).rejects.toThrow();
    // A failed adoption must not leave the agent believing it holds a scope.
    expect(agent.isGranted).toBe(false);
    expect(agent.grantRecord()).toBeUndefined();
  });
});
