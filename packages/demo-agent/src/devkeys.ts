/**
 * Shared local-demo configuration: RPC endpoint, Foundry path, and the Anvil dev keys.
 *
 * SEC-4: Anvil's well-known development keys (anvil #0 / #1) are PUBLIC, universally-known
 * values that exist in every Anvil install. They hold no value and are meaningless outside a
 * local chain. They live here — in ONE place — so that:
 *   - `npm run demo` / `npm run fleet` work with zero setup, and
 *   - the secret-scanning allowlist (`.gitleaks.toml`) can pin exactly these two literals,
 *     which keeps scanning meaningful for every other file in the repo.
 *
 * SEC-6: that arrangement is only safe while the endpoint is loopback. The comment this
 * module used to carry merely ADVISED "never inline a key for a funded chain" — advice a
 * script does not read. {@link assertSafeDemoEnvironment} turns it into an EXECUTABLE
 * constraint, enforced at import time below: pointing a dev key at a public RPC now fails
 * immediately instead of signing a real transaction from a key printed in every Anvil
 * install on earth.
 *
 * Both keys are overridable from the environment so a demo can target a different account
 * without editing source:
 *
 *   SIGILKIT_RPC_URL=… SIGILKIT_OWNER_KEY=0x… SIGILKIT_AGENT_KEY=0x… npm run demo
 *
 * Overriding the RPC to anything non-loopback REQUIRES overriding the keys too, or the
 * process refuses to start (see the guard at the bottom).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "@sigilkit/core/config";

// This module reads the environment while it is being imported, so `.env` has to be loaded
// here — a call from `main()` would already be too late for the constants below.
loadDotEnv();

export const ANVIL_URL = process.env.SIGILKIT_RPC_URL ?? "http://127.0.0.1:8545";

// Foundry installs `forge.exe` on Windows, so the bare name would resolve to a
// non-existent file and `npm run demo` would fail before it started.
const FORGE_BINARY = process.platform === "win32" ? "forge.exe" : "forge";

export const FORGE = process.env.FORGE_BIN ?? join(homedir(), ".foundry", "bin", FORGE_BINARY);

/** Anvil's public development keys. See the module docstring before changing these. */
export const ANVIL_DEV_KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  /**
   * Gas-only relayer key, dev-only. It is a THIRD distinct role (see agent.ts): it pays
   * gas for already-signed calldata and holds no authority, so a stolen relayer can burn
   * at most its own gas money.
   *
   * Truth in comments (SEC-4): this is a HARDCODED 32-byte hex literal — one of Anvil's
   * well-known development keys — NOT derived from any string. It is public by design,
   * is harmless only against the local Anvil chain, and must NEVER be used on a funded
   * chain; the loopback guard below (`assertSafeDemoEnvironment`, enforced at import
   * time) makes that refusal executable rather than advisory.
   */
  relayer: "0x65bccb4404fa485f7d8da6cd9c29eeba4b8df0532e0735574572c95b0eb9003d",
} as const;

/** Loopback hosts on which a dev key is provably harmless. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * True when the endpoint provably cannot leave this machine.
 *
 * Deliberately conservative: an unparseable URL is treated as NON-loopback (fail closed),
 * and only an explicit loopback host qualifies. A hostname that merely RESOLVES to
 * 127.0.0.1 (e.g. `localtest.me`, or an /etc/hosts entry) does not qualify — that mapping
 * is attacker-controllable on a compromised host, and DNS rebinding makes it worse.
 */
export function isLoopbackRpcUrl(rpcUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return false; // fail closed: an unparseable endpoint is never "local"
  }
  const normalized = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  // 127.0.0.0/8 is entirely loopback (127.0.0.2, 127.1.2.3, …), not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** True when `key` is one of Anvil's publicly-known development keys. */
export function isAnvilDevKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return Object.values(ANVIL_DEV_KEYS).some((k) => k.toLowerCase() === normalized);
}

/**
 * SEC-6 guardrail: refuses to run a publicly-known dev key against a non-loopback endpoint.
 *
 * @param rpcUrl  the endpoint the process is about to sign against.
 * @param keys    the keys the process is about to use, keyed by role name.
 * @throws Error with an actionable message when a dev key meets a remote endpoint.
 *
 * Why this throws rather than warns: the failure it prevents is silent and irreversible.
 * A dev key is public, so anything it signs is spendable by anyone watching the chain. On
 * a local Anvil that is worth nothing; on a funded chain the first `grantSessionKey` is an
 * open door. No legitimate workflow needs both a public key AND a remote endpoint, so
 * refusing costs nothing and removes a footgun with a very long fuse.
 */
export function assertSafeDemoEnvironment(rpcUrl: string, keys: Readonly<Record<string, string>>): void {
  if (isLoopbackRpcUrl(rpcUrl)) return;
  const usedDevKeys = Object.entries(keys)
    .filter(([, key]) => isAnvilDevKey(key))
    .map(([role]) => role);
  if (usedDevKeys.length === 0) return;

  const envVars: Readonly<Record<string, string>> = {
    owner: "SIGILKIT_OWNER_KEY",
    agent: "SIGILKIT_AGENT_KEY",
    relayer: "SIGILKIT_RELAYER_KEY",
  };
  // "owner and agent" for two, "owner, agent and relayer" for three — a bare join(" and ")
  // reads badly as the list grows.
  const roleList =
    usedDevKeys.length <= 2
      ? usedDevKeys.join(" and ")
      : `${usedDevKeys.slice(0, -1).join(", ")} and ${usedDevKeys[usedDevKeys.length - 1]}`;
  const plural = usedDevKeys.length > 1;
  throw new Error(
    `refusing to start: the ${roleList} key${plural ? "s are" : " is"} Anvil's PUBLIC development ` +
      `key${plural ? "s" : ""}, and ${rpcUrl} is not a loopback address.\n` +
      `These keys are printed by every Anvil install and are known to everyone, so anything they sign is ` +
      `spendable by anyone. This combination would broadcast real, publicly-spendable transactions on a ` +
      `remote chain.\n` +
      `Do ONE of:\n` +
      `  - point the demo at a local node:  SIGILKIT_RPC_URL=http://127.0.0.1:8545\n` +
      `  - supply your own key for ${usedDevKeys.map((r) => envVars[r] ?? r).join(" / ")}\n` +
      `  - for anything beyond a local demo, use a Safe/HSM owner and a separate relayer (see the ` +
      `SEC-6 section of the package README).`,
  );
}

/** Reads a 32-byte hex private key from the environment, else falls back to `fallback`. */
export function requireKey(envVar: string, fallback: string): `0x${string}` {
  const v = process.env[envVar];
  if (v === undefined) return fallback as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${envVar} must be a 32-byte hex private key (0x + 64 hex chars)`);
  }
  return v as `0x${string}`;
}

/**
 * OWNER_KEY is the deployer/owner credential. SEC-6: it is used ONLY by the explicit,
 * opt-in owner step in cli.ts (deploy, fund, grant) and NEVER reaches TreasuryAgent — the
 * agent process's signing and relaying keys are separate. Keep it that way: the whole
 * value of the fix is that these keys never appear in the same object.
 */
export const OWNER_KEY = requireKey("SIGILKIT_OWNER_KEY", ANVIL_DEV_KEYS.owner);
export const AGENT_KEY = requireKey("SIGILKIT_AGENT_KEY", ANVIL_DEV_KEYS.agent);
export const RELAYER_KEY = requireKey("SIGILKIT_RELAYER_KEY", ANVIL_DEV_KEYS.relayer);

// SEC-6: enforce the constraint at import time so EVERY entry point (`npm run demo`,
// `npm run fleet`, and any future script that imports this module) is covered by it,
// rather than each caller having to remember to call the guard.
assertSafeDemoEnvironment(ANVIL_URL, {
  owner: OWNER_KEY,
  agent: AGENT_KEY,
  relayer: RELAYER_KEY,
});
