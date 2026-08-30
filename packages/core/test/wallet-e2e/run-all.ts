/**
 * Wallet conformance entry point: runs both the MetaMask and Coinbase Smart
 * Wallet harnesses in one process. Exits non-zero on any failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ANVIL = process.env.ANVIL_BIN || join(homedir(), ".foundry", "bin", "anvil");
const TSX = process.env.TSX_BIN || join(homedir(), ".bun", "bin", "tsx") ||
  join(homedir(), "AppData", "Roaming", "npm", "tsx.cmd");

interface SuiteResult {
  suite: string;
  exitCode: number;
  output: string;
}

function runSuite(name: string, file: string): Promise<SuiteResult> {
  return new Promise<SuiteResult>((resolve) => {
    const proc = spawn(TSX, [file], { shell: true, stdio: "pipe" });
    let out = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (out += b.toString()));
    proc.on("close", (code) => resolve({ suite: name, exitCode: code ?? 1, output: out }));
  });
}

async function waitForRpc(url: string, timeoutMs = 30000): Promise<void> {
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
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not start in time");
}

async function main() {
  const anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  try {
    await waitForRpc("http://127.0.0.1:8545");

    const metamask = await runSuite("MetaMask", "run.ts");
    console.log("=".repeat(60));
    console.log(metamask.output);
    const coinbase = await runSuite("Coinbase Smart Wallet", "coinbase.ts");
    console.log("=".repeat(60));
    console.log(coinbase.output);

    const failed = [metamask, coinbase].filter((r) => r.exitCode !== 0).length;
    console.log("=".repeat(60));
    console.log(`[overall] ${failed === 0 ? "ALL GREEN" : `${failed} suite(s) failed`}`);
    process.exit(failed);
  } finally {
    anvil.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
