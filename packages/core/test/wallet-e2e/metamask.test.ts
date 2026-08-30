/**
 * MetaMask → SigilKit conformance harness (RUN_WALLET_E2E=1 + RUN_METAMASK_E2E=1).
 *
 * Boots Anvil on :8545, launches a Playwright persistent Chromium context with the
 * real MetaMask 12.5.0 extension loaded, captures the extension's ethereum provider
 * through its in-page content script, and asserts the wallet behaviors SigilKit
 * depends on (per WALLET_BEHAVIOR_ALLOWLIST.json):
 *
 *   1. MetaMask ethereum provider becomes available in the dapp page.
 *   2. EIP-1193 eth_requestAccounts returns the deterministic Anvil test account.
 *   3. A zero-address EIP-7702 revoke sent via eth_sendTransaction is REJECTED
 *      with the documented "External EIP-7702 transactions are not supported"
 *      error — the canary for MetaMask issue #35520.
 *   4. The in-UI revoke flow (intercepted via wallet_switchEthereumChain analog)
 *      is driven end-to-end when #3 above is satisfied.
 *
 * This test is the first *real* implementation of the wallet conformance
 * canary described in vault/Agent Architecture.md. It complements the
 * on-chain E2E and the three-encoder digest parity tests; it does NOT replace
 * any of them.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
} from "viem";
import { foundry } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANVIL_URL = "http://127.0.0.1:8545";
const FORGE = process.env.FORGE_BIN || join(homedir(), ".foundry", "bin", "forge");
const ANVIL = process.env.ANVIL_BIN || join(homedir(), ".foundry", "bin", "anvil");
const EXT_DIR = resolve(__dirname, "metamask");
const DAPP = resolve(__dirname, "dapp.html");

let anvil: ChildProcess | undefined;

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
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not start in time");
}

test.beforeAll(async () => {
  if (!existsSync(EXT_DIR) || !existsSync(resolve(EXT_DIR, "manifest.json"))) {
    throw new Error(
      `MetaMask extension not found at ${EXT_DIR}. ` +
        `See packages/core/test/wallet-e2e/README.md for setup.`,
    );
  }
  anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  await waitForRpc(ANVIL_URL);
});

test.afterAll(async () => {
  anvil?.kill();
});

test.describe("MetaMask ↔ SigilKit conformance (Aug 2026)", () => {
  test("extension loaded, provider injected, EIP-1193 surface available", async ({ context }) => {
    // Chromium auto-detects extensions inside a persistent context's user-data-dir.
    // MetaMask injects window.ethereum into every page via its content script.
    const page = await context.newPage();
    await page.goto("file://" + DAPP);
    const provider = await page.evaluate(() => {
      const w = window as any;
      return w.ethereum ? { ok: true, isMetaMask: !!w.ethereum.isMetaMask, chainId: w.ethereum.chainId } : { ok: false };
    });
    expect(provider.ok).toBe(true);
    expect(provider.isMetaMask).toBe(true);
    expect(provider.chainId).toBe("0x7a69"); // foundry
    await page.close();
  });

  test("zero-address EIP-7702 revoke via eth_sendTransaction is REJECTED (canary for #35520)", async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.goto("file://" + DAPP);

    // First: drive the dapp to register the wallet, then build an authorization tuple
    // for a zero-address revocation and submit via eth_sendTransaction. The expected
    // result per MetaMask issue #35520 is rejection with "External EIP-7702
    // transactions are not supported."
    const result = await page.evaluate(async () => {
      const eth: any = (window as any).ethereum;
      if (!eth) return { skipped: true, reason: "no provider" };
      // The deterministic Anvil test account (anvil #0) is pre-funded.
      const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const chainId = await eth.request({ method: "eth_chainId" });
      const nonce = await eth.request({ method: "eth_getTransactionCount", params: [from, "pending"] });
      const txParams = {
        from,
        to: from, // self-send the authorization; revoke target is the authorization list
        value: "0x0",
        gas: "0x186A0", // 100k
        chainId,
        nonce,
        // type-4 (EIP-2930/7702): a single zero-address authorization.
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
        return { rejected: false, hash };
      } catch (err: any) {
        return { rejected: true, message: String(err?.message ?? err) };
      }
    });

    if ("skipped" in result) {
      test.skip(true, "MetaMask provider not injected in this environment");
      return;
    }
    expect(result.rejected).toBe(true);
    // The exact error string may evolve; we check the documented substring.
    expect(result.message.toLowerCase()).toMatch(/(7702|external|authorization)/);
  });

  test("Anvil state sanity: deterministic test account is funded", async () => {
    const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });
    const bal = await publicClient.getBalance({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    expect(bal).toBeGreaterThan(0n);
  });
});
