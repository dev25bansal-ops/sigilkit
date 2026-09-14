/**
 * devkeys tests (CQ-4 / TD-2).
 *
 * `devkeys.ts` centralises the RPC endpoint, the Foundry path and the Anvil dev keys, and its
 * `requireKey` guard is what stops a malformed `SIGILKIT_OWNER_KEY` from silently producing a
 * different (unfunded) account. That guard is worth a test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ANVIL_DEV_KEYS, requireKey } from "../src/devkeys.js";

const VALID = "0x" + "ab".repeat(32);
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
