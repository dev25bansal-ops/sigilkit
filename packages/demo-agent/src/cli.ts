#!/usr/bin/env node
/**
 * sigilkit-demo — end-to-end demo of the SigilKit primitives against a local Anvil node.
 *
 * What it does, in order:
 *   1. deploys SessionKeyManager and a Counter target
 *   2. funds the wallet so the agent has something to spend
 *   3. grants a 1-hour scoped session key (0.01 ETH/action, 0.05 ETH/window)
 *   4. runs N strategy ticks — ticks 1 and 3 fire a 0.004 ETH "rebalance" poke
 *
 * Prerequisites: `anvil` listening on the RPC URL below, and `forge` available
 * (Foundry on PATH, or FORGE_BIN set).
 *
 *   anvil
 *   npm run demo
 *   npm run demo -- --ticks 10 --rpc http://127.0.0.1:8545
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, toHex, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { runCli, UserError, type CliSpec } from "@sigilkit/core/cli";
import { loadServiceConfig } from "@sigilkit/core/config";
import { TreasuryAgent } from "./agent.js";
// SEC-4: RPC/forge paths and the (public, allowlisted) Anvil dev keys live in one module.
import { AGENT_KEY, ANVIL_URL, FORGE, OWNER_KEY } from "./devkeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SPEC: CliSpec = {
  name: "sigilkit-demo",
  version: "0.1.0",
  summary: "Deploy SigilKit to a local chain, grant a scoped session key, and run an autonomous agent loop.",
  usage: ["sigilkit-demo [--rpc <url>] [--chain-id <id>] [--ticks <n>] [--tick-delay <ms>] [--json]"],
  flags: [
    { name: "--rpc", value: "<url>", description: "JSON-RPC endpoint (env: SIGILKIT_RPC_URL, default http://127.0.0.1:8545)" },
    { name: "--chain-id", value: "<id>", description: "Chain id (env: SIGILKIT_CHAIN_ID, default 31337)" },
    { name: "--ticks", value: "<n>", description: "Strategy ticks to run (default 5; the demo strategy fires on ticks 1 and 3, so < 4 ticks means fewer actions)" },
    { name: "--tick-delay", value: "<ms>", description: "Delay between ticks in milliseconds (default 500)" },
    { name: "--json", description: "Emit a machine-readable summary on completion" },
  ],
  examples: [
    "anvil &",
    "sigilkit-demo",
    "sigilkit-demo --ticks 10 --tick-delay 200",
  ],
  notes: [
    "REQUIREMENTS",
    "  A local `anvil` on the RPC endpoint, and `forge` (Foundry on PATH, or FORGE_BIN).",
    "  Uses Anvil's public development keys by default; override with SIGILKIT_OWNER_KEY",
    "  and SIGILKIT_AGENT_KEY. Never point this at a funded chain.",
    "",
    "EXIT CODES",
    "  0  success     1  runtime failure     2  usage error",
  ],
};

function sh(cmd: string, args: string[], env?: Record<string, string>): string {
  // forge resolves contract paths against CWD — always run from the repo root.
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** Uses the viem `foundry` chain for Anvil, and a minimal shim for anything else. */
function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === foundry.id) return foundry;
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain;
}

await runCli(SPEC, process.argv.slice(2), async (args) => {
  const config = loadServiceConfig();
  const rpcUrl = args.url("--rpc") ?? config.rpcUrl ?? ANVIL_URL;
  const chainId = args.int("--chain-id", { min: 1 }) ?? config.chainId;
  const ticks = args.int("--ticks", { min: 1, max: 10_000 }) ?? 5;
  const tickDelay = args.int("--tick-delay", { min: 0, max: 600_000 }) ?? 500;
  const json = args.has("--json");

  try {
    const forgeVersion = sh(FORGE, ["--version"]);
    if (!forgeVersion.includes("Version")) throw new Error("unexpected forge --version output");
  } catch (err) {
    throw new UserError(
      `forge not found or not runnable at ${FORGE}`,
      "install Foundry (https://getfoundry.sh) and/or set FORGE_BIN to the forge executable.",
    );
  }

  const chain = chainFor(chainId, rpcUrl);

  // Fail fast with a clear message when nothing is listening, rather than a timeout
  // buried in the first contract deploy.
  try {
    await createPublicClient({ chain, transport: http(rpcUrl) }).getBlockNumber();
  } catch (err) {
    throw new UserError(
      `no JSON-RPC node reachable at ${rpcUrl}`,
      "start one with `anvil` (or point --rpc / SIGILKIT_RPC_URL at a node).",
    );
  }

  // ── deploy manager + counter target ──────────────────────────────────────────
  if (!json) console.log("deploying SessionKeyManager…");
  const deployOut = sh(
    FORGE,
    ["script", "contracts/script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--sig", "run()", "--root", REPO_ROOT],
    { SIGILKIT_OWNER_KEY: OWNER_KEY }, // keep 0x prefix: forge parses uint envs as hex only with it
  );
  const managerMatch = deployOut.match(/SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/);
  if (!managerMatch) {
    throw new UserError("manager deployment failed", `forge output tail:\n${deployOut.slice(-800)}`);
  }
  const managerAddress = managerMatch[1] as `0x${string}`;
  if (!json) console.log("manager:", managerAddress);

  if (!json) console.log("deploying Counter target…");
  const counterOut = sh(FORGE, [
    "create",
    "contracts/test/CounterTarget.sol:CounterTarget",
    "--rpc-url",
    rpcUrl,
    "--private-key",
    OWNER_KEY,
    "--broadcast",
    "--root",
    REPO_ROOT,
  ]);
  const counterMatch = counterOut.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
  if (!counterMatch) {
    throw new UserError("counter target deployment failed", `forge output tail:\n${counterOut.slice(-800)}`);
  }
  const counterAddress = counterMatch[1] as `0x${string}`;
  if (!json) console.log("counter:", counterAddress);

  // ── fund the wallet so the agent has a budget ────────────────────────────────
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const owner = privateKeyToAccount(OWNER_KEY);
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  await ownerWallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });

  const agent = new TreasuryAgent({
    chain,
    rpcUrl,
    managerAddress,
    agentPrivateKey: AGENT_KEY,
    ownerPrivateKey: OWNER_KEY,
    scope: {
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      windowSeconds: 600,
      perActionCap: 10n ** 16n, // 0.01 ETH
      perWindowCap: 5n * 10n ** 16n, // 0.05 ETH
      merkleRoot: toHex(new Uint8Array(32)), // allow-all for the demo
      countersignAbove: 0n, // no owner countersign required in the demo
      enforceNativeDelta: false,
      tokenWatchlist: [],
    },
    strategy: (tick) => {
      if (tick !== 1 && tick !== 3) return null; // idle on other ticks
      // nonce omitted on purpose: prepareExecution fetches the live getNonce from the
      // manager at fire time, so a failed tick can't permanently desync nonces the way
      // an actionsExecuted-derived counter would.
      return {
        agentId: toHex(new TextEncoder().encode("demo-treasury-v1")).padEnd(66, "0") as `0x${string}`,
        target: counterAddress,
        selector: "0x32145f90", // poke(uint256)
        value: 4n * 10n ** 15n, // 0.004 ETH — within caps
        expiry: Math.floor(Date.now() / 1000) + 120,
        rationaleHash: ("0x" + Buffer.from(`rebalance tick ${tick}`).toString("hex").padStart(64, "0")) as `0x${string}`,
        // CQ-4: `request.data` is the ARGS ONLY — the manager prepends `request.selector`
        // itself (SessionKeyManager: abi.encodePacked(request.selector, request.data)).
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(tick)]), // poke(tick)
      };
    },
  });

  if (!json) console.log("granting scoped session key…");
  const grantHash = await agent.grantScope();
  const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
  if (grantReceipt.status !== "success") {
    throw new UserError(`grantSessionKey reverted (tx ${grantHash})`, "check the scope caps and that the owner account is funded.");
  }
  if (!json) console.log("granted:", grantHash);

  if (!json) console.log(`running ${ticks} ticks (strategy fires on ticks 1 and 3)…`);
  const finalState = await agent.run(ticks, tickDelay);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          manager: managerAddress,
          counter: counterAddress,
          chainId,
          rpcUrl,
          grantTx: grantHash,
          actionsExecuted: finalState.actionsExecuted,
          lastTxHash: finalState.lastTxHash ?? null,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    console.log("done.", { actionsExecuted: finalState.actionsExecuted, lastTxHash: finalState.lastTxHash });
  }
  return 0;
});
