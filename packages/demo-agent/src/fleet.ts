/**
 * Fleet demo (enhancement E20): TWO agents sharing ONE session key, serialized
 * through SigilKitClient.nonceGate (strictly-sequential on-chain nonces would
 * otherwise double-fire), with a JSON run manifest written to ./fleet-manifest.json
 * and a per-agent audit summary from the typed ActionLogged records.
 *
 * Prereq: `anvil --port 8545`. Run: npm run fleet (in packages/demo-agent).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, toHex, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { SigilKitClient, SESSION_KEY_MANAGER_ABI, type ActionLogRecord, type Scope } from "@sigilkit/core";
// SEC-4: shared demo config — the Anvil dev keys are allowlisted in .gitleaks.toml.
import { AGENT_KEY, ANVIL_URL, FORGE, OWNER_KEY } from "./devkeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const sh = (cmd: string, args: string[], env?: Record<string, string>) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: env ? { ...process.env, ...env } : process.env,
  });

async function main() {
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
  const owner = privateKeyToAccount(OWNER_KEY);
  const agent = privateKeyToAccount(AGENT_KEY);
  const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(ANVIL_URL) });

  console.log("deploying SessionKeyManager…");
  const deployOut = sh(
    FORGE,
    ["script", "contracts/script/Deploy.s.sol", "--rpc-url", ANVIL_URL, "--broadcast", "--sig", "run()", "--root", REPO_ROOT],
    { SIGILKIT_OWNER_KEY: OWNER_KEY },
  );
  const managerAddress = deployOut.match(/SessionKeyManager deployed at: (0x[0-9a-fA-F]{40})/)![1] as `0x${string}`;
  const counterOut = sh(FORGE, [
    "create", "contracts/test/CounterTarget.sol:CounterTarget", "--rpc-url", ANVIL_URL, "--private-key", OWNER_KEY, "--broadcast", "--root", REPO_ROOT,
  ]);
  const counterAddress = counterOut.match(/Deployed to: (0x[0-9a-fA-F]{40})/)![1] as `0x${string}`;
  await wallet.sendTransaction({ to: managerAddress, value: 10n ** 18n });

  const scope = {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    windowSeconds: 600,
    perActionCap: 10n ** 16n,
    perWindowCap: 5n * 10n ** 16n,
    merkleRoot: toHex(new Uint8Array(32)),
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
  const agentSigner = {
    address: agent.address,
    sign: async ({ hash }: { hash: `0x${string}` }) => agent.sign({ hash }),
  };

  // Two fleet workers share ONE key: every fire goes through the per-key gate.
  const audits: ActionLogRecord[] = [];
  const worker = (name: string) => async (tick: number) => {
    await client.nonceGate.run(agent.address, async (guard) => {
      const { receipt, audit } = await client.execute(
        {
          account: agentSigner,
          request: {
            agentId: toHex(new TextEncoder().encode(name)).padEnd(66, "0") as Hash,
            target: counterAddress,
            selector: "0x32145f90",
            value: 4n * 10n ** 15n,
            expiry: Math.floor(Date.now() / 1000) + 120,
            rationaleHash: ("0x" + Buffer.from(`${name} tick ${tick}`).toString("hex").padStart(64, "0")) as Hash,
            data: toHex(new Uint8Array(32).fill(tick)),
          },
          scope,
        },
        wallet,
        guard,
      );
      audits.push(audit);
      console.log(`[${name}] tick ${tick} audited: value=${Number(audit.value)} / 1e18 ETH, tx=${audit.txHash}`);
      void receipt;
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
    auditedActions: audits.map((a) => ({
      agentId: a.agentId,
      value: a.value.toString(),
      txHash: a.txHash,
      timestamp: a.timestamp,
    })),
  };
  writeFileSync(join(REPO_ROOT, "fleet-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nfleet run complete: ${audits.length} audited actions, manifest → fleet-manifest.json`);
}

function encodeGrant(key: string, scope: Scope): `0x${string}` {
  return encodeFunctionData({
    abi: SESSION_KEY_MANAGER_ABI,
    functionName: "grantSessionKey",
    args: [key as `0x${string}`, scope],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
