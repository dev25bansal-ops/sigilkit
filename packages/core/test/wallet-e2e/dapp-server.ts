// Tiny static server for the dapp fixture (no deps, single file).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WALLET_DAPP_PORT || 8765);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

createServer((req, res) => {
  const url = req.url || "/";
  const path = url === "/" ? "/dapp.html" : url;
  const full = join(__dirname, path);
  try {
    const body = readFileSync(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`not found: ${path}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[dapp] http://127.0.0.1:${PORT}/dapp.html`);
});
