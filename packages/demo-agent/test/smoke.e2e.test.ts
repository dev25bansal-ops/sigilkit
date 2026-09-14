/**
 * Demo-agent end-to-end smoke test (CQ-4).
 *
 * The README leads with `npm run demo` — "deploy → grant scoped key → strategy ticks" — and
 * nothing verified that flow. This test runs the SAME path the CLI runs: deploy
 * SessionKeyManager + a CounterTarget, fund the wallet, grant a scoped session key, then let
 * TreasuryAgent fire two on-chain actions and confirm each one landed with its audit event.
 *
 * Skips (rather than fails) when the Foundry toolchain is absent, so a machine without
 * forge/anvil still gets a green unit run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Address, Hex } from "viem";
import { TreasuryAgent } from "../src/agent.js";

const ANVIL_URL = "http://127.0.0.1:8545";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // anvil #0
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // anvil #1
const FORGE = process.env.FORGE_BIN ?? join(homedir(), ".foundry", "bin", "forge");
const ANVIL = process.env.ANVIL_BIN ?? join(homedir(), ".foundry", "bin", "anvil");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let anvil: ChildProcess | null = null;
let available = false;

async function waitForRpc(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not start in time");
}

beforeAll(async () => {
  try {
    const v = execFileSync(FORGE, ["--version"], { stdio: "pipe" }).toString();
    if (!v.includes("Version")) return;
    anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
    await waitForRpc(ANVIL_URL);
    available = true;
  } catch {
    available = false;
  }
}, 60000);

afterAll(() => {
  anvil?.kill();
});

describe("demo agent end-to-end (CQ-4)", () => {
  it("runs the documented flow: grant → tick → on-chain enforce → ActionLogged", async () => {
    if (!available) {
      console.warn("skipping demo e2e: forge/anvil not available");
      return;
    }

    // 1. Deploy the manager (same script the CLI uses).
    const deployOut = execFileSync(
      FORGE,
      ["script", "contracts/script/Deploy.s.sol", "--rpc-url", ANVIL_URL, "--broadcast", "--sig", "run()"],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, SIGILKIT_OWNER_KEY: OWNER_KEY } },
    );
    const managerAddress = deployOut.match(/SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/)![1] as Address;

    // 2. Deploy the target the strategy pokes.
    const counterOut = execFileSync(
      FORGE,
      ["create", "contracts/test/CounterTarget.sol:CounterTarget", "--rpc-url", ANVIL_URL, "--private-key", OWNER_KEY, "--broadcast"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const counterAddress = counterOut.match(/Deployed to: (0x[0-9a-fA-F]{40})/)![1] as Address;

    // 3. Fund the wallet so agents can spend from its balance.
    const owner = privateKeyToAccount(OWNER_KEY);
    const ownerWallet = createWalletClient({ account: owner, chain: foundry, transport: http(ANVIL_URL) });
    await ownerWallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });

    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const pokeSelector = ("0x" + keccak256(toHex("poke(uint256)")).slice(2, 10)) as Hex;

    // 4. The agent under test — strategy fires on ticks 1 and 3, exactly like the CLI.
    const agent = new TreasuryAgent({
      chain: foundry,
      rpcUrl: ANVIL_URL,
      managerAddress,
      agentPrivateKey: AGENT_KEY,
      ownerPrivateKey: OWNER_KEY,
      scope: {
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        windowSeconds: 600,
        perActionCap: 10n ** 16n, // 0.01 ETH
        perWindowCap: 5n * 10n ** 16n, // 0.05 ETH
        merkleRoot: toHex(new Uint8Array(32)), // allow-all for the demo
        countersignAbove: 0n,
        enforceNativeDelta: false,
        tokenWatchlist: [],
      },
      strategy: (tick) =>
        tick !== 1 && tick !== 3
          ? null
          : {
              agentId: keccak256(toHex("demo-treasury-v1")),
              target: counterAddress,
              selector: pokeSelector,
              value: 4n * 10n ** 15n, // 0.004 ETH — within caps
              expiry: Math.floor(Date.now() / 1000) + 120,
              rationaleHash: keccak256(toHex(`rebalance tick ${tick}`)),
              // Args only — the manager prepends `request.selector` itself.
              data: encodeAbiParameters([{ type: "uint256" }], [BigInt(tick)]),
            },
    });

    // 5. Owner grants the scoped session key.
    const grantHash = await agent.grantScope();
    const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
    expect(grantReceipt.status).toBe("success");

    // 6. Run 5 ticks — two should execute, three should idle.
    const finalState = await agent.run(5, 100);
    expect(finalState.tick).toBe(5);
    expect(finalState.actionsExecuted, "the strategy fires on ticks 1 and 3").toBe(2);
    expect(finalState.lastTxHash).toBeDefined();

    // 7. The mandatory audit event fired (INV-3) and the target recorded the pokes.
    expect(await agent["client"].assertAuditEmitted(finalState.lastTxHash!)).toBe(true);

    const count = await publicClient.readContract({
      address: counterAddress,
      abi: [{ name: "count", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "count",
    });
    expect(count, "poke(1) + poke(3)").toBe(4n);
  }, 120000);
});
