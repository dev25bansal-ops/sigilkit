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
 * Both are overridable from the environment so a demo can target a different account without
 * editing source:
 *
 *   SIGILKIT_RPC_URL=… SIGILKIT_OWNER_KEY=0x… SIGILKIT_AGENT_KEY=0x… npm run demo
 *
 * Never inline a key for a funded chain.
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
} as const;

/** Reads a 32-byte hex private key from the environment, else falls back to `fallback`. */
export function requireKey(envVar: string, fallback: string): `0x${string}` {
  const v = process.env[envVar];
  if (v === undefined) return fallback as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${envVar} must be a 32-byte hex private key (0x + 64 hex chars)`);
  }
  return v as `0x${string}`;
}

export const OWNER_KEY = requireKey("SIGILKIT_OWNER_KEY", ANVIL_DEV_KEYS.owner);
export const AGENT_KEY = requireKey("SIGILKIT_AGENT_KEY", ANVIL_DEV_KEYS.agent);
