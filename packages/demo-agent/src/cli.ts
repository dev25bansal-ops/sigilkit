#!/usr/bin/env node
/**
 * sigilkit-demo — end-to-end demo of the SigilKit primitives against a local Anvil node.
 *
 * ⚠️  DEMO TOPOLOGY ONLY — NOT A PRODUCTION PATTERN.
 * A single command here performs three roles that production MUST split across separate
 * trust domains: deployer, owner, and agent+relayer loop. The owner key is an env var, and
 * with `--grant` it lives in the SAME process as the agent — so "blast radius = granted
 * scope" is FALSE in the demo path. That is precisely the SEC-06 defect, kept visible here
 * for the convenience of a zero-setup demo. This exists to exercise the contracts, not to
 * be copied. See "Production topology" in the package README.
 *
 * What it does, in order:
 *   1. (owner role, opt-in) deploys SessionKeyManager and a Counter target
 *   2. (owner role, opt-in) funds the manager so the agent has something to spend
 *   3. (owner role, opt-in) grants a 1-hour scoped session key
 *   4. (agent role)       runs N strategy ticks — ticks 1 and 3 fire a 0.004 ETH "rebalance"
 *
 * Steps 1–3 require `--grant` (or SIGILKIT_DEMO_GRANT=1) so the owner credential is never
 * touched unless the operator asks. To keep the owner OUT of this process entirely, pass
 * `--grant-tx <hash>`: the agent then adopts a grant the owner executed elsewhere and
 * verifies it on-chain. In that mode no owner key is loaded at all.
 *
 * Prerequisites: `anvil` listening on the RPC URL below, and `forge` available
 * (Foundry on PATH, or FORGE_BIN set).
 *
 *   anvil
 *   npm run demo -- --grant
 *   npm run demo -- --ticks 10 --rpc http://127.0.0.1:8545
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, toHex, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { SESSION_KEY_MANAGER_ABI, targetLeaf } from "@sigilkit/core";
import { runCli, UserError, type CliSpec } from "@sigilkit/core/cli";
import { loadServiceConfig } from "@sigilkit/core/config";
import { TreasuryAgent, sessionSignerFromKey } from "./agent.js";
// SEC-4: RPC/forge paths and the (public, allowlisted) Anvil dev keys live in one module.
// SEC-6: importing that module also enforces the non-loopback + dev-key startup guardrail.
import { AGENT_KEY, ANVIL_URL, assertSafeDemoEnvironment, FORGE, OWNER_KEY, RELAYER_KEY } from "./devkeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SPEC: CliSpec = {
  name: "sigilkit-demo",
  version: "0.2.0",
  summary: "Deploy SigilKit to a local chain, grant a scoped session key, and run an autonomous agent loop.",
  usage: [
    "sigilkit-demo --grant [--ticks <n>] [--tick-delay <ms>] [--json]",
    "sigilkit-demo --grant-tx <hash> --counter <address>   # adopt an owner grant made elsewhere",
  ],
  flags: [
    { name: "--rpc", value: "<url>", description: "JSON-RPC endpoint (env: SIGILKIT_RPC_URL, default http://127.0.0.1:8545)" },
    { name: "--chain-id", value: "<id>", description: "Chain id (env: SIGILKIT_CHAIN_ID, default 31337)" },
    { name: "--ticks", value: "<n>", description: "Strategy ticks to run (default 5; the strategy fires on ticks 1 and 3, so < 4 ticks means fewer actions)" },
    { name: "--tick-delay", value: "<ms>", description: "Delay between ticks in milliseconds (default 500)" },
    {
      name: "--grant",
      description: "OWNER-SIDE STEP: also deploy, fund and grantSessionKey using the owner key (env: SIGILKIT_DEMO_GRANT=1). Demo topology only.",
    },
    {
      name: "--grant-tx",
      value: "<hash>",
      description: "Adopt an existing owner grantSessionKey tx instead of creating one — the owner never enters this process.",
    },
    { name: "--counter", value: "<address>", description: "Counter target address for --grant-tx mode (the strategy pokes it)." },
    {
      name: "--yes",
      description:
        "Acknowledge the owner-side funding transfers up front, instead of being prompted for each one (required when stdin is not a terminal).",
    },
    { name: "--json", description: "Emit a machine-readable summary on completion" },
  ],
  examples: [
    "anvil &",
    "sigilkit-demo --grant",
    "sigilkit-demo --grant-tx 0xabc… --counter 0xdef…",
    "sigilkit-demo --grant --ticks 10 --tick-delay 200",
  ],
  notes: [
    "REQUIREMENTS",
    "  A local `anvil` on the RPC endpoint, and `forge` (Foundry on PATH, or FORGE_BIN).",
    "  Uses Anvil's public development keys by default; override with SIGILKIT_OWNER_KEY",
    "  and SIGILKIT_AGENT_KEY. A dev key against a NON-loopback RPC is refused at startup.",
    "",
    "  DEMO TOPOLOGY ONLY — NOT A PRODUCTION PATTERN.",
    "  With --grant the owner key is in this process alongside the agent, so the",
    "  \"blast radius = granted scope\" property does NOT hold here. Production: owner in a",
    "  Safe/HSM in another process, agent signing in its own process, relayer gas-only.",
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

/**
 * Extracts a deployed address from forge output, or fails with a readable error.
 * Replaces the non-asserting `output.match(...)![1]` this file used to use, which
 * surfaced a bare `TypeError: Cannot read properties of null` on a failed deploy.
 */
function requireDeployed(output: string, pattern: RegExp, what: string): `0x${string}` {
  const match = output.match(pattern);
  if (!match?.[1]) {
    throw new UserError(
      `${what} deployment failed — forge printed no address`,
      `expected output matching ${pattern}\nforge output tail:\n${output.slice(-800)}`,
    );
  }
  return match[1] as `0x${string}`;
}

/**
 * Asks the operator to acknowledge a value-bearing owner step before it is broadcast.
 *
 * Fail-closed: with no terminal on stdin there is nobody to answer, so the step is REFUSED
 * rather than run unconfirmed (or left hanging on a prompt no one can see). `skip` is
 * `--yes`, the explicit opt-out for a run that has already decided.
 */
async function confirmOwnerSpend(what: string, skip: boolean): Promise<void> {
  if (skip) return;
  if (process.stdin.isTTY !== true) {
    throw new UserError(
      "refusing to broadcast the owner-side funding transfers without confirmation",
      "stdin is not a terminal, so the confirmation cannot be answered; re-run with --yes to acknowledge it explicitly.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${what}\nProceed? type "yes" to continue: `, resolve),
    );
    if (answer.trim().toLowerCase() !== "yes") {
      throw new UserError("aborted before any funds moved", "re-run with --yes to skip this prompt.");
    }
  } finally {
    rl.close();
  }
}

await runCli(SPEC, process.argv.slice(2), async (args) => {
  const config = loadServiceConfig();
  const rpcUrl = args.url("--rpc") ?? config.rpcUrl ?? ANVIL_URL;
  // SEC-6: the guard in devkeys.ts runs at IMPORT time against ANVIL_URL only, so `--rpc`
  // (and any config-supplied URL) walked straight past it — a public Anvil dev key could be
  // pointed at a real network and would sign there. It is re-evaluated here against the
  // RESOLVED endpoint, before any key reaches a wallet and before anything is signed. It
  // THROWS; it is never downgraded to a warning, and it fails closed on an unparseable URL.
  assertSafeDemoEnvironment(rpcUrl, {
    owner: OWNER_KEY,
    agent: AGENT_KEY,
    relayer: RELAYER_KEY,
  });
  const chainId = args.int("--chain-id", { min: 1 }) ?? config.chainId;
  const ticks = args.int("--ticks", { min: 1, max: 10_000 }) ?? 5;
  const tickDelay = args.int("--tick-delay", { min: 0, max: 600_000 }) ?? 500;
  const json = args.has("--json");
  const grantTx = args.hash32("--grant-tx");
  const counterFlag = args.address("--counter");
  // The owner credential is opt-in: with no --grant there is no owner side effect, and
  // with --grant-tx the owner key is not used at all — the agent adopts an existing grant.
  const doGrant = args.has("--grant") || process.env.SIGILKIT_DEMO_GRANT === "1";

  if (grantTx && doGrant) {
    throw new UserError(
      "--grant-tx and --grant are mutually exclusive",
      "use --grant-tx to adopt an existing owner grant, or --grant to create a new one.",
    );
  }
  if (grantTx && !counterFlag) {
    throw new UserError(
      "--grant-tx requires --counter <address>",
      "the agent's strategy pokes the counter target; pass its address (or use --grant to deploy one).",
    );
  }
  if (doGrant && !json) {
    console.warn(
      "⚠  OWNER STEP: this process will hold the OWNER key (deploy + fund + grantSessionKey).\n" +
        "   That is a DEMO convenience, not a production topology: in production the owner lives\n" +
        "   in a Safe/HSM in a separate process, and the agent never sees an owner key at all.\n" +
        "   Proceeding because --grant / SIGILKIT_DEMO_GRANT=1 was set.",
    );
  }

  try {
    const forgeVersion = sh(FORGE, ["--version"]);
    if (!forgeVersion.includes("Version")) throw new Error("unexpected forge --version output");
  } catch (err) {
    throw new UserError(
      `forge not found or not runnable at ${FORGE}`,
      "install Foundry (https://getfoundry.sh) and/or set FORGE_BIN to the forge executable. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const chain = chainFor(chainId, rpcUrl);

  // Fail fast with a clear message when nothing is listening, rather than a timeout
  // buried in the first contract deploy.
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  try {
    await publicClient.getBlockNumber();
  } catch (err) {
    throw new UserError(
      `no JSON-RPC node reachable at ${rpcUrl}`,
      "start one with `anvil` (or point --rpc / SIGILKIT_RPC_URL at a node). " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // ── owner-side setup: deploy + fund ──────────────────────────────────────────────
  let managerAddress: `0x${string}`;
  let counterAddress: `0x${string}`;

  if (doGrant) {
    if (!json) console.log("deploying SessionKeyManager…");
    const deployOut = sh(
      FORGE,
      ["script", "contracts/script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--sig", "run()", "--root", REPO_ROOT],
      { SIGILKIT_OWNER_KEY: OWNER_KEY }, // keep 0x prefix: forge parses uint envs as hex only with it
    );
    managerAddress = requireDeployed(
      deployOut,
      /SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/,
      "manager",
    );
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
    counterAddress = requireDeployed(counterOut, /Deployed to: (0x[0-9a-fA-F]{40})/, "counter target");
    if (!json) console.log("counter:", counterAddress);

    // The MANAGER holds the spendable funds; the relayer holds none of the treasury.
    const ownerWallet = createWalletClient({
      account: privateKeyToAccount(OWNER_KEY),
      chain,
      transport: http(rpcUrl),
    });
    // Real value leaves the owner's wallet here, so name the destination, the amount and
    // the chain first and require an explicit yes before anything is broadcast.
    await confirmOwnerSpend(
      `About to broadcast from the owner key on chain ${chainId} via ${rpcUrl}:\n` +
        `  1 ETH   -> ${managerAddress} (the SessionKeyManager, i.e. the agent's spendable scope)\n` +
        `  0.1 ETH -> ${privateKeyToAccount(RELAYER_KEY).address} (gas-only relayer)`,
      args.has("--yes"),
    );
    await ownerWallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });
    // SEC-6: the relayer needs gas, so it gets a small fixed float — never a share of the
    // treasury. A stolen relayer can then burn only this, not withdraw anything.
    await ownerWallet.sendTransaction({
      to: privateKeyToAccount(RELAYER_KEY).address,
      value: 10n ** 17n,
    });
  } else {
    // Adopted-grant mode: recover the manager from the owner's own grant transaction, so
    // this process needs neither the owner key nor a redeploy. Both flags were validated
    // above (--grant-tx requires --counter), so both are defined on this branch.
    if (!grantTx || !counterFlag) {
      throw new UserError(
        "--grant-tx requires --counter <address>",
        "the agent's strategy pokes the counter target; pass its address (or use --grant to deploy one).",
      );
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: grantTx });
    if (!receipt.to) {
      throw new UserError(`grant transaction ${grantTx} has no target contract`);
    }
    managerAddress = receipt.to;
    counterAddress = counterFlag;
    if (!json) console.log("adopted owner grant:", grantTx, "manager:", managerAddress);
  }

  // ── agent role: session key + gas-only relayer, never the owner key ───────────────
  // SEC-03: the demo's whitelist is exactly the ONE (target, selector) pair its strategy
  // can reach — poke(uint256) on the counter just deployed (or named by --counter). A
  // one-leaf tree's root IS that leaf, so this pins membership instead of granting every
  // target on every contract (merkleRoot 0 = allow ALL, which is what this used to do).
  // The agent carries the leaf so it can hand the sorted-pair proof to prepareExecution;
  // against a non-zero root that proof is what makes the action fireable at all.
  const counterLeaf = targetLeaf(counterAddress, "0x32145f90");
  const scope = {
    expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    windowSeconds: 600,
    perActionCap: 10n ** 16n, // 0.01 ETH
    perWindowCap: 5n * 10n ** 16n, // 0.05 ETH
    merkleRoot: counterLeaf,
    countersignAbove: 0n, // no owner countersign required in the demo
    enforceNativeDelta: false,
    tokenWatchlist: [],
  };

  const agent = new TreasuryAgent({
    chain,
    rpcUrl,
    managerAddress,
    // SEC-6: the agent gets its OWN key plus a gas-only relayer. `ownerPrivateKey` no
    // longer exists on this config, so passing an owner key is a compile error.
    sessionSigner: sessionSignerFromKey(AGENT_KEY),
    relayer: RELAYER_KEY,
    scope,
    whitelistLeaves: [counterLeaf],
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
        // rationaleHash is the on-chain bytes32 DIGEST of the rationale: the old zero-padded
        // hex encoding of the literal text was not a hash, and it published the text.
        rationaleHash: keccak256(toHex(`rebalance tick ${tick}`)) as `0x${string}`,
        // CQ-4: `request.data` is the ARGS ONLY — the manager prepends `request.selector`
        // itself (SessionKeyManager: abi.encodePacked(request.selector, request.data)).
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(tick)]), // poke(tick)
      };
    },
  });

  // ── owner-side grant (opt-in), then the agent ADOPTS it ───────────────────────────
  let adoptedGrant = grantTx;
  if (doGrant) {
    if (!json) console.log("granting scoped session key (owner side)…");
    const ownerWallet = createWalletClient({
      account: privateKeyToAccount(OWNER_KEY),
      chain,
      transport: http(rpcUrl),
    });
    const grantHash = await ownerWallet.sendTransaction({
      to: managerAddress,
      data: encodeFunctionData({
        abi: SESSION_KEY_MANAGER_ABI,
        functionName: "grantSessionKey",
        args: [agent.sessionKeyAddress, scope],
      }),
    });
    const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
    if (grantReceipt.status !== "success") {
      throw new UserError(`grantSessionKey reverted (tx ${grantHash})`, "check the scope caps and that the owner account is funded.");
    }
    // SEC-6: the agent does NOT construct the grant — it adopts the owner's transaction
    // and verifies on-chain that the grant really is for ITS key.
    adoptedGrant = grantHash;
    if (!json) console.log("granted:", grantHash);
  }

  if (!adoptedGrant) {
    // Unreachable: one of the two branches above always sets it. Asserted rather than
    // assumed, so a future refactor cannot silently reach adoptGrant() with no grant.
    throw new UserError(
      "internal: no owner grant to adopt",
      "this is a bug — --grant must produce a grant hash and --grant-tx requires one on the command line.",
    );
  }
  await agent.adoptGrant({ grantTxHash: adoptedGrant });

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
          grantTx: adoptedGrant,
          sessionKey: agent.sessionKeyAddress,
          // ADDRESS, never the key: --json is machine-readable output that gets logged
          // and piped, so it must not carry a private key.
          relayer: privateKeyToAccount(RELAYER_KEY).address,
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
