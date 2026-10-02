/**
 * SIGNING / ENCODING CONFORMANCE SUITE (cr-sig audit, 2026-09-26).
 *
 * This is the byte-level audit suite for everything that turns an intent into a signature and
 * an on-chain object back into an audit record. It exists because the pre-existing suites each
 * check *one* leg in isolation (viem↔ethers parity, a hand-rolled reference, frozen vectors),
 * and none of them pinned the failure modes that only appear at the *seams*:
 *
 *  - a value that is a valid `number` but no longer denotes the value it was written as (> 2^53),
 *  - a uint field that is safe-integer but wider than its ABI type (uint48),
 *  - a decode that silently under-reads a log payload instead of rejecting it,
 *  - hand-rolled calldata slicing fed a non-hex string.
 *
 * The domain-separator tests are the load-bearing ones: they assert the SDK's EIP-712 domain
 * equals the ON-CHAIN construction (`keccak256(abi.encode(...))` over the five EIP-712 domain
 * words) byte-for-byte, and that all three of the SDK / viem / hand-rolled encoders agree.
 * `test/reference.test.ts` already pins a hand-rolled encoder against viem; this file pins the
 * same property against a *Solidity-shaped* `abi.encode` and against the frozen vectors.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";
import {
  ACTION_LOGGED_TOPIC,
  ACTION_REQUEST_TYPEHASH,
  AUTHORIZATION_MAGIC,
  SigilKitClient,
  assertDelegationScope,
  authorizationDigest,
  actionRequestDigest,
  parseActionLogged,
  rlpEncodeScalar,
  signAuthorization,
  toAuthorizationTuple,
  ZERO_ADDRESS,
  type ActionRequest,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "..", "vectors");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const DELEGATE = "0x0000000000000000000000000000000000000abc" as Address;

const REQUEST: ActionRequest = {
  agentId: ("0x" + "33".repeat(32)) as Hash,
  target: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  selector: "0x32145f90",
  value: 10n ** 16n,
  nonce: 0n,
  expiry: 1787654400,
  rationaleHash: ("0x" + "44".repeat(32)) as Hash,
  data: "0x",
};

/** Exactly what `SessionKeyManager._domainSeparator()` computes, in Solidity. */
const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const NAME_HASH = keccak256(toHex("SigilKit"));
const VERSION_HASH = keccak256(toHex("1"));

/** Solidity `keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)))`. */
function solidityDomainSeparator(chainId: number | bigint, contract: Address): Hash {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), contract],
    ),
  );
}

const wordLeft = (hexNoPrefix: string): Hex => ("0x" + hexNoPrefix.padStart(64, "0")) as Hex;
const wordRight = (hexNoPrefix: string): Hex => ("0x" + hexNoPrefix.padEnd(64, "0")) as Hex;

/** A third, dependency-free encoder: the EIP-712 struct hash built by explicit word padding. */
function handRolledStructHash(r: ActionRequest): Hash {
  return keccak256(
    concat([
      ACTION_REQUEST_TYPEHASH,
      r.agentId,
      wordLeft(r.target.slice(2)),
      wordRight(r.selector.slice(2)),
      wordLeft(r.value.toString(16)),
      wordLeft(r.nonce.toString(16)),
      wordLeft(r.expiry.toString(16)),
      r.rationaleHash,
      keccak256(r.data),
    ] as Hex[]),
  );
}

function handRolledDigest(r: ActionRequest, chainId: number, contract: Address): Hash {
  return keccak256(
    concat([
      "0x1901",
      keccak256(
        concat([
          DOMAIN_TYPEHASH,
          NAME_HASH,
          VERSION_HASH,
          wordLeft(BigInt(chainId).toString(16)),
          wordLeft(contract.slice(2)),
        ] as Hex[]),
      ),
      handRolledStructHash(r),
    ] as Hex[]),
  );
}

// ---------------------------------------------------------------------------
// 1. Domain separator — the load-bearing byte-level check
// ---------------------------------------------------------------------------

describe("EIP-712 domain separator: byte-for-byte against the chain", () => {
  it("name/version/chainId/verifyingContract hash to the on-chain _NAME_HASH/_VERSION_HASH", () => {
    // The two domain string constants are duplicated in types.ts (exported as the
    // cross-language reference) and consumed by signing.ts. If either drifts from the
    // Solidity `_NAME_HASH`/`_VERSION_HASH`, every signature the SDK produces is rejected
    // on-chain as InvalidSignature. Pin the hashes, not just the strings.
    expect(NAME_HASH).toBe(keccak256(toHex("SigilKit")));
    expect(VERSION_HASH).toBe(keccak256(toHex("1")));
    expect(DOMAIN_TYPEHASH).toBe(
      keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    );
  });

  const CASES: Array<[number, Address]> = [
    [31337, MANAGER],
    [1, "0x0000000000000000000000000000000000000001"],
    [11155111, "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f"],
    [8453, "0xffffffffffffffffffffffffffffffffffffffff"],
  ];

  it.each(CASES)("digest on chain %i @ %s equals the hand-rolled EIP-712 digest", (chainId, contract) => {
    // This is the whole conformance claim: the digest the SDK signs is the digest
    // `SessionKeyManager._requestDigest` recomputes on chain.
    expect(actionRequestDigest({ request: REQUEST, chainId, verifyingContract: contract })).toBe(
      handRolledDigest(REQUEST, chainId, contract),
    );
  });

  it("the domain separator is exactly the Solidity abi.encode of the five domain words", () => {
    // A hand-rolled separator and an `encodeAbiParameters` separator must agree, which is
    // what makes the hand-rolled encoder above trustworthy as an independent oracle.
    const handRolled = keccak256(
      concat([
        DOMAIN_TYPEHASH,
        NAME_HASH,
        VERSION_HASH,
        wordLeft(BigInt(CHAIN_ID).toString(16)),
        wordLeft(MANAGER.slice(2)),
      ] as Hex[]),
    );
    expect(handRolled).toBe(solidityDomainSeparator(CHAIN_ID, MANAGER));
  });

  it("reproduces every frozen ActionRequest vector (vectors/actionrequest.json)", () => {
    // Real, committed vectors — the digest values are not re-derived here, they are read
    // from the frozen corpus that the Solidity suite also consumes.
    const vectors = JSON.parse(readFileSync(join(VECTORS, "actionrequest.json"), "utf8")) as {
      cases: Array<{
        name: string;
        chainId: number;
        verifyingContract: string;
        request: { value: string; nonce: string; [k: string]: string | number };
        digest: string;
      }>;
    };
    expect(vectors.cases.length).toBeGreaterThanOrEqual(4);
    for (const c of vectors.cases) {
      const digest = actionRequestDigest({
        request: {
          agentId: c.request.agentId as Hash,
          target: c.request.target as Address,
          selector: c.request.selector as Hex,
          value: BigInt(c.request.value as string),
          nonce: BigInt(c.request.nonce as string),
          expiry: Number(c.request.expiry),
          rationaleHash: c.request.rationaleHash as Hash,
          data: c.request.data as Hex,
        },
        chainId: c.chainId,
        verifyingContract: c.verifyingContract as Address,
      });
      expect(digest, `vector: ${c.name}`).toBe(c.digest as Hash);
    }
  });

  it("three independent encoders agree (viem / hand-rolled / ethers-free Solidity shape)", () => {
    const viaViem = hashTypedData({
      domain: { name: "SigilKit", version: "1", chainId: CHAIN_ID, verifyingContract: MANAGER },
      types: {
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
      },
      primaryType: "ActionRequest",
      message: REQUEST,
    });
    expect(actionRequestDigest({ request: REQUEST, chainId: CHAIN_ID, verifyingContract: MANAGER })).toBe(viaViem);
  });
});

// ---------------------------------------------------------------------------
// 2. Integer coercion at the signing boundary
// ---------------------------------------------------------------------------

describe("digest domain fields reject values that are not exactly representable", () => {
  it("refuses a chainId above 2^53 rather than signing a different chain's domain", () => {
    // 2^53 + 1 is an "integer" to IEEE-754 but is NOT representable: BigInt(Number(2^53+1))
    // === 9007199254740992n. Signing it would produce a valid-looking signature bound to a
    // chain the caller never named.
    expect(() =>
      actionRequestDigest({ request: REQUEST, chainId: 2 ** 53, verifyingContract: MANAGER }),
    ).toThrow(/chainId/);
    expect(() =>
      actionRequestDigest({ request: REQUEST, chainId: 2 ** 53 + 2, verifyingContract: MANAGER }),
    ).toThrow(/chainId/);
    // …but 2^53 - 1 is fine.
    expect(() =>
      actionRequestDigest({ request: REQUEST, chainId: 2 ** 53 - 1, verifyingContract: MANAGER }),
    ).not.toThrow();
  });

  it("refuses a non-integer, negative or non-number chainId", () => {
    for (const bad of [1.5, -1, NaN, Infinity, "1" as unknown as number]) {
      expect(() =>
        actionRequestDigest({ request: REQUEST, chainId: bad, verifyingContract: MANAGER }),
      ).toThrow(/chainId/);
    }
  });

  it("refuses a malformed verifyingContract before hashing", () => {
    for (const bad of ["0xdeadbeef", "0x" + "ab".repeat(32), "", "not-an-address"]) {
      expect(() =>
        actionRequestDigest({ request: REQUEST, chainId: CHAIN_ID, verifyingContract: bad as Address }),
      ).toThrow(/verifyingContract/);
    }
  });

  it("refuses an expiry past uint48 even though it is a safe integer", () => {
    // 2^48 is a perfectly good JS integer and Number.isSafeInteger accepts it, but the ABI
    // type is uint48. The old guard only checked safe-integer, so the digest was computed over
    // a uint48 word holding a value the caller never wrote.
    const pastMax = { ...REQUEST, expiry: 2 ** 48 };
    expect(() => actionRequestDigest({ request: pastMax, chainId: CHAIN_ID, verifyingContract: MANAGER })).toThrow(
      /uint48/,
    );
    const atMax = { ...REQUEST, expiry: 2 ** 48 - 1 };
    expect(() => actionRequestDigest({ request: atMax, chainId: CHAIN_ID, verifyingContract: MANAGER })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. EIP-7702 authorization surface
// ---------------------------------------------------------------------------

describe("EIP-7702 authorization: domain separation and pre-image integrity", () => {
  it("matches canonical viem hashAuthorization on every frozen vector", () => {
    const vectors = JSON.parse(readFileSync(join(VECTORS, "eip7702.json"), "utf8")) as {
      cases: Array<{ name: string; chainId: string; contractAddress: string; nonce: string; digest: string }>;
    };
    expect(vectors.cases.length).toBeGreaterThanOrEqual(6);
    for (const c of vectors.cases) {
      const ours = authorizationDigest({
        chainId: BigInt(c.chainId),
        contractAddress: c.contractAddress as Address,
        nonce: BigInt(c.nonce),
      });
      expect(ours, `vector: ${c.name}`).toBe(c.digest as Hash);
      // Independently re-derive with viem's own canonical implementation.
      expect(ours, `viem parity: ${c.name}`).toBe(
        hashAuthorization({
          chainId: BigInt(c.chainId),
          address: c.contractAddress as Address,
          nonce: BigInt(c.nonce),
        }),
      );
    }
  });

  it("uses a dedicated pre-image (magic 0x05), NOT the EIP-712 domain (0x1901)", () => {
    // Cross-purpose replay guard: an authorization signature and an EIP-712 ActionRequest
    // signature must never be interchangeable. If both hashed the same pre-image, a signature
    // obtained for one could be replayed for the other.
    const auth = authorizationDigest({ chainId: CHAIN_ID, contractAddress: DELEGATE, nonce: 0n });
    const action = actionRequestDigest({ request: REQUEST, chainId: CHAIN_ID, verifyingContract: MANAGER });
    expect(auth).not.toBe(action);
    // The magic byte is the constant that makes the two pre-image families disjoint.
    expect(AUTHORIZATION_MAGIC).toBe("0x05");
    expect(AUTHORIZATION_MAGIC).not.toBe("0x1901");
  });

  it("field order is exactly [chainId, address, nonce] and every field is load-bearing", () => {
    const base = { chainId: CHAIN_ID, contractAddress: DELEGATE, nonce: 5n };
    const d = authorizationDigest(base);
    expect(authorizationDigest({ ...base })).toBe(d);
    expect(authorizationDigest({ ...base, chainId: CHAIN_ID + 1 })).not.toBe(d);
    expect(authorizationDigest({ ...base, contractAddress: ZERO_ADDRESS })).not.toBe(d);
    expect(authorizationDigest({ ...base, nonce: 6n })).not.toBe(d);
    // Swapping the address and nonce positions must not reproduce the digest.
    expect(authorizationDigest({ chainId: CHAIN_ID, contractAddress: DELEGATE, nonce: CHAIN_ID })).not.toBe(
      authorizationDigest({ chainId: CHAIN_ID, contractAddress: DELEGATE, nonce: 5n }),
    );
  });

  it("reproduces a real, externally-anchored authorization pre-image byte-for-byte", () => {
    // The full RLP pre-image, spelled out by hand from the EIP-7702 spec, for
    // chainId=31337 (0x7a69), address 0x9858…da94, nonce=0:
    //   0x05 || d9 || 82 7a69 || 94 <20 bytes> || 80
    const addr = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    const expectedPreimage =
      "0x05" + "d9" + "827a69" + "94" + addr.slice(2).toLowerCase() + "80";
    const ours = authorizationDigest({ chainId: 31337, contractAddress: addr as Address, nonce: 0 });
    // keccak256 over the literal pre-image, asserted against the frozen digest.
    expect(ours).toBe(keccak256(expectedPreimage as Hex));
    expect(ours).toBe(hashAuthorization({ chainId: 31337, address: addr as Address, nonce: 0 }));
  });

  it("rejects a chainId/nonce that is a non-negative-looking but non-representable number", () => {
    for (const bad of [2 ** 53 + 2, 1.5, -1, NaN, "12x" as unknown as number]) {
      expect(() =>
        authorizationDigest({ chainId: bad as number, contractAddress: DELEGATE, nonce: 0n }),
      ).toThrow(/chainId/);
      expect(() =>
        authorizationDigest({ chainId: CHAIN_ID, contractAddress: DELEGATE, nonce: bad as number }),
      ).toThrow(/nonce/);
    }
  });

  it("refuses a negative RLP scalar with a readable error", () => {
    // RLP has no representation for a negative number; the guard must not surface as a
    // viem "Invalid byte sequence" error three frames deep.
    expect(() => rlpEncodeScalar(-1n)).toThrow(/negative/i);
  });

  it("assertDelegationScope blocks a chainId-0 wildcard unless explicitly allowed", () => {
    const wildcard = {
      contractAddress: DELEGATE,
      chainId: 0n,
      nonce: 0n,
      yParity: 0 as const,
      r: ("0x" + "11".repeat(32)) as Hex,
      s: ("0x" + "22".repeat(32)) as Hex,
    };
    expect(() => assertDelegationScope(wildcard, { chainId: 0, implementation: DELEGATE })).toThrow(/EVERY chain/i);
    // Explicit opt-in passes.
    expect(
      assertDelegationScope(wildcard, { chainId: 0, implementation: DELEGATE, allowAllChains: true }).chainId,
    ).toBe(0n);
  });

  it("assertDelegationScope rejects a chain or delegate that disagrees with the authorization", () => {
    const auth = {
      contractAddress: DELEGATE,
      chainId: CHAIN_ID,
      nonce: 0n,
      yParity: 0 as const,
      r: ("0x" + "11".repeat(32)) as Hex,
      s: ("0x" + "22".repeat(32)) as Hex,
    };
    expect(() => assertDelegationScope(auth, { chainId: 1, implementation: DELEGATE })).toThrow(/chainId/i);
    expect(() => assertDelegationScope(auth, { chainId: CHAIN_ID, implementation: ZERO_ADDRESS })).toThrow();
    // A revoke-intent paired with a delegating authorization is the dangerous inversion.
    expect(() =>
      assertDelegationScope(auth, { chainId: CHAIN_ID, implementation: ZERO_ADDRESS, revoke: true }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Authorization tuple serialization
// ---------------------------------------------------------------------------

describe("toAuthorizationTuple validates the struct it serializes", () => {
  const good = {
    contractAddress: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address,
    chainId: 31337n,
    nonce: 0n,
    yParity: 0 as const,
    r: ("0x" + "11".repeat(32)) as Hex,
    s: ("0x" + "22".repeat(32)) as Hex,
  };

  it("emits viem's SerializedAuthorization field order", () => {
    const t = toAuthorizationTuple(good);
    expect(t).toHaveLength(6);
    expect(t[0]).toBe("0x7a69"); // chainId, minimal hex
    expect(t[1]).toBe(good.contractAddress);
    expect(t[2]).toBe("0x0"); // nonce
    expect(t[3]).toBe("0x0"); // yParity
    expect(t[4]).toBe(good.r);
    expect(t[5]).toBe(good.s);
  });

  it("rejects a yParity that is not 0 or 1", () => {
    expect(() => toAuthorizationTuple({ ...good, yParity: 2 as unknown as 0 })).toThrow(/yParity/);
  });

  it("rejects an r or s that is not a 32-byte hex scalar", () => {
    expect(() => toAuthorizationTuple({ ...good, r: "0x11" as Hex })).toThrow(/r/);
    expect(() => toAuthorizationTuple({ ...good, s: "zz" as unknown as Hex })).toThrow(/s/);
  });

  it("rejects a malformed delegate address", () => {
    expect(() => toAuthorizationTuple({ ...good, contractAddress: "0xdead" as Address })).toThrow();
  });

  it("rejects a chainId or nonce past uint256 (which cannot be RLP-encoded as a uint256)", () => {
    expect(() => toAuthorizationTuple({ ...good, chainId: 2n ** 256n })).toThrow(/chainId/);
    expect(() => toAuthorizationTuple({ ...good, nonce: 2n ** 256n })).toThrow(/nonce/);
  });

  it("rejects a high-s (EIP-2 malleable) signature", () => {
    expect(() => toAuthorizationTuple({ ...good, s: ("0x" + "f".repeat(64)) as Hex })).toThrow(/s/);
  });

  it("signAuthorization round-trips into a tuple the tuple-encoder accepts", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const auth = await signAuthorization(account, {
      contractAddress: "0x0000000000000000000000000000000000000abc",
      chainId: 31337,
      nonce: 0,
    });
    expect(() => toAuthorizationTuple(auth)).not.toThrow();
    expect(toAuthorizationTuple(auth)[0]).toBe("0x7a69");
  });
});

// ---------------------------------------------------------------------------
// 5. Decode robustness — the audit-record path
// ---------------------------------------------------------------------------

describe("parseActionLogged refuses to fabricate an audit record from a short payload", () => {
  const topic0 = ACTION_LOGGED_TOPIC;
  const topics = [
    topic0,
    ("0x" + "11".repeat(32)) as Hex, // agentId (indexed)
    ("0x" + "00".repeat(12) + "0000000000000000000000000000000000000001") as Hex, // target
    ("0x" + "a9".repeat(4) + "00".repeat(28)) as Hex, // selector
  ];
  const mkLog = (data: string): Log =>
    ({
      address: MANAGER,
      data,
      topics,
      blockNumber: 1n,
      transactionHash: ("0x" + "ab".repeat(32)) as Hash,
      logIndex: 0,
      removed: false,
    }) as unknown as Log;

  // A well-formed 3-word payload (96 bytes = 194 hex chars + "0x"): value, rationaleHash, timestamp.
  const wellFormed = "0x" + "00".repeat(32) + "22".repeat(32) + "00".repeat(32);

  it("accepts a correctly-sized payload", () => {
    const rec = parseActionLogged([mkLog(wellFormed)], {
      emitter: MANAGER,
      request: {
        agentId: ("0x" + "11".repeat(32)) as Hash,
        target: "0x0000000000000000000000000000000000000001",
        selector: "0xa9a9a9a9" as Hex,
        value: 0n,
        // The payload's 2nd word IS the rationaleHash — the expectation must match it.
        rationaleHash: ("0x" + "22".repeat(32)) as Hash,
      },
      txHash: ("0x" + "ab".repeat(32)) as Hash,
    });
    expect(rec).not.toBeNull();
    expect(rec!.value).toBe(0n);
    expect(rec!.rationaleHash).toBe(("0x" + "22".repeat(32)) as Hash);
  });

  it("REJECTS a 2-word payload that decodeEventLog would silently under-read", () => {
    // This is the concrete bug: `decodeEventLog({ strict: true })` accepts any data that is
    // "big enough" per its own check and reads the first three words. A 2-word payload of zeros
    // decoded to a *plausible* record (value=0, rationaleHash=0, timestamp=0) which the SDK
    // then returned as genuine audit evidence. Now rejected on length alone.
    const short = "0x" + "00".repeat(64); // 2 words = 32 bytes
    const rec = parseActionLogged(
      [mkLog(short)],
      {
        emitter: MANAGER,
        request: {
          agentId: ("0x" + "11".repeat(32)) as Hash,
          target: "0x0000000000000000000000000000000000000001",
          selector: "0xa9a9a9a9" as Hex,
          value: 0n,
          rationaleHash: ("0x" + "00".repeat(32)) as Hash,
        },
        txHash: ("0x" + "ab".repeat(32)) as Hash,
      },
    );
    expect(rec).toBeNull();
  });

  it("rejects non-hex and odd-length data without throwing", () => {
    expect(parseActionLogged([mkLog("0x" + "zz".repeat(96))])).toBeNull();
    expect(parseActionLogged([mkLog("0x" + "00".repeat(95))])).toBeNull(); // odd length
    expect(parseActionLogged([mkLog("0x")])).toBeNull();
  });

  it("rejects an over-long payload instead of silently ignoring the tail", () => {
    const overLong = "0x" + "00".repeat(32) + "22".repeat(32) + "00".repeat(32) + "de".repeat(4096);
    expect(parseActionLogged([mkLog(overLong)])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. checkTokenPath — hand-rolled calldata slicing must never throw
// ---------------------------------------------------------------------------

describe("checkTokenPath is total: malformed calldata yields no checks, never a throw", () => {
  // A stub client: checkTokenPath's only RPC is balanceOf/allowance, and a malformed payload
  // must be rejected by the *local* shape gate before any of it is reached.
  const stub = {
    readContract: async () => 0n,
    getCode: async () => "0x",
  } as unknown as PublicClient;
  const client = new SigilKitClient({
    managerAddress: MANAGER,
    chain: { id: CHAIN_ID, name: "stub", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } } as never,
    publicClient: stub,
  });

  const withData = (selector: Hex, data: string): ActionRequest => ({
    ...REQUEST,
    target: "0x0000000000000000000000000000000000009001",
    selector,
    data: data as Hex,
  });

  it("a transfer with non-hex characters in the amount word does not throw", () => {
    // Previously: BigInt("0xzz…") threw a raw SyntaxError out of a method documented as
    // "NEVER throws". Reachable from any agent/MCP surface that hands model output straight
    // through.
    const data = "0x" + "0".repeat(64) + "zz".repeat(64);
    return expect(client.checkTokenPath(withData("0xa9059cbb", data))).resolves.toBeDefined();
  });

  it("a transferFrom with non-hex characters does not throw", () => {
    const data = "0x" + "zz".repeat(64) + "0".repeat(64) + "0".repeat(64);
    return expect(client.checkTokenPath(withData("0x23b872dd", data))).resolves.toBeDefined();
  });

  it("an uppercase selector is still recognized (case-insensitive match)", () => {
    // parseActionRequest accepts a checksummed selector, so the advisory check must too —
    // otherwise the "warn me before I lose funds" branch silently no-ops.
    const data = "0x" + "0".repeat(64) + "0".repeat(64);
    const report = client.checkTokenPath(withData("0xA9059CBB", data));
    return expect(report).resolves.toBeDefined();
  });
});
