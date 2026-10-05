/**
 * Tests for the golden-vector guard (T-05).
 *
 * Method: every negative test is a *mutation fixture* — a deep copy of the real corpus
 * with one field broken the way a destructive SDK change, a hand-edited count or a
 * mislabelled provenance block would break it. A guard is only worth its line count if
 * each rule is shown to actually fire, so each mutation asserts on the specific problem
 * it should raise rather than merely asserting "not ok".
 *
 * No test writes to `vectors/` and no test runs the generator: the corpus is read
 * read-only and mutated in memory.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  HEX32,
  MERKLE_FILE,
  PROVENANCE_REGISTRY,
  VECTOR_FILES,
  checkActionRequestCorpus,
  checkEip7702Corpus,
  checkGeneratorProvenance,
  checkMerkleV2Corpus,
  checkVectorCorpus,
  describeProvenance,
  isBytes32Hex,
  loadVectorCorpus,
  provenanceProblems,
  stripJsComments,
} from "./check-vectors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS_DIR = join(ROOT, "vectors");
const GENERATOR_PATH = join(ROOT, "scripts", "generate-vectors.mjs");

/** The real committed corpus, read once. Never mutated — every test copies it. */
const REAL = loadVectorCorpus(VECTORS_DIR);

/** Deep copy so a mutation cannot leak into the next test. */
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A fully-conformant corpus: the real files plus the `_provenance` block each must
 * carry. Built from the registry so the fixture cannot drift into agreeing with a wrong
 * claim. Mutations then start from this, which is what makes "one break, one problem"
 * true.
 */
function conformantCorpus() {
  const loaded = clone(REAL);
  for (const file of VECTOR_FILES) loaded[file]._provenance = { ...PROVENANCE_REGISTRY[file] };
  return loaded;
}

/** `checkVectorCorpus` with the generator cross-check off: this file tests corpus rules. */
function check(loaded, options = {}) {
  return checkVectorCorpus(loaded, { generatorSource: null, ...options });
}

/** Asserts a mutation is caught, and that the message names the right thing. */
function assertDetected(result, matcher, what) {
  assert.equal(result.ok, false, `${what}: expected the guard to fail`);
  assert.ok(
    result.problems.some((p) => matcher.test(p)),
    `${what}: no problem matched ${matcher}\n  got: ${JSON.stringify(result.problems, null, 2)}`,
  );
}

/** Wraps raw problem strings as a result so `assertDetected` can be reused. */
const asResult = (problems) => ({ ok: problems.length === 0, problems });

// ---------------------------------------------------------------------------
// the real corpus
// ---------------------------------------------------------------------------

test("the committed corpus satisfies every corpus rule with no waiver (counts, 32-byte hex, _doc, tree shape, _provenance)", () => {
  // The `expectProvenance: false` waiver is gone: the attestation is committed, so the
  // whole gate runs against the real files exactly as the CLI runs it.
  const { ok, problems } = check(REAL);
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test("the committed corpus satisfies every provenance rule once the attestation is present", () => {
  const { ok, problems } = check(conformantCorpus());
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test("the real corpus is fully attested: every file carries the _provenance the registry describes", () => {
  // The migration is done, so this no longer asserts a pending gap. It pins the *positive*
  // claim instead: all three files attest, and every attestation matches the registry. The
  // falsifying mutations live in the tests below (a flipped `externallyAnchored`, a
  // rewritten `generator`), which is what keeps this from being a constant-true restatement
  // of the registry — if a real file's block were edited, this fails.
  const rows = describeProvenance(REAL);
  for (const row of rows) {
    assert.ok(row.attested, `${row.file}: real corpus must carry a _provenance block`);
    assert.ok(
      row.matchesRegistry,
      `${row.file}: _provenance says generator=${JSON.stringify(row.generator)} ` +
        `externallyAnchored=${JSON.stringify(row.externallyAnchored)}, which does not match the registry ` +
        `(${JSON.stringify(PROVENANCE_REGISTRY[row.file])})`,
    );
  }
  assert.deepEqual(provenanceProblemsFor(REAL), [], "the real corpus must raise no provenance problem");
});

/** Every provenance problem across the real corpus, one flat list. */
function provenanceProblemsFor(loaded) {
  return VECTOR_FILES.flatMap((file) => provenanceProblems(file, loaded[file]));
}

/**
 * The non-tautology guard, in test form: proving that the two assertions above can go red.
 *
 * A positive claim ("the corpus is attested") cannot demonstrate itself — a test that only
 * ever sees the good corpus would stay green even if the checker were replaced by
 * `() => []`. So the same assertions are re-run against *deliberately corrupted* claims, and
 * each corruption is required to turn the corresponding assertion red. If someone ever
 * weakens `describeProvenance`/`provenanceProblems` so a mislabelled corpus passes, the
 * second half of each pair fails here.
 */
test("a corrupted attestation turns the real-corpus assertion red (the assertion is not constant-true)", () => {
  const original = (file) => REAL[file]._provenance;

  // (a) A self-certified corpus claiming an external anchor.
  const forged = conformantCorpus();
  forged["actionrequest.json"]._provenance.externallyAnchored = true;
  const forgedRows = describeProvenance(forged);
  const forgedAction = forgedRows.find((r) => r.file === "actionrequest.json");
  assert.ok(forgedAction.attested, "the forgery is still an attestation, so `attested` alone cannot catch it");
  assert.equal(
    forgedAction.matchesRegistry,
    false,
    "matchesRegistry must go red for a corpus relabelled as externally anchored",
  );
  assertDetected(
    asResult(provenanceProblemsFor(forged)),
    /actionrequest\.json: _provenance\.externallyAnchored is true .*claim false/,
    "forged external-anchor claim on a self-certified corpus",
  );

  // (b) A wrong generator string.
  const rewritten = conformantCorpus();
  rewritten[MERKLE_FILE]._provenance.generator = "@sigilkit/core:merkleRoot";
  const rewrittenRow = describeProvenance(rewritten).find((r) => r.file === MERKLE_FILE);
  assert.equal(
    rewrittenRow.matchesRegistry,
    false,
    "matchesRegistry must go red when a corpus names a more specific entry point than the gate can verify",
  );
  assertDetected(
    asResult(provenanceProblemsFor(rewritten)),
    /_provenance\.generator says "@sigilkit\/core:merkleRoot", the actual generation source is "@sigilkit\/core"/,
    "generator rewritten to a qualified name the registry does not accept",
  );

  // (c) The externally anchored corpus relabelled as self-certified.
  const downgraded = conformantCorpus();
  downgraded["eip7702.json"]._provenance.externallyAnchored = false;
  assertDetected(
    asResult(provenanceProblemsFor(downgraded)),
    /eip7702\.json: _provenance\.externallyAnchored is false but this corpus is generated by viem:hashAuthorization/,
    "the one externally anchored corpus downgraded to self-certified",
  );

  // Sanity: the unmutated block is what makes the forged ones meaningful.
  assert.equal(original("actionrequest.json").externallyAnchored, false);
  assert.equal(original(MERKLE_FILE).generator, "@sigilkit/core");
});

// ---------------------------------------------------------------------------
// count assertions (the four hand-written counts, which previously had none)
// ---------------------------------------------------------------------------

test("a stale actionrequest casesCount is detected", () => {
  const loaded = conformantCorpus();
  loaded["actionrequest.json"].casesCount = 99;
  assertDetected(check(loaded), /actionrequest\.json: casesCount says 99 but the array holds 4/, "casesCount mutated to 99");
});

test("a stale eip7702 casesCount is detected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"].casesCount = 1;
  assertDetected(check(loaded), /eip7702\.json: casesCount says 1 but the array holds 6/, "eip7702 casesCount undercounted");
});

test("a stale leafCasesCount is detected", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE].leafCasesCount = 99;
  assertDetected(check(loaded), /merkle-v2\.json: leafCasesCount says 99 but the array holds 3/, "leafCasesCount mutated to 99");
});

test("a stale proofsCount is detected", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE].trees[0].proofsCount = 99;
  assertDetected(check(loaded), /trees\[0\]\.proofsCount says 99 but the array holds 3/, "proofsCount mutated to 99");
});

test("a stale leavesCount is detected", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE].trees[0].leavesCount = 99;
  assertDetected(check(loaded), /trees\[0\]\.leavesCount says 99 but the array holds 3/, "leavesCount mutated to 99");
});

test("a case and its count lowered in step — the silently-shrunk corpus — is still detected", () => {
  // The dangerous direction: remove a case *and* lower the count, so the two agree while
  // the corpus shrank. Caught by the cross-check with the tree, not by any count.
  const loaded = conformantCorpus();
  loaded["actionrequest.json"].cases.pop();
  loaded["actionrequest.json"].casesCount = loaded["actionrequest.json"].cases.length;
  assert.equal(check(loaded).ok, true, "a self-consistent count cannot detect a dropped case");

  const merkle = conformantCorpus();
  merkle[MERKLE_FILE].trees[0].proofs.pop();
  merkle[MERKLE_FILE].trees[0].proofsCount = merkle[MERKLE_FILE].trees[0].proofs.length;
  assertDetected(check(merkle), /has no proof for leaf/, "a proof deleted along with its count");
});

test("a missing count is reported, not treated as zero", () => {
  const loaded = conformantCorpus();
  delete loaded["actionrequest.json"].casesCount;
  assertDetected(check(loaded), /casesCount is missing/, "casesCount deleted");
});

test("a count of zero (deleted corpus) is rejected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"].cases = [];
  loaded["eip7702.json"].casesCount = 0;
  assertDetected(check(loaded), /casesCount is 0 — a corpus with no cases/, "emptied eip7702 corpus");
});

// ---------------------------------------------------------------------------
// digest / leaf / root shape
// ---------------------------------------------------------------------------

test("an actionrequest digest that is not 32 bytes is detected", () => {
  const loaded = conformantCorpus();
  loaded["actionrequest.json"].cases[0].digest = "0xdeadbeef";
  assertDetected(check(loaded), /cases\[0\] digest is not 32-byte hex: "0xdeadbeef"/, "truncated digest");
});

test("an eip7702 digest one nibble short is detected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"].cases[3].digest = "0x" + "a".repeat(62);
  assertDetected(check(loaded), /cases\[3\] digest is not 32-byte hex/, "short digest");
});

test("a non-hex digest is detected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"].cases[1].digest = "0x" + "z".repeat(64);
  assertDetected(check(loaded), /digest is not 32-byte hex/, "non-hex digest");
});

test("every merkle 32-byte field is length-checked", () => {
  const mutations = [
    [(c) => { c[MERKLE_FILE].leafCases[0].leaf = "0x01"; }, /leafCases\[0\] leaf is not 32-byte hex/],
    [(c) => { c[MERKLE_FILE].leafCases[1].argsHash = "0x"; }, /leafCases\[1\] argsHash is not 32-byte hex/],
    [(c) => { c[MERKLE_FILE].trees[0].root = "0x" + "b".repeat(10); }, /trees\[0\] root is not 32-byte hex/],
    [(c) => { c[MERKLE_FILE].trees[0].leaves[2] = "0xnothex"; }, /leaves\[2\] leaf is not 32-byte hex/],
    [(c) => { c[MERKLE_FILE].trees[0].proofs[0].proof[0] = "0x1234"; }, /proof\[0\] proof node is not 32-byte hex/],
  ];
  for (const [mutate, matcher] of mutations) {
    const loaded = conformantCorpus();
    mutate(loaded);
    assertDetected(check(loaded), matcher, `mutation ${matcher}`);
  }
});

test("a digest missing entirely is detected", () => {
  const loaded = conformantCorpus();
  delete loaded["actionrequest.json"].cases[2].digest;
  assertDetected(check(loaded), /cases\[2\] digest is not 32-byte hex: undefined/, "deleted digest");
});

test("a malformed proof entry is detected", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE].trees[0].proofs[0].proof = "0xdead";
  assertDetected(check(loaded), /proofs\[0\]\.proof must be an array/, "string proof");
});

test("isBytes32Hex accepts exactly 32-byte hex and nothing else", () => {
  assert.equal(isBytes32Hex("0x" + "A".repeat(64)), true);
  assert.equal(isBytes32Hex("0x" + "0".repeat(63)), false);
  assert.equal(isBytes32Hex("0x" + "0".repeat(65)), false);
  assert.equal(isBytes32Hex("0" + "0".repeat(64)), false);
  assert.equal(isBytes32Hex(123), false);
  assert.equal(isBytes32Hex(null), false);
  assert.equal(HEX32.test("0x" + "f".repeat(64)), true);
});

// ---------------------------------------------------------------------------
// documentation field
// ---------------------------------------------------------------------------

test("a deleted _doc is detected in every corpus", () => {
  for (const file of VECTOR_FILES) {
    const loaded = conformantCorpus();
    delete loaded[file]._doc;
    assertDetected(check(loaded), new RegExp(`${file.replace(".", "\\.")}: _doc is missing`), `_doc deleted from ${file}`);
  }
});

test("an empty _doc is treated as missing", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"]._doc = "   ";
  assertDetected(check(loaded), /_doc is missing or empty/, "blank _doc");
});

// ---------------------------------------------------------------------------
// provenance: making "self-certified" an explicit, checkable fact
// ---------------------------------------------------------------------------

test("a missing _provenance block names what the corpus actually is", () => {
  const loaded = conformantCorpus();
  delete loaded["actionrequest.json"]._provenance;
  assertDetected(check(loaded), /actionrequest\.json: _provenance is missing .*SELF-CERTIFIED/, "_provenance deleted");
});

test("claiming the externally anchored corpus is self-certified is detected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"]._provenance.externallyAnchored = false;
  assertDetected(
    check(loaded),
    /eip7702\.json: _provenance\.externallyAnchored is false but this corpus is generated by viem:hashAuthorization itself/,
    "eip7702 relabelled as self-certified",
  );
});

test("claiming a self-certified corpus is externally anchored is detected", () => {
  const loaded = conformantCorpus();
  loaded["actionrequest.json"]._provenance.externallyAnchored = true;
  assertDetected(
    check(loaded),
    /actionrequest\.json: _provenance\.externallyAnchored is true but this corpus is generated by @sigilkit\/core itself — claim false/,
    "actionrequest relabelled as externally anchored",
  );

  const merkle = conformantCorpus();
  merkle[MERKLE_FILE]._provenance.externallyAnchored = true;
  assertDetected(check(merkle), /merkle-v2\.json: _provenance\.externallyAnchored is true/, "merkle relabelled");
});

test("a wrong generator is detected", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE]._provenance.generator = "foundry";
  assertDetected(
    check(loaded),
    /_provenance\.generator says "foundry", the actual generation source is "@sigilkit\/core"/,
    "wrong generator",
  );
});

test("a non-boolean externallyAnchored is detected", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"]._provenance.externallyAnchored = "yes";
  assertDetected(check(loaded), /externallyAnchored must be a boolean, got "yes"/, "stringly-typed boolean");
});

test("a malformed _provenance is detected", () => {
  const loaded = conformantCorpus();
  loaded["actionrequest.json"]._provenance = ["@sigilkit/core", true];
  assertDetected(check(loaded), /_provenance must be an object/, "array provenance");
});

test("provenanceProblems is a pure per-file check usable without the whole corpus", () => {
  assert.deepEqual(
    provenanceProblems("eip7702.json", { _provenance: { generator: "viem:hashAuthorization", externallyAnchored: true } }),
    [],
  );
  assert.equal(provenanceProblems(MERKLE_FILE, {}).length, 1, "an absent block is one problem for one file");
  assert.deepEqual(provenanceProblems("eip7702.json", {}, { expectProvenance: false }), []);
});

test("describeProvenance names the self-certified corpora explicitly, on the real corpus and not only on a fixture", () => {
  const rows = describeProvenance(REAL);
  assert.equal(rows.length, VECTOR_FILES.length);
  assert.deepEqual(
    rows.filter((r) => r.externallyAnchored === false).map((r) => r.file).sort(),
    ["actionrequest.json", "merkle-v2.json"],
  );
  assert.deepEqual(
    rows.filter((r) => r.externallyAnchored === true).map((r) => r.file),
    ["eip7702.json"],
  );
  // Reversed: the committed corpus is attested, so every row must be attested AND agree
  // with the registry. Reading REAL rather than a fixture is what makes this a statement
  // about the repository instead of about the checker.
  assert.ok(rows.every((r) => r.attested && r.matchesRegistry));
  // And the rows must carry the registry's generator strings, not merely be non-null: a
  // `?? null` default would make a missing block silently read as unattested-but-consistent.
  assert.deepEqual(
    rows.map((r) => r.generator),
    VECTOR_FILES.map((f) => PROVENANCE_REGISTRY[f].generator),
  );
});

test("describeProvenance reports a mismatched attestation as WRONG rather than ok", () => {
  // The CLI marks a row with `attested && !matchesRegistry` as "WRONG"; this pins that the
  // two flags are genuinely independent, so a forgery cannot pass as ok by satisfying one.
  const forged = conformantCorpus();
  forged["eip7702.json"]._provenance.externallyAnchored = false;
  const row = describeProvenance(forged).find((r) => r.file === "eip7702.json");
  assert.equal(row.attested, true, "the block is present");
  assert.equal(row.matchesRegistry, false, "so the row is WRONG, not ok");
  assert.equal(row.attested && row.matchesRegistry, false);

  // Absent block: the other failure direction.
  const absent = conformantCorpus();
  delete absent[MERKLE_FILE]._provenance;
  const missing = describeProvenance(absent).find((r) => r.file === MERKLE_FILE);
  assert.equal(missing.attested, false);
  assert.equal(missing.generator, null);
  assert.equal(missing.externallyAnchored, null);
});

test("the registry itself encodes the asymmetry this guard exists for", () => {
  assert.deepEqual(
    Object.entries(PROVENANCE_REGISTRY)
      .filter(([, p]) => !p.externallyAnchored)
      .map(([f]) => f)
      .sort(),
    ["actionrequest.json", "merkle-v2.json"],
    "only the viem-anchored corpus may claim external anchoring",
  );
});

// ---------------------------------------------------------------------------
// generator wiring
// ---------------------------------------------------------------------------

test("the committed generator still produces the two provenance shapes the registry claims", () => {
  // The wiring (viem anchor + the four @sigilkit/core symbols) must hold with no waiver:
  // if those moved, the registry would describe a generator that no longer runs.
  assert.deepEqual(checkGeneratorProvenance(readFileSync(GENERATOR_PATH, "utf8"), { expectProvenance: false }), []);
});

test("a generator that stops anchoring eip7702 to viem is flagged", () => {
  // Remove the real call site. The header comment and the eip7702 `_doc` string both
  // still name viem's hashAuthorization, so this is the false negative a plain text
  // search would have.
  const source = readFileSync(GENERATOR_PATH, "utf8").replace(/digest: hashAuthorization\(\{/, "digest: ownDigest({");
  assertDetected(
    asResult(checkGeneratorProvenance(source, { expectProvenance: false })),
    /eip7702 digests are no longer produced by viem's hashAuthorization/,
    "viem anchor removed",
  );
});

test("a doc comment or _doc string naming viem does not keep the anchor alive", () => {
  // Both prose mentions survive here: the header comment and the eip7702 `_doc`. Only the
  // code no longer produces the digests with viem, and that is what must be reported.
  const source = readFileSync(GENERATOR_PATH, "utf8");
  assert.ok(source.includes("viem's hashAuthorization"), "fixture must retain the prose mention");
  assertDetected(
    asResult(checkGeneratorProvenance(source.replace(/digest: hashAuthorization\(\{/, "digest: ownDigest({"))),
    /eip7702 digests are no longer produced by viem's hashAuthorization/,
    "call site moved to a local encoder, prose left behind",
  );
});

test("a retained viem import with a deleted call site is flagged (dead code is not an anchor)", () => {
  const source = readFileSync(GENERATOR_PATH, "utf8").replace(/digest: hashAuthorization\(\{/, "digest: ownDigest({");
  // The `const { hashAuthorization } = await import(...)` line is still present; only the
  // call moved. Half an anchor must not read as a whole one.
  assert.ok(
    /hashAuthorization\b[^}]*\}\s*=\s*await\s+import\(/.test(source),
    "fixture must retain the viem import",
  );
  assertDetected(
    asResult(checkGeneratorProvenance(source, { expectProvenance: false })),
    /eip7702 digests are no longer produced by viem's hashAuthorization/,
    "import kept, call deleted",
  );
});

test("a generator that stops importing the SDK symbols is flagged", () => {
  // Remove one symbol from the destructure *and* its only use, so the guard cannot pass
  // on a later mention of the name.
  const source = readFileSync(GENERATOR_PATH, "utf8")
    .replace("targetLeaf, merkleRoot, merkleProof, actionRequestDigest", "merkleRoot, merkleProof, actionRequestDigest")
    .replaceAll("targetLeaf(", "legacyTargetLeaf(");
  assertDetected(
    asResult(checkGeneratorProvenance(source, { expectProvenance: false })),
    /targetLeaf is no longer imported from @sigilkit\/core/,
    "targetLeaf import removed",
  );
});

test("each missing SDK symbol is reported by name, not just the first", () => {
  const source = readFileSync(GENERATOR_PATH, "utf8")
    .replace("targetLeaf, merkleRoot, merkleProof, actionRequestDigest", "")
    .replaceAll("targetLeaf(", "legacyTargetLeaf(")
    .replaceAll("merkleRoot(", "legacyMerkleRoot(")
    .replaceAll("merkleProof(", "legacyMerkleProof(")
    .replaceAll("actionRequestDigest(", "legacyActionRequestDigest(");
  const problems = checkGeneratorProvenance(source, { expectProvenance: false });
  for (const symbol of ["actionRequestDigest", "targetLeaf", "merkleRoot", "merkleProof"]) {
    assert.ok(
      problems.some((p) => p.includes(`${symbol} is no longer imported from @sigilkit/core`)),
      `${symbol} was not reported`,
    );
  }
});

test("a generator that cannot be parsed is reported loudly, not passed over", () => {
  assert.deepEqual(checkGeneratorProvenance(""), [
    "generate-vectors.mjs: could not read the generator source (cannot verify which corpora are self-certified)",
  ]);
  assertDetected(
    asResult(checkGeneratorProvenance("// the import was refactored away\n")),
    /could not find the @sigilkit\/core dist import/,
    "unrecognised generator shape",
  );
});

test("the committed generator really does write a _provenance block into every vector file", () => {
  // Reversed from the migration's pending half. The presence test is a mere substring
  // search, so the load-bearing assertions are the ones below: `checkGeneratorProvenance`
  // with `expectProvenance: true` performs the registry<->generator literal cross-check, and
  // that is what would fire if the blocks were renamed, emptied, or mislabelled. A generator
  // that merely *mentions* `_provenance` in a comment fails here.
  const source = readFileSync(GENERATOR_PATH, "utf8");
  assert.deepEqual(checkGeneratorProvenance(source, { expectProvenance: true }), []);
  // One attestation per corpus, and each is a real object with both fields spelled out.
  for (const [file, claim] of Object.entries(PROVENANCE_REGISTRY)) {
    assert.ok(
      new RegExp(`[{,]\\s*_provenance\\s*:`).test(source),
      "each corpus literal must open a _provenance block",
    );
    assert.ok(source.includes(`"${claim.generator}"`), `${file}: the generator must write ${claim.generator}`);
  }
  // The real generator passes both modes: the waiver is a test affordance, not a real
  // generator property. If it ever needed the waiver, that would be drift.
  assert.deepEqual(checkGeneratorProvenance(source, { expectProvenance: false }), []);
});

/**
 * A synthetic generator that reproduces the real one's wiring (viem anchor + the four SDK
 * symbols) but writes no `_provenance` block.
 *
 * Kept as a hand-built fixture rather than a mutation of the committed generator on purpose:
 * the "a generator that forgets to attest is caught" rule is a standing guard and must keep
 * holding after the real generator gained its blocks. Deriving the fixture from the real file
 * would re-tie that guard to the very thing it is meant to be independent of.
 */
const NO_PROVENANCE_GENERATOR = `
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ROOT = join(".");
const { hashAuthorization } = await import("viem/authorization");
const { targetLeaf, merkleRoot, merkleProof, actionRequestDigest } = require(
  join(ROOT, "packages/core/dist/index.js"),
);
export const digests = {
  eip: { digest: hashAuthorization({ chainId: 1, address: "0x0" }) },
  action: { digest: actionRequestDigest({ request: {}, chainId: 1 }) },
  merkle: { leaf: targetLeaf({}), root: merkleRoot([merkleProof({})]) },
};
`;

test("a generator that writes no _provenance block is flagged (synthetic fixture, wiring otherwise clean)", () => {
  const problems = checkGeneratorProvenance(NO_PROVENANCE_GENERATOR, { expectProvenance: true });
  assertDetected(
    asResult(problems),
    /no `_provenance` block is written into the vector files/,
    "generator with clean wiring but no attestation",
  );
  // Exactly one problem, and it must be the attestation one: the fixture is otherwise a
  // correctly wired generator, so any other problem means the fixture is not isolating the
  // rule it is meant to isolate.
  assert.equal(
    problems.length,
    1,
    `expected only the missing-attestation problem, got: ${JSON.stringify(problems, null, 2)}`,
  );
  // Same source is clean once the field is not required — proving the flag comes from the
  // `_provenance` check and not from the viem/SDK wiring checks.
  assert.deepEqual(checkGeneratorProvenance(NO_PROVENANCE_GENERATOR, { expectProvenance: false }), []);
});

test("a generator whose _provenance generator string disagrees with the registry is flagged", () => {
  // The registry-vs-generator cross-check: the corpus is emitted with a more specific entry
  // point (`@sigilkit/core:merkleRoot`) than the gate verifies, so the two would disagree
  // about what produced the digests. Pinned here so the cross-check cannot be deleted as
  // redundant with the viem/SDK wiring checks.
  const real = readFileSync(GENERATOR_PATH, "utf8");
  const qualified = real.replace('generator: "@sigilkit/core"', 'generator: "@sigilkit/core:merkleRoot"');
  assert.notEqual(qualified, real, "fixture must actually change the literal");
  assertDetected(
    asResult(checkGeneratorProvenance(qualified)),
    /actionrequest\.json writes _provenance\.generator "@sigilkit\/core:merkleRoot", the registry says "@sigilkit\/core"/,
    "generator qualified to an entry point the registry does not name",
  );
});

test("a generator that relabels a self-certified corpus as externally anchored is flagged", () => {
  // The mirror of the corpus-side check: the same lie, told by the generator rather than
  // hand-edited into the file. This is how the mislabel would actually enter the corpus.
  const real = readFileSync(GENERATOR_PATH, "utf8");
  const flipped = real.replace("externallyAnchored: false", "externallyAnchored: true");
  assert.notEqual(flipped, real, "fixture must actually change the literal");
  assertDetected(
    asResult(checkGeneratorProvenance(flipped)),
    /actionrequest\.json writes _provenance\.externallyAnchored true, the registry says false/,
    "generator relabels a self-certified corpus",
  );
});

test("a generator that stops writing an attestation for one corpus is flagged", () => {
  // A corpus silently losing its `_provenance` block is the failure the field exists to
  // make visible, so the block count is checked against the registry's corpus count.
  const real = readFileSync(GENERATOR_PATH, "utf8");
  const fourth = real + '\nconst extra = { _provenance: { generator: "@sigilkit/core", externallyAnchored: false } };\n';
  assertDetected(
    asResult(checkGeneratorProvenance(fourth)),
    /writes 4 `_provenance` block\(s\) but the registry describes 3 corpora/,
    "an attestation for a corpus the registry does not describe",
  );
});

test("a mention-only generator is flagged even when the name survives comment-stripping", () => {
  // `stripJsComments` keeps a literal that looks like a bare module name, so the string
  // `"_provenance"` inside a `console.log` survives into the "code" text. A substring
  // presence test would be satisfied by that while the generator writes no block at all —
  // which is exactly the shape of a generator that documents the field and forgets it. The
  // presence test is therefore anchored on the object key, not on the name.
  const mentionsOnly = NO_PROVENANCE_GENERATOR.replace(
    "export const digests =",
    'console.log("_provenance");\nexport const digests =',
  );
  assert.ok(mentionsOnly.includes("_provenance"), "fixture must still mention _provenance");
  assertDetected(
    asResult(checkGeneratorProvenance(mentionsOnly, { expectProvenance: true })),
    /no `_provenance` block is written into the vector files/,
    "generator that only names the field in a string",
  );
});

test("the block count and the presence check do not interfere (no shared regex lastIndex)", () => {
  // Regression guard: a global regex used by both a `.test()` and a `matchAll()` would carry
  // `lastIndex` between the two, so the block scan would start mid-string and silently read
  // zero blocks. Calling the check twice in a row must be stable, and the order the two
  // checks run in must not be observable.
  const real = readFileSync(GENERATOR_PATH, "utf8");
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(
      checkGeneratorProvenance(real, { expectProvenance: true }),
      [],
      `call ${i} must be stable — a shared lastIndex would make a later call see fewer blocks`,
    );
  }
  // And a generator that genuinely writes 3 blocks reports 3, not 0 or 6.
  const threeBlocks = [1, 2, 3].map(
    () => 'const c = { _provenance: { generator: "@sigilkit/core", externallyAnchored: false } };',
  ).join("\n");
  assertDetected(
    asResult(checkGeneratorProvenance(real.replace("const actionrequest = {", `${threeBlocks}\nconst actionrequest = {`))),
    /writes 6 `_provenance` block\(s\) but the registry describes 3 corpora/,
    "six blocks counted, not zero — the scan really did walk the whole file",
  );
});

test("the registry's generator strings are the ones the committed generator writes", () => {
  // Item 4 of the migration: the registry is the gate's source of truth, so the vector
  // files and the generator must both use its spelling. `@sigilkit/core` is asserted
  // deliberately and NOT the qualified `@sigilkit/core:actionRequestDigest` the brief
  // suggested: the gate compares with `!==`, so a qualified name in the corpus would be
  // reported as a mismatch. If a qualified name is ever wanted, the registry changes first
  // and this test follows it.
  const real = readFileSync(GENERATOR_PATH, "utf8");
  for (const [file, claim] of Object.entries(PROVENANCE_REGISTRY)) {
    assert.equal(REAL[file]._provenance.generator, claim.generator, `${file}: corpus vs registry`);
    assert.ok(
      real.includes(`generator: "${claim.generator}"`),
      `${file}: the generator must write the registry's spelling ${claim.generator}`,
    );
  }
  assert.equal(PROVENANCE_REGISTRY["actionrequest.json"].generator, "@sigilkit/core");
  assert.equal(PROVENANCE_REGISTRY[MERKLE_FILE].generator, "@sigilkit/core");
  assert.equal(PROVENANCE_REGISTRY["eip7702.json"].generator, "viem:hashAuthorization");
  // The anchor detection must survive the registry's spelling: the viem import is a module
  // specifier so it survives comment-stripping, and the four SDK symbols are destructured
  // from the dist path, which is what `checkGeneratorProvenance` looks for.
  assert.deepEqual(checkGeneratorProvenance(real, { expectProvenance: true }), []);
});

// ---------------------------------------------------------------------------
// corpus-level plumbing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the stripper every code-anchor check rests on (item 6)
// ---------------------------------------------------------------------------

/**
 * `stripJsComments` is the substrate under `checkGeneratorProvenance`: if it keeps prose
 * or drops a specifier, the viem / SDK-symbol anchors are satisfied (or missed) for the
 * wrong reason. A stripper bug is a silent hole in *every* check built on it, so its two
 * obligations are pinned directly — and each is shown to be able to fail, so a future
 * "simplification" that widens the specifier heuristic cannot quietly reopen the hole.
 */
test("stripJsComments blanks prose but keeps every module specifier the anchor checks need", () => {
  const src = readFileSync(GENERATOR_PATH, "utf8");
  const code = stripJsComments(src);

  // Offsets are preserved so a regex over the stripped text still anchors to the real
  // source, and a problem message quoting the source stays honest.
  assert.equal(code.length, src.length, "the stripper must preserve character offsets");
  assert.equal(code.split("\n").length, src.split("\n").length, "line count is preserved too");

  // (a) Prose is blanked: comments, and — the load-bearing case — every `_doc` string.
  // Each `_doc` *cites* a package path, so a naive "contains a `/`" test would keep it.
  assert.ok(!code.includes("canonical external reference"), "header comment must be blanked");
  assert.ok(!code.includes("ships hashAuthorization internally"), "inline comment must be blanked");
  assert.ok(!code.includes("on-chain equality"), "actionrequest _doc prose must be blanked");
  assert.ok(!code.includes("canonical signer implementation"), "eip7702 _doc prose must be blanked");

  // (b) The module specifiers the anchor regexes match on survive intact.
  assert.ok(
    code.includes("node_modules/viem/_esm/utils/authorization/hashAuthorization.js"),
    "the viem import specifier must survive",
  );
  assert.ok(code.includes("packages/core/dist/index.js"), "the SDK dist specifier must survive");

  // (c) The two halves of the viem anchor and the SDK-symbol anchor are all still visible
  // in the stripped code — the exact properties `checkGeneratorProvenance` relies on.
  assert.match(code, /\{[^}]*\bhashAuthorization\b[^}]*\}\s*=\s*await\s+import\(/, "viem binding survives");
  assert.match(code, /(?<!['"\w.])hashAuthorization\s*\(/, "viem call site survives");
  assert.match(
    code,
    /\{([^{}]*)\}\s*=\s*require\([\s\S]{0,200}?packages\/core\/dist/,
    "SDK dist import survives",
  );
  // And the four SDK symbols are still readable from that one destructuring group.
  const groups = [...code.matchAll(/\{([^{}]*)\}\s*=\s*require\([\s\S]{0,200}?packages\/core\/dist/g)];
  const imported = new Set(groups.flatMap((m) => m[1].split(",").map((s) => s.trim())));
  for (const symbol of ["actionRequestDigest", "targetLeaf", "merkleRoot", "merkleProof"]) {
    assert.ok(imported.has(symbol), `${symbol} must be readable from the stripped source`);
  }
});

test("a _doc string citing a path cannot be mistaken for an anchor (the false negative this closes)", () => {
  // Regression guard for a real hole, found by inspection: `looksLikeModuleSpecifier` kept
  // any literal containing a `/`, so every `_doc` (which cites `packages/core/...`) was
  // treated as a specifier and survived. Because the eip7702 `_doc` spells out
  // `hashAuthorization({ … })`, a generator that imported viem but *never called it*
  // satisfied the `actuallyCalled` anchor with a string and passed with zero problems.
  //
  // Both halves of the guard are asserted: the offending _doc is blanked, and a generator
  // built to exploit exactly this shape is reported.
  const docOnly = `
const eip7702 = {
  _doc: "Digests are generated with viem's hashAuthorization({ chainId: 1 }) per packages/core docs",
};
`;
  const code = stripJsComments(docOnly);
  assert.ok(
    !code.includes("hashAuthorization({"),
    "a _doc that cites a path and spells a call must be blanked, not kept as code",
  );
  assert.equal(
    /(?<!['"\w.])hashAuthorization\s*\(/.test(code),
    false,
    "prose alone must never satisfy the actuallyCalled anchor",
  );

  // And end-to-end: correct wiring, a genuine viem import, three honest attestations, but
  // the digests come from an SDK encoder and the only `hashAuthorization(` is prose.
  const proseFaked = `
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { hashAuthorization } = await import("viem/authorization");
const { targetLeaf, merkleRoot, merkleProof, actionRequestDigest } = require(
  join(ROOT, "packages/core/dist/index.js"),
);
const eip7702 = {
  _doc: "Digests are generated with viem's hashAuthorization({ chainId: 1 }) per packages/core docs",
  _provenance: { generator: "viem:hashAuthorization", externallyAnchored: true },
  cases: [],
};
const a = { _provenance: { generator: "@sigilkit/core", externallyAnchored: false }, cases: [] };
const c = { _provenance: { generator: "@sigilkit/core", externallyAnchored: false }, cases: [] };
`;
  assertDetected(
    asResult(checkGeneratorProvenance(proseFaked, { expectProvenance: false })),
    /eip7702 digests are no longer produced by viem's hashAuthorization/,
    "an import with no call site, its only 'call' living in a _doc string",
  );
});

/**
 * Item 5, second half: the generator is asked to attest with a *different entry point* than
 * the registry names. This is the drift where the corpus is produced by, say, a vendored
 * copy or a forked `merkleRoot`, and the gate would otherwise describe a generator that no
 * longer runs. Built from the synthetic generator (not a mutation of the real file) so the
 * cross-check is pinned against the registry itself rather than against today's wiring.
 */
test("a registry entry point the generator does not actually use is flagged (synthetic fixture)", () => {
  // The generator imports all four SDK symbols but attests a qualified entry point the
  // registry does not name. `checkGeneratorProvenance` must report the disagreement.
  // The three blocks are written in `VECTOR_FILES` order on purpose: the emitted blocks
  // are read positionally, so a fixture that shuffled them would be testing the ordering
  // rather than the registry disagreement.
  const driftedEntryPoint = `
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { hashAuthorization } = await import("viem/authorization");
const { targetLeaf, merkleRoot, merkleProof, actionRequestDigest } = require(
  join(ROOT, "packages/core/dist/index.js"),
);
const actionrequest = {
  _provenance: { generator: "@sigilkit/core:actionRequestDigest", externallyAnchored: false },
  cases: [],
};
const eip7702 = {
  _provenance: { generator: "viem:hashAuthorization", externallyAnchored: true },
  cases: [{ digest: hashAuthorization({ chainId: 1n }) }],
};
const merkle = {
  _provenance: { generator: "@sigilkit/core:merkleRoot", externallyAnchored: false },
  cases: [],
};
`;
  assertDetected(
    asResult(checkGeneratorProvenance(driftedEntryPoint)),
    /actionrequest\.json writes _provenance\.generator "@sigilkit\/core:actionRequestDigest", the registry says "@sigilkit\/core"/,
    "generator attests a qualified entry point the registry does not name (actionrequest)",
  );
  assertDetected(
    asResult(checkGeneratorProvenance(driftedEntryPoint)),
    /merkle-v2\.json writes _provenance\.generator "@sigilkit\/core:merkleRoot", the registry says "@sigilkit\/core"/,
    "generator attests a qualified entry point the registry does not name (merkle)",
  );
  // It must name the corpus, not just an index, so a reviewer knows which file to open.
  const problems = checkGeneratorProvenance(driftedEntryPoint);
  assert.ok(
    problems.every((p) => /actionrequest\.json|merkle-v2\.json/.test(p)),
    `every drift problem must name the corpus: ${JSON.stringify(problems, null, 2)}`,
  );
});

test("a missing corpus file is reported", () => {
  const loaded = conformantCorpus();
  delete loaded[MERKLE_FILE];
  assertDetected(check(loaded), /merkle-v2\.json: missing from the vector corpus/, "missing file");
});

test("a non-object corpus is reported", () => {
  const loaded = conformantCorpus();
  loaded["eip7702.json"] = [];
  assertDetected(check(loaded), /eip7702\.json: expected a JSON object at the top level/, "array corpus");
});

test("a non-array cases field is reported", () => {
  const loaded = conformantCorpus();
  loaded["actionrequest.json"].cases = { 0: {} };
  assertDetected(check(loaded), /actionrequest\.json: cases must be an array/, "object cases");
});

test("a corpus with no trees is reported", () => {
  const loaded = conformantCorpus();
  loaded[MERKLE_FILE].trees = [];
  assertDetected(check(loaded), /trees must be a non-empty array/, "emptied trees");
});

test("an unnamed case is reported", () => {
  const loaded = conformantCorpus();
  delete loaded["eip7702.json"].cases[4].name;
  assertDetected(check(loaded), /cases\[4\] has no usable "name"/, "deleted name");
});

test("a non-object loaded argument is rejected instead of throwing", () => {
  for (const bad of [null, undefined, 42, "vectors"]) {
    const result = checkVectorCorpus(bad);
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /expected an object keyed by file name/);
  }
});

test("the per-corpus entry points are individually usable and return problem arrays", () => {
  const noProvenance = { expectProvenance: false };
  assert.deepEqual(checkActionRequestCorpus("actionrequest.json", REAL["actionrequest.json"], noProvenance), []);
  assert.deepEqual(checkEip7702Corpus("eip7702.json", REAL["eip7702.json"], noProvenance), []);
  assert.deepEqual(checkMerkleV2Corpus(MERKLE_FILE, REAL[MERKLE_FILE], noProvenance), []);
  // Each is independently actionable: a broken digest is reported without the other
  // two corpora being present at all.
  const broken = clone(REAL["eip7702.json"]);
  broken.cases[0].digest = "0x00";
  assert.equal(checkEip7702Corpus("eip7702.json", broken, noProvenance).length, 1);
});
