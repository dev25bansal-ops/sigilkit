#!/usr/bin/env node
/**
 * Golden-vector corpus guard (T-05).
 *
 * `scripts/generate-vectors.mjs` derives two of the three corpora from the SDK it is
 * supposed to pin: `actionrequest.json` digests come from `@sigilkit/core`'s own
 * `actionRequestDigest`, and `merkle-v2.json` leaves/roots/proofs come from its own
 * `targetLeaf` / `merkleRoot` / `merkleProof`. Only `eip7702.json` is anchored outside the
 * project, to viem's `hashAuthorization`.
 *
 * That asymmetry is a trap. A breaking SDK change, re-run of the generator, and a green
 * `git diff` is the *expected* outcome of a self-certifying loop: the new vectors are
 * produced by the new logic and therefore agree with it. Nothing flags it. This module
 * makes two facts checkable instead of assumed:
 *
 *   1. the four counts that `generate-vectors.mjs` writes by hand (Foundry's `parseJson`
 *      cannot evaluate `.length`) are pinned against the arrays they claim to count, and
 *      every digest/leaf/root is pinned to 32 bytes — the counts previously had zero
 *      assertions, so a dropped case silently shrank the corpus to whatever the count
 *      happened to say;
 *   2. every file states its own provenance in a `_provenance` block, and this checker
 *      cross-checks that claim against a registry *and* against the generator source, so
 *      "which vectors are certified by the code under test" is a visible, falsifiable
 *      fact rather than something a reader has to infer from the generator.
 *
 * This is a *shape and provenance* gate. It cannot tell you a digest is cryptographically
 * right — only regeneration can (see the no-op gate in `.github/workflows/ci.yml`:
 * `npm run vectors:generate && git diff --exit-code -- vectors/`).
 *
 *   node scripts/check-vectors.mjs            # verify (exit 1 on any problem)
 *   node --test scripts/check-vectors.test.mjs
 *
 * Every rule is a pure exported function over already-parsed JSON, so the test file can
 * drive mutated fixtures without touching `vectors/`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS_DIR = join(ROOT, "vectors");
const GENERATOR_PATH = join(ROOT, "scripts", "generate-vectors.mjs");

/** A 32-byte hex word: `0x` + 64 hex chars. Digest, leaf, root and proof node shape. */
export const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** The three committed corpora, keyed by the file they live in. */
export const VECTOR_FILES = ["actionrequest.json", "eip7702.json", "merkle-v2.json"];

/** The file name that holds the Merkle v2 corpus (not `merkle.json`). */
export const MERKLE_FILE = "merkle-v2.json";

/**
 * What actually generates each corpus. This is the single source of truth for the
 * self-certification question, and every `_provenance` block in `vectors/*.json` is
 * checked against it.
 *
 * `externallyAnchored: true` means some code outside this repository produced the
 * digests, so the corpus can falsify a bug in the SDK. `false` means the SDK produced
 * its own vectors: the corpus can only confirm that the SDK still agrees with itself,
 * and a breaking change to the SDK would silently rewrite it. That distinction is the
 * reason the field exists, so it is asserted, not documented in prose only.
 */
export const PROVENANCE_REGISTRY = {
  "actionrequest.json": { generator: "@sigilkit/core", externallyAnchored: false },
  "eip7702.json": { generator: "viem:hashAuthorization", externallyAnchored: true },
  [MERKLE_FILE]: { generator: "@sigilkit/core", externallyAnchored: false },
};

/**
 * How many `_provenance` blocks the generator is expected to emit: one per registry entry.
 *
 * Kept as its own constant rather than derived from `PROVENANCE_REGISTRY` at module load,
 * because the whole point of the cross-check below is to catch the case where those two
 * drift apart. Deriving the expectation from the thing being checked would make the check
 * incapable of failing on exactly the axis it exists to test.
 */
const EXPECTED_PROVENANCE_BLOCKS = 3;

/**
 * The `generator` value the generator is expected to write for each *self-certified*
 * corpus, keyed by file. Written out literally — and separately from the registry — for
 * the same reason as `EXPECTED_PROVENANCE_BLOCKS`: an independent restatement, so drift
 * between the gate and the generator is reported rather than silently agreeing.
 *
 * The values deliberately match the registry exactly. The registry is the gate's source of
 * truth, and a corpus must not claim a more specific entry point (`@sigilkit/core:xxx`)
 * than the gate can verify.
 *
 * `eip7702.json` is absent on purpose: it is anchored to a third-party symbol, so its
 * registry value is *checked* against the wiring above rather than matched literally —
 * `viem:hashAuthorization` is not a module specifier, so `stripJsComments` blanks it and a
 * literal match there would be a check that cannot pass.
 */
const EXPECTED_SELF_CERTIFIED_GENERATOR = {
  "actionrequest.json": "@sigilkit/core",
  [MERKLE_FILE]: "@sigilkit/core",
};

/** Core symbols the generator must take from `packages/core/dist` to self-certify. */
const SELF_CERTIFIED_SYMBOLS = ["actionRequestDigest", "targetLeaf", "merkleRoot", "merkleProof"];

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** True for a 32-byte hex word; rejects non-strings, short/long words and mixed junk. */
export function isBytes32Hex(value) {
  return typeof value === "string" && HEX32.test(value);
}

/** A `_doc` must exist: it is what tells the next reader what a file is for. */
function checkDoc(file, corpus, problems) {
  if (typeof corpus._doc !== "string" || corpus._doc.trim() === "") {
    problems.push(`${file}: _doc is missing or empty — the file must state what it pins and who consumes it`);
  }
}

/**
 * Compares a hand-written count against the array it claims to count. The count exists
 * because Foundry's `parseJson` cannot evaluate `.length`, so it is written by hand in
 * `generate-vectors.mjs` and had no assertion anywhere: a case added without the count
 * following would have the on-chain suite read a different corpus than the SDK suite.
 */
function checkCount(problems, file, label, declared, actual) {
  if (declared === undefined) {
    problems.push(`${file}: ${label} is missing (Foundry parseJson cannot read .length, so the generator writes it by hand and this check pins it)`);
    return;
  }
  if (declared !== actual) {
    problems.push(
      `${file}: ${label} says ${declared} but the array holds ${actual} — a case was added or dropped without the count following`,
    );
  }
}

/** A corpus with no cases is a deleted corpus, not an empty one. */
function checkNonEmpty(problems, file, label, count) {
  if (typeof count === "number" && !(count > 0)) {
    problems.push(`${file}: ${label} is ${count} — a corpus with no cases is a silently deleted vector set`);
  }
}

function checkName(problems, file, at, name) {
  if (typeof name !== "string" || name.trim() === "") {
    problems.push(`${file}: ${at} has no usable "name" (a vector a test cannot address is a vector nobody reads)`);
  }
}

function checkHex(problems, file, at, label, value) {
  if (!isBytes32Hex(value)) {
    problems.push(`${file}: ${at} ${label} is not 32-byte hex: ${JSON.stringify(value)}`);
  }
}

/**
 * Verifies the in-file `_provenance` attestation against the registry. Three distinct
 * failures are reported separately, because they mean different things to a reviewer: a
 * missing block (the corpus predates the field), a wrong generator, and a flipped
 * `externallyAnchored` — the last being the one that matters, since relabelling a
 * self-certified corpus as externally anchored is exactly the drift this field exists to
 * make visible.
 */
export function provenanceProblems(file, corpus, options = {}) {
  const { expectProvenance = true } = options;
  if (!expectProvenance) return [];
  const expected = PROVENANCE_REGISTRY[file];
  const claim = corpus?._provenance;
  if (claim === undefined) {
    const kind = expected.externallyAnchored
      ? `externally anchored to ${expected.generator}`
      : `SELF-CERTIFIED — generated by ${expected.generator} itself, so it can only prove the SDK still agrees with itself`;
    return [`${file}: _provenance is missing — this corpus is ${kind}; that fact belongs in the file, not inferred from the generator`];
  }
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return [`${file}: _provenance must be an object with { generator, externallyAnchored }`];
  }
  const problems = [];
  if (claim.generator !== expected.generator) {
    problems.push(
      `${file}: _provenance.generator says ${JSON.stringify(claim.generator)}, the actual generation source is ${JSON.stringify(expected.generator)}`,
    );
  }
  if (typeof claim.externallyAnchored !== "boolean") {
    problems.push(
      `${file}: _provenance.externallyAnchored must be a boolean, got ${JSON.stringify(claim.externallyAnchored)}`,
    );
  } else if (claim.externallyAnchored !== expected.externallyAnchored) {
    problems.push(
      `${file}: _provenance.externallyAnchored is ${claim.externallyAnchored} but this corpus is generated by ${expected.generator} itself — ` +
        `claim ${expected.externallyAnchored ? "true" : "false"}`,
    );
  }
  return problems;
}

/** One row per corpus describing what is actually in the file (for the CLI table). */
export function describeProvenance(loaded) {
  return VECTOR_FILES.map((file) => {
    const expected = PROVENANCE_REGISTRY[file];
    const claim = loaded?.[file]?._provenance;
    return {
      file,
      generator: claim?.generator ?? null,
      externallyAnchored: claim?.externallyAnchored ?? null,
      attested: claim !== undefined,
      matchesRegistry:
        claim !== undefined &&
        claim?.generator === expected.generator &&
        claim?.externallyAnchored === expected.externallyAnchored,
    };
  });
}

// ---------------------------------------------------------------------------
// per-corpus checks
// ---------------------------------------------------------------------------

/** ActionRequest EIP-712 digests. Self-certified by `@sigilkit/core`. */
export function checkActionRequestCorpus(file, corpus, options = {}) {
  const problems = [];
  checkDoc(file, corpus, problems);
  problems.push(...provenanceProblems(file, corpus, options));
  const cases = corpus.cases;
  if (!Array.isArray(cases)) {
    problems.push(`${file}: cases must be an array`);
    return problems;
  }
  checkCount(problems, file, "casesCount", corpus.casesCount, cases.length);
  checkNonEmpty(problems, file, "casesCount", corpus.casesCount);
  cases.forEach((testCase, i) => {
    const at = `cases[${i}]`;
    if (typeof testCase !== "object" || testCase === null) {
      problems.push(`${file}: ${at} must be an object`);
      return;
    }
    checkName(problems, file, at, testCase.name);
    checkHex(problems, file, at, "digest", testCase.digest);
  });
  return problems;
}

/** EIP-7702 authorization digests. The one externally anchored corpus (viem). */
export function checkEip7702Corpus(file, corpus, options = {}) {
  const problems = [];
  checkDoc(file, corpus, problems);
  problems.push(...provenanceProblems(file, corpus, options));
  const cases = corpus.cases;
  if (!Array.isArray(cases)) {
    problems.push(`${file}: cases must be an array`);
    return problems;
  }
  checkCount(problems, file, "casesCount", corpus.casesCount, cases.length);
  checkNonEmpty(problems, file, "casesCount", corpus.casesCount);
  cases.forEach((testCase, i) => {
    const at = `cases[${i}]`;
    if (typeof testCase !== "object" || testCase === null) {
      problems.push(`${file}: ${at} must be an object`);
      return;
    }
    checkName(problems, file, at, testCase.name);
    checkHex(problems, file, at, "digest", testCase.digest);
  });
  return problems;
}

/**
 * Merkle v2: leaf cases plus the trees built from them. Every tree is checked, not just
 * `trees[0]` — the counts are hand-written per tree, so checking only the first would
 * leave any future second tree unasserted.
 */
export function checkMerkleV2Corpus(file, corpus, options = {}) {
  const problems = [];
  checkDoc(file, corpus, problems);
  problems.push(...provenanceProblems(file, corpus, options));

  const leafCases = corpus.leafCases;
  if (!Array.isArray(leafCases)) {
    problems.push(`${file}: leafCases must be an array`);
  } else {
    checkCount(problems, file, "leafCasesCount", corpus.leafCasesCount, leafCases.length);
    checkNonEmpty(problems, file, "leafCasesCount", corpus.leafCasesCount);
    leafCases.forEach((leafCase, i) => {
      const at = `leafCases[${i}]`;
      if (typeof leafCase !== "object" || leafCase === null) {
        problems.push(`${file}: ${at} must be an object`);
        return;
      }
      checkName(problems, file, at, leafCase.name);
      checkHex(problems, file, at, "leaf", leafCase.leaf);
      checkHex(problems, file, at, "argsHash", leafCase.argsHash);
    });
  }

  const trees = corpus.trees;
  if (!Array.isArray(trees) || trees.length === 0) {
    problems.push(`${file}: trees must be a non-empty array (a corpus with no tree pins no root)`);
    return problems;
  }

  trees.forEach((tree, i) => {
    const at = `trees[${i}]`;
    if (typeof tree !== "object" || tree === null) {
      problems.push(`${file}: ${at} must be an object`);
      return;
    }
    const leaves = tree.leaves;
    if (!Array.isArray(leaves)) {
      problems.push(`${file}: ${at}.leaves must be an array`);
    } else {
      checkCount(problems, file, `${at}.leavesCount`, tree.leavesCount, leaves.length);
      checkNonEmpty(problems, file, `${at}.leavesCount`, tree.leavesCount);
      leaves.forEach((leaf, j) => checkHex(problems, file, `${at}.leaves[${j}]`, "leaf", leaf));
    }
    checkHex(problems, file, at, "root", tree.root);

    const proofs = tree.proofs;
    if (!Array.isArray(proofs)) {
      problems.push(`${file}: ${at}.proofs must be an array`);
      return;
    }
    checkCount(problems, file, `${at}.proofsCount`, tree.proofsCount, proofs.length);
    const proven = new Set();
    proofs.forEach((entry, j) => {
      const pat = `${at}.proofs[${j}]`;
      if (typeof entry !== "object" || entry === null) {
        problems.push(`${file}: ${pat} must be an object`);
        return;
      }
      checkHex(problems, file, pat, "leaf", entry.leaf);
      proven.add(entry.leaf);
      if (!Array.isArray(entry.proof)) {
        problems.push(`${file}: ${pat}.proof must be an array`);
        return;
      }
      entry.proof.forEach((node, k) => checkHex(problems, file, `${pat}.proof[${k}]`, "proof node", node));
    });
    // A tree whose proofs do not cover its leaves can verify one path while leaving
    // another leaf unproven — the same hole a count-only assertion would miss.
    if (Array.isArray(leaves)) {
      for (const leaf of leaves) {
        if (!proven.has(leaf)) {
          problems.push(`${file}: ${at} has no proof for leaf ${JSON.stringify(leaf)}`);
        }
      }
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// generator wiring
// ---------------------------------------------------------------------------

/**
 * Blanks comments and string/template *bodies* while preserving newlines and character
 * offsets, so regexes still anchor correctly and any message quoting the source stays
 * honest.
 *
 * Needed because the generator *documents* its own provenance in prose: the header says
 * "viem's hashAuthorization (external reference)", and the eip7702 `_doc` says the
 * digests are "generated with viem's hashAuthorization". A regex over raw text therefore
 * reports the anchor as present long after the call site moved to the SDK's own encoder —
 * which is precisely the drift this check exists to catch.
 *
 * Import specifiers are the deliberate exception and are preserved: a string that names a
 * *module* is not prose. `require(join(ROOT, "packages/core/dist/index.js"))` is how the
 * generator identifies the SDK as the source of the self-certified digests, so blanking it
 * would hide exactly the evidence this check needs. Literals with no path-ish content stay
 * blanked, so `_doc` and log messages cannot satisfy a code check.
 *
 * Exported for its own tests: a stripper that mis-handles a literal is a silent hole in
 * every check that depends on it.
 */
export function stripJsComments(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  const keepNewlines = (from, to) => {
    for (let k = from; k < to; k++) out.push(source[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      keepNewlines(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      keepNewlines(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Scan the literal, honouring escapes. A template's `${ … }` may nest further
      // literals, so track brace depth inside backticks.
      const quote = ch;
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (quote === "`" && c === "$" && source[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (quote === "`" && c === "}" && depth > 0) {
          depth--;
          j++;
          continue;
        }
        if (c === quote && depth === 0) break;
        j++;
      }
      const stop = Math.min(j + 1, n);
      const literal = source.slice(i, stop);
      // A literal naming a module is identity, not prose: keep it intact.
      if (looksLikeModuleSpecifier(literal)) {
        out.push(literal);
      } else {
        keepNewlines(i, stop);
      }
      i = stop;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * True for a string literal whose body names a module path: a `/` or `\` separator, a file
 * extension, or a bare package name. Keeps `"./x.js"`, `"viem"` and
 * `"packages/core/dist/index.js"`; rejects `"vectors written: 3 cases"` and every `_doc`
 * prose, none of which can masquerade as a path.
 *
 * A body containing whitespace is rejected outright, which is the rule that makes the
 * `_doc` claim above true: a sentence that merely *cites* a path is not a specifier.
 */
function looksLikeModuleSpecifier(literal) {
  const body = literal.slice(1, -1);
  if (body.trim() === "") return false;
  if (/[\r\n]/.test(body)) return false;
  // Whitespace is what separates a *path* from *prose that mentions a path*. Every real
  // specifier in this generator is one unbroken token (`"viem"`, `"packages/core/dist/index.js"`,
  // `"node_modules/viem/_esm/utils/authorization/hashAuthorization.js"`), while every `_doc`
  // is a sentence that happens to cite one — `"… Consumers: packages/core/test/vectors.test.ts …"`.
  // Without this line the `[/\\]` branch below kept every `_doc`, and because the eip7702 `_doc`
  // spells out `hashAuthorization({ … })`, the `actuallyCalled` anchor was satisfied by a
  // *string* rather than a call site: a generator that imported viem but never called it
  // passed with zero problems. Rejecting whitespace costs nothing real (a specifier containing
  // a space is legal on disk but appears nowhere here) and closes the false negative.
  if (/\s/.test(body)) return false;
  return /[/\\]/.test(body) || /\.[a-zA-Z][a-zA-Z0-9+.-]*$/.test(body) || /^[\w@][\w@/.-]*$/.test(body);
}

/**
 * `_provenance` written as an object key. The `[{,]\s*` prefix is what separates "a block is
 * being written" from "the name is mentioned": a bare `_provenance:` would also match a
 * ternary branch or a label, and the leading brace or comma keeps the match inside an
 * object literal.
 *
 * Deliberately two separate patterns rather than one global one. A global regex carries a
 * mutable `lastIndex`, so sharing it between a `.test()` and a later `matchAll()` would make
 * the second use start scanning from wherever the first left off — a check that silently
 * reads the wrong span. Keeping the boolean form stateless costs one duplicated literal.
 */
const PROVENANCE_KEY = /[{,]\s*_provenance\s*:\s*\{/;
const PROVENANCE_KEY_ALL = /[{,]\s*_provenance\s*:\s*\{/g;

/**
 * Extracts the `{ generator, externallyAnchored }` pair from each `_provenance` block the
 * generator writes, in source order, so they can be compared against the registry.
 *
 * This is a *shallow* read of the literal, not an evaluation of the object: it exists to
 * catch the drift where a corpus's attested source stops matching the registry, not to
 * model arbitrary JS. A block it cannot read is reported as `null` rather than guessed at,
 * so an unreadable shape surfaces as a problem instead of a silent pass.
 *
 * @returns `{ generator: string|null, externallyAnchored: boolean|null }[]`
 */
function readEmittedProvenance(code) {
  const out = [];
  for (const match of code.matchAll(PROVENANCE_KEY_ALL)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = code.indexOf("}", bodyStart);
    const body = bodyEnd === -1 ? "" : code.slice(bodyStart, bodyEnd);
    const generator = /\bgenerator\s*:\s*"([^"]*)"/.exec(body);
    const anchored = /\bexternallyAnchored\s*:\s*(true|false)/.exec(body);
    out.push({
      generator: generator ? generator[1] : null,
      externallyAnchored: anchored ? anchored[1] === "true" : null,
    });
  }
  return out;
}

/**
 * Reads `generate-vectors.mjs` and checks that the registry still describes the wiring
 * that actually runs. Without this, `externallyAnchored: true` for eip7702 would be an
 * unchecked promise: a change that moved those digests onto the SDK's own encoder would
 * turn the only externally anchored corpus into a self-certified one, and the field would
 * still claim otherwise. Checks the source shape too — if the generator is refactored
 * past recognition this reports loudly rather than passing on a failed parse.
 *
 * The registry is additionally cross-checked against the literals the generator actually
 * writes into the files, so `PROVENANCE_REGISTRY` cannot drift away from the corpus it is
 * supposed to describe without being reported.
 */
export function checkGeneratorProvenance(source, options = {}) {
  const { expectProvenance = true } = options;
  const problems = [];
  if (typeof source !== "string" || source.trim() === "") {
    return ["generate-vectors.mjs: could not read the generator source (cannot verify which corpora are self-certified)"];
  }

  // Match against code only. Both prose mentions of hashAuthorization in the generator
  // (the header comment and the eip7702 `_doc` string) would otherwise satisfy a naive
  // text search, and the anchor would look intact after the call site had been swapped
  // for the SDK's own encoder.
  const code = stripJsComments(source);

  // The anchor has two halves and both must hold: a binding sourced from viem, AND an
  // actual call. Keeping the import while deleting the call site leaves dead code that
  // reads like an anchor; keeping the call while dropping the import is a local encoder.
  const boundToViem = /\{[^}]*\bhashAuthorization\b[^}]*\}\s*=\s*await\s+import\(/.test(code);
  const actuallyCalled = /(?<!['"\w.])hashAuthorization\s*\(/.test(code);
  if (!boundToViem || !actuallyCalled) {
    problems.push(
      "generate-vectors.mjs: eip7702 digests are no longer produced by viem's hashAuthorization — " +
        "the only externally anchored corpus would become self-certified; update PROVENANCE_REGISTRY deliberately",
    );
  }

  // `[^{}]*` cannot cross a brace boundary, so each capture stays inside ONE destructuring
  // group. A lazy `[\s\S]*?` would happily start at the viem `import { … } from "viem"`
  // above it and swallow every symbol in between, making the check pass for the wrong
  // reason — a guard that cannot fail is worse than no guard.
  const coreImports = [...code.matchAll(/\{([^{}]*)\}\s*=\s*require\([\s\S]{0,200}?packages\/core\/dist/g)];
  if (coreImports.length === 0) {
    problems.push(
      "generate-vectors.mjs: could not find the @sigilkit/core dist import (source shape changed?) — " +
        "the self-certified corpora can no longer be confirmed, so the registry is unverified",
    );
  } else {
    const imported = new Set(
      coreImports.flatMap((m) => m[1].split(",").map((s) => s.trim().split(":")[0].trim())).filter(Boolean),
    );
    for (const symbol of SELF_CERTIFIED_SYMBOLS) {
      if (!imported.has(symbol)) {
        problems.push(
          `generate-vectors.mjs: ${symbol} is no longer imported from @sigilkit/core — the corpus it generated ` +
            `is now anchored somewhere else; update PROVENANCE_REGISTRY deliberately`,
        );
      }
    }
  }

  // `_provenance` must be written as an object *key*, not merely appear in the source. The
  // substring form of this test is satisfiable by a comment, by a log message and — because
  // `stripJsComments` deliberately keeps a literal that looks like a bare module name — by
  // the string `"_provenance"`. A generator that only talked about the attestation would
  // have satisfied it while writing nothing at all.
  if (expectProvenance && !PROVENANCE_KEY.test(code)) {
    problems.push(
      "generate-vectors.mjs: no `_provenance` block is written into the vector files — the attestation that " +
        "separates externally anchored digests from self-certified ones has to be emitted by the generator, " +
        "or it cannot be checked at all",
    );
  }

  if (!expectProvenance) return problems;

  // Presence alone is not enough: a generator could write three *identical* blocks, or one
  // honest block and two copies of the other corpus's claim, and the substring test above
  // would still be satisfied. So the blocks are read and compared against the registry,
  // position by position.
  const emitted = readEmittedProvenance(code);
  if (emitted.length === 0) return problems; // already reported above

  if (emitted.length !== EXPECTED_PROVENANCE_BLOCKS) {
    problems.push(
      `generate-vectors.mjs: writes ${emitted.length} \`_provenance\` block(s) but the registry describes ` +
        `${EXPECTED_PROVENANCE_BLOCKS} corpora — a corpus gained or lost its attestation`,
    );
    return problems;
  }

  // Only the SDK-anchored values are matched literally: `viem:hashAuthorization` is not a
  // module specifier, so `stripJsComments` blanks it and a literal match there would be a
  // check that cannot pass. That corpus is held to the wiring check above instead, which is
  // stronger evidence than a string comparison: it proves viem's symbol is really called.
  //
  // The file name is recovered from the enclosing object literal so the complaint names the
  // corpus a reader has to open, not just an index into the generator.
  for (const [i, file] of VECTOR_FILES.entries()) {
    const expectedGenerator = EXPECTED_SELF_CERTIFIED_GENERATOR[file];
    if (expectedGenerator === undefined) continue; // externally anchored: wiring-checked
    const claim = emitted[i];
    if (claim.generator !== expectedGenerator) {
      problems.push(
        `generate-vectors.mjs: ${file} writes _provenance.generator ${JSON.stringify(claim.generator)}, ` +
          `the registry says ${JSON.stringify(expectedGenerator)} — the generator and the gate disagree about what ` +
          `produced this corpus`,
      );
    }
    if (claim.externallyAnchored !== false) {
      problems.push(
        `generate-vectors.mjs: ${file} writes _provenance.externallyAnchored ${JSON.stringify(claim.externallyAnchored)}, ` +
          `the registry says false — a self-certified corpus must not claim an external anchor`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// corpus-level entry point + CLI
// ---------------------------------------------------------------------------

/**
 * Runs every rule over an already-parsed corpus.
 *
 * @param loaded  `{ "actionrequest.json": …, "eip7702.json": …, "merkle-v2.json": … }`
 * @param options `generatorSource` (string) enables the wiring cross-check;
 *                `expectProvenance: false` downgrades a missing `_provenance` block to
 *                a non-problem, which exists only for the migration test.
 * @returns `{ ok, problems }` — `ok` is `problems.length === 0`.
 */
export function checkVectorCorpus(loaded, options = {}) {
  const { generatorSource = null, expectProvenance = true } = options;
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    return { ok: false, problems: ["vector corpus: expected an object keyed by file name"] };
  }

  const problems = [];
  for (const file of VECTOR_FILES) {
    const corpus = loaded[file];
    if (corpus === undefined) {
      problems.push(`${file}: missing from the vector corpus (run npm run vectors:generate)`);
      continue;
    }
    if (typeof corpus !== "object" || corpus === null || Array.isArray(corpus)) {
      problems.push(`${file}: expected a JSON object at the top level`);
      continue;
    }
    if (file === MERKLE_FILE) problems.push(...checkMerkleV2Corpus(file, corpus, { expectProvenance }));
    else if (file === "eip7702.json") problems.push(...checkEip7702Corpus(file, corpus, { expectProvenance }));
    else problems.push(...checkActionRequestCorpus(file, corpus, { expectProvenance }));
  }

  if (generatorSource !== null) problems.push(...checkGeneratorProvenance(generatorSource, { expectProvenance }));

  return { ok: problems.length === 0, problems };
}

/** Reads the three corpora from `dir`. A missing file is left to the checker to report. */
export function loadVectorCorpus(dir = VECTORS_DIR) {
  const loaded = {};
  for (const file of VECTOR_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    loaded[file] = JSON.parse(readFileSync(path, "utf8"));
  }
  return loaded;
}

function main() {
  let loaded;
  try {
    loaded = loadVectorCorpus();
  } catch (error) {
    console.error(`vector corpus: could not parse vectors/*.json — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // An absent generator must NOT be the same observation as "no generator to check": `null`
  // is the documented sentinel that skips `checkGeneratorProvenance` altogether, so deleting
  // or renaming scripts/generate-vectors.mjs used to switch the whole provenance cross-check
  // off and the gate exited 0 on an unverifiable registry. An empty string reaches the
  // check, which reports the unreadable source.
  const generatorSource = existsSync(GENERATOR_PATH) ? readFileSync(GENERATOR_PATH, "utf8") : "";

  const { ok, problems } = checkVectorCorpus(loaded, { generatorSource });

  for (const row of describeProvenance(loaded)) {
    const mark = row.attested ? (row.matchesRegistry ? "ok  " : "WRONG") : "none ";
    const anchored = row.externallyAnchored === null ? "unattested" : row.externallyAnchored ? "externally anchored" : "self-certified";
    console.log(`${mark} ${row.file.padEnd(20)} generator=${row.generator ?? "?"} (${anchored})`);
  }

  if (ok) {
    const selfCertified = describeProvenance(loaded).filter((r) => r.externallyAnchored === false).map((r) => r.file);
    console.log(`\nvector corpus OK — counts pinned, all digests/leaves/roots 32-byte hex.`);
    console.log(
      selfCertified.length > 0
        ? `  externally anchored: eip7702.json · self-certified (SDK-generated, pinned by the no-op gate only): ${selfCertified.join(", ")}`
        : "  no corpus is self-certified",
    );
    process.exit(0);
  }

  console.error(`\nvector corpus: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nCounts are written by hand (Foundry parseJson cannot read .length): run `npm run vectors:generate`, " +
      "review the diff, and if `_provenance` is the missing piece add the block to generate-vectors.mjs.",
  );
  process.exit(1);
}

/** True when this module is the process entry point (not imported by the test file). */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = pathToFileURL(entry).href;
  return process.platform === "win32"
    ? resolved.toLowerCase() === import.meta.url.toLowerCase()
    : resolved === import.meta.url;
}

if (isDirectInvocation()) main();
