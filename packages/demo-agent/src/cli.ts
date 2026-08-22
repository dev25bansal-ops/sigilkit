/**
 * Demo CLI: runs the treasury agent against a local Anvil node.
 *
 * Prereqs: `anvil --port 8545` running; foundry available for the target deploy.
 * The demo deploys SessionKeyManager + a Counter target, funds the wallet,
 * grants a 1-hour scoped session key (0.05 ETH/action, 0.1 ETH/window), then runs
 * five strategy ticks — ticks 1 and 3 fire a 0.04 ETH "rebalance" poke.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { TreasuryAgent } from "./agent.js";

const ANVIL_URL = "http://127.0.0.1:8545";
const FORGE = join(homedir(), ".foundry", "bin", "forge");
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1

function sh(cmd: string, args: string[], env?: Record<string, string>) {
  // forge resolves contract paths against CWD — always run from the repo root.
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

async function main() {
  const forgeBin = sh(FORGE, ["--version"]);
  if (!forgeBin.includes("Version")) throw new Error("foundry not installed");

  // Deploy manager + counter target against the running anvil.
  console.log("deploying SessionKeyManager…");
  const deployOut = sh(FORGE, [
    "script", "contracts/script/Deploy.s.sol",
    "--rpc-url", ANVIL_URL, "--broadcast", "--sig", "run()",
    "--root", REPO_ROOT,
  ], { SIGILKIT_OWNER_KEY: OWNER_KEY }); // keep 0x prefix: forge parses uint envs as hex only with it
  const managerMatch = deployOut.match(/SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/);
  if (!managerMatch) throw new Error("manager deploy failed:\n" + deployOut.slice(-800));
  const managerAddress = managerMatch[1] as `0x${string}`;
  console.log("manager:", managerAddress);

  console.log("deploying Counter target…");
  const counterOut = sh(FORGE, [
    "create", "contracts/test/CounterTarget.sol:CounterTarget",
    "--rpc-url", ANVIL_URL, "--private-key", OWNER_KEY, "--broadcast",
    "--root", REPO_ROOT,
  ]);
  const counterMatch = counterOut.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
  if (!counterMatch) throw new Error("counter deploy failed:\n" + counterOut.slice(-800));
  const counterAddress = counterMatch[1] as `0x${string}`;
  console.log("counter:", counterAddress);

  // Fund the wallet with 1 ETH so agents can spend from it.
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
  const owner = privateKeyToAccount(OWNER_KEY);
  const ownerWallet = createWalletClient({ account: owner, chain: foundry, transport: http(ANVIL_URL) });
  await ownerWallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });

  const agent = new TreasuryAgent({
    chain: foundry,
    rpcUrl: ANVIL_URL,
    managerAddress,
    agentPrivateKey: AGENT_KEY,
    ownerPrivateKey: OWNER_KEY,
    scope: {
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      windowSeconds: 600,
      perActionCap: 10n ** 16n, // 0.01 ETH
      perWindowCap: 5n * 10n ** 16n, // 0.05 ETH
      merkleRoot: toHex(new Uint8Array(32)), // allow-all for the demo
    },
    strategy: (tick, state) => {
      if (tick !== 1 && tick !== 3) return null; // idle on other ticks
      return {
        agentId: toHex(new TextEncoder().encode("demo-treasury-v1")).padEnd(66, "0") as `0x${string}`,
        target: counterAddress,
        selector: "0x32145f90", // poke(uint256)
        value: 4n * 10n ** 15n, // 0.004 ETH — within caps
        nonce: BigInt(state.actionsExecuted),
        expiry: Math.floor(Date.now() / 1000) + 120,
        rationaleHash: ("0x" + Buffer.from(`rebalance tick ${tick}`).toString("hex").padStart(64, "0")) as `0x${string}`,
        data: toHex(new Uint8Array(32).fill(Number(tick))), // poke(tick)
      };
    },
  });

  console.log("granting scoped session key…");
  const grantHash = await agent.grantScope();
  await publicClient.waitForTransactionReceipt({ hash: grantHash });
  console.log("granted:", grantHash);

  console.log("running 5 ticks (strategy fires on ticks 1 and 3)…");
  const finalState = await agent.run(5, 500);
  console.log("done.", { actionsExecuted: finalState.actionsExecuted, lastTxHash: finalState.lastTxHash });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
