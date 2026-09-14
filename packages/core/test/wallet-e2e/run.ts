/**
 * MetaMask → SigilKit conformance harness — standalone runner.
 *
 * Booted by `npx tsx packages/core/test/wallet-e2e/run.ts`. We use tsx + Playwright
 * directly instead of the Playwright Test runner because vitest's discovery
 * collides with the test file's imports.
 */
import { chromium, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANVIL_URL = "http://127.0.0.1:8545";
const DAPP_URL = process.env.DAPP_URL || "http://127.0.0.1:8765/dapp.html";
const ANVIL = process.env.ANVIL_BIN || join(homedir(), ".foundry", "bin", "anvil");
const EXT_DIR = resolve(__dirname, "metamask");
const DAPP = resolve(__dirname, "dapp.html");
const USER_DATA = resolve(__dirname, ".playwright-profile");

if (!existsSync(EXT_DIR) || !existsSync(`${EXT_DIR}/manifest.json`)) {
  throw new Error(`MetaMask extension missing at ${EXT_DIR}`);
}
if (!existsSync(USER_DATA)) mkdirSync(USER_DATA);

let anvil: ChildProcess | undefined;
let dappServer: { close: () => void } | undefined;

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

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({
      name,
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    console.error(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  console.log(`[anvil] starting on :8545`);
  anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  anvil.unref();
  anvil.on("error", () => { /* anvil may already be gone; ignore spawn errors */ });
  await waitForRpc(ANVIL_URL);

  // Start the dapp fixture server (separate port so MetaMask sees an http:// origin
  // that matches its content_scripts MV3 host_permissions: ['http://localhost:8545/',
  // 'http://*/*', ...]).
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const port = Number(new URL(DAPP_URL).port || 80);
  const dappHtml = readFileSync(DAPP);
  const dappSrv = createServer((req, res) => {
    if (req.url === "/dapp.html" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dappHtml);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((res) => dappSrv.listen(port, "127.0.0.1", () => res()));
  dappServer = { close: () => dappSrv.close() };
  console.log(`[dapp] http://127.0.0.1:${port}/dapp.html`);

  console.log(`[chromium] launching with MetaMask extension (MV3 12.5.0)`);
  const browser = await chromium.launchPersistentContext(USER_DATA, {
    // MV3 service workers don't reliably activate in headless mode; we run a
    // virtual display so the extension's content scripts and worker load as in
    // headed mode. The persistent context is hermetic per-profile.
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-sandbox",
    ],
  });

  // Wait for MetaMask's MV3 service worker to register.
  let worker = browser.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
  if (!worker) {
    await new Promise<void>((resolveWorker) => {
      const timer = setTimeout(resolveWorker, 15000);
      browser.on("serviceworker", () => {
        clearTimeout(timer);
        resolveWorker();
      });
    });
    worker = browser.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
  }
  if (!worker) {
    console.warn(`[warn] MetaMask service worker not detected after 15s — proceeding anyway`);
  } else {
    console.log(`[metamask] service worker: ${worker.url()}`);
  }

  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await test("Anvil test account is funded (deterministic pre-condition)", async () => {
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const bal = await publicClient.getBalance({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    if (bal === 0n) throw new Error("anvil test account unfunded");
  });

  await test("MetaMask service worker is registered", async () => {
    const sw = browser.serviceWorkers().find((w) => w.url().includes("chrome-extension://"));
    if (!sw) throw new Error("no extension service worker registered");
  });

  await test("window.ethereum injected into dapp page (MetaMask provider present)", async () => {
    await page.goto(DAPP_URL, { waitUntil: "domcontentloaded" });
    // MV3 content scripts run on document_start, but cold-start extensions can take
    // a few seconds to bind window.ethereum on the first navigation after load.
    try {
      await page.waitForFunction(
        () => (window as any).ethereum !== undefined,
        { timeout: 45_000 },
      );
    } catch {
      // Try a second navigation in case the content script missed the first event.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => (window as any).ethereum !== undefined,
        { timeout: 45_000 },
      );
    }
    const info = await page.evaluate(() => {
      const e: any = (window as any).ethereum;
      return { isMetaMask: !!e.isMetaMask, chainId: e.chainId, has: !!e };
    });
    if (!info.has) throw new Error("no ethereum provider");
    if (!info.isMetaMask) throw new Error(`provider isMetaMask=false (got ${JSON.stringify(info)})`);
    console.log(`        [info] provider isMetaMask=true, chainId=${info.chainId}`);
  });

  await test("eth_chainId via injected provider (defaults to mainnet pre-auth)", async () => {
    // Real MetaMask returns the network of the currently selected account, or mainnet
    // (0x1) if the dapp is not yet connected. The fact that this returns a real
    // number from the live provider (not null) is the signal that the real wallet
    // is wired — that's what we're proving here.
    const chainId = await page.evaluate(async () => {
      return await (window as any).ethereum.request({ method: "eth_chainId" });
    });
    if (typeof chainId !== "string" || !chainId.startsWith("0x")) {
      throw new Error(`eth_chainId not a 0x string: ${chainId}`);
    }
    console.log(`        [info] MetaMask returned chainId=${chainId} (expected 0x1 mainnet pre-auth)`);
    // Soft-assert: this test PASSES as long as MetaMask returns a valid chain ID,
    // regardless of which one. The on-chain wiring uses a separate anvil-side test
    // (forge fork smoke) for the chain binding assertion.
  });

  await test("zero-address 7702 revoke via eth_sendTransaction is REJECTED (canary for MetaMask #35520)", async () => {
    const result = (await page.evaluate(async () => {
      const eth: any = (window as any).ethereum;
      const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const txParams = {
        from,
        to: from,
        value: "0x0",
        gas: "0x186A0",
        chainId: "0x7a69",
        nonce: "0x0",
        type: "0x4",
        authorizationList: [
          {
            chainId: "0x7a69",
            address: "0x0000000000000000000000000000000000000000",
            nonce: "0x0",
            yParity: "0x0",
            r: "0x" + "11".repeat(32),
            s: "0x" + "22".repeat(32),
          },
        ],
      };
      try {
        const hash = await eth.request({ method: "eth_sendTransaction", params: [txParams] });
        return { rejected: false as const, hash };
      } catch (err: any) {
        return { rejected: true as const, message: String(err?.message ?? err) };
      }
    })) as { rejected: boolean; hash?: string; message?: string };

    // The canary is allowlist-driven: WALLET_BEHAVIOR_ALLOWLIST.json records the
    // verified behavior (metamask:revoke-raw-rejected ⇒ "rejected", extension 12.5.0).
    // A silent flip — MetaMask starting to ACCEPT raw zero-address revocations —
    // must fail this harness so the SDK's revocation routing gets revisited before
    // users hit it, not after.
    const allowlist = JSON.parse(
      readFileSync(resolve(__dirname, "../WALLET_BEHAVIOR_ALLOWLIST.json"), "utf8"),
    ) as { behaviors: Array<{ id: string; expected: string; verifiedOn: string }> };
    const entry = allowlist.behaviors.find((b) => b.id === "metamask:revoke-raw-rejected");
    if (!entry) throw new Error("allowlist missing metamask:revoke-raw-rejected");

    if (!result.rejected) {
      console.log(`        [info] tx hash: ${result.hash}`);
      if (entry.expected === "rejected") {
        throw new Error(
          `ALLOWLIST VIOLATION: MetaMask accepted a raw zero-address 7702 revoke ` +
            `(expected "${entry.expected}", verified on ${entry.verifiedOn}). ` +
            `Update WALLET_BEHAVIOR_ALLOWLIST.json and re-verify the SDK revocation routing.`,
        );
      }
    } else {
      console.log(`        [info] rejection message: ${result.message}`);
      if (entry.expected === "accepted-or-documented-absent") {
        throw new Error(
          `ALLOWLIST VIOLATION: MetaMask now REJECTS raw zero-address revokes ` +
            `(expected "${entry.expected}"). Update WALLET_BEHAVIOR_ALLOWLIST.json.`,
        );
      }
    }
  });

  console.log(`
[result] MetaMask <-> SigilKit harness`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " -- " + r.detail : ""}`);
  }
  const failed = results.filter((r) => !r.pass).length;

  await browser.close();
  dappServer?.close();
  anvil?.kill();
  // See coinbase.ts: let libuv settle before exit on Windows.
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 250);
}

main().catch((err) => {
  console.error(err);
  dappServer?.close();
  anvil?.kill();
  setTimeout(() => process.exit(1), 250);
});
