#!/usr/bin/env node
/**
 * Cross-file fact-source guard: three facts, one owner each, every restatement asserted.
 *
 *   node scripts/sync-facts.mjs              # --check (default)
 *   node scripts/sync-facts.mjs --check      # same
 *   node scripts/sync-facts.mjs --strict     # also red on `split` (healthy duplication)
 *   node scripts/sync-facts.mjs --write      # repair the whitelisted targets, then re-verify
 *   node scripts/sync-facts.mjs --list       # every restatement point, grouped by fact
 *   node scripts/sync-facts.mjs --json       # machine-readable report
 *   node scripts/sync-facts.mjs --root=<dir> # inspect another checkout
 *
 * ── THE THREE FACTS AND THEIR OWNERS ────────────────────────────────────────────
 *
 *   node engine floor   owner  package.json → engines.node   (e.g. ">=24" → 24)
 *   forge test scope    owner  scripts/foundry-scope.json    (unitExclude et al.)
 *   foundry version     owner  .github/workflows/ci.yml → env.FOUNDRY_VERSION
 *
 * Every other place that states one of these is a *restatement*. This script finds
 * them, decides whether each agrees, and refuses to let a disagreement pass silently.
 *
 * ── SEVERITY ────────────────────────────────────────────────────────────────────
 *
 *   error  a consumer is WRONG, or is FRAGILE. Fails the check (exit 1).
 *   split  a consumer's value is RIGHT, but the fact is duplicated there. Reported
 *          always; red only under --strict. Duplication is not itself a bug — the
 *          point is that it is now *visible* and has one named owner.
 *   info   context: the owner itself, a missing consumer, a stricter-than-expected
 *          declaration. Never affects the exit code.
 *
 * `error` covers fragility on purpose. Value drift in these consumers fails loudly
 * somewhere else (npm refuses to install, Docker pulls the wrong base, forge runs the
 * wrong suites). The digit-slice parse in bootstrap.mjs is the one place where a wrong
 * answer is *indistinguishable from a right one* until the major version reaches three
 * digits — so it is an error today, while its value is still correct.
 *
 * ── WHAT `--write` CAN AND CANNOT DO  (read before trusting a green --write) ─────
 *
 * `--write` rewrites exactly four kinds of target, and nothing else:
 *
 *   .nvmrc                              the bare major
 *   Dockerfile                          each `node:<major>` in a FROM
 *   packages/<ws>/package.json          engines.node, whitespace/indent preserved
 *   scripts/foundry-scope.json          the derived `jsExclude` field only
 *
 * It then re-checks its own whitelist (applyWrite) so a plan built from bad data
 * cannot escape, and re-verifies, so a rewrite is only a success if the drift is gone.
 *
 * IT DOES NOT TOUCH, AND CANNOT:
 *
 *   • GitHub Actions workflows. A workflow's `env:` block resolves expressions at
 *     dispatch time; it cannot read a JSON file out of the repository. ci.yml is
 *     therefore ASSERT-ONLY. `--check` names the exact file:line of every exclude step
 *     that has drifted; a human edits it. This is a property of the platform.
 *   • JavaScript source (verify.mjs, check-doc-counts.mjs). These SHOULD read the
 *     scope at runtime — that is the fix for the duplication half of the problem, and
 *     it is a code change, so it is asserted and left to a human.
 *   • The root package.json. It is a source of truth, not a restatement; a script that
 *     rewrites its own inputs cannot be audited.
 *
 * Those three cases are why only 2 of the scope consumers can be made to auto-follow a
 * JSON edit and 5 cannot. The guard's job is to make the 5 impossible to forget.
 *
 * Everything below the I/O boundary is pure and exported; the test file drives all of
 * it against in-memory fixtures. This script only runs when invoked directly.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseNodeFloor } from "./check-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = "usage: sync-facts [--check] [--write] [--list] [--strict] [--json] [--root=<dir>]";

/** Severity levels, most to least serious. */
export const SEVERITY = { error: 2, split: 1, info: 0 };

// ── 1. strict engine-floor parsing ──────────────────────────────────────────────

/**
 * Range shapes this parser accepts. A floor must be ONE simple lower-bound version:
 * an optional range operator, then a dotted numeric version, then end of string.
 *
 * The `$` and `^\s*` are the entire point. An unanchored match (what
 * `check-runtime.mjs` uses, and what is correct *there* — that function reports a
 * floor, it does not police one) silently accepts ">= 24 < 26" as 24 and "lts/*" as
 * the DEFAULT_FLOOR 24 with `specified: false`. A guard that guesses is worse than a
 * guard that refuses: the guess is indistinguishable from a real reading downstream.
 */
const STRICT_FLOOR = /^\s*(?:>=|\^|~|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/;

/** Operators semver treats as a lower bound rather than a locked version. */
const FROZEN_OPS = new Set(["^", "~"]);

/**
 * Parses an `engines.node` range into its numeric floor, or throws.
 *
 * Accepts: ">=24", ">=24.1.0", "^24.0.0", "~24.1", "24", "  >=24  ", ">=100".
 * Rejects: "lts/*", "24.x", ">= 24 < 26", "", null, undefined, non-strings.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, raw: string}}
 */
export function parseEngineFloor(value) {
  if (value === null || value === undefined) {
    throw new Error("engines.node is absent; a floor cannot be assumed (defaulting is a guess, not a reading)");
  }
  if (typeof value !== "string") {
    throw new Error(`engines.node must be a string, got ${typeof value}`);
  }
  const match = STRICT_FLOOR.exec(value);
  if (!match) {
    throw new Error(
      `engines.node ${JSON.stringify(value)} is not a single simple floor (e.g. ">=24", "^24.1.0"); ` +
        'ranges like "lts/*", "24.x" and ">= 24 < 26" are refused rather than guessed at',
    );
  }
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major) || major <= 0) {
    throw new Error(`engines.node ${JSON.stringify(value)} has a non-positive major version`);
  }
  return { major, minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), raw: value };
}

/**
 * The legacy digit-slice parse, kept ONLY so a test can falsify it.
 *
 * This is verbatim the shape of `scripts/bootstrap.mjs`
 * (`Number(node.replace(/[^0-9]/g, "").slice(0, 2)) || 24`). It is wrong and is not used
 * to decide anything: it concatenates every digit in the string and then keeps the
 * first two, so a three-digit major is silently truncated — ">=100" → "10" → 10.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function legacyDigitSliceFloor(value) {
  return Number(String(value ?? "").replace(/[^0-9]/g, "").slice(0, 2)) || 24;
}

/** Coerces a floor-ish value to `[major, minor, patch]`, or `null` if unreadable. */
function toTriple(value) {
  if (Array.isArray(value) && value.length >= 1) {
    return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)];
  }
  if (typeof value === "number" && Number.isFinite(value)) return [value, 0, 0];
  if (value && typeof value === "object" && Number.isFinite(value.major)) {
    return [value.major, value.minor ?? 0, value.patch ?? 0];
  }
  if (typeof value === "string") {
    try {
      const floor = parseEngineFloor(value);
      return [floor.major, floor.minor, floor.patch];
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Orders two floors. Pure.
 *
 * @returns {"lower"|"equal"|"higher"|"unknown"} how `actual` sits relative to `expected`
 */
export function compareFloors(actual, expected) {
  const a = toTriple(actual);
  const b = toTriple(expected);
  if (!a || !b) return "unknown";
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return "higher";
    if (a[i] < b[i]) return "lower";
  }
  return "equal";
}

// ── 2. the forge scope file ─────────────────────────────────────────────────────

/** The four forge invocations the scope file parameterises. */
const SCOPE_FIELDS = {
  unit: { field: "unitExclude", mode: "--no-match-contract" },
  full: { field: "forkMatch", mode: "--no-match-contract" },
  invariant: { field: "invariantMatch", mode: "--match-contract" },
  fork: { field: "forkMatch", mode: "--match-contract" },
};

/** Canonical key order, so serialization is a stable, idempotent function. */
const SCOPE_KEYS = ["$comment", "unitExclude", "invariantMatch", "forkMatch", "jsExclude"];

/**
 * The scope field and forge flag a given kind reads.
 *
 * `full` deserves a note: `npm run test:full` is the *wide* scope — it runs the
 * invariant suites and excludes only the fork ones, which is why it reads `forkMatch`
 * rather than `unitExclude`. Reading it from the wrong field would silently narrow the
 * command it is supposed to widen.
 *
 * @throws when `kind` is not one of the four — an unknown kind returns nothing, never
 *   an unfiltered argument list, because "run everything" is never the safe default.
 */
export function extractScopePair(scope, kind) {
  const entry = Object.hasOwn(SCOPE_FIELDS, kind) ? SCOPE_FIELDS[kind] : undefined;
  if (entry === undefined) {
    throw new Error(
      `unknown forge scope kind ${JSON.stringify(kind)}; expected one of ${Object.keys(SCOPE_FIELDS).join(", ")}`,
    );
  }
  const pattern = scope?.[entry.field];
  if (typeof pattern !== "string" || pattern === "") {
    throw new Error(`foundry-scope.json is missing a usable "${entry.field}" for kind "${kind}"`);
  }
  return { field: entry.field, mode: entry.mode, pattern };
}

/**
 * The `forge test` argument pair for one scope kind.
 *
 * @throws on an unknown kind, and on a missing scope field.
 * @returns {string[]} exactly two elements — `[flag, pattern]`
 */
export function forgeScopeArgs(scope, kind) {
  const pair = extractScopePair(scope, kind);
  return [pair.mode, pair.pattern];
}

/**
 * The JS-side mirror, for `check-doc-counts.mjs`'s `EXCLUDED`.
 *
 * Unanchored on purpose: that consumer calls `re.test(contractName)`, where the name
 * is a whole suite identifier and a leading anchor would match nothing.
 *
 * @throws when the stored pattern does not compile — a broken regex must not become
 *   `new RegExp(undefined)`, which silently matches everything.
 */
export function jsExcludeToRegExp(scope) {
  const source = scope?.jsExclude;
  if (typeof source !== "string" || source === "") {
    throw new Error('foundry-scope.json is missing a usable "jsExclude"');
  }
  try {
    return new RegExp(source);
  } catch (err) {
    throw new Error(`foundry-scope.json jsExclude ${JSON.stringify(source)} is not a valid regex: ${err.message}`);
  }
}

/**
 * Derives the JS mirror from `unitExclude`, which is the field a new category is added
 * to. Each branch loses its forge-side decoration (`^`, `.*`) and nothing else, so the
 * mirror is a function of the owner rather than a fourth thing to remember.
 */
export function deriveJsExclude(scope) {
  const unit = scope?.unitExclude;
  if (typeof unit !== "string" || unit === "") {
    throw new Error('foundry-scope.json is missing a usable "unitExclude"');
  }
  return unit
    .split("|")
    .map((branch) => branch.replace(/^\^/, "").replace(/^\.\*/, ""))
    .join("|");
}

/**
 * Internal consistency of the scope file itself.
 *
 * Two failure modes, both of which have been silent until now:
 *   1. `jsExclude` is stale — a category was added to `unitExclude` and the mirror was
 *      not regenerated, so the PR-gated scope and the documented scope disagree.
 *   2. `invariantMatch` is not one of `unitExclude`'s branches — the two-step jobs
 *      would then gate a suite the PR gate does not exclude, or exclude one it gates.
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateScope(scope) {
  const problems = [];
  const branches = (pattern) =>
    String(pattern ?? "").split("|").map((b) => b.trim()).filter((b) => b !== "");

  if (scope === null || typeof scope !== "object") {
    return { ok: false, problems: ["foundry-scope.json did not parse as an object"] };
  }
  for (const field of ["unitExclude", "invariantMatch", "forkMatch", "jsExclude"]) {
    if (typeof scope[field] !== "string" || scope[field] === "") {
      problems.push(`foundry-scope.json: "${field}" is missing or empty`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  let expectedMirror;
  try {
    expectedMirror = deriveJsExclude(scope);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
  if (scope.jsExclude !== expectedMirror) {
    problems.push(
      `foundry-scope.json: jsExclude is stale — says ${JSON.stringify(scope.jsExclude)}, ` +
        `derived from unitExclude it is ${JSON.stringify(expectedMirror)} (run --write)`,
    );
  }

  const unitBranches = branches(scope.unitExclude);
  for (const field of ["invariantMatch", "forkMatch"]) {
    const value = branches(scope[field]);
    if (value.length !== 1) {
      problems.push(`foundry-scope.json: "${field}" must name exactly one suite category, got ${value.length}`);
      continue;
    }
    if (!unitBranches.includes(value[0])) {
      problems.push(
        `foundry-scope.json: "${field}" (${JSON.stringify(value[0])}) is not a branch of ` +
          `unitExclude (${JSON.stringify(unitBranches)}); add the category to unitExclude first`,
      );
    }
  }
  try {
    jsExcludeToRegExp(scope);
  } catch (err) {
    problems.push(err.message);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The canonical on-disk form: fixed key order, two-space indent, trailing newline.
 * Idempotent by construction — re-serializing a parsed document reproduces it byte for
 * byte, so `--write` converges in one pass and a second pass is a no-op.
 */
export function serializeScope(scope) {
  const ordered = {};
  for (const key of SCOPE_KEYS) {
    if (scope[key] !== undefined) ordered[key] = scope[key];
  }
  for (const key of Object.keys(scope)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = scope[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ── 3. comment blanking and occurrence finding ───────────────────────────────────

/** A JS import/export line: code, and the link that attributes an occurrence to a file. */
const JS_IMPORT = /^\s*(?:import|export)\b[^;]*\bfrom\s*["']/;

/**
 * Replaces prose with spaces, preserving every offset.
 *
 * Three properties the scan depends on:
 *   • line count and column positions are unchanged, so a finding's `file:line` stays
 *     true for the *original* file even though the scan ran on the blanked copy;
 *   • prose is blanked, so a comment that mentions `.*Invariant|.*Fork` is never
 *     counted as a consumer;
 *   • import/export specifiers survive, because they are code.
 *
 * Quote-aware: `"git+https://…"` keeps its `//`, so a URL is not mistaken for a
 * comment and truncated.
 *
 * Block comments are followed across lines, because a JSDoc block that *mentions* an
 * exclusion pattern is prose like any other: `verify.mjs` documented exactly why it
 * avoids a shell, quoted the pattern in the explanation, and a `//`-only scan counted
 * that sentence as the code consumer while missing the real argv two hundred lines below.
 */
export function blankComments(text) {
  const out = [];
  let inBlock = false;
  for (const line of String(text ?? "").split("\n")) {
    if (!inBlock && JS_IMPORT.test(line)) {
      out.push(line);
      continue;
    }
    const blanked = blankFrom(line, 0, inBlock);
    inBlock = blanked.inBlock;
    out.push(blanked.text);
  }
  return out.join("\n");
}

/**
 * Blanks one line from `start`, honouring quote state and block-comment state. Returns the
 * blanked line plus the block state to carry into the next line, and never changes the
 * line's length — that length is what keeps a reported `file:line` true for the original.
 */
function blankFrom(line, start, inBlock) {
  let out = line.slice(0, start);
  let quote = null;
  let blocked = inBlock;
  for (let i = start; i < line.length; i += 1) {
    if (blocked) {
      if (line.startsWith("*/", i)) {
        out += "  ";
        i += 1;
        blocked = false;
      } else {
        out += " ";
      }
      continue;
    }
    const ch = line[i];
    if (quote !== null) {
      out += ch;
      // An escaped quote does not close the string: `'a\'b'` must not end at the `\'`.
      if (ch === "\\" && i + 1 < line.length) {
        out += line[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if ((ch === "/" && line[i + 1] === "/") || ch === "#") {
      out += " ".repeat(line.length - i);
      return { text: out, inBlock: false };
    }
    // Only a JSDoc-style opener *starts a comment* here: the slash must be preceded by
    // nothing, or by a `*` (a `/**` block), and must not sit inside a path or a glob. A
    // naive `/*` test swallows `packages/*/coverage/` — a glob in ci.yml's artifact path —
    // and every real consumer below it with it, which is how the fork job's
    // `--match-contract '.*Fork'` disappeared from the report without any error to show.
    const opener = line.startsWith("/**", i) || line.startsWith("/*", i);
    if (opener && (i === 0 || /[\s{,;=(]/.test(line[i - 1]))) {
      out += "  ";
      i += 1;
      blocked = true;
      continue;
    }
    out += ch;
  }
  return { text: out, inBlock: blocked };
}

/**
 * Every match of `pattern` in `text`, 1-based, on the comment-blanked copy.
 * @returns {{line: number, column: number, match: string, groups: string[]}[]}
 */
export function findOccurrences(text, pattern) {
  const source = blankComments(text);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out = [];
  for (const m of source.matchAll(re)) {
    const before = source.slice(0, m.index);
    out.push({
      line: before.split("\n").length,
      column: m.index - before.lastIndexOf("\n"),
      match: m[0],
      groups: m.slice(1),
    });
  }
  return out;
}

/**
 * Matches a forge suite filter in every surface syntax this repository actually uses, in
 * priority order — argv element, then double-quoted, single-quoted, backslash-escaped
 * (JSON), then bare. The order is the whole contract: a bare-token rule tried first would
 * swallow the `", "` between an argv flag and its value, and an escaped-quote rule tried
 * after a plain one would never be reached.
 *
 * The argv branch allows the flag's own closing quote and *no* space before the comma
 * (`"--no-match-contract", "…"`), which is how `verify.mjs` spells it; demanding
 * whitespace there made the file's only genuine code restatement invisible to the guard.
 */
const MATCH_CONTRACT =
  /--(no-)?match-contract(?:["']?[ \t]*,[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|[ \t]+("(?:[^"\\\n]|\\.)*")|[ \t]+('(?:[^'\\\n]|\\.)*')|[ \t]+(\\"(?:[^"\\\n]|\\.)*\\")|[ \t]+(`[^`\n]*`)|[ \t]+([^\s"',`'#]+))/g;

/**
 * Tools with their own `--match-contract` that this guard must not read as forge scope.
 * `halmos --match-contract Halmos` is a different runner filtering its own spec set, and
 * treating it as forge drift flagged an unrelated job on every run.
 */
const NON_FORGE_RUNNER = /\b(?:halmos|echidna|slither|mythril|aderyn)\b/i;
/** The `EXCLUDED = /…/` declaration in check-doc-counts.mjs. */
const JS_EXCLUDE_DECL = /EXCLUDED\s*=\s*\/([^/\n]*)\/([gimsuy]*)/g;

// ── 4. the write whitelist ───────────────────────────────────────────────────────

/**
 * Whether `--write` may touch this repo-relative path.
 *
 * Positive cases: `.nvmrc`, `Dockerfile`, `scripts/foundry-scope.json`, and
 * `packages/<workspace>/package.json` at exactly one level of depth.
 *
 * Everything else is refused, including three that a naive list would let through:
 *   • `package.json` — the root manifest is a *source of truth* here. A tool that
 *     rewrites its own inputs cannot be audited after the fact.
 *   • `.github/workflows/ci.yml` — workflow content is asserted, never generated.
 *   • `../escape` (and any absolute path, backslash, or `.`/`..` segment) — the
 *     whitelist is a list of exact in-repo targets, so traversal is not representable.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isWritable(relPath) {
  if (typeof relPath !== "string" || relPath === "") return false;
  if (relPath.includes("\\") || relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath)) return false;
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (relPath === ".nvmrc" || relPath === "Dockerfile") return true;
  if (relPath === "scripts/foundry-scope.json") return true;
  if (parts.length === 3 && parts[0] === "packages" && parts[2] === "package.json") return true;
  return false;
}

// ── 5. the consumer table ────────────────────────────────────────────────────────

/**
 * Every place the forge scope is restated, and which kind it must use.
 *
 * A file may hold several kinds at once — ci.yml runs forge with the unit, invariant and
 * fork scopes in different jobs — so each entry is checked against only the hits that
 * carry *its* pattern, and a partial fix (one step updated, the others stale) still shows
 * up because a stale hit is either a pattern belonging to another field in the wrong mode,
 * or a pattern belonging to no field at all. Both are errors.
 */
const SCOPE_CONSUMERS = [
  { id: "npm-test", file: "package.json", kind: "unit" },
  { id: "npm-test-full", file: "package.json", kind: "full" },
  { id: "ci-unit", file: ".github/workflows/ci.yml", kind: "unit" },
  { id: "ci-invariant", file: ".github/workflows/ci.yml", kind: "invariant" },
  { id: "ci-fork", file: ".github/workflows/ci.yml", kind: "fork" },
  { id: "verify-contracts", file: "scripts/verify.mjs", kind: "unit" },
  { id: "doc-counts-excluded", file: "scripts/check-doc-counts.mjs", kind: "js" },
];

/**
 * The `--(no-)match-contract` occurrences in a file, as `{mode, pattern, line}`.
 *
 * Three surface syntaxes are real, and all three are matched here because each is how one
 * of this repository's actual consumers spells the fact:
 *
 *   argv   `["test", "--no-match-contract", ".*Fork"]`   — verify.mjs passes argv, so the
 *          pattern is the next *array element*, not the next whitespace token. Trying the
 *          shell rule first here captured `", "` and reported the one genuine code
 *          restatement in the file as no consumer at all.
 *   quoted `forge test --no-match-contract '.*Fork'`     — YAML, and a shell line whose
 *          pattern contains `|`. The quotes must be part of the match, or the pattern is
 *          read with its quotes and looks drifted while being byte-identical.
 *   escaped `\"…\"`                                     — inside a JSON string, so the
 *          quotes are backslash-escaped and the shell rule captures the backslashes.
 *
 * Matching is done on the comment-blanked copy, which is what keeps a JSDoc paragraph
 * *mentioning* a pattern out of the results while leaving the line numbers true.
 */
function contractArgs(text) {
  const source = blankComments(text);
  const lines = source.split("\n");
  const out = [];
  for (const m of source.matchAll(MATCH_CONTRACT)) {
    const line = source.slice(0, m.index).split("\n").length;
    // These are *forge* suite filters. `halmos --match-contract Halmos` is a different
    // tool's own flag on a different runner, and reading it as forge scope drift would
    // flag every unrelated job in the workflow.
    if (NON_FORGE_RUNNER.test(lines[line - 1] ?? "")) continue;
    out.push({
      line,
      mode: m[1] ? "--no-match-contract" : "--match-contract",
      pattern: contractPattern(m),
    });
  }
  return out;
}

/** Picks the value out of whichever alternative matched, and unquotes it. */
function contractPattern(m) {
  // Group 1 is the `no-` prefix; 2 argv, 3 double-quoted, 4 single-quoted, 5 escaped,
  // 6 backtick, 7 bare. Every branch that captures its quotes hands them to `unquote`,
  // and every branch that does not returns the value as written — each is unquoted
  // exactly once. Unquoting one branch twice (or not at all) is what made a byte-identical
  // single-quoted YAML value read as drifted: `'…'` versus `…`.
  if (m[2] !== undefined) return unquote(m[2]);
  if (m[3] !== undefined) return unquote(m[3]);
  if (m[4] !== undefined) return unquote(m[4]);
  // The escaped branch captures the value *including* its `\"` delimiters, because those
  // backslashes are what a JSON string literal writes where a shell line would write `'`.
  // Removing them one at a time — quote-delimiter first, then the escape backslash — is
  // what turns `\"…\"` into the bare pattern, in that order and no other.
  if (m[5] !== undefined) return m[5].replace(/^\\"/, "").replace(/\\"$/, "").replace(/\\\\/g, "\\");
  if (m[6] !== undefined) return unquote(m[6]);
  return m[7] ?? "";
}

/** Removes one layer of matching quotes from a JS string literal, resolving its escapes. */
function unquote(literal) {
  const first = literal[0];
  if (literal.length >= 2 && (first === '"' || first === "'" || first === "`") && literal.at(-1) === first) {
    return literal.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return literal;
}

// ── 6. findings ─────────────────────────────────────────────────────────────────

const finding = (fields) => ({
  severity: "info",
  file: null,
  line: null,
  occurrences: [],
  fact: null,
  actual: null,
  expected: null,
  why: null,
  writable: false,
  ...fields,
});

function nodeFloorFindings(manifestText, io) {
  const out = [];
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    return [finding({ severity: "error", id: "node-floor.unreadable-manifest", file: "package.json", why: err.message })];
  }
  if (manifest?.engines === undefined) {
    return [
      finding({
        severity: "error",
        id: "node-floor.undeclared",
        file: "package.json",
        why: "package.json declares no engines.node, so there is no floor for the other restatements to agree with",
      }),
    ];
  }

  // The owner's own view of itself, lenient, from the existing check.
  const lenient = parseNodeFloor(manifest.engines);

  let expected;
  try {
    expected = parseEngineFloor(lenient.raw);
  } catch (err) {
    return [
      finding({
        severity: "error",
        id: "node-floor.fragile-parse",
        file: "package.json",
        fact: "node engine floor",
        actual: lenient.raw,
        expected: 'a single simple floor such as ">=24"',
        why: `${err.message} — check-runtime.mjs would silently report its ${lenient.specified ? "floor" : "DEFAULT_FLOOR"} (${lenient.floor.join(".")})`,
      }),
    ];
  }

  const op = /^\s*([\^~])\s*\d/.exec(lenient.raw);
  if (op && FROZEN_OPS.has(op[1])) {
    out.push(
      finding({
        id: "node-floor.frozen-range",
        file: "package.json",
        fact: "node engine floor",
        actual: lenient.raw,
        expected: `>=${expected.major}`,
        why: `"${op[1]}" also pins the upper bound; a bump to ${expected.major}.x can break it without any restatement changing`,
      }),
    );
  }

  const compare = (a) => compareFloors(a, expected);

  // ── .nvmrc ────────────────────────────────────────────────────────────────────
  if (io.exists(".nvmrc")) {
    const text = io.readText(".nvmrc");
    const first = text.split("\n")[0].trim();
    const actual = /^\d+$/.test(first) ? Number(first) : null;
    if (actual === null) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.nvmrc-unparseable",
          file: ".nvmrc",
          line: 1,
          fact: "node engine floor",
          actual: JSON.stringify(text),
          expected: `>=${expected.major}`,
          why: "the first line must be the bare major version",
          writable: true,
        }),
      );
    } else if (compare(actual) === "lower") {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.drift",
          file: ".nvmrc",
          line: 1,
          fact: "node engine floor",
          actual,
          expected: expected.major,
          why: "nvm would select a runtime the root manifest forbids",
          writable: true,
        }),
      );
    } else {
      out.push(
        finding({
          severity: compare(actual) === "equal" ? "split" : "info",
          id: compare(actual) === "equal" ? "node-floor.dup" : "node-floor.stricter",
          file: ".nvmrc",
          line: 1,
          fact: "node engine floor",
          actual,
          expected: expected.major,
          why:
            compare(actual) === "equal"
              ? "restatement; owner is package.json"
              : "declared stricter than the owner — --write will not weaken it, so raise engines.node instead",
          writable: true,
        }),
      );
    }
  } else {
    out.push(finding({ id: "node-floor.consumer-missing", file: ".nvmrc", fact: "node engine floor", why: "not present" }));
  }

  // ── Dockerfile: every `node:<major>` in a FROM ────────────────────────────────
  if (io.exists("Dockerfile")) {
    // A lookbehind rather than a consumed `(?:^|\s)`: a consumed separator makes the match
    // *start* on the preceding line, so every `FROM node:<major>` was reported one line
    // above where it actually is — and `file:line` is the whole deliverable of this report.
    const hits = findOccurrences(io.readText("Dockerfile"), /(?<=^|\s)FROM[ \t]+node:(\d+)/g);
    if (hits.length === 0) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.dockerfile-unreadable",
          file: "Dockerfile",
          fact: "node engine floor",
          actual: "no `FROM node:<major>` stage",
          expected: `node:${expected.major}`,
          why: "the base image pins the runtime for both the build and the runtime stage",
          writable: true,
        }),
      );
    }
    for (const hit of hits) {
      const actual = Number(hit.groups[0]);
      const relation = compare(actual);
      out.push(
        relation === "lower"
          ? finding({
              severity: "error",
              id: "node-floor.drift",
              file: "Dockerfile",
              line: hit.line,
              fact: "node engine floor",
              actual: `node:${actual}`,
              expected: `node:${expected.major}`,
              why: "the image would build and run on a runtime the root manifest forbids",
              writable: true,
            })
          : finding({
              severity: relation === "equal" ? "split" : "info",
              id: relation === "equal" ? "node-floor.dup" : "node-floor.stricter",
              file: "Dockerfile",
              line: hit.line,
              fact: "node engine floor",
              actual: `node:${actual}`,
              expected: `node:${expected.major}`,
              why:
                relation === "equal"
                  ? "restatement; owner is package.json"
                  : "declared stricter than the owner — --write will not weaken it",
              writable: true,
            }),
      );
    }
  } else {
    out.push(finding({ id: "node-floor.consumer-missing", file: "Dockerfile", fact: "node engine floor", why: "not present" }));
  }

  // ── workspace manifests ───────────────────────────────────────────────────────
  // The scan is driven by the directory listing, not by a separate `exists("packages")`
  // probe. An io that only knows files — a Map-backed fixture, a filtered index — reports
  // `false` for the directory and the loop body never runs, so every workspace silently
  // went unscanned. `listDir` already answers `[]` for something that is not there, which
  // is the one behaviour this needs.
  for (const name of io.listDir("packages")) {
    const rel = `packages/${name}/package.json`;
    if (!io.exists(rel)) continue;
    let pkg;
    try {
      pkg = JSON.parse(io.readText(rel));
    } catch (err) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.unreadable-manifest",
          file: rel,
          fact: "node engine floor",
          actual: err.message,
          expected: "a parseable manifest",
          why: "the workspace's own floor could not be read",
          writable: true,
        }),
      );
      continue;
    }
    if (pkg?.engines?.node === undefined) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.missing-engine",
          file: rel,
          fact: "node engine floor",
          actual: "no engines.node",
          expected: `>=${expected.major}`,
          why: "npm would accept any Node here while the root forbids the old ones",
          writable: true,
        }),
      );
      continue;
    }
    let local;
    try {
      local = parseEngineFloor(pkg.engines.node);
    } catch (err) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.fragile-parse",
          file: rel,
          fact: "node engine floor",
          actual: pkg.engines.node,
          expected: `>=${expected.major}`,
          why: err.message,
          writable: true,
        }),
      );
      continue;
    }
    const relation = compareFloors(local, expected);
    out.push(
      finding({
        severity: relation === "equal" ? "split" : relation === "higher" ? "info" : "error",
        id: relation === "equal" ? "node-floor.dup" : relation === "higher" ? "node-floor.stricter" : "node-floor.drift",
        file: rel,
        fact: "node engine floor",
        actual: pkg.engines.node,
        expected: `>=${expected.major}`,
        why:
          relation === "equal"
            ? "restatement; owner is package.json"
            : relation === "higher"
              ? "stricter than the owner — --write will not weaken it"
              : "the workspace accepts a runtime the root forbids",
        writable: true,
      }),
    );
  }

  // ── the fragile parse ─────────────────────────────────────────────────────────
  // This is the finding the whole script is named for. Its value is correct today, so
  // no value comparison can ever produce it: it is reported because the *expression* is
  // wrong, and it is `error` rather than `split` because a three-digit major turns a
  // silent wrong answer into a setup script that stops working on 4 000 machines with
  // no failing test to point at it.
  if (io.exists("scripts/bootstrap.mjs")) {
    const hits = findOccurrences(
      io.readText("scripts/bootstrap.mjs"),
      /\.replace\(\/\[\^0-9\]\/g[ \t]*,[ \t]*""\)\.slice\(0[ \t]*,[ \t]*2\)/g,
    );
    for (const hit of hits) {
      out.push(
        finding({
          severity: "error",
          id: "node-floor.fragile-parse",
          file: "scripts/bootstrap.mjs",
          line: hit.line,
          fact: "node engine floor",
          actual: `${legacyDigitSliceFloor(lenient.raw)} today, ${legacyDigitSliceFloor(">=100")} for a three-digit major`,
          expected: expected.major,
          why:
            "digit-slice floor: every digit is concatenated, then the first two are kept, " +
            'so ">=100" becomes 10. Agrees with the owner by luck and diverges silently. ' +
            "Replace with parseEngineFloor() from scripts/sync-facts.mjs. Not writable — JS source is asserted only.",
          writable: false,
        }),
      );
    }
  }
  return out;
}

function scopeFindings(io) {
  const out = [];
  const rel = "scripts/foundry-scope.json";
  if (!io.exists(rel)) {
    return [
      finding({
        severity: "error",
        id: "scope.missing",
        file: rel,
        fact: "forge test scope",
        why: "the scope file is the owner of the exclusion categories; without it there is nothing to compare against",
      }),
    ];
  }
  let scope;
  try {
    scope = JSON.parse(io.readText(rel));
  } catch (err) {
    return [
      finding({
        severity: "error",
        id: "scope.unreadable",
        file: rel,
        fact: "forge test scope",
        actual: err.message,
        expected: "a parseable JSON object",
        why: "the owner could not be read, so no restatement can be checked",
      }),
    ];
  }

  for (const problem of validateScope(scope).problems) {
    const stale = problem.includes("stale");
    out.push(
      finding({
        severity: stale ? "split" : "error",
        id: stale ? "scope.stale-mirror" : "scope.inconsistent",
        file: rel,
        fact: "forge test scope",
        actual: problem,
        expected: "a scope file whose mirrors all agree with unitExclude",
        why: stale
          ? "values are usable but the mirror drifted; --write regenerates jsExclude"
          : "the owner is internally inconsistent, so every restatement below is unverifiable",
        writable: stale,
      }),
    );
  }

  const cache = new Map();
  const readOnce = (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, io.exists(file) ? io.readText(file) : null);
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };

  for (const consumer of SCOPE_CONSUMERS) {
    const text = readOnce(consumer.file);
    if (text === null) {
      out.push(
        finding({
          id: "scope.consumer-missing",
          file: consumer.file,
          fact: "forge test scope",
          why: "not present; the guard looked here and found nothing to assert",
        }),
      );
      continue;
    }

    if (consumer.kind === "js") {
      const hits = findOccurrences(text, JS_EXCLUDE_DECL);
      if (hits.length === 0) {
        out.push(
          finding({
            severity: "error",
            id: "scope.consumer-missing",
            file: consumer.file,
            fact: "forge test scope",
            why: "no `EXCLUDED = /…/` declaration found; check-doc-counts.mjs must derive it from foundry-scope.json",
          }),
        );
        continue;
      }
      let mirror;
      try {
        mirror = jsExcludeToRegExp(scope);
      } catch (err) {
        out.push(
          finding({
            severity: "error",
            id: "scope.consumer-unresolvable",
            file: consumer.file,
            fact: "forge test scope",
            actual: err.message,
            expected: "a usable jsExclude",
            why: "the consumer cannot be checked against an unusable mirror",
          }),
        );
        continue;
      }
      for (const hit of hits) {
        const actual = hit.groups[0];
        const agrees = actual === scope.jsExclude;
        out.push(
          finding({
            severity: agrees ? "split" : "error",
            id: agrees ? "scope.dup" : "scope.drift",
            file: consumer.file,
            line: hit.line,
            fact: "forge test scope (jsExclude)",
            actual,
            expected: scope.jsExclude,
            why: agrees
              ? "restatement; the fix is to read the scope file at runtime, so this stops being a restatement at all"
              : "the documented PR-gated scope differs from the PR-gated scope",
          }),
        );
      }
      continue;
    }

    let pair;
    try {
      pair = extractScopePair(scope, consumer.kind);
    } catch (err) {
      out.push(
        finding({
          severity: "error",
          id: "scope.consumer-unresolvable",
          file: consumer.file,
          fact: "forge test scope",
          actual: err.message,
          expected: `a usable scope for kind "${consumer.kind}"`,
          why: "an unknown kind must not fall back to running everything",
        }),
      );
      continue;
    }

    const hits = contractArgs(text);

    // A workflow legitimately runs forge with *different* scopes in different jobs: the
    // unit job excludes the invariant and fork suites, the invariant job gates one category
    // on its own, the fork job gates another, and the canary job deliberately runs both
    // spellings. So a hit cannot be compared against "the one pattern this kind uses" —
    // each hit is classified by which scope field it actually matches, and only the hits
    // belonging to this kind are checked against it. Anything that matches *no* field is
    // genuine drift and is reported; that is what keeps a newly invented pattern visible.
    const classified = hits.map((hit) => ({ ...hit, field: scopeFieldOf(scope, hit) }));
    const mine = classified.filter((hit) => hit.field === pair.field);
    const foreign = classified.filter((hit) => hit.field === null);

    if (mine.length === 0 && foreign.length === 0) {
      out.push(
        finding({
          severity: "error",
          id: "scope.consumer-missing",
          file: consumer.file,
          fact: `forge test scope (${consumer.id})`,
          actual: "no --match-contract / --no-match-contract pair",
          expected: `${pair.mode} '${pair.pattern}'`,
          why:
            "the invocation this guard exists to cover was removed or reworded; a guard whose " +
            "consumer has vanished must fail, or it silently checks nothing",
        }),
      );
      continue;
    }

    // A hit matching a *different* field, in the wrong mode for this kind, is a real error:
    // e.g. the fork job excluding `.*Invariant|.*Fork` would skip every suite it exists to run.
    const wrongMode = mine.filter((hit) => hit.mode !== pair.mode);
    const drifted = foreign.concat(wrongMode);
    const agreed = mine.filter((hit) => hit.mode === pair.mode);
    const sample = agreed[0] ?? hits[0];

    out.push(
      finding({
        severity: drifted.length === 0 ? "split" : "error",
        id: drifted.length === 0 ? "scope.dup" : "scope.drift",
        file: consumer.file,
        line: drifted.length > 0 ? drifted[0].line : sample.line,
        occurrences: (agreed.length > 0 ? agreed : hits).map((hit) => hit.line),
        fact: `forge test scope (${consumer.kind})`,
        actual:
          drifted.length > 0
            ? drifted.map((h) => `'${h.pattern}'`).join(", ")
            : `'${sample.pattern}'`,
        expected: pair.pattern,
        why:
          drifted.length === 0
            ? `restatement at lines ${(agreed.length > 0 ? agreed : hits).map((h) => h.line).join(", ")}; owner is foundry-scope.json (${pair.field}) — asserted only, updated by hand`
            : `${drifted.length} of ${hits.length} occurrence(s) drifted; a partial fix is still a failure — asserted only, updated by hand`,
        writable: false,
      }),
    );
  }
  return out;
}

/**
 * Which scope field a hit's pattern belongs to, or `null` if it belongs to none of them.
 * A pattern is matched by exact string equality against each field, which is what lets a
 * single ci.yml be checked once per kind without each check claiming the others' lines.
 */
function scopeFieldOf(scope, hit) {
  for (const field of ["unitExclude", "invariantMatch", "forkMatch"]) {
    if (typeof scope[field] === "string" && scope[field] !== "" && scope[field] === hit.pattern) return field;
  }
  return null;
}

function foundryFindings(io) {
  const out = [];
  const rel = ".github/workflows/ci.yml";
  if (!io.exists(rel)) {
    return [finding({ id: "foundry.consumer-missing", file: rel, fact: "foundry version", why: "not present" })];
  }
  const text = io.readText(rel);
  const declared = /^\s*FOUNDRY_VERSION:\s*"?([^"\n]+)"?\s*$/m.exec(blankComments(text));
  if (declared === null) {
    return [
      finding({
        severity: "error",
        id: "foundry.undeclared",
        file: rel,
        fact: "foundry version",
        actual: "no FOUNDRY_VERSION",
        expected: "a pinned version",
        why: "the toolchain would float on whatever foundry-toolchain defaults to",
      }),
    ];
  }
  const pinned = declared[1].trim();
  // The canary job is *supposed* to diverge — that is what a canary is. Anything else
  // that names a literal version is a second pin, which is the defect this guards.
  //
  // The key must be anchored on a word boundary. Unanchored, `version:` also matches the
  // tail of `node-version: "24"`, `python-version: "3.12"` and `solc-version: 0.8.36`, and
  // a guard that calls a Python pin a "hard-coded toolchain version env.FOUNDRY_VERSION
  // cannot control" is a guard that cries wolf on every unrelated job in the workflow.
  const literals = findOccurrences(text, /(?:^|[\s,{])version[ \t]*:[ \t]*(?:"([^"\n]+)"|([^\s,}]+))/g)
    .map((hit) => ({ line: hit.line, value: hit.groups[0] ?? hit.groups[1] ?? "" }))
    .filter((hit) => hit.value !== "" && hit.value !== "nightly" && !/^\$\{\{/.test(hit.value));
  for (const hit of literals) {
    out.push(
      finding({
        severity: hit.value === pinned ? "split" : "error",
        id: hit.value === pinned ? "foundry.dup" : "foundry.drift",
        file: rel,
        line: hit.line,
        fact: "foundry version",
        actual: hit.value,
        expected: pinned,
        why:
          hit.value === pinned
            ? "a literal second pin where the env: indirection belongs; one pin, one bump"
            : "a hard-coded toolchain version that env.FOUNDRY_VERSION cannot control",
      }),
    );
  }
  const envRefs = findOccurrences(text, /version:[ \t]*"?\$\{\{[ \t]*env\.FOUNDRY_VERSION[ \t]*\}\}"?/g);
  out.push(
    finding({
      id: "foundry.owner",
      file: rel,
      line: text.split("\n").findIndex((l) => l.includes("FOUNDRY_VERSION:")) + 1,
      fact: "foundry version",
      actual: pinned,
      expected: pinned,
      occurrences: envRefs.map((hit) => hit.line),
      why: `owner: env.FOUNDRY_VERSION, consumed by ${envRefs.length} toolchain step(s); the canary's "nightly" is a deliberate exception`,
    }),
  );
  return out;
}

// ── 7. collection, planning, writing, verdict ────────────────────────────────────

/** Every finding, most serious first, then by file and line. */
export function buildFindings(io) {
  const all = [...nodeFloorFindings(io.readText("package.json"), io), ...scopeFindings(io), ...foundryFindings(io)];
  return all.sort(
    (a, b) =>
      SEVERITY[b.severity] - SEVERITY[a.severity] ||
      String(a.file).localeCompare(String(b.file)) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * The rewrite plan: only whitelisted targets, only where the fix is a tightening, and
 * never a rewrite that would make a consumer *more* permissive than the owner. That
 * last rule is why `.nvmrc:26` survives a `--write` against a floor of 24: lowering it
 * would silently replace a deliberate choice with a derived one.
 *
 * Pure — returns before/after strings, touches nothing.
 */
export function planWrites(findings, io) {
  const plan = [];
  const push = (path, before, after, reason) => {
    if (!isWritable(path)) return;
    if (before === after) return;
    // One entry per path, last writer wins. A multi-stage Dockerfile produces one finding
    // per `FROM node:<major>`, and each of them plans the *whole file*; without this the
    // second entry carried a `before` that the first entry had already invalidated, and
    // applyWrite aborted the entire run with "changed since the plan was built" — a
    // self-inflicted false positive on the very file the guard advertises it can repair.
    const existing = plan.findIndex((entry) => entry.path === path);
    if (existing === -1) {
      plan.push({ path, before, after, reason });
    } else {
      plan[existing] = { path, before: plan[existing].before, after, reason };
    }
  };

  for (const f of findings) {
    // The gate is `writable`, not `severity === "error"`. A finding that declares itself
    // writable is asking to be repaired, and `scope.stale-mirror` is deliberately a
    // `split`: the values are all usable, only the derived mirror drifted, so it must not
    // fail the gate — but `--write` is the documented way to close it, and filtering on
    // severity made the plan empty and left the mirror stale forever.
    if (!f.writable) continue;

    if ((f.id === "node-floor.drift" || f.id === "node-floor.nvmrc-unparseable") && f.file === ".nvmrc") {
      const major = majorOf(f.expected);
      if (major === null) continue;
      if (compareFloors(major, Number(f.actual)) === "higher" || f.actual === undefined) {
        push(f.file, io.readText(f.file), `${major}\n`, "nvm floor raised to the declared engine");
      }
    }

    if (f.id === "node-floor.drift" && f.file === "Dockerfile") {
      // A Dockerfile finding reports `expected` as the whole image tag (`node:24`), while a
      // `.nvmrc` finding reports the bare major (`24`). Reading the former with `Number()`
      // yields NaN, so the comparison is never "higher" and the plan came out empty — the
      // one whitelisted target `--write` advertises in its own help text was never repaired.
      const major = majorOf(f.expected);
      if (major === null) continue;
      const before = io.readText(f.file);
      const after = before.replace(/(FROM[ \t]+node:)(\d+)/g, (whole, head, digits) =>
        compareFloors(major, Number(digits)) === "higher" ? `${head}${major}` : whole,
      );
      push(f.file, before, after, "base image raised to the declared engine");
    }

    if (f.id === "node-floor.drift" && /^packages\/.+\/package\.json$/.test(f.file)) {
      const before = io.readText(f.file);
      const major = majorOf(f.expected);
      if (major === null) continue;
      const after = before.replace(
        /("node"[ \t]*:[ \t]*")([^"]*)(")/,
        (whole, head, old, tail) => {
          let local;
          try {
            local = parseEngineFloor(old);
          } catch {
            return whole;
          }
          return compareFloors(major, local.major) === "higher" ? `${head}>=${major}${tail}` : whole;
        },
      );
      push(f.file, before, after, "workspace engine floor raised to the declared engine");
    }

    if (f.id === "node-floor.missing-engine") {
      const before = io.readText(f.file);
      const major = majorOf(f.expected);
      if (major === null) continue;
      // Anchor on a top-level field so the insertion is syntactically safe without
      // reformatting the rest of the file.
      const anchor = /"type"[ \t]*:[ \t]*"module"/.test(before) ? '"type": "module",' : null;
      if (anchor === null) continue;
      const after = before.replace(anchor, `${anchor}\n  "engines": {\n    "node": ">=${major}"\n  },`);
      push(f.file, before, after, "workspace declared no engine floor at all");
    }

    if (f.id === "scope.stale-mirror") {
      const before = io.readText(f.file);
      let parsed = null;
      try {
        parsed = JSON.parse(before);
      } catch {
        continue;
      }
      let derived;
      try {
        derived = deriveJsExclude(parsed);
      } catch {
        continue;
      }
      const after = before.replace(/("jsExclude"[ \t]*:[ \t]*")([^"]*)(")/, (_w, head, _old, tail) => `${head}${derived}${tail}`);
      push(f.file, before, after, "jsExclude regenerated from unitExclude");
    }
  }
  return plan;
}

/**
 * The major version a finding's `expected` refers to, or `null` if it names none.
 *
 * The field is deliberately not uniform: `.nvmrc` and the workspace manifests carry a
 * bare major, while a Dockerfile carries the whole tag. Normalising here is what lets one
 * comparison rule serve both, instead of `Number("node:24")` quietly producing NaN and a
 * plan that repairs nothing.
 */
function majorOf(expected) {
  if (typeof expected === "number" && Number.isFinite(expected)) return expected;
  const digits = /(\d+)/.exec(String(expected ?? ""));
  return digits === null ? null : Number(digits[1]);
}

/**
 * Applies a plan, re-checking the whitelist for every entry.
 *
 * The second check is not redundancy. A plan is data; data can be wrong, and the
 * consequence of a bad plan is a script rewriting a file it has no business touching.
 * Fail closed, loudly, before the first write rather than after the last one.
 *
 * @throws when any entry is outside the whitelist, or a file changed under us
 * @returns {{path: string, changed: boolean}[]}
 */
export function applyWrite(plan, io) {
  const outside = plan.filter((entry) => !isWritable(entry.path));
  if (outside.length > 0) {
    throw new Error(`refusing to write outside the whitelist: ${outside.map((e) => e.path).join(", ")}`);
  }
  const applied = [];
  for (const entry of plan) {
    let onDisk = null;
    try {
      onDisk = io.readText(entry.path);
    } catch {
      onDisk = null;
    }
    if (onDisk !== null && onDisk !== entry.before) {
      throw new Error(`${entry.path} changed since the plan was built; refusing to overwrite a file this run did not read`);
    }
    const current = onDisk ?? entry.before;
    if (current === entry.after) {
      applied.push({ path: entry.path, changed: false });
      continue;
    }
    io.write(entry.path, entry.after);
    applied.push({ path: entry.path, changed: true });
  }
  return applied;
}

/** Human-readable one finding, always carrying file:line, actual and expected. */
export function renderFinding(f) {
  const where = f.line === null || f.line === undefined ? String(f.file) : `${f.file}:${f.line}`;
  const lines = [`${f.severity.toUpperCase().padEnd(5)} ${where}  [${f.id}]`, `      fact:     ${f.fact ?? "—"}`];
  if (f.actual !== null) lines.push(`      actual:   ${f.actual}`);
  if (f.expected !== null) lines.push(`      expected: ${f.expected}`);
  lines.push(`      writable: ${f.writable ? "yes — --write repairs this" : "no — asserted only, fix by hand"}`);
  if (f.why) lines.push(`      why:      ${f.why}`);
  return lines.join("\n");
}

/**
 * The exit code. Only `error` is fatal; `split` becomes fatal solely under --strict,
 * because duplication is a debt to be scheduled, not a defect to be blocked on.
 */
export function verdict(findings, { strict = false } = {}) {
  const errors = findings.filter((f) => f.severity === "error");
  const splits = findings.filter((f) => f.severity === "split");
  const infos = findings.filter((f) => f.severity === "info");
  const exitCode = errors.length > 0 || (strict && splits.length > 0) ? 1 : 0;
  return { ok: exitCode === 0, exitCode, strict, errors, splits, infos, findings };
}

function renderList(findings) {
  const lines = ["sync-facts: restatement points, grouped by fact", ""];
  const groups = new Map();
  for (const f of findings) {
    const key = f.fact ?? "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [fact, items] of groups) {
    lines.push(`${fact}  (${items.length})`);
    for (const f of items) {
      const where = f.line === null || f.line === undefined ? f.file : `${f.file}:${f.line}`;
      const extra =
        f.occurrences && f.occurrences.length > 1
          ? `  [also lines ${f.occurrences.filter((l) => l !== f.line).join(", ")}]`
          : "";
      lines.push(`  ${f.severity.padEnd(5)} ${where.padEnd(34)} ${f.actual ?? ""}${extra}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── 8. CLI ───────────────────────────────────────────────────────────────────────

/** Real-filesystem io bound to one root. */
export function makeIo(root) {
  const at = (rel) => join(root, ...String(rel).split("/"));
  return {
    root,
    readText: (rel) => readFileSync(at(rel), "utf8"),
    listDir: (rel) => {
      try {
        return readdirSync(at(rel));
      } catch {
        return [];
      }
    },
    exists: (rel) => existsSync(at(rel)),
    write: (rel, text) => writeFileSync(at(rel), text),
  };
}

function parseFlags(argv) {
  const known = new Set(["--check", "--write", "--list", "--strict", "--json"]);
  const flags = { check: false, write: false, list: false, strict: false, json: false, root: ROOT };
  for (const arg of argv) {
    if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
      if (flags.root === "") throw new Error("--root= needs a directory");
      continue;
    }
    if (!known.has(arg)) throw new Error(`unrecognized argument ${JSON.stringify(arg)}`);
    flags[arg.slice(2)] = true;
  }
  // Mutually exclusive outputs. A --write that also listed would be a run whose stdout
  // cannot be parsed by anything.
  if (flags.write && flags.list) throw new Error("--write and --list are mutually exclusive");
  if (!flags.write && !flags.list) flags.check = true;
  return flags;
}

/**
 * The CLI. Returns the process exit code; never calls process.exit itself, so the
 * test file can drive it against an in-memory io and assert on the return value.
 */
export function main(argv = [], io = null) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`sync-facts: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const activeIo = io ?? makeIo(flags.root);
  let findings;
  try {
    findings = buildFindings(activeIo);
  } catch (err) {
    process.stderr.write(`sync-facts: could not read the repository: ${err.message}\n`);
    return 2;
  }

  if (flags.list) {
    process.stdout.write(renderList(findings));
    return 0;
  }

  if (flags.write) {
    const plan = planWrites(findings, activeIo);
    let applied;
    try {
      applied = applyWrite(plan, activeIo);
    } catch (err) {
      process.stderr.write(`sync-facts: ${err.message}\n`);
      return 2;
    }
    const changed = applied.filter((entry) => entry.changed);
    for (const entry of changed) {
      process.stdout.write(`rewrote ${entry.path} — ${plan.find((p) => p.path === entry.path).reason}\n`);
    }
    if (changed.length === 0) {
      process.stdout.write("--write changed nothing: every whitelisted target already agreed with its owner.\n");
    }
    // Re-read from disk rather than reusing `findings`: a rewrite is only a success if
    // a fresh scan says so, and reusing the pre-write findings would report the drift
    // that was just repaired.
    const after = verdict(buildFindings(activeIo), { strict: flags.strict });
    for (const f of after.errors) process.stderr.write(`${renderFinding(f)}\n`);
    process.stdout.write(
      `\n--write: ${changed.length} file(s) rewritten, ${applied.length - changed.length} already correct; ` +
        `${after.errors.length} error(s) remain.\n` +
        "GitHub Actions workflows and JS source are asserted, not written — a workflow's env: block " +
        "cannot read a JSON file, so those are yours to edit by hand.\n",
    );
    return after.exitCode;
  }

  const v = verdict(findings, { strict: flags.strict });
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: v.ok, strict: v.strict, counts: { error: v.errors.length, split: v.splits.length, info: v.infos.length }, findings },
        null,
        2,
      )}\n`,
    );
    return v.exitCode;
  }

  for (const f of v.errors) process.stderr.write(`${renderFinding(f)}\n`);
  // The branch is on the *verdict*, not on `errors.length`. Keying it on the error count
  // made `--strict` exit 1 while still printing "sync-facts OK" — a run that fails and
  // says it passed, which is the one thing a gate must never do.
  if (!v.ok) {
    const detail =
      v.errors.length > 0
        ? `${v.errors.length} error(s) — run --write for the whitelisted targets, fix the rest by hand.`
        : `${v.splits.length} restatement(s) duplicated under --strict — consolidate them onto their owner, or drop --strict.`;
    process.stderr.write(`\nsync-facts: ${detail}\n`);
  } else {
    process.stdout.write(
      `sync-facts OK — ${v.splits.length} restatement(s) agree with their owner` +
        `${v.infos.length > 0 ? `, ${v.infos.length} note(s)` : ""}.` +
        `${v.splits.length > 0 ? " Use --strict to make duplication fatal, --list to see them." : ""}\n`,
    );
  }
  return v.exitCode;
}

const invokedDirectly =
  process.argv[1] &&
  (process.platform === "win32"
    ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase()
    : pathToFileURL(process.argv[1]).href === import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
