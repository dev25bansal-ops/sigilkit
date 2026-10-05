/**
 * E2E — the E10 owner-countersignature digest: does the SDK help build it AT ALL?
 *
 * Why this file exists
 * --------------------
 * `SessionKeyManager` (Solidity) gates any action whose `value` exceeds
 * `scope.countersignAbove` on an owner EIP-712 signature over
 *
 *     keccak256(abi.encode(REQUEST_APPROVAL_TYPEHASH, requestDigest))
 *
 * where `REQUEST_APPROVAL_TYPEHASH = keccak256("RequestApproval(bytes32 requestDigest)")`
 * (`SessionKeyManager.sol:112-113`, digest at `:872`, verified at `:510-515`).
 *
 * The repo has exactly one golden-vector file for cross-language digest parity --
 * `vectors/actionrequest.json` -- and its `_doc` names both consumers: the SDK test and
 * `contracts/test/GoldenVectors.t.sol`. So the *ActionRequest* digest has a single
 * source of truth consumed by both languages. **The approval digest does not.**
 *
 * The consequence is worse than "the vectors are missing". It is that the SDK has no
 * way to produce this signature at all, so every counter-signed action is assembled by
 * hand, out-of-band, by whoever integrates the library:
 *
 *   - `grep` over every TypeScript file under `packages/` finds `ownerApproval` in just
 *     three places, all of them *pass-through*: the optional field on `ActionRequest`
 *     (`types.ts:189`), the optional parameter on the client method (`client.ts:217`),
 *     and the two `?? "0x"` forwards into the contract call (`client.ts:714,721`).
 *     There is no `RequestApproval` typehash constant, no `approvalDigest()` helper,
 *     and no `signApproval()` anywhere in `@sigilkit/core`.
 *   - So the digest is hand-written per integration, exactly like the three hand-rolled
 *     recomputations ck-test found in the Solidity tests.
 *
 * This matters more than the agentId case-sensitivity defect in Flow A, not less:
 * a wrong agentId returns zero rows (an availability failure), whereas a wrong
 * approval digest either invalidates every large action (all large transfers revert)
 * or — worse — lets a signature over one request be replayed as approval for another.
 *
 * What this test does
 * -------------------
 * It pins the CURRENT state, which is "the SDK exports no approval-digest builder and
 * no approval typehash". That is a fact about the public API surface, and asserting it
 * means the day someone adds the helper, this test goes red and the vector work gets
 * done instead of being quietly forgotten.
 *
 * It then goes one step further and *reconstructs* the digest the way an integrator has
 * to today, so that when a golden vector is finally added, the expected bytes are
 * already written down here and cross-checkable against the Solidity side.
 *
 * No network, no chain: this is pure EIP-712 arithmetic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hashDomain, keccak256, toHex, type Hash } from "viem";
import * as core from "@sigilkit/core";

/** `SessionKeyManager.sol:112-113`, verbatim. */
const REQUEST_APPROVAL_TYPE_STRING = "RequestApproval(bytes32 requestDigest)";
const REQUEST_APPROVAL_TYPEHASH = keccak256(toHex(REQUEST_APPROVAL_TYPE_STRING));

/** A minimal but structurally complete request; the digest must not depend on the values. */
const REQUEST = {
  agentId: ("0x" + "11".repeat(32)) as Hash,
  target: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  selector: "0x32145f90" as `0x${string}`,
  value: 5_000_000_000_000_000_000n,
  nonce: 7n,
  expiry: 1_900_000_000,
  rationaleHash: ("0x" + "22".repeat(32)) as Hash,
  data: "0x" as `0x${string}`,
} as const;
const CHAIN_ID = 31337;
const MANAGER = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as `0x${string}`;

describe("E10 approval digest — cross-language single source of truth", () => {
  it("@sigilkit/core exports NO approval-digest builder, so integrators hand-roll it", () => {
    // Pins the gap. Everything else in this file is downstream of this fact.
    //
    // The naming is derived from how core names its sibling: the ActionRequest digest has
    // `ACTION_REQUEST_TYPEHASH` (types.ts:202) and `actionRequestDigest()`
    // (signing.ts). The approval digest has neither counterpart. Asserting on the whole
    // export namespace — rather than on hard-coded names — is what makes this robust: if
    // a helper is added under any of the plausible names, this goes red.
    const exported = Object.keys(core).sort();

    const approvalNamed = exported.filter((k) => /approval/i.test(k));
    expect(
      approvalNamed,
      `core now exports something approval-related (${approvalNamed.join(", ")}) — the E10 gap is closed or renamed; update this test and add the golden vector`,
    ).toEqual([]);
    // Non-vacuity: the filter must be capable of matching something. If the regex or the
    // namespace shape ever changes, this fails instead of the assertion above silently
    // passing for an unrelated reason. `ACTION_REQUEST_TYPEHASH` is the sibling core DOES
    // export, so its presence proves the namespace really was walked.
    expect(exported).toContain("ACTION_REQUEST_TYPEHASH");
    expect(typeof core.actionRequestDigest).toBe("function");
    expect(["approvalDigest", "APPROVAL_TYPEHASH"].filter((k) => /approval/i.test(k))).toHaveLength(2);

    // The SECOND missing piece, found while writing the reconstruction below: there is no
    // `domainSeparator()` helper either. `actionRequestDigest` computes the separator
    // internally, so it never needed to export one — but the approval digest requires the
    // separator *separately*, so a caller has to know to reach for viem's `hashDomain` and
    // core's exported name/version constants. An integrator following the obvious path
    // ("hash the typehash and the request digest, then sign") gets it wrong twice over:
    // no typehash constant, and no domain separator to hand.
    const domainish = exported.filter((k) => /domain/i.test(k));
    expect(
      domainish.filter((k) => typeof (core as Record<string, unknown>)[k] === "function"),
      `core now exports a domain helper (${domainish.join(", ")}) — the E10 gap has narrowed; update this test`,
    ).toEqual([]);
    // The two constants that make manual composition possible — without these, even a
    // determined integrator cannot build the envelope.
    expect(core.SIGILKIT_DOMAIN_NAME).toBe("SigilKit");
    expect(core.SIGILKIT_DOMAIN_VERSION).toBe("1");
  });

  it("the ActionRequest digest IS anchored in vectors/, but the approval digest is not", () => {
    // The structural asymmetry, stated as a test. `actionrequest.json` names both
    // consumers in its `_doc`; there is no approval counterpart, and `merkle-v2.json`
    // covers the Merkle path only.
    expect(
      exportedApprovalSurface(),
      "an approval-digest vector was added — re-point this test at it and assert Solidity parity",
    ).toEqual([]);
  });

  it("reconstructs the approval digest the way an integrator must today", () => {
    // This is the reconstruction, written down so it can be diffed against the Solidity
    // side and, later, against a golden vector.
    //
    // It is built from `actionRequestDigest` — the SDK's own, already conformance-tested
    // function — so the only unverified links are the two the SDK has no helper for at all:
    // the approval struct hash and its EIP-712 envelope.
    //
    // IMPORTANT, and an earlier draft of this test got it wrong: the contract does NOT
    // verify the bare `keccak256(abi.encode(TYPEHASH, requestDigest))`. It wraps that in a
    // SECOND EIP-712 envelope before recovering the signer:
    //
    //   structHash  = keccak256(abi.encode(_REQUEST_APPROVAL_TYPEHASH, requestDigest))   (:872)
    //   digest      = keccak256("\x19\x01" || domainSeparator() || structHash)             (:510-513)
    //
    // Signing the struct hash alone — which is exactly what "just hash it and sign" invites
    // — yields a signature the contract rejects, and the SDK has nothing to catch it. The
    // per-domain nesting is what stops a valid approval on one chain/contract being replayed
    // on another, so it is load-bearing, not decoration.
    const requestDigest = core.actionRequestDigest({
      request: REQUEST as never,
      chainId: CHAIN_ID,
      verifyingContract: MANAGER,
    });

    // abi.encode(bytes32, bytes32) is two zero-padded 32-byte words, left-aligned.
    const approvalStructHash = keccak256(
      (requestDigest.slice(2).padStart(64, "0") + REQUEST_APPROVAL_TYPEHASH.slice(2).padStart(64, "0")) as `0x${string}`,
    ) as Hash;

    // The outer envelope, recomputed from core's own exported domain constants via viem's
    // `hashDomain` — the same composition `domain-constants.test.ts:49-58` uses, so this is
    // not a private path. Note there is NO `domainSeparator()` helper in core either: a
    // caller must know to compose this themselves, which is the second half of the gap.
    const domainSeparator = hashDomain({
      domain: {
        name: core.SIGILKIT_DOMAIN_NAME,
        version: core.SIGILKIT_DOMAIN_VERSION,
        chainId: BigInt(CHAIN_ID),
        verifyingContract: MANAGER,
      },
      // `hashDomain` forwards to `hashStruct`, which does `types["EIP712Domain"].map(...)`.
      // The key must be the DOMAIN type, not the approval type — and omitting it throws
      // `Cannot read properties of undefined (reading 'map')` rather than degrading quietly.
      // This is exactly the sharp edge an integrator hits, which is why core should be
      // exporting a helper instead of leaving callers to discover it.
      // Field order is the canonical EIP-712 encode order and must not be reordered.
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    const approvalDigest = keccak256(
      ("0x1901" + domainSeparator.slice(2) + approvalStructHash.slice(2)) as `0x${string}`,
    ) as Hash;

    // The typehash half comes from the type STRING, copied verbatim from
    // `SessionKeyManager.sol:113`. Pinning the string — not a hash of it — is the part
    // that is actually cross-checkable by a human against the Solidity, which is the whole
    // point: if either side edits its type string, this string stops matching the contract
    // and the vector work becomes urgent. (An earlier draft of this test asserted a
    // hard-coded hash here; that value was invented, and the assertion failed immediately,
    // which is the only reason it is not still here. Asserting a digest against a constant
    // typed next to the code that computes it would also have been circular.)
    expect(REQUEST_APPROVAL_TYPE_STRING).toBe("RequestApproval(bytes32 requestDigest)");
    expect(REQUEST_APPROVAL_TYPEHASH).toBe(keccak256(toHex(REQUEST_APPROVAL_TYPE_STRING)));

    // The envelope is genuinely part of what is signed: the struct hash alone is a
    // DIFFERENT digest, and this is the exact mistake an integrator makes by hand.
    expect(approvalStructHash).not.toBe(approvalDigest);

    // Structural properties, so this is a real reconstruction and not a tautology:
    // the digest is 32 bytes and it genuinely binds the request.
    expect(approvalDigest).toMatch(/^0x[0-9a-f]{64}$/);

    // Binding: a one-bit change anywhere in the request must change the digest. If this
    // ever passes, the reconstruction has stopped binding the request and would sign
    // over anything.
    const other = core.actionRequestDigest({
      request: { ...REQUEST, nonce: 8n } as never,
      chainId: CHAIN_ID,
      verifyingContract: MANAGER,
    });
    expect(other).not.toBe(requestDigest);
    // The enveloped digest must also change. Note both branches are wrapped: asserting
    // only the struct hash would pass even if the envelope were dropped from `approvalDigest`
    // (an earlier draft made exactly that mistake, so it is written out explicitly here).
    const otherStructHash = keccak256(
      (other.slice(2).padStart(64, "0") + REQUEST_APPROVAL_TYPEHASH.slice(2).padStart(64, "0")) as `0x${string}`,
    ) as Hash;
    expect(
      keccak256(("0x1901" + domainSeparator.slice(2) + otherStructHash.slice(2)) as `0x${string}`),
    ).not.toBe(approvalDigest);
  });

  it("core forwards ownerApproval as an opaque bytes — it cannot validate it locally", () => {
    // Why the SDK cannot grow a local check later without a breaking change: the digest
    // the signature must cover is a function of the request AND the verifying contract
    // AND the chain, and the client only holds the signature as `bytes`. So there is no
    // place in the current API where a wrong ownerApproval is caught before it costs a
    // transaction. A test that silently accepted a malformed approval would be
    // structurally impossible to write today.
    expect(core.SESSION_KEY_MANAGER_ABI).toBeDefined();
    const exec = core.SESSION_KEY_MANAGER_ABI.find(
      (f) => f.type === "function" && f.name === "executeWithSessionKey",
    );
    expect(exec, "the entry point that consumes ownerApproval must exist").toBeDefined();
    const ownerApprovalParam = (exec!.inputs ?? []).find((i) => i.name === "ownerApproval");
    expect(ownerApprovalParam?.type, "ownerApproval crosses the boundary as opaque bytes").toBe("bytes");
  });

  it("the anchor views exist in the on-disk ABI; the typehash views are missing from the SDK's runtime ABI", () => {
    // Answers a practical question for #16b/#16c that had not been checked: CAN the
    // approval digest be pinned to an external anchor, or is the contract self-describing
    // in a way that makes any vector circular?
    //
    // It CAN be anchored — the Solidity source exposes all three inputs as views
    // (`SessionKeyManager.sol:595-597, 601-603, 607-609`), and the on-disk ABI carries all
    // three as zero-arg `bytes32` getters. So a Solidity-side vector assertion can read the
    // typehash and separator from the contract instead of re-deriving them.
    //
    // BUT the SDK cannot reach them: `SESSION_KEY_MANAGER_ABI` (client.ts:66) is a
    // hand-trimmed 5-function subset, and none of these three views is in it. That is not
    // itself a bug — the SDK has no reason to call them — but it is the precise reason
    // #16b needs SDK work rather than only a new JSON file: with the current ABI there is
    // no way for a vector *consumer* on the TS side to read the anchor, so the only
    // available comparison remains SDK-literal vs SDK-literal.
    //
    // This test reads the on-disk ABI (the contract's own artefact) for the "exists" half
    // and the runtime ABI for the "unreachable" half, because those are two different
    // claims about two different files.
    const onDisk = readFileSync(
      new URL("../../core/abis/SessionKeyManager.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(onDisk) as Array<{ type?: string; name?: string }>;
    for (const anchor of ["DOMAIN_SEPARATOR", "ACTION_REQUEST_TYPEHASH", "REQUEST_APPROVAL_TYPEHASH"]) {
      expect(
        parsed.map((f) => f.name),
        `the on-disk ABI must expose ${anchor}() for a non-circular vector anchor`,
      ).toContain(anchor);
    }

    // The SDK's runtime ABI is a trimmed subset. What matters for #16b is not the exact
    // membership but WHICH anchors remain unreachable from TypeScript: a vector consumer
    // can only anchor to the chain for inputs it is able to read.
    //
    // `DOMAIN_SEPARATOR` was added to `SESSION_KEY_MANAGER_ABI` (client.ts:132-138) while
    // this test was being written, which is progress toward the gap being closed — so this
    // assertion deliberately does NOT pin the set. It pins the two typehash views, which
    // are the ones an E10 vector actually needs and which remain absent. If they are added
    // too, this goes red and #16b can anchor end-to-end.
    const runtimeNames = core.SESSION_KEY_MANAGER_ABI.filter((f) => f.type === "function").map((f) => f.name);
    for (const anchor of ["ACTION_REQUEST_TYPEHASH", "REQUEST_APPROVAL_TYPEHASH"]) {
      expect(
        runtimeNames,
        `core's runtime ABI now exposes ${anchor}() — the E10 gap has narrowed; update this test and anchor vectors to the chain`,
      ).not.toContain(anchor);
    }

    // And the SDK's own literals, which are what a vector would be comparing today.
    // `ACTION_REQUEST_TYPEHASH` is a hand-written string in `types.ts:202-206`, and the
    // domain name/version likewise — so SDK-vs-SDK agreement is maintained by hand.
    expect(core.ACTION_REQUEST_TYPEHASH).toBe(
      keccak256(
        toHex(
          "ActionRequest(bytes32 agentId,address target,bytes4 selector,uint256 value,uint256 nonce,uint48 expiry,bytes32 rationaleHash,bytes data)",
        ),
      ),
    );
    expect(core.SIGILKIT_DOMAIN_NAME).toBe("SigilKit");
    expect(core.SIGILKIT_DOMAIN_VERSION).toBe("1");
  });
});

/**
 * The approval-digest surface of `@sigilkit/core`, read from the live module namespace.
 * Empty today; the point of the helper is that a future addition shows up here.
 */
function exportedApprovalSurface(): string[] {
  return Object.keys(core)
    .filter((k) => /approval/i.test(k))
    .sort();
}
