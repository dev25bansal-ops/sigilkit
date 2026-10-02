#!/usr/bin/env node
/**
 * Dockerfile / compose guard.
 *
 * The container image is the one deliverable that CI cannot exercise cheaply, so it rots
 * quietly: someone renames `dist/cli.js`, adds a `files[]` entry, or tightens `.dockerignore`,
 * and the build only fails on a machine that has a daemon. This script checks the parts that
 * *are* statically verifiable — every COPY source exists in the build context, every COPY
 * source survives `.dockerignore`, and the ENTRYPOINT/CMD targets resolve — so a broken image
 * fails in the same job that lints the workflows.
 *
 *   node scripts/check-dockerfile.mjs
 *
 * It takes no flags. Exit 0 clean, 1 on any finding, 2 when the check could not run as
 * asked — an argument was passed, `--root` included, and those were ignored rather than
 * rejected.
 *
 * It does NOT build the image; it cannot catch a bad base tag or a failing `npm ci`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, messageOf, reportUsage } from "./lib/exit.mjs";
import { parseArgs, usage } from "./lib/cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = join(ROOT, "Dockerfile");
const DOCKERIGNORE = join(ROOT, ".dockerignore");
const TOOL = "check-dockerfile";
/** This gate takes no flags; the line exists so an argument can be named in the error. */
const USAGE = usage([`usage: ${TOOL}`], {});
const problems = [];

/** Joins Dockerfile line continuations into one logical instruction per entry. */
function instructions(text) {
  const out = [];
  let buffer = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    buffer = buffer === "" ? line : `${buffer} ${line}`;
    if (buffer.endsWith("\\")) {
      buffer = buffer.slice(0, -1).trim();
      continue;
    }
    out.push(buffer);
    buffer = "";
  }
  if (buffer !== "") out.push(buffer);
  return out;
}

/** Splits an instruction's arguments, honouring simple quoting. */
function tokenize(rest) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(rest))) tokens.push(m[1] ?? m[2] ?? m[3]);
  // Punctuation between quoted arguments arrives as its own token; drop it so callers can
  // index by position (e.g. the argument after "node").
  return tokens.filter((t) => t !== ",");
}

/** Parses the exec form `["node", "x.js"]`, falling back to tokenising. */
function execFormArgs(rest) {
  try {
    const parsed = JSON.parse(rest);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* not strict JSON — fall through */
  }
  return tokenize(rest.replace(/^\[/, "").replace(/\]$/, ""));
}

/**
 * Loads `.dockerignore` patterns, ignoring comments and blanks.
 *
 * P0-ZERO: this used to `return []` when `.dockerignore` was absent, which made "the file was
 * deleted" and "the file legitimately ignores nothing" the SAME observation — zero rules is
 * a valid state, so a removed `.dockerignore` was undetectable and every `COPY source is
 * excluded by .dockerignore` check silently became vacuous. `existsSync` is the wrong question:
 * this returns the rules plus whether the file was actually there to read.
 *
 * A present-but-empty file is a real, authorable state and is still zero rules — the
 * distinction being preserved is *absent* vs *present and empty*, not *absent* vs *non-empty*.
 * So absence is a finding (`null`), not a fabricated empty rule set.
 */
function dockerignorePatterns() {
  if (!existsSync(DOCKERIGNORE)) return null;
  return readFileSync(DOCKERIGNORE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => ({ pattern: l, negated: l.startsWith("!") }))
    .map(({ pattern, negated }) => ({ pattern: negated ? pattern.slice(1) : pattern, negated }));
}

/** Approximate match of a repo-relative path against the .dockerignore patterns in use. */
function isIgnored(relPath, rules) {
  let ignored = false;
  for (const { pattern, negated } of rules) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    const base = posix.basename(relPath);
    let hit = false;
    if (clean.includes("*")) {
      const re = new RegExp("^" + clean.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
      hit = re.test(relPath) || re.test(base);
    } else {
      hit = relPath === clean || relPath.startsWith(clean + "/") || base === clean;
    }
    if (hit) ignored = !negated;
  }
  return ignored;
}

// Rejected before any file is read. This gate has no flags and had no argv handling at
// all, so `--root` (and every other argument) was ignored: a caller that named a
// different repository got a clean report on this one, which reads exactly like "the
// other repository is fine". Exit 2 — never 0, and never after the checks have run.
const ARGV = process.argv.slice(2);
try {
  const parsed = parseArgs(ARGV, {});
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT.OK);
  }
} catch (err) {
  process.exit(reportUsage(TOOL, messageOf(err), USAGE));
}

if (!existsSync(DOCKERFILE)) {
  console.error("Dockerfile: not found");
  process.exit(1);
}

const lines = instructions(readFileSync(DOCKERFILE, "utf8"));
// P0-ZERO: `null` means the file is absent, which is a finding — NOT an empty rule set. The
// exclusion checks below are vacuous without rules, so treating absence as "ignores nothing"
// would let a deleted .dockerignore turn every COPY-exclusion assertion into a no-op.
const rules = dockerignorePatterns();
if (rules === null) {
  problems.push(
    `.dockerignore is missing — without it every "COPY source is excluded by .dockerignore" ` +
    `check is vacuous, so the guard cannot see what the build context would actually contain`,
  );
}

/** Stages declared with `FROM … AS name`. */
const stages = [];
for (const line of lines) {
  const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
  if (m) stages.push({ image: m[1], name: m[2] ?? null });
}
if (stages.length === 0) problems.push("no FROM instruction found");

/** Resolves a COPY source that came from an earlier stage (paths are absolute in-image). */
function checkStageCopy(source, dest) {
  const rel = source.replace(/^\/app\/?/, "");
  if (rel === "" ) return; // whole-workdir copy
  if (existsSync(join(ROOT, rel))) return;
  // Build output legitimately absent before the build runs — accept `packages/<p>/dist`.
  if (/^packages\/[^/]+\/dist(\/|$)/.test(rel)) {
    const pkg = rel.split("/")[1];
    if (!existsSync(join(ROOT, "packages", pkg))) {
      problems.push(`COPY --from source references unknown package: ${source} (dest ${dest})`);
    }
    return;
  }
  problems.push(`COPY --from source does not exist in the repo: ${source} (dest ${dest})`);
}

for (const line of lines) {
  if (!/^COPY\s/i.test(line)) continue;
  const tokens = tokenize(line.replace(/^COPY\s+/i, ""));
  const fromIdx = tokens.findIndex((t) => t.startsWith("--from="));
  const sources = fromIdx === 0 ? tokens.slice(1, -1) : tokens.slice(0, -1);
  const dest = tokens[tokens.length - 1];
  if (!dest) {
    problems.push(`COPY without a destination: ${line}`);
    continue;
  }

  for (const source of sources) {
    if (fromIdx === 0) {
      checkStageCopy(source, dest);
      continue;
    }
    const rel = source.replace(/^\.\//, "");
    if (!existsSync(join(ROOT, rel))) {
      problems.push(`COPY source does not exist in the build context: ${source}`);
      continue;
    }
    if (isIgnored(rel, rules)) {
      problems.push(`COPY source is excluded by .dockerignore: ${source}`);
    }
  }
}

/**
 * Runtime paths mirror WORKDIR /app. Before a package is built, accept only outputs
 * backed by its src/ tree (the workspace tsc builds map src/ to dist/). Once dist/
 * exists, require the output itself so stale or incomplete builds cannot mask typos.
 */
function runtimeTargetExists(target) {
  if (existsSync(join(ROOT, target))) return true;
  // The pre-build fallback is `packages/<p>/dist/<stem>.<ext>` backed by
  // `packages/<p>/src/<stem>.<ts-ish ext>`. The extension group is any run of word
  // characters so a target whose extension was mangled still resolves to its source
  // rather than falling out of the check as "not a dist path" and passing silently.
  const match = /^packages\/([^/]+)\/dist\/(.+)\.([\w-]+)$/.exec(target);
  if (!match) return false;
  const [, pkg, stem, extension] = match;
  if (stem.split("/").some((part) => part === "." || part === ".." || part === "")) return false;
  if (existsSync(join(ROOT, "packages", pkg, "dist"))) return false;
  const sourceExtension = { js: "ts", mjs: "mts", cjs: "cts" }[extension] ?? "ts";
  return existsSync(join(ROOT, "packages", pkg, "src", `${stem}.${sourceExtension}`));
}

/**
 * A path the image would try to execute. Deliberately NOT restricted to `.js`/`.mjs`/
 * `.cjs`: the previous `\.(js|mjs|cjs)$` filter silently *skipped* every other target, so
 * an ENTRYPOINT renamed to `dist/cli.js-gone`, to `dist/cli` (extension dropped) or to
 * `dist/cli.txt` passed the gate with exit 0 — a broken image that only fails on a machine
 * with a daemon. A path-shaped token is now checked whatever its extension, and only a
 * genuine flag/option (leading `-`) is exempt, because that is an argument to the runtime
 * rather than the script it loads.
 */
const EXECUTABLE_PATH = /^[\w./@:+-]+\/[\w./@:+-]*$/;

/** Verifies the node script referenced by ENTRYPOINT/CMD exists (repo-relative). */
function checkRuntimeTarget(instruction) {
  // Strip the keyword first: both the shell form (`ENTRYPOINT node x.js`) and the JSON form
  // (`ENTRYPOINT ["node", "x.js"]`) must be handled, and only the first token differs.
  const rest = instruction.replace(/^(ENTRYPOINT|CMD)\s+/i, "").trim();
  let target;
  if (rest.startsWith("[")) {
    const parts = execFormArgs(rest);
    const nodeIdx = parts.indexOf("node");
    if (nodeIdx >= 0) target = parts[nodeIdx + 1];
  } else {
    const m = /^node\s+(\S+)/.exec(rest);
    if (m) target = m[1];
  }
  if (!target) return;
  // A flag is an argument to the runtime, not a script path. Everything else that is not
  // path-shaped (a bare word, an env var, a shell substitution) is unverifiable, and a
  // target this gate cannot resolve is reported rather than assumed good.
  if (target.startsWith("-")) return;
  if (!EXECUTABLE_PATH.test(target)) {
    problems.push(
      `${instruction.split(" ")[0]} target is not a verifiable script path: ${target} — this guard cannot confirm it exists`,
    );
    return;
  }
  if (!runtimeTargetExists(target)) {
    problems.push(`${instruction.split(" ")[0]} references a missing script: ${target}`);
  }
}

for (const line of lines) {
  if (/^ENTRYPOINT/i.test(line) || /^CMD/i.test(line)) checkRuntimeTarget(line);
}

// The compose file overrides the entrypoint for the MCP service; check that target too.
const COMPOSE = join(ROOT, "docker-compose.yml");
if (existsSync(COMPOSE)) {
  const compose = readFileSync(COMPOSE, "utf8");
  for (const m of compose.matchAll(/entrypoint:\s*\[([^\]]*)\]/g)) {
    const parts = tokenize(m[1]);
    // Same hole as the Dockerfile branch, closed the same way: pick the token that
    // FOLLOWS the runtime rather than the first one that merely ends in `.js`. A renamed
    // MCP entrypoint (`dist/cli.js-gone`) used to match nothing here and pass silently.
    const runtimeIdx = parts.findIndex((p) => /^(node|npx|tsx|deno|bun)$/.test(p));
    const candidate = runtimeIdx >= 0 ? parts[runtimeIdx + 1] : undefined;
    const script = candidate ?? parts.find((p) => p.includes("/") && !p.startsWith("-"));
    if (!script || script.startsWith("-")) continue;
    if (!runtimeTargetExists(script)) {
      problems.push(`docker-compose.yml entrypoint references a missing script: ${script}`);
    }
  }
  // Any file: volume source that is a bind mount must exist or be creatable.
  for (const m of compose.matchAll(/-\s+\.\/([A-Za-z0-9._-]+):/g)) {
    if (!existsSync(join(ROOT, m[1]))) {
      problems.push(`docker-compose.yml binds a path that does not exist: ./${m[1]}`);
    }
  }
}

if (problems.length === 0) {
  const runtimeTargets = lines.filter((l) => /^(ENTRYPOINT|CMD)/i.test(l)).length;
  console.log(
    `dockerfile OK — ${stages.length} stage(s), ${lines.filter((l) => /^COPY/i.test(l)).length} COPY, ` +
      `${runtimeTargets} ENTRYPOINT/CMD, ${rules === null ? "NO .dockerignore" : `${rules.length} .dockerignore rule(s)`}.`,
  );
  console.log("  (static checks only — this does not build the image)");
  process.exit(0);
}

console.error(`dockerfile/compose problems (${problems.length}):`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
