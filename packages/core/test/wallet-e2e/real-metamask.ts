/**
 * REAL MetaMask integration check — drives the user's actual Chrome (started
 * with --remote-debugging-port) and the MetaMask extension installed there.
 *
 * SAFETY CONTRACT (deliberately stricter than the pinned-extension harness):
 *  - NO auto-approval: every MetaMask popup must be clicked by the human.
 *  - NO eth_sendTransaction, NO wallet creation, NO seed import, NO settings
 *    changes. The wallet itself is never touched beyond what a normal dapp
 *    session does.
 *  - Only: provider detection, eth_chainId, eth_requestAccounts (user approves),
 *    eth_accounts, and one personal_sign probe (user approves) verified
 *    cryptographically against the connected address. personal_sign is an
 *    offline signature — it cannot move funds.
 *
 * Run:
 *   1. Close all Chrome windows.
 *   2. Start Chrome with debugging:
 *        & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *   3. Unlock MetaMask if needed, then:
 *        node --import tsx packages/core/test/wallet-e2e/real-metamask.ts
 *
 * Override the CDP endpoint with CDP_URL (default http://127.0.0.1:9222).
 */
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const DAPP_PORT = Number(process.env.WALLET_DAPP_PORT || 8765);
const DAPP_URL = `http://127.0.0.1:${DAPP_PORT}/dapp.html`;
const DAPP = resolve(__dirname, "dapp.html");
/** How long the human gets to answer each MetaMask popup. */
const APPROVAL_TIMEOUT_MS = 180_000;

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
    console.error(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log(`[cdp] attaching to real Chrome at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("no default browser context — is Chrome running with the debugging port?");

  // Fail fast when MetaMask is missing from the attached profile: every leg
  // below reads silent injection absence as a 30s timeout (real-metamask.log
  // 2026-09-19 failed 5x against a profile where MM was installed only later).
  const METAMASK_EXT_ID = "nkbihfbeogaeaoehlefnkodbefgpgknn";
  try {
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${METAMASK_EXT_ID}/home.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await probe.close().catch(() => {});
  } catch {
    throw new Error(
      "MetaMask is not installed/enabled in this Chrome profile — install it, then re-run",
    );
  }
  console.log("        [info] MetaMask extension confirmed installed in this profile");

  const dappHtml = readFileSync(DAPP);
  const srv = createServer((req, res) => {
    if (req.url === "/dapp.html" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dappHtml);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => srv.listen(DAPP_PORT, "127.0.0.1", () => r()));
  console.log(`[dapp] ${DAPP_URL}`);

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

  await test("real MetaMask provider is injected into a normal web page", async () => {
    await page.goto(DAPP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as any).ethereum !== undefined, null, { timeout: 30_000 });
    const info = await page.evaluate(() => {
      const e: any = (window as any).ethereum;
      return { isMetaMask: !!e.isMetaMask, browserRuntimeName: e.selectedProvider ?? null };
    });
    if (!info.isMetaMask) throw new Error(`ethereum present but isMetaMask=false (${JSON.stringify(info)})`);
    console.log("        [info] real MetaMask detected");
  });

  await test("eth_chainId answers without any approval (public read)", async () => {
    const chainId = await page.evaluate(async () =>
      (window as any).ethereum.request({ method: "eth_chainId" }),
    );
    if (typeof chainId !== "string" || !chainId.startsWith("0x")) {
      throw new Error(`bad chainId: ${String(chainId)}`);
    }
    console.log(`        [info] selected network chainId=${chainId} (${parseInt(chainId, 16)})`);
  });

  let connected: string[] = [];
  await test("eth_requestAccounts — APPROVE THE POPUP IN YOUR REAL METAMASK", async () => {
    console.log("        >>> a MetaMask connect popup is open in YOUR browser — click Connect/Next there");
    const accounts = (await Promise.race([
      page.evaluate(async () => (window as any).ethereum.request({ method: "eth_requestAccounts" })),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`no approval within ${APPROVAL_TIMEOUT_MS / 1000}s`)), APPROVAL_TIMEOUT_MS)),
    ])) as string[];
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error(`empty account list: ${JSON.stringify(accounts)}`);
    }
    connected = accounts;
    console.log(`        [info] real wallet connected: ${accounts.join(", ")}`);
  });

  await test("eth_accounts agrees with the approved connection", async () => {
    const accounts = (await page.evaluate(async () =>
      (window as any).ethereum.request({ method: "eth_accounts" }),
    )) as string[];
    if (JSON.stringify(accounts.map((a) => a.toLowerCase())) !== JSON.stringify(connected.map((a) => a.toLowerCase()))) {
      throw new Error(`eth_accounts ${JSON.stringify(accounts)} != approved ${JSON.stringify(connected)}`);
    }
  });

  await test("personal_sign probe verifies against the connected address — APPROVE THE SIGN POPUP", async () => {
    const message = `SigilKit real-wallet probe ${new Date().toISOString()} (no transaction, no value)`;
    const hex = "0x" + Buffer.from(message, "utf8").toString("hex");
    console.log("        >>> a signature popup is open in YOUR browser — click Sign there");
    const signature = (await Promise.race([
      page.evaluate(async (h: string) => {
        const eth: any = (window as any).ethereum;
        const [from] = await eth.request({ method: "eth_accounts" });
        return await eth.request({ method: "personal_sign", params: [h, from] });
      }, hex),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`no approval within ${APPROVAL_TIMEOUT_MS / 1000}s`)), APPROVAL_TIMEOUT_MS)),
    ])) as `0x${string}`;
    const ok = await verifyMessage({ address: connected[0] as `0x${string}`, message, signature });
    if (!ok) throw new Error("signature did not verify against the connected address");
    console.log("        [info] signature cryptographically bound to the connected account");
  });

  console.log(`
[result] REAL MetaMask integration`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " -- " + r.detail : ""}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(
    failed === 0
      ? "[scope] proves: real extension injection, live network read, human-approved connect, human-approved offline signature. It does NOT prove transaction signing or EIP-7702 authorization support in your MetaMask version."
      : "[scope] run completed with failures — see above.",
  );

  await page.close().catch(() => {});
  srv.close();
  // Detach without closing the user's real browser.
  browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
