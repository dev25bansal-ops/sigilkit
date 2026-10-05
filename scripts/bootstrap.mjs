#!/usr/bin/env node
/**
 * One-command setup: check the toolchain, install dependencies, build every workspace.
 *
 *   npm run setup                # install + build
 *   npm run setup -- --no-install
 *   npm run setup -- --no-build
 *   npm run setup -- --install   # npm install instead of npm ci (locked/restricted node_modules)
 *
 * Deliberately tolerant about Foundry: the TypeScript packages (SDK, indexer, MCP) build
 * and test without it, so a missing `forge` is a warning with install instructions rather
 * than a hard failure. Contract tests and the demo agent do need it, and the summary says
 * so explicitly.
 *
 * The Foundry step probes all four executables (`forge`, `cast`, `anvil`, `chisel`) in one
 * pass and checks the standard install directory, not just PATH — see {@link probeFoundry}.
 * When they are found outside PATH it *prints* the `export`/`$env:` lines that fix that and
 * does not set them itself, for the reason in {@link exportHint}.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEngineFloor } from "./sync-facts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SKIP_INSTALL = args.includes("--no-install");
const SKIP_BUILD = args.includes("--no-build");
/**
 * `npm ci` deletes node_modules wholesale before installing. That fails on Windows when a
 * process still holds a handle inside it, and in restricted sandboxes that block bulk
 * deletion. `--install` uses `npm install` instead, which reconciles the tree in place —
 * still lockfile-driven, just not a from-scratch install.
 */
const USE_INSTALL = args.includes("--install");

const SETUP_USAGE = "usage: npm run setup [--no-install] [--no-build] [--install]";
const KNOWN_FLAGS = new Set(["--no-install", "--no-build", "--install", "--help", "-h"]);

/**
 * Reject an unrecognized argument before any step runs.
 *
 * Every flag above was read with `args.includes(...)`, so nothing noticed a flag it did not
 * know: `npm run setup -- --no-instal` — one character of typo — installed dependencies, built
 * every workspace and exited 0, while the command line said "skip the install". A flag that is
 * silently ignored is worse than one that is rejected, because the result is identical and the
 * caller has no way to tell which they got.
 *
 * Exit 2, matching the convention verify.mjs already uses: 2 means "you asked wrongly", 1 means
 * "setup did not work", and a caller scripting this has to be able to tell them apart.
 */
const strayArgs = args.filter((a) => !KNOWN_FLAGS.has(a));
if (strayArgs.length > 0) {
  process.stderr.write(`setup: unrecognized argument(s): ${strayArgs.join(", ")}\n${SETUP_USAGE}\n`);
  process.exit(2);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(SETUP_USAGE);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * The node floor this setup refuses to run below, read from the repo's own `engines.node`.
 *
 * It used to strip every non-digit out of the range and keep the first two of what was left
 * (see `legacyDigitSliceFloor` in scripts/sync-facts.mjs, kept only so a test can falsify it).
 * That is right by luck at ">=24" and silently wrong for every three-digit major: ">=100"
 * becomes "10", so a future Node 100 machine would be told it needs Node 10 and this script
 * would stop working with no failing test to point at it. `sync-facts.mjs` asserted that
 * expression as an error, so the bug was already known and merely not fixed.
 *
 * `parseEngineFloor` refuses rather than guesses: a range it cannot read as one simple lower
 * bound ("lts/*", "24.x", ">= 24 < 26") throws instead of silently defaulting. A wrong floor
 * must stop setup, because "setup ran anyway" is the failure nobody notices.
 */
const REQUIRED_NODE_MAJOR = parseEngineFloor(pkg.engines?.node).major;

const c = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);
const bad = (m) => console.log(`${c.red}✗${c.reset} ${m}`);
const step = (m) => console.log(`\n${c.bold}${c.cyan}${m}${c.reset}`);

const failures = [];
const warnings = [];

function checkNode() {
  step("1/4  Node.js");
  const major = Number(process.version.slice(1).split(".")[0]);
  if (major < REQUIRED_NODE_MAJOR) {
    bad(`Node ${process.version} found, but this project requires >=${REQUIRED_NODE_MAJOR}.`);
    console.log(`   Install Node ${REQUIRED_NODE_MAJOR}: https://nodejs.org/  (or use \`nvm use\` — .nvmrc is committed)`);
    failures.push(`node ${process.version} < ${REQUIRED_NODE_MAJOR}`);
    return;
  }
  ok(`Node ${process.version}`);
}

/**
 * The npm invocation, as `[command, prefixArgs]` with NO shell.
 *
 * SEC-11: the three call sites below used to build one command *string* and run it with
 * `shell: true`. A shell re-parses its input, so every argument became shell syntax and any
 * `;`/`` ` ``/`$()` in it executed. `npm run build` reads `package.json` — which a pull
 * request can edit — so a PR that put a `;` into a workspace name or a build script would get
 * arbitrary command execution as whoever ran setup. Nothing here needs a shell.
 *
 * The shell cannot simply be dropped, because on Windows `npm` is `npm.cmd` and Node refuses
 * to spawn a `.cmd` with an args array and no shell (EINVAL — the CVE-2024-27980 mitigation).
 * So this resolves npm's *JavaScript entry point* and runs it with the current `node`, giving a
 * real argv array end to end: no shell, no re-parsing, no `PATHEXT` resolution.
 *
 * Order, first existing wins: `npm_execpath` (set when this script is itself started by npm,
 * naming the exact npm that launched us), then `<dirname(node)>/…/npm/bin/npm-cli.js`.
 * Falling back to the bare name still fails loudly rather than silently using a shell.
 */
function resolveNpm() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [process.execPath, [candidate]];
  }
  return [process.platform === "win32" ? "npm.cmd" : "npm", []];
}

const NPM = resolveNpm();

function checkNpm() {
  const r = spawnSync(NPM[0], [...NPM[1], "--version"], { encoding: "utf8" });
  if (r.status !== 0) {
    bad("npm not found on PATH.");
    failures.push("npm missing");
    return;
  }
  ok(`npm ${r.stdout.trim()}`);
}

/**
 * The four Foundry executables, probed together.
 *
 * `cast`, `anvil` and `chisel` are probed in the same pass as `forge` because they ship as one
 * archive into one directory. An earlier version of this file probed only `forge` and `anvil`,
 * which produced a report saying "cast unavailable" on a machine where all four were installed
 * at `~/.foundry/bin/` — the probe answered "is it on PATH" when the real question was "does it
 * exist at the standard install location". {@link probeFoundry} asks the second question.
 */
const FOUNDRY_TOOLS = ["forge", "cast", "anvil", "chisel"];

/**
 * Resolves one Foundry executable, preferring an explicit `FOUNDRY_BIN`-style override.
 *
 * The `<NAME>_BIN` environment variable wins over everything, so an explicit
 * `FORGE_BIN=/some/other/forge` is never overridden by the `~/.foundry/bin` guess. That ordering
 * matters: a caller who names a binary is stating a fact, and a probe must not overrule it.
 *
 * `existsSync` is deliberately **not** the test. It reports "this path resolved to something",
 * which is true for a dangling symlink and for a junction whose target is gone — so a
 * `FOUNDRY_BIN` pointing at a stale link passes `existsSync` and then fails at `spawn` with an
 * error that names the symlink rather than the cause. `statSync` follows the link, so it
 * answers the question actually being asked: does a *usable* file live here. See
 * `docs/TROUBLESHOOTING.md` → "Test-Path / existsSync says a path is fine, but using it fails".
 *
 * @param {string} name bare tool name, e.g. `forge`
 * @param {NodeJS.ProcessEnv} [env] injected in tests to exercise both branches
 * @returns {string|null} an absolute path or the bare name; `null` when not found anywhere
 */
function resolveFoundry(name, env = process.env) {
  const envName = `${name.toUpperCase()}_BIN`;
  const override = env[envName];
  if (override && isUsableFile(override)) return override;

  const local = join(foundryBinDir(), foundryExeName(name));
  if (isUsableFile(local)) return local;

  // Last resort: PATH. Checked by running it, because a bare name that resolves to a broken
  // shim on Windows still "exists" and would otherwise be reported as a working tool.
  const probe = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true });
  if (!probe.error && probe.status === 0) return name;
  return null;
}

/**
 * True when `p` is a file that can actually be executed — not merely a path that resolved.
 *
 * The distinction is the whole point of this function. `existsSync` is true for a dangling
 * symlink, so a stale `FORGE_BIN` would pass it and fail later at `spawn` with a message that
 * blames the tool. `statSync` follows links, so a link with no target throws `ENOENT` here,
 * where the message can still name the variable that needs fixing.
 *
 * A directory is also rejected: a `FORGE_BIN` pointing at `~/.foundry/bin` is a plausible
 * mistake and would otherwise survive every existence check.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isUsableFile(p) {
  if (typeof p !== "string" || p === "") return false;
  try {
    return statSync(p).isFile();
  } catch {
    // ENOENT, EACCES, ELOOP, and on Windows the UNKNOWN (errno -4094) that a reparse point
    // with a missing target raises. All of them mean the same thing here: not usable.
    return false;
  }
}

/**
 * Probes all four Foundry executables in one pass.
 *
 * @param {NodeJS.ProcessEnv} [env] injected in tests
 * @returns {{found: Object<string,string>, missing: string[], dir: string|null}}
 *   `dir` is the standard install directory when at least one tool was found there, so the
 *   caller can print a copy-pasteable export line instead of four separate paths.
 */
export function probeFoundry(env = process.env) {
  const found = {};
  for (const name of FOUNDRY_TOOLS) {
    const resolved = resolveFoundry(name, env);
    if (resolved !== null) found[name] = resolved;
  }
  const missing = FOUNDRY_TOOLS.filter((name) => !(name in found));
  return { found, missing, dir: foundryBinDir() };
}

/** The standard Foundry install directory for this platform. */
function foundryBinDir() {
  return join(homedir(), ".foundry", "bin");
}

/** The on-disk file name of a Foundry tool — Windows ships `.exe`, POSIX does not. */
function foundryExeName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * The copy-pasteable lines that make the probe stick.
 *
 * Deliberately **printed, never applied**. Writing `process.env.FORGE_BIN = …` inside this
 * process would make `checkFoundry` report a green forge while every later step — and every
 * sibling script that reads the same variable, `check-doc-counts.mjs:42` among them — still saw
 * no forge at all. The agent would then report "forge resolved", and the next command would fail
 * with "command not found": a *second* false report manufactured by the fix for the first one.
 * Setting an env var in a child process cannot reach the parent shell, full stop, so the only
 * honest options are to print the line or to write a file the developer opts into sourcing.
 *
 * @param {string} dir the directory the tools were found in
 * @returns {string} lines to paste into the current shell
 */
function exportHint(dir) {
  const lines = process.platform === "win32"
    ? ["# PowerShell — this session only; add to $PROFILE to persist"]
    : ["# sh/bash/zsh — this session only; add to ~/.bashrc to persist"];
  for (const name of FOUNDRY_TOOLS) {
    const path = join(dir, foundryExeName(name));
    lines.push(
      process.platform === "win32"
        ? `$env:${name.toUpperCase()}_BIN="${path}"`
        : `export ${name.toUpperCase()}_BIN="${path}"`,
    );
  }
  return lines.join("\n");
}

function checkFoundry() {
  step("2/4  Foundry (forge + cast + anvil + chisel)");
  const { found, missing, dir } = probeFoundry();

  if (Object.keys(found).length === 0) {
    warn("no Foundry tools found — contract tests and the demo agent are unavailable.");
    console.log("   Install:  curl -L https://foundry.paradigm.xyz | bash && foundryup");
    console.log("   Or set:   FORGE_BIN=/path/to/forge");
    console.log(`   Looked in PATH and in ${dir}`);
    warnings.push("foundry missing");
    return;
  }

  // Version comes from the resolved path, so the number printed is the number that will run.
  const forge = found.forge;
  if (forge) {
    const version = spawnSync(forge, ["--version"], { encoding: "utf8", windowsHide: true })
      .stdout?.trim().split("\n")[0] ?? "unknown";
    ok(`forge (${version})`);
  } else {
    warn("forge not found — contract tests and the demo agent are unavailable.");
    warnings.push("forge missing");
  }

  // The three companions are reported as a group: they are installed as one archive, so
  // "foundry is half-installed" is the only interesting state, and listing each separately
  // invited the reading that a missing `cast` meant a missing toolchain.
  const companions = FOUNDRY_TOOLS.filter((n) => n !== "forge" && n in found);
  if (companions.length > 0) ok(`${companions.join(", ")}`);
  if (missing.length > 0) {
    warn(`not on this machine: ${missing.join(", ")}`);
    warnings.push(`${missing.join("/")} not found`);
  }

  // The probe answered "does it exist", which is not the same as "will the next command find
  // it". When the tools came from ~/.foundry/bin and are not on PATH, say so and hand over the
  // exact line that fixes it — printed, not applied, for the reason in {@link exportHint}.
  if (dir && found.forge === join(dir, foundryExeName("forge"))) {
    console.log(`   ${c.dim}found in ${dir}, which is not on PATH — for this shell:${c.reset}`);
    console.log(exportHint(dir).split("\n").map((l) => `   ${c.cyan}${l}${c.reset}`).join("\n"));
  }
}

function install() {
  step("3/4  Dependencies");
  if (SKIP_INSTALL) {
    warn("skipped (--no-install)");
    return;
  }
  const hasLock = existsSync(join(ROOT, "package-lock.json"));
  const cmd = hasLock && !USE_INSTALL ? ["ci"] : ["install"];
  console.log(`${c.dim}$ npm ${cmd.join(" ")}${c.reset}`);
  // SEC-11: an argv array, never a command string. See {@link resolveNpm} for why npm still
  // runs correctly on Windows without a shell.
  const r = spawnSync(NPM[0], [...NPM[1], ...cmd], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    bad(`npm ${cmd.join(" ")} failed`);
    if (cmd[0] === "ci") {
      console.log(
        `\n${c.yellow}hint:${c.reset} \`npm ci\` replaces node_modules wholesale, which fails when a file is\n` +
          `      still locked (Windows) or bulk deletion is restricted. Retry with:\n` +
          `        ${c.cyan}npm run setup -- --install${c.reset}`,
      );
    }
    failures.push("dependency install");
    return;
  }
  ok(hasLock ? (USE_INSTALL ? "installed from lockfile (in-place)" : "installed from lockfile (reproducible)") : "installed (no lockfile present)");
}

function build() {
  step("4/4  Build");
  if (SKIP_BUILD) {
    warn("skipped (--no-build)");
    return;
  }
  const r = spawnSync(NPM[0], [...NPM[1], "run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    bad("build failed");
    failures.push("build");
    return;
  }
  // A build that exits 0 without producing a dist/ has not built. Reporting a missing dist/ as
  // a warning let the summary print "every workspace built" over a tree where none of them
  // had: `npm run build --workspaces --if-present` succeeds trivially when a workspace has no
  // build script, when its tsc run emitted nothing, or when the output landed elsewhere — and
  // `npm run verify` then failed much later on a missing dist/index.js, a long way from the
  // step that caused it. Missing output is a build failure: it goes to `failures` and the
  // process exits 1. This only ever strengthens the check.
  for (const p of ["core", "indexer", "mcp", "demo-agent"]) {
    const dist = join(ROOT, "packages", p, "dist");
    if (existsSync(dist)) {
      ok(`@sigilkit/${p} → dist/`);
    } else {
      bad(`@sigilkit/${p} produced no dist/`);
      failures.push(`build (@sigilkit/${p}: no dist/)`);
    }
  }
}

console.log(`${c.bold}SigilKit bootstrap${c.reset}`);
checkNode();
checkNpm();
checkFoundry();
install();
build();

console.log(`\n${c.bold}Summary${c.reset}`);
if (failures.length === 0) {
  // A run that installed nothing and built nothing must not say it did both. `--no-install
  // --no-build` is a real, supported invocation (it is how you check the toolchain alone), and
  // claiming "dependencies installed and every workspace built" there is a green report for a
  // run that performed no work — the same "it said it did the thing but didn't" failure the
  // clean.mjs confirmation guard exists to prevent.
  const skippedWork = SKIP_INSTALL && SKIP_BUILD;
  if (skippedWork) warn("toolchain checked only — install and build were both skipped.");
  else ok("setup complete — dependencies installed and every workspace built.");
  console.log("\nNext steps:");
  console.log(`  ${c.cyan}npm run verify${c.reset}                 run the full gate (lint + docs + tests)`);
  console.log(`  ${c.cyan}npm run demo${c.reset}                   deploy + run the demo agent (needs anvil)`);
  console.log(`  ${c.cyan}npm test --workspace @sigilkit/core${c.reset}  SDK conformance suite`);
  if (warnings.length > 0) console.log(`\n${c.yellow}Warnings:${c.reset} ${warnings.join(", ")}`);
  process.exit(0);
} else {
  bad(`setup finished with ${failures.length} problem(s): ${failures.join(", ")}`);
  process.exit(1);
}
