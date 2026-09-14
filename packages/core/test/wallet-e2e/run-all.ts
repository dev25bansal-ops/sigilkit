/**
 * Wallet conformance entry point: runs both the MetaMask and Coinbase Smart
 * Wallet harnesses sequentially. Each suite self-manages its own Anvil node,
 * so this file is a thin sequential runner with no shared infrastructure.
 * Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SuiteResult {
  suite: string;
  exitCode: number;
  output: string;
}

function runSuite(name: string, file: string): Promise<SuiteResult> {
  return new Promise<SuiteResult>((resolve) => {
    // `npx tsx` resolves the repo-local node_modules/.bin/tsx reliably; a
    // hard-coded home-dir path does not exist on a fresh checkout.
    // cwd = __dirname so the suite's relative paths (metamask/, dapp.html) resolve.
    const proc = spawn("npx", ["tsx", file], {
      shell: true,
      cwd: __dirname,
      stdio: "pipe",
    });
    let out = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (out += b.toString()));
    proc.on("close", (code) => resolve({ suite: name, exitCode: code ?? 1, output: out }));
  });
}

async function main() {
  console.log("[1/2] MetaMask harness (Anvil + Chromium + MetaMask 12.5.0 extension)");
  const metamask = await runSuite("MetaMask", join(__dirname, "run.ts"));
  console.log(metamask.output);

  console.log("[2/2] Coinbase Smart Wallet harness (Anvil + on-chain designator)");
  const coinbase = await runSuite("Coinbase Smart Wallet", join(__dirname, "coinbase.ts"));
  console.log(coinbase.output);

  console.log("=".repeat(60));
  const failed = [metamask, coinbase].filter((r) => r.exitCode !== 0);
  if (failed.length === 0) {
    console.log("[overall] ALL GREEN");
    process.exit(0);
  } else {
    for (const f of failed) {
      console.error(`[FAIL] ${f.suite} (exit ${f.exitCode})`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
