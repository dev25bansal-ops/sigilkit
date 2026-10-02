/**
 * Fleet demo (enhancement E20): TWO agents sharing ONE session key, serialized
 * through SigilKitClient.nonceGate (strictly-sequential on-chain nonces would
 * otherwise double-fire), with a JSON run manifest written to ./fleet-manifest.json
 * and a per-agent audit summary from the typed ActionLogged records.
 *
 * SEC-6 role separation: the fleet workers hold ONLY the agent key (EIP-712 signing) and
 * a gas-only relayer key. The owner key appears exactly once, in the owner-side setup
 * block, and is never handed to a worker. In production that block moves to a separate
 * process entirely (Safe/HSM owner); it is inlined here purely so the demo needs zero
 * setup, which is why the README marks this topology demo-only.
 *
 * Prereq: `anvil --port 8545`. Run: npm run fleet (in packages/demo-agent).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { SigilKitClient, SESSION_KEY_MANAGER_ABI, merkleProof, targetLeaf, type ActionLogRecord, type Scope } from "@sigilkit/core";
// SEC-4: shared demo config — the Anvil dev keys are allowlisted in .gitleaks.toml.
// SEC-6: importing this module also enforces the non-loopback + dev-key guardrail.
import { AGENT_KEY, ANVIL_URL, FORGE, OWNER_KEY, RELAYER_KEY } from "./devkeys.js";
// P0-3/R27: logger symbols come from the `/logger` subpath, so progress/errors honour
// SIGILKIT_LOG_LEVEL / SIGILKIT_LOG_FORMAT instead of bypassing it via console.*.
import { createLogger } from "@sigilkit/core/logger";

const log = createLogger({ scope: "fleet" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const sh = (cmd: string, args: string[], env?: Record<string, string>) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: env ? { ...process.env, ...env } : process.env,
  });

/**
 * Extracts a deployed address from forge output, or throws a readable error.
 *
 * Replaces the `output.match(...)![1]` this file used to use: a non-asserting destructure
 * turned any failed or reworded forge run into an opaque
 * `TypeError: Cannot read properties of null (reading '1')`, which says nothing about the
 * real cause. Now a missing address names the step AND tails the forge output.
 */
function requireDeployed(output: string, pattern: RegExp, what: string): Address {
  const match = output.match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `${what} deployment failed — forge printed no address.\n` +
        `expected output matching ${pattern}\nforge output tail:\n${output.slice(-800)}`,
    );
  }
  return match[1] as Address;
}

async function main() {
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

  // ── owner-side setup (the owner key is used HERE ONLY, never by a worker) ────────
  const wallet = createWalletClient({
    account: privateKeyToAccount(OWNER_KEY),
    chain: foundry,
    transport: http(ANVIL_URL),
  });

  log.info("deploying SessionKeyManager…");
  const deployOut = sh(
    FORGE,
    ["script", "contracts/script/Deploy.s.sol", "--rpc-url", ANVIL_URL, "--broadcast", "--sig", "run()", "--root", REPO_ROOT],
    { SIGILKIT_OWNER_KEY: OWNER_KEY },
  );
  const managerAddress = requireDeployed(
    deployOut,
    /SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/,
    "SessionKeyManager",
  );
  const counterOut = sh(FORGE, [
    "create", "contracts/test/CounterTarget.sol:CounterTarget", "--rpc-url", ANVIL_URL, "--private-key", OWNER_KEY, "--broadcast", "--root", REPO_ROOT,
  ]);
  const counterAddress = requireDeployed(counterOut, /Deployed to: (0x[0-9a-fA-F]{40})/, "CounterTarget");

  // The manager holds the spendable balance; the relayer gets a small gas float and
  // never a share of the treasury (SEC-6) — a stolen relayer burns only this.
  await wallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });
  await wallet.sendTransaction({ to: privateKeyToAccount(RELAYER_KEY).address, value: 10n ** 17n });

  // ── agent role ─────────────────────────────────────────────────────────────────
  // The shared fleet key signs actions; the relayer only pays gas. Neither is the owner,
  // so a compromised worker cannot revoke, re-grant, or withdraw.
  const agent = privateKeyToAccount(AGENT_KEY);
  const relayer = privateKeyToAccount(RELAYER_KEY);
  const relayerWallet = createWalletClient({ account: relayer, chain: foundry, transport: http(ANVIL_URL) });

  // SEC-03: the fleet's whitelist is the ONE (target, selector) pair its workers can reach
  // — poke(uint256) on the counter just deployed. A one-leaf tree's root IS that leaf, so
  // this pins membership instead of granting every target on every contract (root 0).
  const counterLeaf = targetLeaf(counterAddress, "0x32145f90");
  const scope = {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    windowSeconds: 600,
    perActionCap: 10n ** 16n,
    perWindowCap: 5n * 10n ** 16n,
    merkleRoot: counterLeaf,
    countersignAbove: 0n,
    enforceNativeDelta: false,
    tokenWatchlist: [],
  };
  const grantHash = await wallet.sendTransaction({
    to: managerAddress,
    data: encodeGrant(agent.address, scope),
  });
  const grantReceipt = await publicClient.waitForTransactionReceipt({ hash: grantHash });
  if (grantReceipt.status !== "success") throw new Error("grant reverted");

  const client = new SigilKitClient({ managerAddress, chain: foundry, rpcUrl: ANVIL_URL });
  // R08 (seam, unused on purpose): no `leaseStore` is passed, so the cross-process
  // lease seam (`lease-fs` FileLeaseStore / SafeGate) is not wired in this demo —
  // in-process mode, where the shared fleet key is serialized by nonceGate alone.
  // A multi-process fleet sharing one key would construct the client WITH a leaseStore.
  const agentSigner = {
    address: agent.address,
    sign: async ({ hash }: { hash: `0x${string}` }) => agent.sign({ hash }),
  };

  // Two fleet workers share ONE key: every fire goes through the per-key gate.
  const audits: ActionLogRecord[] = [];
  const worker = (name: string) => async (tick: number) => {
    await client.nonceGate.run(agent.address, async (guard) => {
      const { audit } = await client.execute(
        {
          account: agentSigner,
          request: {
            agentId: toHex(new TextEncoder().encode(name)).padEnd(66, "0") as Hash,
            target: counterAddress,
            selector: "0x32145f90",
            value: 4n * 10n ** 15n,
            expiry: Math.floor(Date.now() / 1000) + 120,
            // rationaleHash is the on-chain bytes32 DIGEST of the rationale: the old
            // zero-padded hex encoding of the literal text was not a hash, and it
            // published the text it was supposed to keep off-chain.
            rationaleHash: keccak256(toHex(`${name} tick ${tick}`)),
            data: toHex(new Uint8Array(32).fill(tick)),
          },
          scope,
          // Membership proof for the single-leaf whitelist above; a non-zero root is
          // enforced on-chain, so the workers must present it.
          merkleProof: merkleProof([counterLeaf], counterLeaf),
        },
        // SEC-6: the relayer submits the already-signed calldata. It is not the owner
        // and holds no balance, so the contract (not the relayer) is the spend authority.
        relayerWallet,
        guard,
      );
      audits.push(audit);
      log.info(`[${name}] tick ${tick} audited: value=${Number(audit.value)} / 1e18 ETH, tx=${audit.txHash}`);
    });
  };

  const alpha = worker("fleet-alpha");
  const beta = worker("fleet-beta");
  // Interleave concurrently — the gate serializes nonce acquisition per key.
  await Promise.all([alpha(1), beta(1), alpha(2), beta(2)]);

  const manifest = {
    manager: managerAddress,
    counter: counterAddress,
    // JSON.stringify throws on BigInt — coerce every bigint in the scope
    // generically so new Scope fields can't regress this.
    scope: JSON.parse(
      JSON.stringify(scope, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
    sharedKey: agent.address,
    // SEC-6: record the three roles explicitly so the manifest documents which key may do
    // what — the agent signs, the relayer pays gas, the owner does neither. ADDRESSES only:
    // a manifest is a file that gets committed and shared, so it must never contain a
    // private key, not even a well-known dev one.
    roles: {
      owner: privateKeyToAccount(OWNER_KEY).address,
      agent: agent.address,
      relayer: relayer.address,
    },
    auditedActions: audits.map((a) => ({
      agentId: a.agentId,
      value: a.value.toString(),
      txHash: a.txHash,
      timestamp: a.timestamp,
    })),
  };
  writeFileSync(join(REPO_ROOT, "fleet-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log.info(`\nfleet run complete: ${audits.length} audited actions, manifest → fleet-manifest.json`);
}

function encodeGrant(key: string, scope: Scope): `0x${string}` {
  return encodeFunctionData({
    abi: SESSION_KEY_MANAGER_ABI,
    functionName: "grantSessionKey",
    args: [key as `0x${string}`, scope],
  });
}

main().catch((err) => {
  log.error("fleet run failed", {}, err);
  process.exit(1);
});
