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

/** Calls a JSON-RPC method on the shared test node. */
async function rpc(method: string): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
  return ((await res.json()) as { result?: unknown }).result;
}

/** True when a JSON-RPC node already answers on {@link ANVIL_URL}. */
async function anvilIsUp(): Promise<boolean> {
  try {
    await rpc("eth_chainId");
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures an Anvil is reachable on :8545 and returns a disposer.
 *
 * If a node is already listening it is **reused** and the disposer is a no-op — a developer
 * may legitimately have one running. Reuse is announced, because these suites deploy
 * contracts, grant session keys and assert on balances: against a chain that already has
 * history they can fail in ways that look like code bugs. The warning names the block height
 * so the cause is obvious.
 */
export async function spawnAnvil(): Promise<() => Promise<void>> {
  if (await anvilIsUp()) {
    const height = Number(await rpc("eth_blockNumber").catch(() => 0));
    if (height > 0) {
      console.warn(
        `[test] reusing the Anvil on ${ANVIL_URL}, which is already at block ${height}.\n` +
          `[test] These suites assume a fresh chain and may fail spuriously against existing state.\n` +
          `[test] For a hermetic run, stop that node first (the suite starts and stops its own).`,
      );
    } else {
      console.warn(`[test] reusing the Anvil already listening on ${ANVIL_URL} (at genesis).`);
    }
    return async () => {
      /* not ours to stop */
    };
  }

  proc = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await anvilIsUp()) return stopAnvil;
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
