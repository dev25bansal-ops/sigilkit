#!/usr/bin/env node
/**
 * Manual wallet-conformance fixture (AC-09 hybrid legs).
 *
 * Starts the two servers the wallet-e2e harness normally owns — anvil on 8545 and the
 * dapp fixture with a POST /report echo on 8765 — so a human can drive connect/sign
 * legs in their own browser (Brave + MetaMask) and the outcomes land in
 * outputs/wallet-e2e-manual.log. Ctrl+C stops both.
 *
 * The served wallet mnemonic is Anvil's public developer mnemonic, never a real secret.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANVIL = process.env.ANVIL_BIN ?? join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const DAPP_HTML = new URL("./dapp.html", import.meta.url);
const REPORT_LOG = join(process.cwd(), "outputs", "wallet-e2e-manual.log");
const PORT = 8765;

if (!existsSync(ANVIL)) {
  console.error(`anvil not found at ${ANVIL}; set ANVIL_BIN.`);
  process.exit(1);
}

let anvil;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => {
      try { appendFileSync(REPORT_LOG, `${new Date().toISOString()} ${body}\n`); } catch { /* log dir missing */ }
      console.log(`[report] ${body}`);
      res.writeHead(200).end("ok");
    });
    return;
  }
  if (req.url === "/dapp.html" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(DAPP_HTML));
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  anvil.on("error", () => { /* anvil failed; keep serving instructions */ });
  console.log(`
Manual wallet-conformance fixture is up:
  dapp:  http://127.0.0.1:${PORT}/dapp.html
  chain: http://127.0.0.1:8545 (anvil, chain 31337)

In Brave (MetaMask):
  1. Import the Anvil dev mnemonic (test test test test test test test test test test test junk)
     or keep your own wallet pointed at Localhost 8545.
  2. Open the dapp URL, click "Connect Wallet" (approve), then "Sign" (approve).
  3. Outcomes appear here and in ${REPORT_LOG}.

Ctrl+C to stop.`);
});

const shutdown = () => {
  server.close();
  anvil?.kill();
  setTimeout(() => process.exit(0), 250);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);