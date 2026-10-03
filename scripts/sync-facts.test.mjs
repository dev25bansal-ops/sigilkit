import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SEVERITY,
  applyWrite,
  blankComments,
  buildFindings,
  compareFloors,
  contractArgs,
  deriveJsExclude,
  extractScopePair,
  findOccurrences,
  forgeScopeArgs,
  isWritable,
  jsExcludeToRegExp,
  legacyDigitSliceFloor,
  main,
  makeIo,
  parseEngineFloor,
  planWrites,
  renderFinding,
  serializeScope,
  validateScope,
  verdict,
} from "./sync-facts.mjs";

/**
 * The cross-file fact-source guard.
 *
 * Everything below the I/O boundary is pure, so the suite drives it against in-memory
 * fixtures and a throwaway `mkdtemp` root. The one real repository the suite reads is the
 * last test, and that test replaces `write` with a thrower, so a regression that starts
 * rewriting the working tree fails loudly instead of quietly.
 *
 * Fixtures never hand-write a fact the guard also derives. Where a consumer line depends on
 * a scope pattern it is *generated* with `forgeScopeArgs()` / `serializeScope()`, and the
 * expectation is built from the same call: a literal written by the same hand as the
 * assertion cannot detect that the two have drifted from the owner's output.
 */

// ── fixtures ─────────────────────────────────────────────────────────────────────

/** The repository's real foundry-scope.json, including its `$comment` provenance field. */
const SCOPE = {
  $comment:
    "Single source of truth for which Solidity contract suites are excluded from the PR gate.",
  unitExclude: ".*Invariant|.*Fork",
  invariantMatch: ".*Invariant",
  forkMatch: ".*Fork",
  jsExclude: "Invariant|Fork",
};

/**
 * The same scope with a third category added. `jsExclude` is left at its old value on
 * purpose: that is exactly the state a contributor creates by adding to `unitExclude`
 * without regenerating the mirror, and it is a `split` (repairable by `--write`), not an
 * error. A test that pre-fixed it would be testing a repository nobody actually has.
 */
const WIDE_SCOPE = { ...SCOPE, unitExclude: ".*Invariant|.*Fork|.*Something" };

/**
 * An io over a `Map`. `readText` throws for an absent key so `exists()` and `readText()`
 * disagree exactly the way the real filesystem makes them disagree — several guards only
 * behave correctly when the read path is allowed to fail.
 */
function memIo(files) {
  const store = new Map(Object.entries(files));
  const writes = [];
  return {
    store,
    writes,
    readText: (rel) => {
      if (!store.has(rel)) throw new Error(`ENOENT: ${rel}`);
      return store.get(rel);
    },
    listDir: (rel) => {
      const prefix = `${rel}/`;
      const names = new Set();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
      }
      return [...names].sort();
    },
    exists: (rel) => store.has(rel),
    write: (rel, text) => {
      writes.push({ rel, text });
      store.set(rel, text);
    },
  };
}

/**
 * A self-consistent fake repository whose every consumer line is generated from the scope
 * owner. `opts` breaks exactly one fact at a time, so a test expecting drift can be sure
 * the drift is the one it introduced and not a residue of the fixture.
 */
function consistentFiles(scope = SCOPE, opts = {}) {
  const [unitFlag, unitPattern] = forgeScopeArgs(scope, "unit");
  const [fullFlag, fullPattern] = forgeScopeArgs(scope, "full");
  const [invFlag, invPattern] = forgeScopeArgs(scope, "invariant");
  const [forkFlag, forkPattern] = forgeScopeArgs(scope, "fork");
  const { engines = ">=24", nvm = "24", docker = "24-bookworm-slim", workspaces = ["core"], scopeFile = null } = opts;

  const ci = [
    "name: ci",
    "on: [push]",
    "env:",
    '  FOUNDRY_VERSION: "v1.7.1"',
    "jobs:",
    "  forge-unit:",
    "    steps:",
    "      - uses: foundry-rs/foundry-toolchain@v1",
    '        with: { version: "${{ env.FOUNDRY_VERSION }}" }',
    `      - run: forge test ${unitFlag} '${unitPattern}'`,
    "  forge-invariant:",
    "    steps:",
    `      - run: forge test ${invFlag} '${invPattern}'`,
    "  forge-fork:",
    "    steps:",
    "      - uses: foundry-rs/foundry-toolchain@v1",
    '        with: { version: "${{ env.FOUNDRY_VERSION }}" }',
    `      - run: forge test --fork-url "$RPC_BASE" ${forkFlag} '${forkPattern}'`,
    "",
  ].join("\n");

  const files = {
    "package.json": `${JSON.stringify(
      {
        name: "sigilkit",
        type: "module",
        workspaces: workspaces.map((w) => `packages/${w}`),
        engines: { node: engines },
        scripts: {
          test: `forge test ${unitFlag} "${unitPattern}" && npm run test --workspaces --if-present`,
          "test:full": `forge test ${fullFlag} "${fullPattern}" && npm run test --workspaces --if-present`,
        },
      },
      null,
      2,
    )}\n`,
    ".nvmrc": `${nvm}\n`,
    Dockerfile: [
      "# build",
      `FROM node:${docker} AS build`,
      "WORKDIR /app",
      "RUN npm ci",
      "",
      "# runtime",
      `FROM node:${docker} AS runtime`,
      'CMD ["node", "cli.js"]',
      "",
    ].join("\n"),
    "scripts/foundry-scope.json": scopeFile ?? serializeScope(scope),
    ".github/workflows/ci.yml": ci,
    "scripts/verify.mjs": [
      'import { run } from "./harness.mjs";',
      `await run(FORGE, ["test", ${JSON.stringify(unitFlag)}, ${JSON.stringify(unitPattern)}]);`,
      "",
    ].join("\n"),
    "scripts/check-doc-counts.mjs": [
      'import { readFileSync } from "node:fs";',
      "",
      `export const EXCLUDED = /${jsExcludeToRegExp(scope).source}/;`,
      "",
    ].join("\n"),
  };
  for (const ws of workspaces) {
    files[`packages/${ws}/package.json`] = `${JSON.stringify(
      { name: `@sigilkit/${ws}`, type: "module", engines: { node: engines } },
      null,
      2,
    )}\n`;
  }
  return files;
}

/** Drives `main()` with stdout/stderr captured, restoring both in a `finally`. */
function runMain(argv, io) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    return { code: main(argv, io), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Materialises a fixture tree into a throwaway directory, for the real-`makeIo` cases. */
function tempRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "sync-facts-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── 1. parseEngineFloor: what it reads ───────────────────────────────────────────

test("parseEngineFloor: reads every accepted floor shape, triple and all", () => {
  // The triple is asserted, not just the major, because a parser that answers "24" for
  // both "24.1.0" and "24" is indistinguishable from a correct one until someone writes
  // `engines.node: ">=24.1"` and npm starts refusing installs on 24.0.
  assert.deepEqual(parseEngineFloor(">=24"), { major: 24, minor: 0, patch: 0, raw: ">=24" });
  assert.deepEqual(parseEngineFloor(">=24.1.0"), { major: 24, minor: 1, patch: 0, raw: ">=24.1.0" });
  assert.deepEqual(parseEngineFloor("^24.0.0"), { major: 24, minor: 0, patch: 0, raw: "^24.0.0" });
  assert.deepEqual(parseEngineFloor("~24.1"), { major: 24, minor: 1, patch: 0, raw: "~24.1" });
  assert.deepEqual(parseEngineFloor("24"), { major: 24, minor: 0, patch: 0, raw: "24" });
  assert.deepEqual(parseEngineFloor("  >=24  "), { major: 24, minor: 0, patch: 0, raw: "  >=24  " });
  assert.deepEqual(parseEngineFloor(">=100"), { major: 100, minor: 0, patch: 0, raw: ">=100" });
});

test("parseEngineFloor: refuses every range it cannot read as one floor", () => {
  // The refusal list is the point of the function. Each entry is a range npm accepts and
  // `check-runtime.mjs`'s lenient parse silently misreads — "lts/*" becoming DEFAULT_FLOOR
  // and ">= 24 < 26" becoming 24 are both guesses, and a guard that guesses produces a
  // number indistinguishable from a real reading.
  for (const bad of ["lts/*", "24.x", ">= 24 < 26", "", ">= 24.1.0 < 26", "  "]) {
    assert.throws(
      () => parseEngineFloor(bad),
      (err) => err instanceof Error && /engines\.node/.test(err.message),
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
  for (const bad of [null, undefined, 24, {}, [], true]) {
    assert.throws(() => parseEngineFloor(bad), Error, `expected ${String(bad)} to be refused`);
  }
  assert.throws(() => parseEngineFloor(">=0"), /non-positive major/);
  assert.throws(() => parseEngineFloor("0000"), /non-positive major/);
});

test("parseEngineFloor: a three-digit major survives — the reason the parser exists", () => {
  // Pinned separately from the legacy counter-example so an edit to one parse cannot
  // silently change the other. Today both agree at 24; only one is right at 100.
  assert.equal(parseEngineFloor(">=100").major, 100);
  assert.equal(parseEngineFloor(">=1000").major, 1000);
});

// ── 2. the legacy parse, pinned as a known-wrong answer ─────────────────────────

test("legacyDigitSliceFloor: the old bootstrap parse truncates a three-digit major to 10", () => {
  // This test exists to falsify `bootstrap.mjs`'s expression. It goes red if someone
  // "fixes" the legacy helper, which is the signal to delete the helper and its finding
  // rather than to keep a second parser around.
  assert.equal(legacyDigitSliceFloor(">=100"), 10);
  assert.equal(legacyDigitSliceFloor(">=24"), 24);
  assert.equal(legacyDigitSliceFloor(null), 24, "an absent engine still defaulted to 24");
  assert.equal(legacyDigitSliceFloor("lts/*"), 24, "and so did an unreadable one");
  assert.equal(legacyDigitSliceFloor(""), 24);
});

test("the two parses agree at 24 and disagree at 100, which is the whole report", () => {
  // Asserted as a table so the value the guard prints for bootstrap.mjs stays
  // arithmetically true as the floor moves, rather than being frozen at today's digits.
  // The legacy parse concatenates every digit and keeps the first two, so it is wrong for
  // every three-digit major: ">=100" → 10 and ">=1000" → 100, while both are right at 24.
  for (const [range, legacy, strict] of [
    [">=24", 24, 24],
    [">=100", 10, 100],
    [">=1000", 10, 1000],
  ]) {
    assert.equal(parseEngineFloor(range).major, strict, `strict reads ${range}`);
    assert.equal(legacyDigitSliceFloor(range), legacy, `legacy reads ${range} as ${legacy}`);
  }
  assert.notEqual(legacyDigitSliceFloor(">=100"), parseEngineFloor(">=100").major, "they diverge at 100");
});

// ── 3. compareFloors ─────────────────────────────────────────────────────────────

test("compareFloors: reports lower / equal / higher / unknown", () => {
  // Fed every shape the findings code can hand it — numbers, parsed objects, arrays and
  // unreadable strings — because a helper that handled only some of them would return
  // "unknown" in production and quietly downgrade a drift to a non-finding.
  assert.equal(compareFloors(24, 24), "equal");
  assert.equal(compareFloors(20, 24), "lower");
  assert.equal(compareFloors(26, 24), "higher");
  assert.equal(compareFloors(24, 26), "lower");
  assert.equal(compareFloors(">=24", { major: 24, minor: 0, patch: 0 }), "equal");
  assert.equal(compareFloors({ major: 24 }, 24), "equal");
  assert.equal(compareFloors(24, [24, 0, 0]), "equal");
  assert.equal(compareFloors([24, 1], [24, 0, 0]), "higher", "the minor version is compared");
  assert.equal(compareFloors("lts/*", 24), "unknown");
  assert.equal(compareFloors(24, "lts/*"), "unknown");
  assert.equal(compareFloors(null, 24), "unknown");
  assert.equal(compareFloors(24, null), "unknown");
  assert.equal(compareFloors(undefined, undefined), "unknown");
});

// ── 4. the forge scope pairs ─────────────────────────────────────────────────────

test("extractScopePair: each kind reads its own field, and `full` reads forkMatch", () => {
  // `full` is the trap. `npm run test:full` is the *wide* run: it keeps the invariant
  // suites and drops only the fork ones. Reading it from `unitExclude` would emit
  // `--no-match-contract '.*Invariant|.*Fork'` where the owner says `.*Fork`, quietly
  // narrowing the wide run until it is identical to the unit run. The field name is
  // asserted, not just the arguments, because the arguments can coincide in a later edit.
  assert.deepEqual(extractScopePair(SCOPE, "unit"), {
    field: "unitExclude",
    mode: "--no-match-contract",
    pattern: ".*Invariant|.*Fork",
  });
  assert.deepEqual(extractScopePair(SCOPE, "full"), {
    field: "forkMatch",
    mode: "--no-match-contract",
    pattern: ".*Fork",
  });
  assert.deepEqual(extractScopePair(SCOPE, "invariant"), {
    field: "invariantMatch",
    mode: "--match-contract",
    pattern: ".*Invariant",
  });
  assert.deepEqual(extractScopePair(SCOPE, "fork"), {
    field: "forkMatch",
    mode: "--match-contract",
    pattern: ".*Fork",
  });
});

test("forgeScopeArgs: the four kinds produce exactly the two-argument pairs", () => {
  assert.deepEqual(forgeScopeArgs(SCOPE, "unit"), ["--no-match-contract", ".*Invariant|.*Fork"]);
  assert.deepEqual(forgeScopeArgs(SCOPE, "full"), ["--no-match-contract", ".*Fork"]);
  assert.deepEqual(forgeScopeArgs(SCOPE, "invariant"), ["--match-contract", ".*Invariant"]);
  assert.deepEqual(forgeScopeArgs(SCOPE, "fork"), ["--match-contract", ".*Fork"]);
  for (const kind of ["unit", "full", "invariant", "fork"]) {
    assert.equal(forgeScopeArgs(SCOPE, kind).length, 2, `${kind} must be a flag/pattern pair`);
  }
});

test("forgeScopeArgs: an unknown kind throws instead of returning unfiltered args", () => {
  // "Run everything" is never the safe default: an unfiltered `forge test` in a package
  // script would pull the fork suites into the PR gate, which needs no RPC to run.
  for (const kind of ["everything", "Unit", "all", "", null, undefined, "no-match", "constructor", "toString"]) {
    assert.throws(
      () => forgeScopeArgs(SCOPE, kind),
      /unknown forge scope kind/,
      `kind ${JSON.stringify(kind)} must not fall back to a default`,
    );
  }
});

test("forgeScopeArgs: a missing, empty or non-string scope field throws", () => {
  // A scope file that lost a field must fail the gate, not run the suites that field gated.
  for (const [field, kind] of [
    ["unitExclude", "unit"],
    ["invariantMatch", "invariant"],
    ["forkMatch", "fork"],
  ]) {
    for (const bad of [undefined, null, "", 24, {}, []]) {
      assert.throws(
        () => forgeScopeArgs({ ...SCOPE, [field]: bad }, kind),
        /missing a usable/,
        `${field}=${JSON.stringify(bad)} must not be usable`,
      );
    }
  }
  for (const bad of [undefined, null, "", 24]) {
    assert.throws(() => jsExcludeToRegExp({ ...SCOPE, jsExclude: bad }), /missing a usable|not a valid regex/);
  }
  assert.throws(() => forgeScopeArgs(undefined, "unit"), /missing a usable/);
  assert.throws(() => forgeScopeArgs(null, "unit"), /missing a usable/);
});

test("contractArgs: a forge coverage filter is instrumentation hygiene, not forge scope", () => {
  // The nightly job excludes the gas-budget suites from the coverage RUN because
  // instrumentation inflates gas past their absolute ceilings. That filter is not a
  // restatement of the forge scope (the coverage run inherits it untouched), so reading
  // it as drift would flag the workflow for a pattern that belongs to no field — which
  // is exactly what happened when the exclusion was first added. Runner words from other
  // tools (halmos) stay skipped by the same rule, and a real forge test line is still seen.
  const yaml = [
    "      - run: halmos --match-contract Halmos",
    "      - run: forge coverage --report lcov --report summary --no-match-contract 'GasBudgetTest|Gas7579ScalingTest'",
    "      - run: forge test --no-match-contract '.*Invariant|.*Fork'",
  ].join("\n");
  const hits = contractArgs(yaml);
  assert.equal(hits.length, 1, `only the forge test line is scope; got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].mode, "--no-match-contract");
  assert.equal(hits[0].pattern, ".*Invariant|.*Fork");
});

test("jsExcludeToRegExp: compiles the mirror, and refuses an unusable one", () => {
  // A broken regex must not become `new RegExp(undefined)`, which matches everything and
  // would exclude every suite from the documented scope while looking healthy.
  assert.equal(jsExcludeToRegExp(SCOPE).source, "Invariant|Fork");
  assert.ok(jsExcludeToRegExp(SCOPE).test("VaultInvariant"));
  assert.ok(jsExcludeToRegExp(SCOPE).test("VaultFork"));
  assert.ok(!jsExcludeToRegExp(SCOPE).test("Vault"));
  assert.throws(() => jsExcludeToRegExp({ ...SCOPE, jsExclude: "([a-z" }), /not a valid regex/);
  assert.throws(() => jsExcludeToRegExp({ ...SCOPE, jsExclude: "(?<bad" }), /not a valid regex/);
});

test("deriveJsExclude: the JS mirror is a function of unitExclude, not a fourth field", () => {
  // Each branch loses only its forge-side decoration, so adding a category to the owner
  // regenerates the mirror instead of leaving a second thing to remember.
  assert.equal(deriveJsExclude(SCOPE), "Invariant|Fork");
  assert.equal(deriveJsExclude(WIDE_SCOPE), "Invariant|Fork|Something");
  assert.equal(deriveJsExclude({ unitExclude: "^Vault.*|^Session.*" }), "Vault.*|Session.*");
  for (const bad of [undefined, null, "", 24, {}]) {
    assert.throws(() => deriveJsExclude({ ...SCOPE, unitExclude: bad }), /missing a usable/);
  }
});

// ── 5. validateScope ─────────────────────────────────────────────────────────────

test("validateScope: the real scope file is self-consistent", () => {
  const { ok, problems } = validateScope(SCOPE);
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test("validateScope: a stale jsExclude mirror is reported as the stale case", () => {
  // This is the failure the `split` severity exists for: every value is usable, only the
  // derived mirror drifted, so the gate stays green and `--write` repairs it. The message
  // must keep the word "stale" because `scopeFindings` keys the severity off that word.
  for (const stale of ["Invariant", "Invariant|Fork|Something"]) {
    const { ok, problems } = validateScope({ ...SCOPE, jsExclude: stale });
    assert.equal(ok, false);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /jsExclude is stale/);
  }
  const missing = validateScope({ ...SCOPE, jsExclude: "" });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /"jsExclude" is missing or empty/);
});

test("validateScope: an invariantMatch outside unitExclude is reported", () => {
  // The two-step PR gate gates the invariant suites and excludes the others. If
  // invariantMatch named a category unitExclude does not carry, the gate would run a suite
  // it is meant to skip and skip one it is meant to run.
  for (const [field, value] of [
    ["invariantMatch", ".*Gas"],
    ["forkMatch", ".*Bridge"],
  ]) {
    const { ok, problems } = validateScope({ ...SCOPE, [field]: value });
    assert.equal(ok, false);
    assert.match(problems.join("\n"), new RegExp(`"${field}" .* is not a branch of`));
    assert.match(problems.join("\n"), /add the category to unitExclude first/);
  }
});

test("validateScope: reports EVERY problem, not just the first", () => {
  // A guard that stopped at the first problem would turn a one-shot report into a guessing
  // game: fix one mirror, re-run, discover the next. This case breaks all three
  // consistency rules at once and asserts all three come back.
  const broken = {
    $comment: "x",
    unitExclude: ".*Invariant",
    invariantMatch: ".*Gas",
    forkMatch: ".*Bridge",
    jsExclude: "Stale",
  };
  const { ok, problems } = validateScope(broken);
  assert.equal(ok, false);
  // Three distinct problems, all reported: the stale mirror and both out-of-tree categories.
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.ok(problems.some((p) => /jsExclude is stale/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /"invariantMatch"/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /"forkMatch"/.test(p)), problems.join("\n"));
});

test("validateScope: a multi-category match field is refused", () => {
  // `forkMatch` must name exactly one category; a value listing two would make the
  // "exclude the fork suites" run depend on which half a reader looked at.
  for (const value of [".*Invariant|.*Fork", "a|b|c"]) {
    const { ok, problems } = validateScope({ ...SCOPE, forkMatch: value });
    assert.equal(ok, false, `forkMatch=${JSON.stringify(value)} must not validate`);
    assert.match(problems.join("\n"), /"forkMatch" is missing or empty|must name exactly one suite category/);
  }
  for (const value of [undefined, null, "", 24]) {
    const { ok, problems } = validateScope({ ...SCOPE, invariantMatch: value });
    assert.equal(ok, false);
    assert.match(problems.join("\n"), /is missing or empty/);
  }
});

test("validateScope: a non-object document fails closed", () => {
  for (const bad of [null, undefined, 24, "{}", true]) {
    const { ok, problems } = validateScope(bad);
    assert.equal(ok, false);
    assert.match(problems.join("\n"), /did not parse as an object|is missing or empty/);
  }
});

// ── 6. serializeScope ────────────────────────────────────────────────────────────

test("serializeScope: idempotent, with a canonical key order", () => {
  // Idempotence is what lets `--write` converge in one pass. Asserted as the algebraic
  // property — round-tripping is a fixed point — rather than on a sample, so a future key
  // added out of order still has to survive the round trip.
  const first = serializeScope(SCOPE);
  assert.equal(serializeScope(JSON.parse(first)), first);
  assert.equal(serializeScope(JSON.parse(serializeScope(JSON.parse(first)))), first);
  assert.deepEqual(
    [...first.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]),
    ["$comment", "unitExclude", "invariantMatch", "forkMatch", "jsExclude"],
  );
  assert.ok(first.endsWith("\n"), "the canonical form ends with exactly one newline");
  assert.match(first, /^\{\n {2}"\$comment"/, "two-space indent, first key first");
  // Keys written in the wrong order are normalised; an unknown key survives, after the known.
  const scrambled = {
    jsExclude: SCOPE.jsExclude,
    forkMatch: SCOPE.forkMatch,
    unitExclude: SCOPE.unitExclude,
    invariantMatch: SCOPE.invariantMatch,
    extra: 1,
  };
  const normalised = serializeScope(scrambled);
  assert.deepEqual(
    [...normalised.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]),
    ["unitExclude", "invariantMatch", "forkMatch", "jsExclude", "extra"],
    "an absent $comment is simply skipped, and unknown keys land after the canonical ones",
  );
  assert.ok(normalised.includes('"extra": 1'));
  assert.equal(serializeScope(JSON.parse(normalised)), normalised);
});

// ── 7. comment blanking ──────────────────────────────────────────────────────────

test("blankComments: preserves line count and every column offset", () => {
  // Offset preservation is load-bearing: a finding's `file:line` must stay true for the
  // ORIGINAL file even though the scan ran on a blanked copy. A dropped or shortened line
  // would shift every line number after it, and the guard's output *is* a list of lines.
  const src = [
    'import { readFileSync } from "node:fs";',
    "// prose mentioning '.*Invariant' and a URL https://example.com/x",
    "const EXCLUDED = /Invariant/; // trailing prose with https://example.com/y",
    "/**",
    " * A JSDoc block quoting `--no-match-contract '.*Fork'` in prose.",
    " */",
    'const value = "a//b";',
    "",
  ].join("\n");
  const before = src.split("\n");
  const after = blankComments(src).split("\n");
  assert.equal(after.length, before.length, "line count is preserved");
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].length, before[i].length, `line ${i + 1} width changed`);
  }
  assert.equal(blankComments(src).length, src.length, "total length is preserved");
});

test("blankComments: prose goes, code and import specifiers stay", () => {
  const src = [
    'import { a } from "./a.mjs"; // keep the specifier',
    "// a leading comment about INVARIANT",
    "const y = 2; /* inline block */ const z = 3;",
    "/*",
    " * block prose with --match-contract '.*Fork'",
    " */",
    "const w = 4;",
  ].join("\n");
  const out = blankComments(src);
  assert.ok(out.includes('"./a.mjs"'), "an import specifier is code and must survive");
  assert.ok(!/\/\/ a leading comment about INVARIANT/.test(out), "a leading comment is blanked");
  assert.ok(!/block prose with/.test(out), "block-comment prose is blanked");
  assert.ok(out.includes("const y = 2;"), "code before a block comment survives");
  assert.ok(out.includes("const z = 3;"), "code after a block comment on one line survives");
  assert.ok(out.includes("const w = 4;"), "code after a closed block comment survives");
  // The blanked regions are spaces, never deleted, so the offsets hold: `const z = 3;`
  // keeps its column on the same line even though the inline comment went blank.
  const line = out.split("\n")[2];
  assert.equal(line.length, src.split("\n")[2].length);
  assert.equal(line.indexOf("const z = 3;"), src.split("\n")[2].indexOf("const z = 3;"), "the column is unchanged");
  assert.equal(line.slice(0, line.indexOf("const z")).trim(), "const y = 2;", "the code before the comment is intact");
  assert.ok(!line.includes("inline block"), "the comment text is gone");
});

test("blankComments: a // inside a quoted string is code, not a comment", () => {
  // The `//` in a URL is the classic false positive: truncating at it would blank the rest
  // of a line that ends in a URL, and a real consumer there would be lost.
  for (const line of [
    'const url = "git+https://github.com/foundry-rs/foundry"; // trailing',
    "const url2 = 'https://example.com/a//b';",
    "// a real comment with https://example.com",
    "const t = `https://example.com/${x}//tail`;",
  ]) {
    assert.equal(blankComments(line).length, line.length, "width preserved");
  }
  assert.ok(blankComments('const u = "https://x.dev//y"; // gone').includes("https://x.dev//y"));
  assert.ok(!blankComments('const u = "https://x.dev//y"; // gone').includes("gone"));
  // An escaped quote must not close the string and re-open comment mode.
  const escaped = 'const s = "a\\"// still inside"; // cut here';
  const out = blankComments(escaped);
  assert.ok(out.includes('a\\"// still inside'), "an escaped quote does not end the string");
  assert.ok(!out.includes("cut here"), "the real comment after it is still cut");
});

test("blankComments: a glob that looks like a block comment is not one", () => {
  // Regression: a plain `/*` test treated `path: packages/*/coverage/` as a block-comment
  // opener, and every real consumer after that line — including the workflow's fork step —
  // was blanked with no error to show for it. A glob is not a comment.
  const src = ["          path: packages/*/coverage/", "      - run: forge test --match-contract '.*Fork'", ""].join("\n");
  const out = blankComments(src);
  assert.ok(out.includes("packages/*/coverage/"), "the glob survives intact");
  assert.ok(out.includes("forge test --match-contract '.*Fork'"), "the consumer below it survives");
});

// ── 8. findOccurrences ───────────────────────────────────────────────────────────

test("findOccurrences: 1-based line numbers, and comments are not matches", () => {
  // 1-based because a finding says `file:line` and a human opening the file counts from 1.
  const text = [
    "// --match-contract '.*Ghost' in a comment must not be found",
    "const first = 1;",
    "const second = /target/;",
    "/* --match-contract '.*Ghost' in a block comment */",
    "const third = /target/;",
  ].join("\n");
  const hits = findOccurrences(text, /target/g);
  assert.deepEqual(hits.map((h) => h.line), [3, 5], "1-based, and only the code lines");
  // Columns differ per line because the two code lines have different prefixes; what is
  // asserted is that the column is where the match really starts, not a fixed offset.
  assert.deepEqual(hits.map((h) => h.column), [17, 16]);
  assert.equal(text.split("\n")[2].indexOf("target") + 1, 17, "column 17 is /target on line 3");
  assert.equal(text.split("\n")[4].indexOf("target") + 1, 16, "column 16 is /target on line 5");
  assert.equal(hits[0].match, "target");
  assert.deepEqual(findOccurrences(text, /Ghost/g), [], "a commented-out pattern is not a consumer");
  assert.deepEqual(findOccurrences("", /x/g), []);
  assert.deepEqual(findOccurrences(null, /x/g), []);
  assert.deepEqual(findOccurrences("no newline at all", /nowhere/g), []);
});

test("findOccurrences: a non-global pattern is still applied globally", () => {
  // A caller that forgets the `g` flag would otherwise see only the first hit, and the
  // "a partial fix is still a failure" property would quietly become "the first fix only
  // is a failure" — the one regression this guard most needs to not have.
  const nonGlobal = findOccurrences("a a a", /a/);
  const global = findOccurrences("a a a", /a/g);
  assert.equal(nonGlobal.length, 3, "a non-global pattern is re-applied with the g flag");
  assert.deepEqual(nonGlobal.map((h) => h.column), global.map((h) => h.column));
  assert.deepEqual(findOccurrences("x a y a z", /a/), findOccurrences("x a y a z", /a/g));
});

// ── 9. the write whitelist ───────────────────────────────────────────────────────

test("isWritable: accepts exactly the four whitelisted target shapes", () => {
  // The whitelist is a list of exact in-repo targets, not a shape family. `packages/<ws>/`
  // at one level of depth is included; two levels is not, because nothing at that depth
  // holds one of the three facts and a broader rule is a broader blast radius.
  for (const ok of [
    ".nvmrc",
    "Dockerfile",
    "scripts/foundry-scope.json",
    "packages/core/package.json",
    "packages/anything/package.json",
  ]) {
    assert.equal(isWritable(ok), true, `${ok} is a whitelisted target`);
  }
  for (const no of [
    "packages/a/b/package.json",
    "packages/package.json",
    "package.json",
    "Dockerfile.dev",
    "nvmrc",
    ".nvmrc.bak",
    "scripts/verify.mjs",
    "scripts/check-doc-counts.mjs",
    "scripts/bootstrap.mjs",
  ]) {
    assert.equal(isWritable(no), false, `${no} is not a whitelisted target`);
  }
});

test("isWritable: refuses the root manifest, workflows, and every traversal attempt", () => {
  // Three that a naive "is it a .json?" rule would let through:
  //   • `package.json` — the root manifest is a source of TRUTH here; a tool that rewrites
  //     its own inputs cannot be audited afterwards.
  //   • `.github/workflows/ci.yml` — workflow content is asserted, never generated.
  //   • traversal — not representable in a list of exact targets.
  for (const no of [
    "package.json",
    ".github/workflows/ci.yml",
    ".github/workflows/other.yml",
    "../escape",
    "../escape/package.json",
    "packages/../package.json",
    "scripts/../package.json",
    "/etc/passwd",
    "/packages/core/package.json",
    "C:/repo/package.json",
    "c:\\repo\\package.json",
    "scripts\\foundry-scope.json",
    "packages//core/package.json",
    "./Dockerfile",
    ".",
    "..",
    "./",
    "",
  ]) {
    assert.equal(isWritable(no), false, `${JSON.stringify(no)} must be refused`);
  }
  for (const no of [null, undefined, 24, {}, [], true]) {
    assert.equal(isWritable(no), false, `${String(no)} must be refused`);
  }
});

// ── 10. the core: a new category propagates, and every drifted literal is named ────

test("adding a category to unitExclude propagates to the forge args and the derived mirror", () => {
  // The reason foundry-scope.json exists. `forgeScopeArgs` reads the owner directly, and
  // the JS mirror is *derivable* from it, so a contributor editing one field cannot leave
  // the rest behind. The stored `jsExclude` is deliberately still the old value here — the
  // gap between the two is precisely the staleness `--check` reports and `--write` closes.
  const [flag, pattern] = forgeScopeArgs(WIDE_SCOPE, "unit");
  assert.deepEqual([flag, pattern], ["--no-match-contract", ".*Invariant|.*Fork|.*Something"]);
  assert.equal(deriveJsExclude(WIDE_SCOPE), "Invariant|Fork|Something", "the mirror follows the owner");
  assert.notEqual(deriveJsExclude(WIDE_SCOPE), WIDE_SCOPE.jsExclude, "which is why the file is stale");
  assert.equal(jsExcludeToRegExp(WIDE_SCOPE).source, WIDE_SCOPE.jsExclude, "the consumer is checked against what is stored");
  assert.ok(new RegExp(deriveJsExclude(WIDE_SCOPE)).test("VaultSomething"));
  // `full` still widens from forkMatch, unchanged by a new exclusion category.
  assert.deepEqual(forgeScopeArgs(WIDE_SCOPE, "full"), ["--no-match-contract", ".*Fork"]);
  // Regenerating the mirror makes the two agree again — the one --write can do unaided.
  const repaired = { ...WIDE_SCOPE, jsExclude: deriveJsExclude(WIDE_SCOPE) };
  assert.deepEqual(validateScope(repaired).problems, []);
  assert.equal(jsExcludeToRegExp(repaired).source, deriveJsExclude(WIDE_SCOPE));
});

test("every drifted literal consumer is named with its exact file:line", () => {
  // The core promise. A repository built against the two-category scope is checked against
  // the three-category owner, and every hard-coded consumer must be reported at the line it
  // is actually on. A file may hold several kinds at once, so the report is one finding per
  // *kind* per file, with `occurrences` naming every line of that kind — which is why the
  // three ci.yml kinds all carry the first drifted line and differ in `expected`.
  const stale = consistentFiles(SCOPE);
  const wide = { ...stale, "scripts/foundry-scope.json": serializeScope(WIDE_SCOPE) };
  const errors = buildFindings(memIo(wide)).filter((f) => f.severity === "error");

  // Index 1 is the pattern; index 0 is the forge flag. Destructured by position because
  // the flag is asserted separately, where it matters (the fork job must *gate*).
  const [, unitPattern] = forgeScopeArgs(WIDE_SCOPE, "unit");
  const [forkFlag] = forgeScopeArgs(WIDE_SCOPE, "fork");

  // Only the consumers whose *own* field changed can drift. Adding a third category to
  // `unitExclude` widens `unitExclude` and the derived mirror, but `invariantMatch` and
  // `forkMatch` are untouched — so their steps are still correct. What is left is the unit
  // scope, which appears in three files: package.json, ci.yml and verify.mjs.
  //
  // In ci.yml the unit, invariant and fork steps are all read out of the same scan, and the
  // drifted *unit* pattern at line 10 is what every one of the three kinds reports as its
  // anchor line — the pattern it does not own is a "foreign" hit, and those are errors.
  const ci = wide[".github/workflows/ci.yml"].split("\n");
  // `package.json` holds two forge lines, and the `full` script's line is read as a
  // consumer for *both* kinds it carries: the fork pattern it owns, and the unit pattern
  // it does not (which only matches the unit line). So the `full` consumer is a drift too
  // — its `occurrences` list names both lines of the file, and the drifted one is the unit.
  const expected = [
    { file: "package.json", line: 11, fact: "forge test scope (unit)", want: unitPattern },
    { file: "package.json", line: 11, fact: "forge test scope (full)", want: ".*Fork" },
    { file: ".github/workflows/ci.yml", line: 10, fact: "forge test scope (unit)", want: unitPattern },
    { file: ".github/workflows/ci.yml", line: 10, fact: "forge test scope (invariant)", want: ".*Invariant" },
    { file: ".github/workflows/ci.yml", line: 10, fact: "forge test scope (fork)", want: ".*Fork" },
    { file: "scripts/verify.mjs", line: 2, fact: "forge test scope (unit)", want: unitPattern },
  ];
  // The JS consumer still agrees with the *stored* mirror, so it is a `split`, and the
  // owner's own mirror staleness is reported at the same time — the same root cause seen
  // from two levels up.
  const all = buildFindings(memIo(wide));
  const jsSplit = all.filter(
    (f) => f.severity === "split" && String(f.fact).startsWith("forge test scope (jsExclude)"),
  );
  assert.equal(jsSplit.length, 1, "the JS consumer is a split, not a drift");
  assert.equal(jsSplit[0].expected, WIDE_SCOPE.jsExclude, "it is compared with what the owner stores");
  assert.equal(
    errors.length,
    expected.length,
    `expected one error per drifted consumer kind, got:\n${errors.map((f) => renderFinding(f)).join("\n\n")}`,
  );
  for (const want of expected) {
    const got = errors.find((f) => f.file === want.file && f.line === want.line && f.fact === want.fact);
    assert.ok(got, `no error reported at ${want.file}:${want.line} (${want.fact})`);
    assert.equal(got.id, "scope.drift", `${want.file}:${want.line} id`);
    assert.equal(got.expected, want.want, `${want.file}:${want.line} expected pattern`);
    assert.equal(got.writable, false, `${want.file}:${want.line} is asserted, not written`);
  }
  const staleMirror = all.find((f) => f.id === "scope.stale-mirror");
  assert.ok(staleMirror, "the owner is also flagged as having a stale mirror");
  assert.equal(staleMirror.severity, "split", "a stale mirror alone is not fatal");
  // Every line the guard points at really is the consumer line it claims.
  assert.match(ci[9], /forge test --no-match-contract/);
  assert.ok(forkFlag.startsWith("--match"), "the fork job gates with --match-contract");
  assert.match(ci[12], /forge test --match-contract/);
  assert.match(ci[17], /forge test --fork-url/);
});

test("fixing every drifted consumer brings the error count to zero", () => {
  // The other half of the core promise, and the reason the drift test is not a snapshot: a
  // guard that always reports the same errors teaches its reader to ignore it. Each
  // consumer is repaired with the owner-derived pattern and the errors must disappear.
  const wide = { ...consistentFiles(SCOPE), "scripts/foundry-scope.json": serializeScope(WIDE_SCOPE) };
  const broken = buildFindings(memIo(wide)).filter((f) => f.severity === "error");
  assert.ok(broken.length > 0, "precondition: it starts broken");

  const [unitFlag, unitPattern] = forgeScopeArgs(WIDE_SCOPE, "unit");
  const [, fullPattern] = forgeScopeArgs(WIDE_SCOPE, "full");
  const [invFlag, invPattern] = forgeScopeArgs(WIDE_SCOPE, "invariant");
  const [forkFlag, forkPattern] = forgeScopeArgs(WIDE_SCOPE, "fork");
  // Inside a JSON file the pattern's quotes are backslash-escaped in the *text*, so the
  // repairs are written against the escaped spelling. Getting this wrong is exactly the
  // "no-op replace" trap a `deepEqual` on the error list then catches.
  const files = {
    ...wide,
    "package.json": wide["package.json"]
      .replace(`forge test ${unitFlag} \\".*Invariant|.*Fork\\"`, `forge test ${unitFlag} \\"${unitPattern}\\"`)
      .replace(`forge test ${unitFlag} \\".*Fork\\"`, `forge test ${unitFlag} \\"${fullPattern}\\"`),
    ".github/workflows/ci.yml": wide[".github/workflows/ci.yml"]
      .replace(`forge test ${unitFlag} '.*Invariant|.*Fork'`, `forge test ${unitFlag} '${unitPattern}'`)
      .replace(`forge test ${invFlag} '.*Invariant'`, `forge test ${invFlag} '${invPattern}'`)
      .replace(`forge test ${forkFlag} '.*Fork'`, `forge test ${forkFlag} '${forkPattern}'`),
    // The argv form spells the pattern as a plain double-quoted JS string (no shell
    // quoting, no escapes), so it is repaired with JSON.stringify — the same spelling
    // `consistentFiles` generated it with.
    "scripts/verify.mjs": wide["scripts/verify.mjs"].replace(
      `${JSON.stringify(unitFlag)}, ${JSON.stringify(".*Invariant|.*Fork")}`,
      `${JSON.stringify(unitFlag)}, ${JSON.stringify(unitPattern)}`,
    ),
    "scripts/check-doc-counts.mjs": wide["scripts/check-doc-counts.mjs"].replace(
      "/Invariant|Fork/",
      `/${deriveJsExclude(WIDE_SCOPE)}/`,
    ),
    // The owner is fixed first: the mirror and the JS consumer are both derived from it,
    // so repairing the consumers before the owner would repair them to the wrong value.
    "scripts/foundry-scope.json": serializeScope({ ...WIDE_SCOPE, jsExclude: deriveJsExclude(WIDE_SCOPE) }),
  };
  const after = buildFindings(memIo(files)).filter((f) => f.severity === "error");
  assert.deepEqual(after, [], after.map((f) => renderFinding(f)).join("\n\n"));
});

// ── 11. --check ──────────────────────────────────────────────────────────────────

test("--check: a self-consistent repository exits 0 and writes nothing", () => {
  // Zero writes, not "no drift" alone: `--check` is the mode CI runs, and a version that
  // repaired files on the way to reporting would be unreviewable in a PR diff.
  const io = memIo(consistentFiles());
  const before = new Map(io.store);
  const { code, out, err } = runMain(["--check"], io);
  assert.equal(code, 0, err + out);
  assert.equal(io.writes.length, 0, `--check wrote ${io.writes.map((w) => w.rel).join(", ")}`);
  for (const [rel, text] of before) assert.equal(io.store.get(rel), text, `${rel} was modified`);
  assert.match(out, /sync-facts OK/);
  assert.match(out, /restatement\(s\) agree with their owner/);
  assert.equal(err, "", "a clean check writes nothing to stderr");
});

test("--check: a drifted Docker base image exits 1 naming file:line, actual and expected", () => {
  // The reported detail is the deliverable: a guard that says "Dockerfile is wrong" forces
  // a human to go looking, while `Dockerfile:2` plus both versions *is* the fix.
  const io = memIo(consistentFiles(SCOPE, { docker: "22-bookworm-slim" }));
  const { code, out, err } = runMain(["--check"], io);
  assert.equal(code, 1);
  assert.equal(io.writes.length, 0);
  const docker = io.store.get("Dockerfile").split("\n");
  const firstFrom = docker.findIndex((l) => l.startsWith("FROM")) + 1;
  const lastFrom = docker.map((l, i) => (l.startsWith("FROM") ? i + 1 : 0)).filter(Boolean).pop();
  assert.ok(err.includes(`Dockerfile:${firstFrom}`), `expected Dockerfile:${firstFrom} in:\n${err}`);
  assert.ok(err.includes(`Dockerfile:${lastFrom}`), `both FROM stages must be named:\n${err}`);
  // The line in the report must be the line that actually holds the FROM.
  assert.match(docker[firstFrom - 1], /FROM node:22/, "the reported line really is the drifted FROM");
  assert.ok(err.includes("node:22"), "the actual is reported");
  assert.ok(err.includes("node:24"), "the expected is reported");
  assert.match(err, /writable: yes/, "the fixable ones say so");
  assert.equal(out, "", "errors go to stderr, so stdout stays machine-readable");
});

test("--check: a partial fix across repeated steps is still a failure", () => {
  // A workflow that runs the *same* scope in more than one job is the case a
  // first-match-only scan calls clean. `ci.yml` is given two unit steps; the contributor
  // updates one and leaves the other stale, and every step of that kind must still fail.
  const good = consistentFiles();
  const [unitFlag, unitPattern] = forgeScopeArgs(WIDE_SCOPE, "unit");
  const step = `      - run: forge test ${unitFlag} '.*Invariant|.*Fork'\n`;
  const doubled = good[".github/workflows/ci.yml"].replace(step, step + step);
  assert.equal(doubled.split(step).length - 1, 2, "precondition: the unit scope appears in two steps");
  // `String.replace` with a string needle replaces only the FIRST occurrence, so this is
  // exactly the half-done edit: step one updated, step two still carrying the old value.
  const half = {
    ...good,
    "scripts/foundry-scope.json": serializeScope(WIDE_SCOPE),
    ".github/workflows/ci.yml": doubled.replace(step, `      - run: forge test ${unitFlag} '${unitPattern}'\n`),
  };
  assert.equal(half[".github/workflows/ci.yml"].split(unitPattern).length - 1, 1, "one step was updated");
  assert.equal(half[".github/workflows/ci.yml"].split("'.*Invariant|.*Fork'").length - 1, 1, "one step is still stale");
  const errors = buildFindings(memIo(half)).filter(
    (f) => f.severity === "error" && f.fact === "forge test scope (unit)" && f.file === ".github/workflows/ci.yml",
  );
  assert.equal(errors.length, 1, `one finding per kind, not per step:\n${errors.map((f) => renderFinding(f)).join("\n")}`);
  // `line` and `actual` point at the step that is still stale, so the report names the
  // half-done edit rather than the finished half. `occurrences` lists the steps that DO
  // agree, which is the complement — together they account for every step of this kind.
  const ciLines = half[".github/workflows/ci.yml"].split("\n");
  const stepLines = ciLines
    .map((l, i) => (l.includes(`forge test ${unitFlag} `) ? i + 1 : 0))
    .filter(Boolean);
  assert.equal(stepLines.length, 2, "both steps of this kind are present");
  assert.equal(errors[0].line, stepLines[1], "the reported line is the step that is still stale");
  assert.match(ciLines[errors[0].line - 1], /\.\*Invariant\|\.\*Fork'/, "and that line really is stale");
  assert.match(String(errors[0].actual), /\.\*Invariant\|\.\*Fork/, "the stale value is quoted");
  assert.ok(!/\.\*Something/.test(String(errors[0].actual)), "the fixed value is not the one reported");
  assert.deepEqual(errors[0].occurrences, [stepLines[0]], "the agreeing step is listed alongside");
  assert.match(String(errors[0].why), /partial fix is still a failure/);

  // With every step of the kind updated *and* the other two files repaired, the check goes
  // quiet — so the previous failure was the drift, not the fixture.
  const full = {
    ...good,
    "scripts/foundry-scope.json": serializeScope(WIDE_SCOPE),
    ".github/workflows/ci.yml": doubled
      .split(step)
      .join(`      - run: forge test ${unitFlag} '${unitPattern}'\n`),
    "package.json": good["package.json"].replace(
      `forge test ${unitFlag} \\".*Invariant|.*Fork\\"`,
      `forge test ${unitFlag} \\"${unitPattern}\\"`,
    ),
    "scripts/verify.mjs": good["scripts/verify.mjs"].replace(
      `${JSON.stringify(unitFlag)}, ${JSON.stringify(".*Invariant|.*Fork")}`,
      `${JSON.stringify(unitFlag)}, ${JSON.stringify(unitPattern)}`,
    ),
  };
  const clean = buildFindings(memIo(full)).filter(
    (f) => f.severity === "error" && String(f.fact).startsWith("forge test scope ("),
  );
  assert.deepEqual(clean, [], "fixing every consumer clears the finding");
});

test("--check: a vanished consumer is reported, not silently passed", () => {
  // The guard's most important negative property. If a consumer is deleted, a scan that
  // only compares what it finds has nothing to compare and passes — the one outcome that
  // makes the whole file worthless.
  for (const [rel, marker] of [
    ["package.json", "--no-match-contract"],
    [".github/workflows/ci.yml", "forge test"],
    ["scripts/verify.mjs", "--no-match-contract"],
  ]) {
    const files = consistentFiles();
    const stripped = files[rel].split("\n").filter((l) => !l.includes(marker)).join("\n");
    const findings = buildFindings(memIo({ ...files, [rel]: stripped }));
    const missing = findings.filter((f) => f.id === "scope.consumer-missing" && f.file === rel);
    assert.ok(missing.length > 0, `${rel}: losing ${marker} must be reported as a missing consumer`);
    assert.ok(missing.every((f) => f.severity === "error"), `${rel}: a missing consumer is fatal`);
  }
  // A file that loses its EXCLUDED declaration is reported by the same id.
  const files = consistentFiles();
  const noDecl = files["scripts/check-doc-counts.mjs"].replace(/EXCLUDED\s*=/, "NOT_THE_NAME =");
  const m = buildFindings(memIo({ ...files, "scripts/check-doc-counts.mjs": noDecl })).filter(
    (f) => f.id === "scope.consumer-missing",
  );
  assert.ok(m.length > 0, "a renamed EXCLUDED declaration is a missing consumer");
  assert.equal(m[0].severity, "error");
});

test("--check: a drifted .nvmrc, workspace engine and stale mirror are all reported", () => {
  // Three different consumers, reached through three different code paths, so this doubles
  // as a check that none of those paths has gone silent.
  const files = consistentFiles(SCOPE, { nvm: "20", workspaces: ["core", "mcp"] });
  files["packages/mcp/package.json"] = files["packages/mcp/package.json"].replace(
    `"node": ">=24"`,
    `"node": ">=20"`,
  );
  files["scripts/foundry-scope.json"] = files["scripts/foundry-scope.json"].replace(
    /"jsExclude": ".*"/,
    '"jsExclude": "Invariant"',
  );
  const findings = buildFindings(memIo(files));
  const errors = findings.filter((f) => f.severity === "error");
  const ids = errors.map((f) => `${f.file}:${f.line}:${f.id}`);
  assert.ok(
    errors.some((f) => f.file === ".nvmrc" && f.id === "node-floor.drift"),
    `the .nvmrc drift must be reported:\n${ids.join("\n")}`,
  );
  assert.ok(ids.some((s) => s.startsWith("packages/mcp/package.json:")), ids.join("\n"));
  // A stale mirror is a `split`, not an error: every value is still usable.
  const stale = findings.find((f) => f.id === "scope.stale-mirror");
  assert.ok(stale, "the stale mirror is reported");
  assert.equal(stale.severity, "split", "a stale mirror alone does not fail the gate");
  assert.equal(stale.writable, true, "and --write can regenerate it");
});

// ── 12. verdict and rendering ────────────────────────────────────────────────────

test("verdict: only error is fatal; --strict also fails on split; info never fails", () => {
  // The severity contract, stated as the exit code it produces. `split` is healthy
  // duplication that should not block a PR and `info` is context; only `error`, and on
  // request `split`, are fatal.
  const mk = (severity) => ({
    severity,
    id: "x",
    file: "f",
    line: 1,
    occurrences: [],
    fact: "y",
    actual: null,
    expected: null,
    why: null,
    writable: false,
  });
  const errs = [mk("error")];
  const splits = [mk("split")];
  const infos = [mk("info")];

  assert.equal(verdict(errs).exitCode, 1);
  assert.equal(verdict(splits).exitCode, 0, "duplication alone is not a failure");
  assert.equal(verdict(infos).exitCode, 0, "info is never fatal");
  assert.equal(verdict([]).exitCode, 0);
  assert.equal(verdict(infos, { strict: true }).exitCode, 0, "info is not even fatal under --strict");
  assert.equal(verdict(splits, { strict: true }).exitCode, 1, "--strict makes duplication fatal");
  assert.equal(verdict([...splits, ...infos], { strict: true }).exitCode, 1);
  assert.equal(verdict(errs, { strict: true }).exitCode, 1);
  // The buckets are exhaustive and disjoint: every finding lands in exactly one.
  const v = verdict([...errs, ...splits, ...infos], { strict: true });
  assert.equal(v.errors.length + v.splits.length + v.infos.length, v.findings.length);
  assert.equal(v.ok, v.exitCode === 0);
  assert.equal(v.strict, true);
  assert.equal(verdict([]).strict, false, "strict defaults off");
  assert.deepEqual(SEVERITY, { error: 2, split: 1, info: 0 }, "the severity order is used for sorting");
});

test("buildFindings sorts most serious first, then by file and line", () => {
  // The order is the reading order of a report: a wall of splits must never push the one
  // error below them, and two errors in one file should be adjacent in line order.
  const files = consistentFiles(SCOPE, { nvm: "20", docker: "22-bookworm-slim" });
  const all = buildFindings(memIo(files));
  const rank = { error: 2, split: 1, info: 0 };
  for (let i = 1; i < all.length; i += 1) {
    const prev = all[i - 1];
    const cur = all[i];
    const bySeverity = rank[prev.severity] - rank[cur.severity];
    assert.ok(
      bySeverity > 0 ||
        (bySeverity === 0 && String(prev.file) <= String(cur.file)) ||
        (bySeverity === 0 && prev.file === cur.file && (prev.line ?? 0) <= (cur.line ?? 0)),
      `findings out of order at ${i}: ${prev.file}:${prev.line} then ${cur.file}:${cur.line}`,
    );
  }
  assert.equal(all[0].severity, "error", "an error leads the report");
  assert.equal(all.filter((f) => f.severity === "error").length, 3, ".nvmrc plus both Docker stages");
});

test("renderFinding: always carries a location, and actual/expected where known", () => {
  // The output is the deliverable a human acts on. A finding with no line must still name
  // the file, and a finding that knows both versions must print both.
  const withLine = renderFinding({
    severity: "error",
    id: "node-floor.drift",
    file: ".nvmrc",
    line: 1,
    fact: "node engine floor",
    actual: 20,
    expected: 24,
    why: "nvm would select a runtime the root manifest forbids",
    writable: true,
  });
  assert.match(withLine, /^\s*ERROR\s+\.nvmrc:1\s+\[node-floor\.drift\]/);
  assert.match(withLine, /actual:\s+20/);
  assert.match(withLine, /expected:\s+24/);
  assert.match(withLine, /writable:\s+yes/);
  assert.match(withLine, /fact:\s+node engine floor/);
  assert.match(withLine, /why:/);

  const noLine = renderFinding({
    severity: "error",
    id: "scope.consumer-missing",
    file: "scripts/verify.mjs",
    line: null,
    fact: "forge test scope",
    actual: null,
    expected: "a thing",
    why: "it vanished",
    writable: false,
  });
  assert.ok(noLine.includes("scripts/verify.mjs"), "the filename is present even with no line");
  assert.ok(!/:null/.test(noLine), "no `:null` leaks into the output");
  assert.match(noLine, /writable:\s+no/);
  // A finding with no actual/expected omits those lines rather than printing "null".
  const bare = renderFinding({
    severity: "info",
    id: "foundry.owner",
    file: "a.yml",
    line: 3,
    fact: "f",
    actual: null,
    expected: null,
    why: null,
    writable: false,
  });
  assert.ok(!/actual:/.test(bare), "an unknown actual is omitted, not printed as null");
  assert.ok(!/expected:/.test(bare));
  assert.ok(!/why:/.test(bare));
  // An undefined line is treated the same as null.
  assert.ok(
    renderFinding({ severity: "info", id: "i", file: "b.yml", fact: "f", writable: false }).includes("b.yml"),
  );
});

// ── 13. planning and writing ─────────────────────────────────────────────────────

test("planWrites: pure — it returns a plan and touches nothing", () => {
  // Planning and applying are separated so the blast radius can be reviewed before it
  // lands. If planning wrote anything there would be no point in the two-phase shape.
  const io = memIo(consistentFiles(SCOPE, { nvm: "20", docker: "22-bookworm-slim" }));
  const findings = buildFindings(io);
  const snapshot = new Map(io.store);
  const plan = planWrites(findings, io);
  assert.ok(plan.length > 0, "there is something to repair");
  assert.equal(io.writes.length, 0, "planning wrote nothing");
  for (const [rel, text] of snapshot) assert.equal(io.store.get(rel), text, `${rel} changed during planning`);
  for (const entry of plan) {
    assert.equal(typeof entry.before, "string");
    assert.equal(typeof entry.after, "string");
    assert.ok(entry.reason, "every planned rewrite carries a reason");
    assert.notEqual(entry.before, entry.after, "a no-op rewrite is not planned");
    assert.equal(isWritable(entry.path), true, `planned path ${entry.path} must be whitelisted`);
  }
});

test("planWrites: only the whitelisted, only-tightening targets appear", () => {
  // `.nvmrc: 20` under a floor of 24 is raised, a workspace at 20 is raised, and nothing
  // the guard cannot safely repair is ever in the plan — the workflow and the JS sources
  // are asserted only, so they must be absent from a plan built from their own errors.
  const files = consistentFiles(SCOPE, { nvm: "20", docker: "22-bookworm-slim", workspaces: ["core", "mcp"] });
  // The manifests are generated with `JSON.stringify`, so the replacement is written
  // against that spelling — a `"node": ">=24"` with no space never appears on disk, and a
  // replace that matches nothing would leave the test passing for the wrong reason.
  files["packages/mcp/package.json"] = files["packages/mcp/package.json"].replace(
    `"node": ">=24"`,
    `"node": ">=20"`,
  );
  assert.ok(files["packages/mcp/package.json"].includes(`"node": ">=20"`), "precondition: mcp drifted");
  const io = memIo(files);
  const plan = planWrites(buildFindings(io), io);
  assert.deepEqual(
    [...new Set(plan.map((e) => e.path))].sort(),
    [".nvmrc", "Dockerfile", "packages/mcp/package.json"],
  );
  for (const entry of plan) {
    assert.ok(!entry.path.includes("ci.yml"), "a workflow is never in a plan");
    assert.ok(!entry.path.endsWith(".mjs"), "JS source is never in a plan");
    assert.ok(entry.path !== "package.json", "the root manifest is never in a plan");
  }
});

test("--write: rewrites only the whitelisted targets and nothing else", () => {
  // `writes` is the whole audit trail, so it is asserted as a set: exactly the drifted
  // targets, and no byte of any other file moved.
  const files = consistentFiles(SCOPE, { nvm: "20", docker: "22-bookworm-slim" });
  const io = memIo(files);
  const before = new Map(io.store);
  const { code, out } = runMain(["--write"], io);

  assert.deepEqual(io.writes.map((w) => w.rel).sort(), [".nvmrc", "Dockerfile"], "only the drifted targets were written");
  for (const [rel, text] of before) {
    if (rel === ".nvmrc" || rel === "Dockerfile") continue;
    assert.equal(io.store.get(rel), text, `${rel} must be untouched by --write`);
  }
  assert.equal(io.store.get(".nvmrc"), "24\n");
  assert.match(io.store.get("Dockerfile"), /FROM node:24-bookworm-slim AS build/);
  assert.match(io.store.get("Dockerfile"), /FROM node:24-bookworm-slim AS runtime/);
  assert.match(out, /rewrote \.nvmrc/);
  assert.match(out, /rewrote Dockerfile/);
  assert.match(out, /GitHub Actions workflows and JS source are asserted, not written/);
  assert.equal(code, 0, `expected a clean re-verify, got:\n${out}`);
});

test("--write: does not weaken a stricter-than-owner declaration", () => {
  // The asymmetry is deliberate, and is the reason a floor can be raised without destroying
  // a deliberate choice: `.nvmrc: 26` under a floor of 24 is a human decision to test on a
  // newer runtime, and lowering it to 24 would replace that decision with a derived one.
  const io = memIo(consistentFiles(SCOPE, { nvm: "26" }));
  const nvm = buildFindings(io).find((f) => f.file === ".nvmrc");
  assert.equal(nvm.severity, "info", "stricter is reported, not as drift");
  assert.equal(nvm.id, "node-floor.stricter");
  assert.deepEqual(planWrites(buildFindings(io), io).map((e) => e.path), [], "nothing to weaken");
  runMain(["--write"], io);
  assert.equal(io.store.get(".nvmrc"), "26\n", "the stricter value survives --write");
  assert.equal(io.writes.length, 0);

  // A workspace and a Docker base newer than the floor are likewise left alone.
  const files = consistentFiles(SCOPE, { workspaces: ["core"] });
  files["packages/core/package.json"] = files["packages/core/package.json"].replace(
    `"node": ">=24"`,
    `"node": ">=26"`,
  );
  assert.deepEqual(planWrites(buildFindings(memIo(files)), memIo(files)).map((e) => e.path), []);
  assert.deepEqual(
    planWrites(buildFindings(memIo(consistentFiles(SCOPE, { docker: "26-bookworm-slim" }))), memIo(consistentFiles(SCOPE, { docker: "26-bookworm-slim" }))).map((e) => e.path),
    [],
  );
});

test("--write: regenerates a stale jsExclude mirror and touches no other line", () => {
  // The scope file is the one JSON document the guard owns end to end. The rewrite must
  // change exactly the derived value: the `$comment`, the other patterns, the indentation
  // and the trailing newline all survive byte for byte.
  const files = consistentFiles(SCOPE);
  files["scripts/foundry-scope.json"] = files["scripts/foundry-scope.json"].replace(
    /"jsExclude": ".*"/,
    '"jsExclude": "Stale"',
  );
  const io = memIo(files);
  const { code } = runMain(["--write"], io);
  assert.deepEqual(io.writes.map((w) => w.rel), ["scripts/foundry-scope.json"]);
  const after = io.store.get("scripts/foundry-scope.json");
  assert.equal(after, serializeScope(SCOPE), "the file is back to the canonical serialization");
  assert.match(after, /"jsExclude": "Invariant\|Fork"/);
  assert.ok(after.includes(SCOPE.$comment), "the comment field is preserved");
  assert.equal(code, 0, "regenerating the mirror clears the only finding");
  for (const [rel, text] of Object.entries(files)) {
    if (rel === "scripts/foundry-scope.json") continue;
    assert.equal(io.store.get(rel), text, `${rel} must be untouched`);
  }
});

test("--write: is idempotent — a second pass changes no bytes at all", () => {
  // Idempotence is what makes the mode safe to run in a pre-commit hook: a first pass
  // repairs, and every subsequent pass must write nothing and say so.
  const files = consistentFiles(SCOPE, { nvm: "20", docker: "22-bookworm-slim" });
  files["scripts/foundry-scope.json"] = files["scripts/foundry-scope.json"].replace(
    /"jsExclude": ".*"/,
    '"jsExclude": "Stale"',
  );
  const io = memIo(files);
  runMain(["--write"], io);
  const afterFirst = new Map(io.store);
  const firstWrites = io.writes.length;
  assert.ok(firstWrites > 0, "precondition: the first pass had work to do");

  const second = runMain(["--write"], io);
  assert.equal(io.writes.length, firstWrites, "the second pass wrote nothing");
  for (const [rel, text] of afterFirst) assert.equal(io.store.get(rel), text, `${rel} changed on the second pass`);
  assert.match(second.out, /--write changed nothing/);
  assert.equal(second.code, 0);
  // A third pass, for good measure: a fixed point, not merely "converged once".
  runMain(["--write"], io);
  assert.equal(io.writes.length, firstWrites);
});

test("applyWrite: re-checks the whitelist and refuses a plan built from bad data", () => {
  // A plan is data. The second whitelist check is not redundancy — it is what stops a
  // malformed plan (a consumer added with a bad path, a bug in a rewrite rule) from
  // becoming a script that edits a file it has no business touching. It must throw BEFORE
  // the first write, not after the last one.
  for (const path of [
    "package.json",
    ".github/workflows/ci.yml",
    "../outside.json",
    "/etc/passwd",
    "C:/x.json",
    "scripts/verify.mjs",
  ]) {
    const io = memIo(consistentFiles());
    assert.throws(
      () => applyWrite([{ path, before: "a", after: "b", reason: "malicious" }], io),
      /refusing to write outside the whitelist/,
      `${path} must be refused`,
    );
    assert.equal(io.writes.length, 0, `${path}: nothing may be written, not even the legal entries`);
  }
  // A mixed plan still aborts the whole batch, atomically.
  const io = memIo(consistentFiles(SCOPE, { nvm: "20" }));
  const legal = { path: ".nvmrc", before: io.store.get(".nvmrc"), after: "24\n", reason: "ok" };
  const illegal = { path: "package.json", before: "x", after: "y", reason: "no" };
  assert.throws(() => applyWrite([legal, illegal], io), /refusing to write outside the whitelist/);
  assert.equal(io.writes.length, 0, "the legal entry before the illegal one is not written either");
  assert.equal(io.store.get(".nvmrc"), "20\n", "and the file is unchanged on disk");
});

test("applyWrite: refuses a file that changed after the plan was built", () => {
  // The plan carries the exact bytes it was built from. If the file moved underneath — a
  // concurrent formatter, a merge, another tool — overwriting it would destroy work this
  // run never read, so the write fails loudly instead.
  const io = memIo(consistentFiles(SCOPE, { nvm: "20" }));
  const plan = planWrites(buildFindings(io), io);
  assert.ok(plan.length > 0, "precondition: something to write");
  const target = plan[0].path;
  io.store.set(target, "26\n");
  assert.throws(
    () => applyWrite(plan, io),
    new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} changed since the plan was built`),
  );
  assert.equal(io.writes.length, 0, "nothing is written when the plan is stale");
  assert.equal(io.store.get(target), "26\n", "the newer value is preserved, not clobbered");
});

test("applyWrite: an entry already at its target reports changed:false and writes nothing", () => {
  // The re-verify step after a --write depends on this: a plan entry whose `after` already
  // matches the file is a no-op, and reporting it as a change would make --write look like
  // it did work it did not do. The `before` must match disk too, so the plan is built
  // *after* the file already holds the target value — otherwise the run would (correctly)
  // treat it as a concurrent edit, which is the other test and the other error.
  const io = memIo(consistentFiles(SCOPE, { nvm: "24" }));
  const plan = [
    { path: ".nvmrc", before: io.store.get(".nvmrc"), after: "24\n", reason: "already at the floor" },
  ];
  assert.equal(plan[0].before, plan[0].after, "precondition: the file is already at its target");
  const applied = applyWrite(plan, io);
  assert.deepEqual(applied, [{ path: ".nvmrc", changed: false }]);
  assert.equal(io.writes.length, 0, "a no-op entry writes nothing");
  assert.equal(io.store.get(".nvmrc"), "24\n", "and the file is untouched");
  // A repaired tree plans nothing further, which is what makes `--write` idempotent.
  assert.deepEqual(planWrites(buildFindings(io), io), [], "a repaired tree has nothing left to do");
  // An empty plan is a valid, silent no-op.
  assert.deepEqual(applyWrite([], io), []);
  assert.equal(io.writes.length, 0);
});

// ── 14. the real CLI against a throwaway root ────────────────────────────────────

test("CLI against a temp root: --check is 0, --write changes nothing, --list names the facts", () => {
  // Drives the real `makeIo` and the real argument parser against a real directory,
  // because the in-memory io cannot catch a path-joining bug, a missing parent directory or
  // an argument the parser rejects. The root is a temp dir, so the working tree is at risk
  // never.
  const root = tempRoot(consistentFiles());
  try {
    const run = (...args) =>
      spawnSync(process.execPath, ["scripts/sync-facts.mjs", ...args, `--root=${root}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    const check = run("--check");
    assert.ifError(check.error);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /sync-facts OK/);

    // Already consistent, so --write must report that it changed nothing.
    const write = run("--write");
    assert.ifError(write.error);
    assert.equal(write.status, 0, write.stdout + write.stderr);
    assert.match(write.stdout, /--write changed nothing/);
    assert.ok(!/rewrote /.test(write.stdout), "nothing should have been rewritten");

    // --list groups the restatement points under the facts they belong to.
    const list = run("--list");
    assert.ifError(list.error);
    assert.equal(list.status, 0, list.stdout + list.stderr);
    assert.match(list.stdout, /node engine floor/);
    assert.match(list.stdout, /forge test scope/);
    assert.match(list.stdout, /foundry version/);

    // --json is machine-readable and carries the counts.
    const json = run("--json");
    assert.ifError(json.error);
    const parsed = JSON.parse(json.stdout.replace(/^\uFEFF/, ""));
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed.counts).sort(), ["error", "info", "split"]);
    assert.equal(parsed.counts.error, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI against a temp root: an unknown argument exits 2, and --write/--list are exclusive", () => {
  // Exit 2 is "this invocation was wrong", distinct from exit 1 "your repository is wrong",
  // so a CI job can tell a bad command from a failing gate.
  const root = tempRoot(consistentFiles());
  try {
    const run = (...args) =>
      spawnSync(process.execPath, ["scripts/sync-facts.mjs", ...args, `--root=${root}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    const bad = run("--nonsense");
    assert.ifError(bad.error);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unrecognized argument "--nonsense"/);
    assert.match(bad.stderr, /usage: sync-facts/);

    const exclusive = run("--write", "--list");
    assert.equal(exclusive.status, 2, "a run that both wrote and listed would have unparseable stdout");
    assert.match(exclusive.stderr, /mutually exclusive/);

    const emptyRoot = spawnSync(process.execPath, ["scripts/sync-facts.mjs", "--root="], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(emptyRoot.status, 2);
    assert.match(emptyRoot.stderr, /--root= needs a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI against a temp root: --strict turns duplication into a failure, and says so", () => {
  // Proves the flag reaches the verdict rather than being parsed and ignored, using a
  // repository that is self-consistent but duplicated. The message matters as much as the
  // exit code: a run that exits 1 while printing "sync-facts OK" is a gate that lies.
  const root = tempRoot(consistentFiles());
  try {
    const run = (...args) =>
      spawnSync(process.execPath, ["scripts/sync-facts.mjs", ...args, `--root=${root}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    const plain = run("--check");
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /sync-facts OK/);
    const strict = run("--check", "--strict");
    assert.equal(strict.status, 1, "duplication is fatal only when asked for");
    assert.ok(!/sync-facts OK/.test(strict.stdout), "a failing strict run must not claim OK");
    assert.match(strict.stderr, /sync-facts: .*restatement\(s\) duplicated under --strict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main: bad flags exit 2, no flags defaults to --check, and nothing is written", () => {
  // The in-memory io is used here purely as "a repository that exists", so the assertions
  // are about argument handling rather than about findings.
  const io = memIo(consistentFiles());
  const bad = runMain(["--verbose"], io);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unrecognized argument/);
  assert.equal(bad.out, "");
  assert.equal(io.writes.length, 0);
  assert.equal(runMain(["--write", "--list"], io).code, 2);
  const dflt = runMain([], io);
  assert.equal(dflt.code, 0, "no flags defaults to --check");
  assert.match(dflt.out, /sync-facts OK/);
  assert.equal(io.writes.length, 0);
});

test("main: --json output parses and reflects the findings exactly", () => {
  // `--json` is the machine surface, so it has to agree with the human one: the counts in
  // the payload must be derivable from the findings it carries.
  const io = memIo(consistentFiles(SCOPE, { nvm: "20" }));
  const { code, out } = runMain(["--json"], io);
  const payload = JSON.parse(out.replace(/^\uFEFF/, ""));
  const bySeverity = (s) => payload.findings.filter((f) => f.severity === s).length;
  assert.equal(payload.counts.error, bySeverity("error"));
  assert.equal(payload.counts.split, bySeverity("split"));
  assert.equal(payload.counts.info, bySeverity("info"));
  assert.equal(payload.ok, code === 0);
  assert.equal(payload.strict, false);
  assert.ok(payload.findings.length > 0);
  for (const f of payload.findings) {
    assert.ok("severity" in f && "id" in f && "file" in f, "every finding is fully shaped");
  }
  assert.equal(io.writes.length, 0, "--json never writes");
});

// ── 15. the real repository, read-only ───────────────────────────────────────────

test("real repository: --check reports no errors — the fragile parse is gone, and never writes", () => {
  // Read-only against the actual checkout, and read-only *by construction*: `write` is
  // replaced with a thrower, so if a future change starts rewriting the working tree during
  // a check, this test fails instead of quietly editing the repository.
  //
  // INVERTED 2026-09-26. This assertion used to be `errors === ["node-floor.fragile-parse"]`:
  // it pinned the *presence* of a known defect, so fixing the defect turned the test red and
  // invited someone to "restore" the bug. `scripts/bootstrap.mjs` now calls
  // `parseEngineFloor()` (which refuses a range it cannot read instead of guessing), and the
  // guard is clean. Asserting "no errors" is the stronger claim: it fails both if the parse
  // regresses to a digit-slice AND if any other consumer drifts.
  //
  // This is not vacuous. The paired test below re-introduces the exact digit-slice expression
  // into a fixture and proves this same finding fires — so an empty `errors` here means "the
  // defect is absent", not "the scan is blind".
  const realIo = makeIo(REPO_ROOT);
  const io = {
    ...realIo,
    write: () => {
      throw new Error("the real repository must not be written by a check");
    },
  };
  const findings = buildFindings(io);
  const errors = findings.filter((f) => f.severity === "error");
  const splits = findings.filter((f) => f.severity === "split");
  const infos = findings.filter((f) => f.severity === "info");

  assert.deepEqual(
    errors,
    [],
    `the real tree must report no errors; got:\n${errors.map((f) => renderFinding(f)).join("\n\n")}`,
  );
  // Stated separately from the empty-array assertion so a regression names the cause instead
  // of only dumping a diff. A reintroduced digit-slice is the expected way to fail here.
  assert.ok(
    !findings.some((f) => f.id === "node-floor.fragile-parse"),
    "scripts/bootstrap.mjs must not carry the digit-slice parse any more: it reads \">=100\" as 10",
  );

  // Every remaining finding is duplication or context, never a wrong value.
  assert.ok(splits.length > 0, "the tree has restatement points");
  assert.equal(infos.length, 1, "only the foundry owner is context");
  assert.equal(infos[0].id, "foundry.owner");

  // The 7 scope consumers are all reported, so the duplication is visible and owned.
  const scopeFindings = splits.filter((f) => String(f.fact).startsWith("forge test scope"));
  assert.equal(
    scopeFindings.length,
    7,
    `all 7 scope consumers are restatements:\n${scopeFindings.map((f) => `${f.file}:${f.line} (${f.fact})`).join("\n")}`,
  );
  const byFact = new Map();
  for (const f of scopeFindings) byFact.set(f.fact, (byFact.get(f.fact) ?? 0) + 1);
  assert.deepEqual(
    [...byFact.entries()].sort(),
    [
      ["forge test scope (fork)", 1],
      ["forge test scope (full)", 1],
      ["forge test scope (invariant)", 1],
      ["forge test scope (jsExclude)", 1],
      ["forge test scope (unit)", 3],
    ],
    "unit is restated in package.json, ci.yml and verify.mjs; the rest once each",
  );
  for (const f of scopeFindings) {
    assert.equal(f.expected, SCOPE[f.fact.replace("forge test scope (", "").replace(")", "")] ?? f.expected);
  }

  // The `--check` path on the real tree agrees with buildFindings and writes nothing.
  const check = runMain(["--check"], io);
  assert.equal(check.code, 0, "no errors means a clean exit 0");
  assert.match(check.out, /sync-facts OK/, "a clean check says so on stdout");
  assert.doesNotMatch(
    check.err,
    /node-floor\.fragile-parse/,
    "a clean check must not print an error to stderr",
  );

  // `--json` over the real tree parses and reports the same counts.
  const json = runMain(["--json"], io);
  const payload = JSON.parse(json.out.replace(/^\uFEFF/, ""));
  assert.equal(payload.ok, true, "no errors means ok:true");
  assert.equal(payload.counts.error, 0);
  assert.equal(payload.counts.split, splits.length);
  assert.equal(payload.counts.info, 1);
});

/**
 * The non-vacuity control for the test above.
 *
 * An assertion of "no errors" is only worth something if the scan can still produce one. This
 * plants the *exact* legacy expression the guard looks for into an otherwise self-consistent
 * fixture and asserts the finding comes back — so the empty `errors` in the real-tree test
 * means "the defect is absent", not "the guard stopped looking".
 *
 * The expression is a copy of the historical `bootstrap.mjs` line rather than a hand-written
 * paraphrase, because the guard matches it as a literal source pattern
 * (`/\.replace\(\/\[\^0-9\]\/g[ \t]*,[ \t]*""\)\.slice\(0[ \t]*,[ \t]*2\)/g`): a paraphrase would
 * not match, and the control would pass for the wrong reason.
 */
const LEGACY_DIGIT_SLICE_LINE =
  'const REQUIRED_NODE_MAJOR = Number((pkg.engines?.node ?? ">=24").replace(/[^0-9]/g, "").slice(0, 2)) || 24;';

test("control: the digit-slice expression still trips node-floor.fragile-parse, so the clean-tree assertion can fail", () => {
  // A fixture whose every other fact agrees, plus exactly one legacy line in bootstrap.mjs.
  const files = consistentFiles();
  files["scripts/bootstrap.mjs"] = [
    'import { readFileSync } from "node:fs";',
    "",
    LEGACY_DIGIT_SLICE_LINE,
    "",
  ].join("\n");

  const findings = buildFindings(memIo(files));
  const fragile = findings.filter((f) => f.id === "node-floor.fragile-parse");

  assert.equal(fragile.length, 1, `the planted line must be reported exactly once, got:\n${findings.map((f) => renderFinding(f)).join("\n\n")}`);
  const [hit] = fragile;
  assert.equal(hit.severity, "error", "a fragile parse is an error, so it fails the check");
  assert.equal(hit.file, "scripts/bootstrap.mjs");
  assert.ok(hit.line !== null && hit.line > 0, "it is reported at a real line");
  assert.equal(hit.writable, false, "JS source is asserted, never written");
  assert.match(String(hit.actual), /10 for a three-digit major/, "the counter-example quoted is the real one");

  // And the same fixture *without* the legacy line is clean — so the finding above is caused
  // by that line and not by the fixture. Without this pair the control could pass for the
  // wrong reason: a fixture that is dirty for some unrelated reason.
  const clean = buildFindings(memIo(consistentFiles()));
  assert.deepEqual(
    clean.filter((f) => f.severity === "error"),
    [],
    "the same fixture without the legacy line has no errors, so the finding is caused by that line",
  );
});
