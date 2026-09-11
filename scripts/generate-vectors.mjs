/**
 * Golden-vector corpus generator (enhancement E7).
 *
 * Produces cross-language fixtures shared by the TS suite, the Foundry suite, and the
 * docs. Canonical sources: viem's hashAuthorization (external reference) for EIP-7702,
 * viem's hashTypedData for ActionRequest digests, and @sigilkit/core's own builders
 * for Merkle v2 (whose correctness the Solidity side independently pins).
 *
 * Run:  npm run vectors:generate   (from the repo root; requires npm run build first)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  hashTypedData,
  keccak256,
} from "viem";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// viem 2.x ships hashAuthorization internally but does not re-export it from the
// package root; import the module file directly for the canonical external reference.
const { hashAuthorization } = await import(
  pathToFileURL(join(ROOT, "node_modules/viem/_esm/utils/authorization/hashAuthorization.js")).href
);

const { targetLeaf, merkleRoot, merkleProof, actionRequestDigest } = require(
  join(ROOT, "packages/core/dist/index.js"),
);

// ---------------------------------------------------------------------------
// ActionRequest EIP-712 digests
// ---------------------------------------------------------------------------
const MANAGER = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f"; // any address; vectors pin the MATH
const TYPES = {
  ActionRequest: [
    { name: "agentId", type: "bytes32" },
    { name: "target", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint48" },
    { name: "rationaleHash", type: "bytes32" },
    { name: "data", type: "bytes" },
  ],
};

function requestCase(name, chainId, request) {
  const digest = actionRequestDigest({ request, chainId, verifyingContract: MANAGER });
  return {
    name,
    chainId,
    verifyingContract: MANAGER,
    request: {
      agentId: request.agentId,
      target: request.target,
      selector: request.selector,
      value: request.value.toString(),
      nonce: request.nonce.toString(),
      expiry: request.expiry,
      rationaleHash: request.rationaleHash,
      data: request.data,
    },
    digest,
  };
}

const actionrequest = {
  _doc: "Golden vectors for the ActionRequest EIP-712 digest. Consumers: packages/core/test/vectors.test.ts (SDK equality) and contracts/test/GoldenVectors.t.sol (on-chain equality). Regenerate: npm run vectors:generate.",
  casesCount: 0, // filled below (Foundry parseJson cannot evaluate .length paths)
  cases: [
    requestCase("zero-value-empty-data", 31337, {
      agentId: ("0x" + "11".repeat(32)),
      target: "0x0000000000000000000000000000000000000001",
      selector: "0x32145f90",
      value: 0n,
      nonce: 0n,
      expiry: 1_900_000_000,
      rationaleHash: ("0x" + "22".repeat(32)),
      data: "0x",
    }),
    requestCase("value-and-args", 1, {
      agentId: ("0x" + "ab".repeat(32)),
      target: "0x0000000000000000000000000000000000009001",
      selector: "0xa9059cbb",
      value: ("0x" + "1".padEnd(64, "0")).slice(0, 66),
      nonce: 7n,
      expiry: 1_900_000_000,
      rationaleHash: ("0x" + "cd".repeat(32)),
      data: ("0x" + "00".repeat(20) + "ff".repeat(32)),
    }),
    requestCase("max-uint48-expiry", 11155111, {
      agentId: ("0x" + "00".repeat(32)),
      target: "0x0000000000000000000000000000000000000000",
      selector: "0x00000000",
      value: "0x" + "3".padEnd(64, "0"),
      nonce: ("0x" + "f".repeat(64)).slice(0, 66),
      expiry: 2 ** 48 - 1,
      rationaleHash: ("0x" + "ff".repeat(32)),
      data: "0xdeadbeef",
    }),
    requestCase("long-data", 8453, {
      agentId: ("0x" + "57".repeat(32)),
      target: "0x000000000000000000000000000000000000cafe",
      selector: "0x01234567",
      value: 123456789n,
      nonce: 18446744073709551615n,
      expiry: 4294967295,
      rationaleHash: ("0x" + "9a".repeat(32)),
      data: ("0x" + "5a".repeat(256)),
    }),
  ],
};

// ---------------------------------------------------------------------------
// EIP-7702 authorization digests (canonical: viem hashAuthorization)
// ---------------------------------------------------------------------------
const eip7702 = {
  _doc: "Golden vectors for EIP-7702 authorization digests. Digests are generated with viem's hashAuthorization — the canonical signer implementation — NOT with @sigilkit/core, so the SDK test pins our encoder to go-ethereum semantics.",
  casesCount: 0, // filled below
  cases: [
    { name: "revocation-zero-address", chainId: "1", contractAddress: "0x0000000000000000000000000000000000000000", nonce: "0" },
    { name: "leading-zero-address", chainId: "1", contractAddress: "0x00000000000000000000000000000000deadbeef", nonce: "0" },
    { name: "nonce-127", chainId: "31337", contractAddress: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f", nonce: "127" },
    { name: "nonce-128-length-prefix", chainId: "31337", contractAddress: "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f", nonce: "128" },
    { name: "nonce-uint16-max", chainId: "8453", contractAddress: "0x7702cb554e6bFb442cb743A7dF23154544a7176C", nonce: "65535" },
    { name: "sepolia", chainId: "11155111", contractAddress: "0x000100abaad02f1cfC8Bbe32bD5a564817339E72", nonce: "1" },
  ].map((c) => ({
    ...c,
    digest: hashAuthorization({
      contractAddress: c.contractAddress,
      chainId: BigInt(c.chainId),
      nonce: BigInt(c.nonce),
    }),
  })),
};

// ---------------------------------------------------------------------------
// Merkle v2 leaves (pinned + wildcard) and multi-level trees
// ---------------------------------------------------------------------------
function leafCase(name, target, selector, data) {
  const wildcard = targetLeaf(target, selector);
  const leaf = data === undefined ? wildcard : targetLeaf(target, selector, data);
  return {
    name,
    target,
    selector,
    argsHash: data === undefined ? "0x" + "0".repeat(64) : keccak256(data),
    // data is stored so consumers can recompute argsHash = keccak256(data) themselves.
    data: data === undefined ? null : data,
    leaf,
  };
}

const targets = [
  "0x0000000000000000000000000000000000009001",
  "0x0000000000000000000000000000000000009002",
  "0x0000000000000000000000000000000000009003",
];
const leaves = [
  leafCase("pinned-transfer", targets[0], "0xa9059cbb", ("0x" + "00".repeat(20) + "03e8".padStart(64 - 40, "0"))),
  leafCase("wildcard-poke", targets[1], "0x32145f90", undefined),
  leafCase("pinned-empty-calldata", targets[2], "0x00000000", "0x"),
];

// Build one 3-leaf tree (exercises odd-node promotion) from the three leaves above.
const treeLeaves = leaves.map((l) => l.leaf);
const root = merkleRoot(treeLeaves);
const proofs = treeLeaves.map((leaf) => ({
  leaf,
  proof: merkleProof(treeLeaves, leaf),
}));

const merkleV2 = {
  _doc: "Golden vectors for whitelist leaf format v2 (pinned + wildcard leaves) and a 3-leaf sorted-pair tree with odd-node promotion. Consumers: both language suites.",
  leafCases: leaves,
  trees: [
    {
      leaves: treeLeaves,
      root,
      proofs,
    },
  ],
};

// ---------------------------------------------------------------------------
// Explicit counts — Foundry parseJson cannot evaluate .length paths.
actionrequest.casesCount = actionrequest.cases.length;
eip7702.casesCount = eip7702.cases.length;
merkleV2.leafCasesCount = merkleV2.leafCases.length;
merkleV2.trees[0].proofsCount = merkleV2.trees[0].proofs.length;
merkleV2.trees[0].leavesCount = merkleV2.trees[0].leaves.length;

const OUT = join(ROOT, "vectors");
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "actionrequest.json"), JSON.stringify(actionrequest, null, 2) + "\n");
writeFileSync(join(OUT, "eip7702.json"), JSON.stringify(eip7702, null, 2) + "\n");
writeFileSync(join(OUT, "merkle-v2.json"), JSON.stringify(merkleV2, null, 2) + "\n");
console.log(`vectors written: actionrequest.json (${actionrequest.cases.length}), eip7702.json (${eip7702.cases.length}), merkle-v2.json (${merkleV2.leafCases.length} leaf cases, 1 tree)`);
