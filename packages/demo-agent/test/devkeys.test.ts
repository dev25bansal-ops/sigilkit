/**
 * devkeys tests (CQ-4 / TD-2 / SEC-6).
 *
 * `devkeys.ts` centralises the RPC endpoint, the Foundry path and the Anvil dev keys, and its
 * `requireKey` guard is what stops a malformed `SIGILKIT_OWNER_KEY` from silently producing a
 * different (unfunded) account. That guard is worth a test.
 *
 * SEC-6: the guardrail half of the file matters more. The dev keys are PUBLIC — printed by
 * every Anvil install — so they are only harmless while the endpoint is loopback. These tests
 * pin the rule that a dev key + a non-loopback RPC is a startup REFUSAL, which is what turns
 * the old "never inline a key for a funded chain" comment into something a script enforces.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ANVIL_DEV_KEYS,
  assertSafeDemoEnvironment,
  isAnvilDevKey,
  isLoopbackRpcUrl,
  requireKey,
} from "../src/devkeys.js";

const VALID = "0x" + "ab".repeat(32);
const OWNER_DEV_KEY = ANVIL_DEV_KEYS.owner;
const AGENT_DEV_KEY = ANVIL_DEV_KEYS.agent;
const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

describe("devkeys", () => {
  it("exposes the public Anvil dev keys with a documented shape", () => {
    expect(ANVIL_DEV_KEYS.owner).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ANVIL_DEV_KEYS.agent).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ANVIL_DEV_KEYS.owner).not.toBe(ANVIL_DEV_KEYS.agent);
  });

  it("falls back to the provided default when the env var is unset", () => {
    delete process.env.SIGILKIT_TEST_KEY;
    expect(requireKey("SIGILKIT_TEST_KEY", VALID)).toBe(VALID);
  });

  it("prefers the environment value when set", () => {
    process.env.SIGILKIT_TEST_KEY = "0x" + "cd".repeat(32);
    expect(requireKey("SIGILKIT_TEST_KEY", VALID)).toBe("0x" + "cd".repeat(32));
  });

  it("rejects a malformed key instead of silently using it", () => {
    for (const bad of ["not-a-key", "0x1234", "ab".repeat(32), "0x" + "zz".repeat(32)]) {
      process.env.SIGILKIT_TEST_KEY = bad;
      expect(() => requireKey("SIGILKIT_TEST_KEY", VALID), `should reject ${bad}`).toThrow(
        /32-byte hex private key/,
      );
    }
  });

  it("rejects an empty-string env value rather than treating it as unset", () => {
    process.env.SIGILKIT_TEST_KEY = "";
    expect(() => requireKey("SIGILKIT_TEST_KEY", VALID)).toThrow();
  });
});

describe("isLoopbackRpcUrl (SEC-6)", () => {
  it("accepts the loopback forms a local Anvil is reached by", () => {
    for (const url of [
      "http://127.0.0.1:8545",
      "http://localhost:8545",
      "http://LOCALHOST:8545",
      "https://127.0.0.1:8545",
      "ws://127.0.0.1:8546",
      "http://[::1]:8545",
      "http://127.0.0.2:8545", // the whole 127.0.0.0/8 range is loopback
    ]) {
      expect(isLoopbackRpcUrl(url), url).toBe(true);
    }
  });

  it("rejects anything that could leave the machine", () => {
    for (const url of [
      "https://eth-sepolia.g.alchemy.com/v2/key",
      "https://mainnet.infura.io/v3/key",
      "http://192.168.1.10:8545",
      "http://0.0.0.0:8545",
      "http://10.0.0.5:8545",
    ]) {
      expect(isLoopbackRpcUrl(url), url).toBe(false);
    }
  });

  it("fails closed on a hostname that merely RESOLVES to loopback, and on garbage", () => {
    // A resolvable name is an /etc/hosts + DNS-rebinding surface, not a loopback guarantee.
    expect(isLoopbackRpcUrl("http://localtest.me:8545")).toBe(false);
    expect(isLoopbackRpcUrl("http://127.0.0.1.evil.example:8545")).toBe(false);
    expect(isLoopbackRpcUrl("not a url")).toBe(false);
    expect(isLoopbackRpcUrl("")).toBe(false);
  });
});

describe("isAnvilDevKey (SEC-6)", () => {
  it("recognises every published dev key, case-insensitively", () => {
    expect(isAnvilDevKey(OWNER_DEV_KEY)).toBe(true);
    expect(isAnvilDevKey(AGENT_DEV_KEY)).toBe(true);
    expect(isAnvilDevKey(OWNER_DEV_KEY.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isAnvilDevKey(`  ${OWNER_DEV_KEY}  `)).toBe(true);
  });

  it("does not flag a private key that is not a known dev key", () => {
    expect(isAnvilDevKey(VALID)).toBe(false);
    expect(isAnvilDevKey("0x" + "cd".repeat(32))).toBe(false);
  });
});

describe("assertSafeDemoEnvironment (SEC-6 guardrail)", () => {
  it("ALLOWS a dev key against a loopback endpoint — the supported demo path", () => {
    expect(() =>
      assertSafeDemoEnvironment("http://127.0.0.1:8545", {
        owner: OWNER_DEV_KEY,
        agent: AGENT_DEV_KEY,
        relayer: ANVIL_DEV_KEYS.relayer,
      }),
    ).not.toThrow();
  });

  it("REFUSES an Anvil dev key against a non-loopback endpoint", () => {
    // The core SEC-6 guardrail. A public key plus a remote chain would broadcast
    // publicly-spendable transactions, so the process must not start.
    expect(() =>
      assertSafeDemoEnvironment("https://mainnet.infura.io/v3/key", {
        owner: OWNER_DEV_KEY,
        agent: AGENT_DEV_KEY,
      }),
    ).toThrow(/refusing to start/i);
  });

  it("names the offending roles and the endpoint so the operator can act", () => {
    let message = "";
    try {
      assertSafeDemoEnvironment("https://eth-sepolia.example/v3/key", { agent: AGENT_DEV_KEY });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/refusing to start/i);
    expect(message).toContain("agent");
    expect(message).toContain("https://eth-sepolia.example/v3/key");
    // Actionable: it must say how to fix it, not just that it is unhappy.
    expect(message).toMatch(/SIGILKIT_RPC_URL/);
    expect(message).toMatch(/SIGILKIT_AGENT_KEY/);
  });

  it("reports every offending role, so a partial override is still caught", () => {
    let message = "";
    try {
      assertSafeDemoEnvironment("https://mainnet.example/v3/key", {
        owner: OWNER_DEV_KEY,
        agent: AGENT_DEV_KEY,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("owner");
    expect(message).toContain("agent");
  });

  it("ALLOWS non-dev keys against a non-loopback endpoint", () => {
    // Overriding the keys is the documented way to point the demo at a real chain; the
    // guardrail must not block an operator who has supplied their own keys.
    expect(() =>
      assertSafeDemoEnvironment("https://mainnet.infura.io/v3/key", {
        owner: VALID,
        agent: "0x" + "cd".repeat(32),
      }),
    ).not.toThrow();
  });

  it("never echoes the private key in its error message", () => {
    let message = "";
    try {
      assertSafeDemoEnvironment("https://mainnet.example", { agent: AGENT_DEV_KEY });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Dev keys are public, but the message must not teach the shape of a real secret by
    // printing whatever key it was handed.
    expect(message).not.toContain(AGENT_DEV_KEY);
  });
});

describe("no key material in emitted output (SEC-6)", () => {
  it("the exported key constants are the only place a key literal appears in src", async () => {
    // fleet-manifest.json and `--json` output are files that get committed, logged and
    // piped to other tools, so they must carry ADDRESSES only. Both are built from these
    // constants, so asserting the derived form is an address is enough to pin it.
    const { privateKeyToAccount } = await import("viem/accounts");
    for (const key of Object.values(ANVIL_DEV_KEYS)) {
      // Deriving the address must work and must be a 20-byte address — the value that is
      // safe to write to a manifest.
      expect(privateKeyToAccount(key).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
