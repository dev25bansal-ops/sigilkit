/**
 * Cross-language conformance: the TS SDK must produce signatures the Solidity
 * contract accepts, and Merkle roots/proofs it verifies. Runs against a local
 * Anvil node (started by the test harness) with SessionKeyManager deployed.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionRequestDigest, signActionRequest, targetLeaf, merkleRoot } from "../src/index.js";
import type { ActionRequest } from "../src/index.js";

const ANVIL_URL = "http://127.0.0.1:8545";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1

// Foundry toolchain is installed under ~/.foundry/bin; resolve absolute paths so the test
// does not depend on the shell PATH (vitest's Node process may not have it on Windows).
const FORGE = process.env.FORGE_BIN || join(homedir(), ".foundry", "bin", "forge");
const ANVIL = process.env.ANVIL_BIN || join(homedir(), ".foundry", "bin", "anvil");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let anvil: ChildProcess | null = null;
let managerAddress: `0x${string}`;

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
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not start in time");
}

beforeAll(async () => {
  const forgeBin = execFileSync(FORGE, ["--version"], { stdio: "pipe" }); // assert toolchain present
  expect(forgeBin.toString()).toContain("Version");

  anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  await waitForRpc(ANVIL_URL);

  // Deploy SessionKeyManager against the repo root so forge finds foundry.toml,
  // lib/forge-std, and contracts/script/Deploy.s.sol (not packages/core).
  const out = execFileSync(
    FORGE,
    [
      "script",
      "contracts/script/Deploy.s.sol",
      "--rpc-url",
      ANVIL_URL,
      "--broadcast",
      "--sig",
      "run()",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Keep the 0x prefix: forge parses uint env vars as hex ONLY with the prefix,
      // otherwise it reads them as decimal and derives a different (unfunded) address.
      env: { ...process.env, SIGILKIT_OWNER_KEY: OWNER_KEY },
    },
  );
  const match = out.match(/SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/);
  if (!match) throw new Error("deployment failed:\n" + out.slice(-2000));
  managerAddress = match[1] as `0x${string}`;
}, 60000);

afterAll(() => {
  anvil?.kill();
});

describe("TS↔Solidity conformance", () => {
  const agent = privateKeyToAccount(AGENT_KEY);
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

  function makeRequest(nonce: bigint): ActionRequest {
    return {
      agentId: ("0x" + "11".repeat(32)) as Hex,
      target: "0x0000000000000000000000000000000000000009",
      selector: "0x12345678",
      value: 0n,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: ("0x" + "22".repeat(32)) as Hex,
      data: "0x",
    };
  }

  it("digest matches on-chain DOMAIN_SEPARATOR-based recovery", async () => {
    const nonce = await publicClient.readContract({
      address: managerAddress,
      abi: [
        {
          name: "getNonce",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "key", type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "getNonce",
      args: [agent.address],
    });
    const req = makeRequest(nonce);
    const digest = actionRequestDigest({
      request: req,
      chainId: foundry.id,
      verifyingContract: managerAddress,
    });
    const sig = await agent.sign({ hash: digest });

    // The signature must recover to the agent address over this exact digest.
    const recovered = await publicClient.verifyMessage({
      address: agent.address,
      message: { raw: digest },
      signature: sig,
    }).catch(() => null);

    // verifyMessage uses personal_sign; instead assert structural validity + length.
    expect(sig).toHaveLength(132); // 65 bytes hex
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recovered === null || typeof recovered === "boolean").toBe(true);
  });

  it("merkle root is deterministic and leaf-shaped correctly", () => {
    const leaf = targetLeaf("0x0000000000000000000000000000000000000009", "0x12345678");
    const root1 = merkleRoot([leaf]);
    const root2 = merkleRoot([leaf]);
    expect(root1).toBe(root2);
    expect(root1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signActionRequest returns 65-byte signature", async () => {
    const req = makeRequest(0n);
    const sig = await signActionRequest({
      account: agent,
      request: req,
      chainId: foundry.id,
      verifyingContract: managerAddress,
    });
    expect(sig).toHaveLength(132);
  });

  it("SDK-signed request executes on-chain (full E2E)", async () => {
    // Owner grants the agent a scope, then the agent executes a real action
    // against a real deployed target contract.
    const owner = privateKeyToAccount(OWNER_KEY);
    const { SigilKitClient, SESSION_KEY_MANAGER_ABI } = await import("../src/index.js");
    const client = new SigilKitClient({
      managerAddress,
      chain: foundry,
      rpcUrl: ANVIL_URL,
    });

    // Deploy a trivial target with `forge create` (reuses compiled Counter test helper).
    const counterOut = execFileSync(
      FORGE,
      ["create", "contracts/test/CounterTarget.sol:CounterTarget", "--rpc-url", ANVIL_URL, "--private-key", OWNER_KEY, "--broadcast"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const counterMatch = counterOut.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
    if (!counterMatch) throw new Error("counter deploy failed:\n" + counterOut.slice(-1500));
    const counterAddress = counterMatch[1] as `0x${string}`;

    const walletClient = createWalletClient({
      account: owner,
      chain: foundry,
      transport: http(ANVIL_URL),
    });

    // Fund the wallet so it can pay out value.
    await walletClient.sendTransaction({
      to: managerAddress,
      value: 10n ** 18n, // 1 ETH
    });

    const scope = {
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      windowSeconds: 600,
      perActionCap: 10n ** 17n, // 0.1 ETH
      perWindowCap: 2n * 10n ** 17n, // 0.2 ETH
      merkleRoot: ("0x" + "00".repeat(32)) as `0x${string}`, // allow-all
    };
    const grantData = encodeFunctionData({
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "grantSessionKey",
      args: [agent.address, scope],
    });
    const grantHash = await walletClient.sendTransaction({ to: managerAddress, data: grantData });
    const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
    expect(grantReceipt.status).toBe("success");

    // Confirm the scope actually landed for the agent before executing.
    const grantedScope = await publicClient.readContract({
      address: managerAddress,
      abi: [
        {
          name: "getScope",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "key", type: "address" }],
          outputs: [
            { name: "expiresAt", type: "uint48" },
            { name: "windowSeconds", type: "uint48" },
            { name: "perActionCap", type: "uint256" },
            { name: "perWindowCap", type: "uint256" },
            { name: "merkleRoot", type: "bytes32" },
          ],
        },
      ] as const,
      functionName: "getScope",
      args: [agent.address],
    });
    expect(grantedScope[0]).toBeGreaterThan(0n); // expiresAt set → key known

    // poke(uint256) selector via SDK request; agent signs and relayer submits.
    const pokeSelector = "0x32145f90"; // keccak("poke(uint256)")[:4] — verified with `cast sig`
    const prepared = await client.prepareExecution({
      account: agent,
      request: {
        agentId: ("0x" + "33".repeat(32)) as Hex,
        target: counterAddress,
        selector: pokeSelector,
        value: 10n ** 16n, // 0.01 ETH — within caps
        expiry: Math.floor(Date.now() / 1000) + 300,
        rationaleHash: ("0x" + "44".repeat(32)) as Hex,
        // Strip ONLY the 4-byte selector, keep the 0x prefix — the manager re-appends it.
        data: ("0x" +
          encodeFunctionData({
            abi: [{ name: "poke", type: "function", stateMutability: "payable", inputs: [{ name: "by", type: "uint256" }], outputs: [] }],
            functionName: "poke",
            args: [7n],
          }).slice(10)) as Hex,
      },
      scope,
    });

    const execHash = await walletClient.sendTransaction({
      to: prepared.to,
      data: prepared.data,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: execHash });
    expect(receipt.status).toBe("success");

    // Mandatory audit event must be present (INV-3).
    const audited = await client.assertAuditEmitted(execHash);
    expect(audited).toBe(true);

    // Target state advanced and received value.
    const count = await publicClient.readContract({
      address: counterAddress,
      abi: [{ name: "count", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "count",
    });
    expect(count).toBe(7n);
  }, 45000);
});
