#!/usr/bin/env node
/**
 * The full local gate, in one command: workflow lint, doc-count drift, typecheck, build,
 * contract tests, TypeScript tests.
 *
 *   npm run verify              # everything
 *   npm run verify -- --quick   # skip the Foundry suites (fast inner loop)
 *   npm run verify -- --no-forge
 *
 * Each step is independent: a failure is recorded and reported, the remaining steps still
 * run, and the exit code is 1 if anything failed. That way one run tells you everything
 * that is broken instead of only the first thing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const NO_FORGE = QUICK || args.includes("--no-forge");

/**
 * Gate step labels, in execution order — the single source of truth for `--only`
 * matching, `--only` validation, and the results report. Declared before any step
 * runs so a selector can be checked against the real label set up front.
 */
const LABELS = {
  lint: "workflow lint",
  packaging: "container packaging",
  docs: "doc counts",
  typecheck: "workspace typecheck",
  build: "workspace build",
  contracts: "contract tests (unit + fuzz)",
  tests: "TypeScript tests",
};
const STEPS = Object.values(LABELS);

let ONLY;

const c = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
};

// ── flag validation ───────────────────────────────────────────────────────────
// Reject a bad invocation before any step runs, so `--only=<typo>` can never silently
// run zero steps and exit 0, and `--only=` can never fall back to running everything.
function abort(message) {
  process.stderr.write(`${c.red}${c.bold}verify: ${message}${c.reset}\n`);
  process.stderr.write(`${c.dim}usage: verify [--quick] [--no-forge] [--only=<label>]${c.reset}\n`);
  process.exit(2);
}

const strayArgs = args.filter((a) => a !== "--quick" && a !== "--no-forge" && !a.startsWith("--only="));
if (strayArgs.length > 0) abort(`unrecognized argument(s): ${strayArgs.join(", ")}`);

const onlyFlags = args.filter((a) => a.startsWith("--only="));
if (onlyFlags.length > 1) abort("--only may be given at most once");

if (onlyFlags.length === 1) {
  ONLY = onlyFlags[0].slice("--only=".length);
  if (ONLY.trim() === "") {
    abort(`--only needs a non-empty selector; known labels: ${STEPS.join(" | ")}`);
  }
  const matched = STEPS.filter((label) => label.toLowerCase().includes(ONLY.toLowerCase()));
  if (matched.length === 0) {
    abort(`--only=${ONLY} matches no step; known labels: ${STEPS.join(" | ")}`);
  }
}

/** True when no selector was given, or when `label` matches the selector. */
function matchesOnly(label) {
  return ONLY === undefined || label.toLowerCase().includes(ONLY.toLowerCase());
}

function resolveForge() {
  if (process.env.FORGE_BIN && existsSync(process.env.FORGE_BIN)) return process.env.FORGE_BIN;
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge");
  if (existsSync(local)) return local;
  const probe = spawnSync("forge", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "forge" : null;
}

const FORGE = resolveForge();
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs one gate step and records the outcome.
 *
 * `shell` is opt-in and used only for npm: on Windows, .cmd shims need a shell, but a
 * shell would also reinterpret the `|` inside `--no-match-contract '.*Invariant|.*Fork'`
 * as a pipe, and mangle an absolute `C:/…` executable path. Node and forge are launched
 * directly instead.
 */
function run(label, cmd, argv, opts = {}) {
  if (!matchesOnly(label)) return null;
  const started = Date.now();
  process.stdout.write(`\n${c.bold}${c.cyan}▶ ${label}${c.reset}\n${c.dim}$ ${cmd} ${argv.join(" ")}${c.reset}\n`);
  const spawnOpts = {
    cwd: ROOT,
    stdio: "inherit",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  };
  // Passing an args array together with `shell: true` is deprecated (DEP0190) because the
  // arguments are concatenated rather than escaped. When a shell is required — only for
  // npm's .cmd shims on Windows — build the command string instead.
  const r = opts.shell
    ? spawnSync([cmd, ...argv].join(" "), { ...spawnOpts, shell: true })
    : spawnSync(cmd, argv, spawnOpts);
  if (r.error) process.stdout.write(`${c.red}${r.error.message}${c.reset}\n`);
  const ms = Date.now() - started;
  const passed = r.status === 0;
  results.push({ label, passed, ms, skipped: false });
  return passed;
}

const results = [];

function skip(label, why) {
  if (!matchesOnly(label)) return;
  results.push({ label, passed: true, ms: 0, skipped: true, why });
}

console.log(`${c.bold}SigilKit verification${c.reset}${QUICK ? c.dim + "  (quick: Foundry suites skipped)" + c.reset : ""}`);

run(LABELS.lint, process.execPath, ["scripts/validate-workflows.mjs"]);
run(LABELS.packaging, process.execPath, ["scripts/check-dockerfile.mjs"]);
run(LABELS.docs, process.execPath, ["scripts/check-doc-counts.mjs"], FORGE ? { env: { FORGE_BIN: FORGE } } : {});
run(LABELS.typecheck, npmCmd, ["run", "lint", "--workspaces", "--if-present"], { shell: true });
run(LABELS.build, npmCmd, ["run", "build", "--workspaces", "--if-present"], { shell: true });

if (NO_FORGE) {
  skip(LABELS.contracts, QUICK ? "--quick" : "--no-forge");
} else if (!FORGE) {
  skip(LABELS.contracts, "forge not installed");
  console.log(`\n${c.yellow}!${c.reset} forge not found — skipping contract tests. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup`);
} else {
  run(LABELS.contracts, FORGE, ["test", "--no-match-contract", ".*Invariant|.*Fork"]);
}

run(LABELS.tests, npmCmd, ["test", "--workspaces", "--if-present"], { shell: true });

// ── report ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.passed);
const ran = results.filter((r) => !r.skipped);

console.log(`\n${c.bold}Results${c.reset}`);
const width = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  const mark = r.skipped ? `${c.yellow}skip${c.reset}` : r.passed ? `${c.green}pass${c.reset}` : `${c.red}FAIL${c.reset}`;
  const time = r.skipped ? `${c.dim}—${c.reset}` : `${c.dim}${(r.ms / 1000).toFixed(1)}s${c.reset}`;
  const why = r.skipped && r.why ? ` ${c.dim}(${r.why})${c.reset}` : "";
  console.log(`  ${mark}  ${r.label.padEnd(width)}  ${time}${why}`);
}

if (failed.length > 0) {
  console.log(`\n${c.red}${c.bold}${failed.length} of ${ran.length} check(s) failed:${c.reset} ${failed.map((f) => f.label).join(", ")}`);
  process.exit(1);
}
console.log(`\n${c.green}${c.bold}All ${ran.length} check(s) passed.${c.reset}`);
