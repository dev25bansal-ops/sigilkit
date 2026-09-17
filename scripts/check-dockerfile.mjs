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
 * It does NOT build the image; it cannot catch a bad base tag or a failing `npm ci`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = join(ROOT, "Dockerfile");
const DOCKERIGNORE = join(ROOT, ".dockerignore");
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

/** Loads `.dockerignore` patterns, ignoring comments and blanks. */
function dockerignorePatterns() {
  if (!existsSync(DOCKERIGNORE)) return [];
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

if (!existsSync(DOCKERFILE)) {
  console.error("Dockerfile: not found");
  process.exit(1);
}

const lines = instructions(readFileSync(DOCKERFILE, "utf8"));
const rules = dockerignorePatterns();

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
  const match = /^packages\/([^/]+)\/dist\/(.+)\.(js|mjs|cjs)$/.exec(target);
  if (!match) return false;
  const [, pkg, stem, extension] = match;
  if (stem.split("/").some((part) => part === "." || part === ".." || part === "")) return false;
  if (existsSync(join(ROOT, "packages", pkg, "dist"))) return false;
  const sourceExtension = { js: "ts", mjs: "mts", cjs: "cts" }[extension];
  return existsSync(join(ROOT, "packages", pkg, "src", `${stem}.${sourceExtension}`));
}

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
  if (!target || !/\.(js|mjs|cjs)$/.test(target)) return;
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
    const script = parts.find((p) => /\.(js|mjs|cjs)$/.test(p));
    if (!script) continue;
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
      `${runtimeTargets} ENTRYPOINT/CMD, ${rules.length} .dockerignore rule(s).`,
  );
  console.log("  (static checks only — this does not build the image)");
  process.exit(0);
}

console.error(`dockerfile/compose problems (${problems.length}):`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
