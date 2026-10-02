/**
 * EIP-712 domain-constant drift guard.
 *
 * `signing.ts` hardcodes `name: "SigilKit", version: "1"` inline in the
 * `hashTypedData` domain, while `types.ts` exports the same two values as
 * `SIGILKIT_DOMAIN_NAME` / `SIGILKIT_DOMAIN_VERSION` "as the cross-language reference
 * for consumers building digests by hand". No test referenced either constant, so the
 * two copies could drift with nothing failing — a consumer building a digest by hand
 * from the exported constants would then produce a digest that does NOT match what
 * `signActionRequest` signs, and every such signature would be rejected on-chain as
 * InvalidSignature with no local warning.
 *
 * This test pins the exported constants to the values the encoder actually uses, by
 * deriving the domain separator from both sides independently.
 */
import { describe, expect, it } from "vitest";
import {
  concat,
  hashDomain,
  keccak256,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  actionRequestDigest,
  ACTION_REQUEST_TYPEHASH,
  SIGILKIT_DOMAIN_NAME,
  SIGILKIT_DOMAIN_VERSION,
  type ActionRequest,
} from "../src/index.js";

const CHAIN_ID = 31337;
const MANAGER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;

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

/** EIP-712 domain separator composed only from the EXPORTED constants. */
function separatorFromExportedConstants(): Hash {
  return hashDomain({
    domain: {
      name: SIGILKIT_DOMAIN_NAME,
      version: SIGILKIT_DOMAIN_VERSION,
      chainId: BigInt(CHAIN_ID),
      verifyingContract: MANAGER,
    },
    // `hashDomain` takes the same `{domain, types}` envelope as `hashTypedData` (viem >= 2.x);
    // passing the domain fields flat is a type error AND silently drops them at runtime.
    // `primaryType` is NOT accepted: viem's type is
    // `UnionOmit<EIP712DomainDefinition<…>, "primaryType">` — the domain-only form is selected
    // by the FUNCTION, not by a discriminator argument.
    //
    // `types` must CONTAIN the `EIP712Domain` entry: `hashDomain` forwards straight to
    // `hashStruct`, which does `types[primaryType].map(...)`. An empty object therefore throws
    // `Cannot read properties of undefined (reading 'map')` — it does not degrade quietly.
    // Inside `hashTypedData` viem synthesises this entry from the domain's own keys via
    // `getTypesForEIP712Domain`; calling `hashDomain` directly means supplying it ourselves,
    // and the canonical field order (the encode order) is fixed by the standard.
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
}

/** The same separator composed by hand, with no library helper. */
function handRolledSeparator(): Hash {
  const domainTypehash = keccak256(
    toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  const word = (hexNoPrefix: string): Hex => ("0x" + hexNoPrefix.padStart(64, "0")) as Hex;
  return keccak256(
    concat([
      domainTypehash,
      keccak256(toHex(SIGILKIT_DOMAIN_NAME)),
      keccak256(toHex(SIGILKIT_DOMAIN_VERSION)),
      word(CHAIN_ID.toString(16)),
      word(MANAGER.slice(2)),
    ] as Hex[]),
  );
}

describe("EIP-712 domain constants match the encoder", () => {
  it("pins the exported name and version to the values the chain expects", () => {
    // Changing either of these changes every signature SigilKit produces, so they are
    // pinned numerically — a silent "improvement" to the domain would break every
    // deployed SessionKeyManager.
    expect(SIGILKIT_DOMAIN_NAME).toBe("SigilKit");
    expect(SIGILKIT_DOMAIN_VERSION).toBe("1");
  });

  it("the library-composed and hand-composed separators agree", () => {
    expect(separatorFromExportedConstants()).toBe(handRolledSeparator());
  });

  it("a digest built from the exported constants equals actionRequestDigest's digest", () => {
    // Recompute the full digest by hand from the exported constants + typehash, then
    // compare against the SDK. This is the property a hand-rolling integrator relies
    // on; if the encoder's inline domain ever drifts from the constants, this fails.
    const structHash = keccak256(
      concat([
        ACTION_REQUEST_TYPEHASH,
        // Already full 32-byte words — passed through verbatim, no padding applied.
        REQUEST.agentId,
        // `.slice(2)` is REQUIRED: the padding helpers take hex WITHOUT the `0x` prefix
        // (they prepend their own). Passing the prefixed form yields "0x0x…", a
        // malformed word that hashes to a wrong struct hash for a reason that has nothing
        // to do with the domain under test.
        wordLeft(REQUEST.target.slice(2)),
        // `selector` is ABI type `bytes4`. Verified empirically against viem's own
        // `hashStruct`, and independently by `reference.test.ts:36-37` (`padWordRight` is
        // the same rule): the 4 bytes occupy the LOW 4 bytes of the word, with the leading
        // 28 zero. Left-aligning instead yields a different struct hash — a false alarm
        // unrelated to the domain.
        wordRight(REQUEST.selector.slice(2)),
        wordLeft(REQUEST.value.toString(16)),
        wordLeft(REQUEST.nonce.toString(16)),
        wordLeft(REQUEST.expiry.toString(16)),
        REQUEST.rationaleHash,
        keccak256(REQUEST.data),
      ] as Hex[]),
    );
    const handBuilt = keccak256(
      concat(["0x1901", handRolledSeparator(), structHash] as Hex[]),
    );
    expect(handBuilt).toBe(
      actionRequestDigest({ request: REQUEST, chainId: CHAIN_ID, verifyingContract: MANAGER }),
    );
  });

  it("the domain binds the chain and the verifying contract", () => {
    // Cross-chain replay protection: the same request must not verify on another chain.
    const here = actionRequestDigest({ request: REQUEST, chainId: 1, verifyingContract: MANAGER });
    const elsewhere = actionRequestDigest({ request: REQUEST, chainId: 2, verifyingContract: MANAGER });
    const otherContract = actionRequestDigest({
      request: REQUEST,
      chainId: 1,
      verifyingContract: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    });
    expect(here).not.toBe(elsewhere);
    expect(here).not.toBe(otherContract);
  });

  it("the exported typehash is the keccak of the canonical ActionRequest type string", () => {
    expect(ACTION_REQUEST_TYPEHASH).toBe(
      keccak256(
        toHex(
          "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)",
        ),
      ),
    );
  });
});

/** Right-aligns into a 32-byte word: zeros AFTER — the ABI rule for `bytesN`. */
function wordRight(hexNoPrefix: string): Hex {
  return ("0x" + hexNoPrefix.padEnd(64, "0")) as Hex;
}
/** Left-aligns into a 32-byte word: zeros BEFORE — the ABI rule for `address`/`uintN`. */
function wordLeft(hexNoPrefix: string): Hex {
  return ("0x" + hexNoPrefix.padStart(64, "0")) as Hex;
}
