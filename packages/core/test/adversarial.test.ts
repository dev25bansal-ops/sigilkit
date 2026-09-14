/**
 * Adversarial one-off fuzz pass over SDK public functions (temp file, deleted after run).
 */
import { describe, expect, it } from "vitest";
import { actionRequestDigest, parseActionRequest, validateAgainstScope, targetLeaf, merkleRoot, merkleProof } from "../src/index.js";
import type { ActionRequest } from "../src/index.js";

const VALID: ActionRequest = {
  agentId: ("0x" + "33".repeat(32)) as `0x${string}`,
  target: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  selector: "0x32145f90",
  value: 10n ** 16n,
  nonce: 0n,
  expiry: 1787654400,
  rationaleHash: ("0x" + "44".repeat(32)) as `0x${string}`,
  data: "0x12345678",
};

describe("adversarial fuzz: SDK public functions", () => {
  it("digest: extreme boundary values produce distinct valid digests", () => {
    const values = [0n, 1n, 2n ** 255n, 2n ** 256n - 1n];
    const digests = new Set(values.map((v) => actionRequestDigest({ request: { ...VALID, value: v }, chainId: 1, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" })));
    expect(digests.size).toBe(values.length);
  });

  it("digest: zero-length and huge data both hash correctly", () => {
    const empty = actionRequestDigest({ request: { ...VALID, data: "0x" }, chainId: 1, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
    const huge = actionRequestDigest({ request: { ...VALID, data: ("0x" + "ab".repeat(4096)) as `0x${string}` }, chainId: 1, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
    expect(empty).toMatch(/^0x[0-9a-f]{64}$/);
    expect(huge).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("parse: rejects negative and float value/nonce strings", () => {
    expect(() => parseActionRequest({ ...VALID, value: -1 })).toThrow();
    expect(() => parseActionRequest({ ...VALID, nonce: 1.5 })).toThrow();
  });

  it("parse: rejects bad hex in every hex field", () => {
    expect(() => parseActionRequest({ ...VALID, selector: "0x12345z" })).toThrow();
    expect(() => parseActionRequest({ ...VALID, data: "0xzz" })).toThrow();
    expect(() => parseActionRequest({ ...VALID, agentId: "nothex" })).toThrow();
  });

  it("validateAgainstScope: boundary caps and expiry edges", () => {
    const now = Math.floor(Date.now() / 1000);
    const scope = { expiresAt: now + 100, windowSeconds: 600, perActionCap: 100n, perWindowCap: 100n, merkleRoot: "0x" + "00".repeat(32) as `0x${string}`, countersignAbove: 0n, enforceNativeDelta: false, tokenWatchlist: [] };
    // exactly at cap passes
    expect(validateAgainstScope({ request: { ...VALID, value: 100n, expiry: now + 10 }, scope }).ok).toBe(true);
    // one wei over fails
    expect(validateAgainstScope({ request: { ...VALID, value: 101n, expiry: now + 10 }, scope }).ok).toBe(false);
    // expiry == now is ACCEPTED: mirrors the contract's `block.timestamp > request.expiry`
    // (valid through the expiry second — Q5 off-by-one alignment)
    expect(validateAgainstScope({ request: { ...VALID, value: 1n, expiry: now }, scope }).ok).toBe(true);
    // one second past expiry fails
    expect(validateAgainstScope({ request: { ...VALID, value: 1n, expiry: now - 1 }, scope }).ok).toBe(false);
    // scope hard-expired
    expect(validateAgainstScope({ request: { ...VALID, value: 1n, expiry: now + 10 }, scope: { ...scope, expiresAt: now - 1 } }).ok).toBe(false);
  });

  it("merkle: proof for every leaf in trees of size 1..17 verifies", () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => targetLeaf(("0x" + i.toString(16).padStart(40, "0")) as `0x${string}`, "0x32145f90"));
      const root = merkleRoot(leaves);
      for (const leaf of leaves) {
        const proof = merkleProof(leaves, leaf) as `0x${string}`[];
        // local verify mirroring the contract (sorted pairs)
        let acc = leaf;
        for (const p of proof) {
          acc = acc.toLowerCase() < p.toLowerCase() ? (require("viem").keccak256(require("viem").concat([acc, p])) as `0x${string}`) : (require("viem").keccak256(require("viem").concat([p, acc])) as `0x${string}`);
        }
        expect(acc).toBe(root);
      }
    }
  }, 30_000);
});
