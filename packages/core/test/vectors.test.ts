/**
 * Golden-vector corpus consumer, TS side (enhancement E7). The committed fixtures in
 * vectors/ are generated ONCE (npm run vectors:generate) and frozen; this suite pins
 * the SDK's encoders to them so any drift — in either direction — fails loudly. The
 * EIP-7702 vectors are generated with viem's internal hashAuthorization (canonical
 * signer semantics), so this also pins our hand-rolled RLP to go-ethereum behavior.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { actionRequestDigest, authorizationDigest, merkleProof, merkleRoot, targetLeaf } from "../src/index.js";
import type { ActionRequest, Scope } from "../src/index.js";
import type { Hash, Hex } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "..", "vectors");

const actionVectors = JSON.parse(readFileSync(join(VECTORS, "actionrequest.json"), "utf8")) as {
  cases: Array<{
    name: string;
    chainId: number;
    verifyingContract: string;
    request: {
      agentId: string;
      target: string;
      selector: string;
      value: string;
      nonce: string;
      expiry: number;
      rationaleHash: string;
      data: string;
    };
    digest: string;
  }>;
};

const authVectors = JSON.parse(readFileSync(join(VECTORS, "eip7702.json"), "utf8")) as {
  cases: Array<{ name: string; chainId: string; contractAddress: string; nonce: string; digest: string }>;
};

const merkleVectors = JSON.parse(readFileSync(join(VECTORS, "merkle-v2.json"), "utf8")) as {
  leafCases: Array<{ name: string; target: string; selector: string; argsHash: string; data: string | null; leaf: string }>;
  trees: Array<{ leaves: string[]; root: string; proofs: Array<{ leaf: string; proof: string[] }> }>;
};

describe("golden vectors: ActionRequest digest", () => {
  for (const c of actionVectors.cases) {
    it(`matches frozen vector: ${c.name}`, () => {
      const request = {
        ...c.request,
        value: BigInt(c.request.value),
        nonce: BigInt(c.request.nonce),
      } as ActionRequest;
      const digest = actionRequestDigest({
        request,
        chainId: c.chainId,
        verifyingContract: c.verifyingContract as `0x${string}`,
      });
      expect(digest).toBe(c.digest as Hash);
    });
  }
});

describe("golden vectors: EIP-7702 authorization digest", () => {
  for (const c of authVectors.cases) {
    it(`matches canonical (viem-generated) vector: ${c.name}`, () => {
      const digest = authorizationDigest({
        chainId: BigInt(c.chainId),
        contractAddress: c.contractAddress as `0x${string}`,
        nonce: BigInt(c.nonce),
      });
      expect(digest).toBe(c.digest as Hash);
    });
  }
});

describe("golden vectors: Merkle v2 leaves and trees", () => {
  it("pinned and wildcard leaves match the frozen preimages", () => {
    for (const c of merkleVectors.leafCases) {
      const data = c.data === null ? undefined : (c.data as Hex);
      // Also independently verify the recorded argsHash commitment.
      const leaf = targetLeaf(c.target as `0x${string}`, c.selector as Hex, data);
      expect(leaf, c.name).toBe(c.leaf as Hash);
    }
  });

  it("tree root and every proof match the frozen 3-leaf tree", () => {
    for (const tree of merkleVectors.trees) {
      const leaves = tree.leaves as Hash[];
      expect(merkleRoot(leaves)).toBe(tree.root as Hash);
      for (const p of tree.proofs) {
        expect(merkleProof(leaves, p.leaf as Hash)).toEqual(p.proof);
      }
    }
  });
});
