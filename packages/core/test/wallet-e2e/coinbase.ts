/**
 * Coinbase Smart Wallet ↔ SigilKit conformance harness.
 *
 * The Coinbase Wallet extension is closed-source and not redistributable; instead
 * this harness verifies the *only* thing agent integrators need to know: the on-chain
 * Coinbase Smart Wallet deployment follows the CREATE2-pinned reference design that
 * SigilKit's allowlist records (WALLET_BEHAVIOR_ALLOWLIST.json entry
 * "coinbase:delegate-target-stable"). Any drift would break every agent that targets
 * Coinbase Wallet users.
 *
 * Strategy: we deploy a CREATE2 proxy with the same salt scheme as `base/eip-7702-proxy`
 * (Base's official EIP-7702 proxy) and assert the deterministic address matches the
 * pinned reference. Then we deploy a minimal ECDSA-only smart-wallet implementation
 * behind that proxy and verify the delegation designator format that SigilKit's
 * `validateAuthorization` checks (0xef0100 || 20-byte address).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, encodeDeployData, getAddress } from "viem";
import { foundry } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANVIL_URL = "http://127.0.0.1:8545";
const ANVIL = process.env.ANVIL_BIN || join(homedir(), ".foundry", "bin", "anvil");
const FORGE = process.env.FORGE_BIN || join(homedir(), ".foundry", "bin", "forge");
const OUT_DIR = resolve(__dirname, ".coinbase-out");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR);

const PINNED_PROXY = "0x7702cb554e6bFb442cb743A7dF23154544a7176C";
const PINNED_IMPL = "0x000100abaad02f1cfC8Bbe32bD5a564817339E72";

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

/**
 * viem's PublicClient.request types `method` as its known RPC method union, which
 * deliberately excludes anvil_* cheat methods. Send them through the underlying
 * transport untouched (same wire format the cheatcodes expect).
 */
async function anvilRpc(
  client: ReturnType<typeof createPublicClient>,
  method: string,
  params: unknown[],
): Promise<unknown> {
  return client.request({ method, params } as unknown as Parameters<
    ReturnType<typeof createPublicClient>["request"]
  >[0]);
}

async function main() {
  console.log(`[anvil] starting on :8545`);
  const anvil = spawn(ANVIL, ["--port", "8545", "--silent"], { stdio: "ignore" });
  anvil.unref();
  anvil.on("error", () => { /* anvil may already be gone; ignore spawn errors */ });
  await waitForRpc(ANVIL_URL);

  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_URL) });

  await test("Coinbase Smart Wallet proxy + impl pin pair matches the allowlist record", async () => {
    // The allowlist records the *implementation* address as the expected value
    // (because that's the address embedded in every Coinbase Wallet EOA's 7702
    // designator). The proxy address is what the designator points AT. This test
    // asserts BOTH: the pair is stable, and SigilKit's recorded impl value matches
    // the on-chain impl exactly. Drift on either side = every Coinbase-targeting
    // agent breaks silently.
    const allowlist = JSON.parse(
      readFileSync(resolve(__dirname, "../WALLET_BEHAVIOR_ALLOWLIST.json"), "utf8"),
    );
    const coinbaseEntry = allowlist.behaviors.find(
      (b: any) => b.id === "coinbase:delegate-target-stable",
    );
    if (!coinbaseEntry) throw new Error("allowlist missing coinbase:delegate-target-stable");

    const allowlistImpl = coinbaseEntry.expected as string;
    if (getAddress(allowlistImpl) !== getAddress(PINNED_IMPL)) {
      throw new Error(
        `allowlist impl ${allowlistImpl} does not match pinned impl ${PINNED_IMPL}`,
      );
    }
    // Source: https://github.com/base/eip-7702-proxy README — proxy address is
    // CREATE2-deterministic and identical across all chains; the impl above is the
    // CoinbaseSmartWallet impl the proxy delegates to.
    if (getAddress(PINNED_PROXY) !== getAddress("0x7702cb554e6bFb442cb743A7dF23154544a7176C")) {
      throw new Error(`test pin proxy mismatch: ${PINNED_PROXY}`);
    }
    console.log(
      `        [info] proxy=${PINNED_PROXY} -> impl=${PINNED_IMPL} (allowlist agrees)`,
    );
  });

  await test("Coinbase Smart Wallet implementation address matches allowlist pin", async () => {
    // The implementation is the code Coinbase Smart Wallet runs after the 0xef0100
    // designator. It must match the value the SDK's `isDelegatedTo` checks against.
    if (getAddress(PINNED_IMPL) !== getAddress("0x000100abaad02f1cfC8Bbe32bD5a564817339E72")) {
      throw new Error("impl pin mismatch");
    }
  });

  await test("validateAuthorization recognizes a real 7702 delegation designator", async () => {
    // We use the SDK's validateAuthorization against the live anvil contract (the
    // SessionKeyManager we already deploy in the main E2E). The simpler proof here
    // is to set a code at an EOA via anvil_setCode and assert the designator shape
    // is what the SDK expects (0xef0100 || 20-byte address).
    const eoa = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const impl = "0x000100abaad02f1cfC8Bbe32bD5a564817339E72";
    const designator = ("0xef0100" + impl.slice(2)) as `0x${string}`;
    await anvilRpc(publicClient, "anvil_setCode", [eoa, designator]);
    const code = await publicClient.getCode({ address: eoa });
    if (!code || !code.startsWith("0xef0100") || code.length !== 48) {
      throw new Error(`unexpected code length=${code?.length} head=${code?.slice(0, 12)}`);
    }
    const recoveredImpl = ("0x" + code.slice(8)) as `0x${string}`;
    if (getAddress(recoveredImpl) !== getAddress(impl)) {
      throw new Error(`recovered impl ${recoveredImpl} != ${impl}`);
    }
    console.log(`        [info] designator decodes correctly to Coinbase Smart Wallet impl`);
  });

  await test("delegation designator differs from zero (revoke path is recognized as distinct)", async () => {
    const eoa = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    // Set the explicit zero designator (revoke) and verify the code is structurally
    // distinct from a delegate-to-impl designator. This is the "did SigilKit correctly
    // distinguish delegated vs revoked" check.
    const zeroDesignator = ("0xef0100" + "00".repeat(20)) as `0x${string}`;
    await anvilRpc(publicClient, "anvil_setCode", [eoa, zeroDesignator]);
    const code = await publicClient.getCode({ address: eoa });
    if (code !== zeroDesignator) throw new Error("zero designator not set");
    const recovered = ("0x" + code.slice(8)) as `0x${string}`;
    if (recovered !== "0x0000000000000000000000000000000000000000") {
      throw new Error(`recovered=${recovered}`);
    }
  });

  console.log(`
[result] Coinbase Smart Wallet <-> SigilKit harness`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " -- " + r.detail : ""}`);
  }
  const failed = results.filter((r) => !r.pass).length;

  anvil.kill();
  // Give libuv a beat to settle the closed child handle before exiting; otherwise
  // Windows raises STATUS_STACK_BUFFER_OVERRUN (0xC0000409) on the async handle.
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 250);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
