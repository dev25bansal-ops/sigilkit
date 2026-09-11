/**
 * Multi-level Merkle property tests — the gap flagged in the 2026-09 issues catalog (Q6):
 * before this file, the deepest proof ever exercised was 1 element (2-leaf tree on-chain,
 * depth-1 Halmos spec), while the SDK implements full multi-level build/proof with odd-node
 * promotion. These tests pin that SDK proofs verify for every tree size against a local
 * reference implementation of MerkleWhitelist.verify (sorted-pair hashing, identical to the
 * Solidity contract).
 */
import { describe, expect, it } from "vitest";
import { concat, keccak256, toHex, type Address, type Hash, type Hex } from "viem";
import { merkleProof, merkleRoot, targetLeaf, validateAgainstScope } from "../src/index.js";
import type { ActionRequest, Scope } from "../src/index.js";

/** Local mirror of MerkleWhitelist.verify (contracts/src/MerkleWhitelist.sol). */
function verifyRef(proof: Hex[], root: Hash, leaf: Hash): boolean {
  let computed = leaf;
  for (const p of proof) {
    computed = sortedPairHash(computed, p);
  }
  return computed === root;
}

/** Local mirror of the on-chain sorted-pair hash. */
function sortedPairHash(a: Hash, b: Hash): Hash {
  return a.toLowerCase() < b.toLowerCase()
    ? keccak256(concat([a, b]))
    : keccak256(concat([b, a]));
}

function leavesFor(n: number): Hash[] {
  return Array.from({ length: n }, (_, i) =>
    targetLeaf(
      `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      "0x32145f90" as Hex, // poke(uint256)
    ),
  );
}

describe("multi-level Merkle proofs (SDK ↔ on-chain sorted-pair scheme)", () => {
  it("proofs for every tree size 1..32 verify against the reference verifier", () => {
    for (let n = 1; n <= 32; n++) {
      const leaves = leavesFor(n);
      const root = merkleRoot(leaves);
      for (const leaf of leaves) {
        const proof = merkleProof(leaves, leaf);
        expect(verifyRef(proof, root, leaf), `size=${n} leaf=${leaf}`).toBe(true);
      }
    }
  });

  it("max-depth proofs have exactly ceil(log2(n)) elements for powers of two", () => {
    expect(merkleProof(leavesFor(32), leavesFor(32)[0]!).length).toBe(5);
    expect(merkleProof(leavesFor(16), leavesFor(16)[7]!).length).toBe(4);
    expect(merkleProof(leavesFor(4), leavesFor(4)[2]!).length).toBe(2);
    expect(merkleProof(leavesFor(1), leavesFor(1)[0]!).length).toBe(0);
  });

  it("tampered proof elements never verify", () => {
    const leaves = leavesFor(8);
    const root = merkleRoot(leaves);
    for (const leaf of leaves) {
      const proof = merkleProof(leaves, leaf);
      for (let i = 0; i < proof.length; i++) {
        const tampered = [...proof];
        tampered[i] = keccak256(toHex(`tamper-${i}`));
        expect(verifyRef(tampered, root, leaf)).toBe(false);
      }
    }
  });

  it("a proof for one leaf does not verify for a different leaf in the same tree", () => {
    const leaves = leavesFor(6);
    const root = merkleRoot(leaves);
    const proofForFirst = merkleProof(leaves, leaves[0]!);
    expect(verifyRef(proofForFirst, root, leaves[1]!)).toBe(false);
  });

  it("duplicate (target, selector) leaves still verify for every position", () => {
    const dup = targetLeaf("0x0000000000000000000000000000000000000042" as Address, "0x32145f90" as Hex);
    const leaves = [dup, leavesFor(1)[0]!, dup, leavesFor(2)[1]!];
    const root = merkleRoot(leaves);
    for (const leaf of leaves) {
      expect(verifyRef(merkleProof(leaves, leaf), root, leaf)).toBe(true);
    }
  });
});

describe("leaf format v2: argument-bound (pinned) leaves — issues catalog S1", () => {
  const TARGET = "0x0000000000000000000000000000000000009001" as Address;
  const SEL = "0xa9059cbb" as Hex; // transfer(address,uint256)
  const DATA = "0x000000000000000000000000000000000000cafe0000000000000000000003e8" as Hex;
  const OTHER = "0x000000000000000000000000000000000000dead000000000000003b9aca00" as Hex;

  function request(data: Hex): ActionRequest {
    return {
      agentId: keccak256(toHex("agent")) as Hash,
      target: TARGET,
      selector: SEL,
      value: 0n,
      nonce: 0n,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: zeroHashLike(),
      data,
    };
  }
  function zeroHashLike(): Hash {
    return `0x${"0".repeat(64)}` as Hash;
  }
  function scope(root: Hash): Scope {
    return {
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      windowSeconds: 600,
      perActionCap: 10n ** 18n,
      perWindowCap: 10n ** 18n,
      merkleRoot: root,
      countersignAbove: 0n,
      enforceNativeDelta: false,
      tokenWatchlist: [],
    };
  }

  it("wildcard and pinned leaves are distinct; pinning binds the exact calldata", () => {
    const wildcard = targetLeaf(TARGET, SEL);
    const pinned = targetLeaf(TARGET, SEL, DATA);
    const pinnedOther = targetLeaf(TARGET, SEL, OTHER);
    expect(pinned).not.toBe(wildcard);
    expect(pinnedOther).not.toBe(pinned);
    // keccak256("") != 0 → pinned-empty and wildcard also differ.
    expect(targetLeaf(TARGET, SEL, "0x")).not.toBe(wildcard);
  });

  it("validateAgainstScope accepts the pinned proof and rejects other calldata", () => {
    const leaves = [targetLeaf(TARGET, SEL, DATA)];
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, targetLeaf(TARGET, SEL, DATA));

    const okResult = validateAgainstScope({
      request: request(DATA),
      scope: scope(root),
      merkleProof: proof,
    });
    expect(okResult).toEqual({ ok: true });

    // Same whitelisted selector, different (draining) calldata → rejected locally
    // before a signature is burned — the zero-gas mirror of the on-chain check.
    const bad = validateAgainstScope({
      request: request(OTHER),
      scope: scope(root),
      merkleProof: proof,
    });
    expect(bad).toEqual({ ok: false, reason: "target not whitelisted" });
  });
});
