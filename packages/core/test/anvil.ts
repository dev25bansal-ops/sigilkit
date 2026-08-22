/**
 * Shared Anvil lifecycle helper for test files.
 * Resolves the foundry binaries by absolute path (Windows PATH is unreliable from vitest).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const ANVIL_URL = "http://127.0.0.1:8545";
export const FORGE = join(homedir(), ".foundry", "bin", "forge");
export const ANVIL = join(homedir(), ".foundry", "bin", "anvil");

let proc: ChildProcess | undefined;

/** Spawns anvil on :8545 and waits until its JSON-RPC answers. */
export async function spawnAnvil(): Promise<() => Promise<void>> {
  proc = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ANVIL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return stopAnvil;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not come up within 30s");
}

/** Kills the anvil started by {@link spawnAnvil}. */
export async function stopAnvil(): Promise<void> {
  proc?.kill();
  proc = undefined;
}

/** Runs `forge --version` to assert the toolchain exists before suites that need it. */
export function requireForge(): void {
  execFileSync(FORGE, ["--version"], { stdio: "pipe" });
}
