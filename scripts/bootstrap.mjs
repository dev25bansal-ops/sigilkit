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
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const REQUIRED_NODE_MAJOR = Number((pkg.engines?.node ?? ">=24").replace(/[^0-9]/g, "").slice(0, 2)) || 24;

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

function checkNpm() {
  const r = spawnSync("npm --version", { encoding: "utf8", shell: true });
  if (r.status !== 0) {
    bad("npm not found on PATH.");
    failures.push("npm missing");
    return;
  }
  ok(`npm ${r.stdout.trim()}`);
}

/** Resolves a Foundry binary from FORGE_BIN/ANVIL_BIN, PATH, or ~/.foundry/bin. */
function resolveFoundry(name) {
  const envName = `${name.toUpperCase()}_BIN`;
  if (process.env[envName] && existsSync(process.env[envName])) return process.env[envName];
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? `${name}.exe` : name);
  if (existsSync(local)) return local;
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return name;
  return null;
}

function checkFoundry() {
  step("2/4  Foundry (forge + anvil)");
  const forge = resolveFoundry("forge");
  if (!forge) {
    warn("forge not found — contract tests and the demo agent are unavailable.");
    console.log("   Install:  curl -L https://foundry.paradigm.xyz | bash && foundryup");
    console.log("   Or set:   FORGE_BIN=/path/to/forge");
    warnings.push("forge missing");
    return;
  }
  const version = spawnSync(forge, ["--version"], { encoding: "utf8" }).stdout?.trim().split("\n")[0] ?? "unknown";
  ok(`forge (${version})`);

  const anvil = resolveFoundry("anvil");
  if (anvil) ok("anvil");
  else {
    warn("anvil not found — only needed for the demo agent and the e2e smoke test.");
    warnings.push("anvil missing");
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
  // Single command string: npm's .cmd shim needs a shell on Windows, and passing an args
  // array together with `shell: true` is deprecated (DEP0190).
  const r = spawnSync(`npm ${cmd.join(" ")}`, { cwd: ROOT, stdio: "inherit", shell: true });
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
  const r = spawnSync("npm run build", { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    bad("build failed");
    failures.push("build");
    return;
  }
  for (const p of ["core", "indexer", "mcp", "demo-agent"]) {
    const dist = join(ROOT, "packages", p, "dist");
    if (existsSync(dist)) ok(`@sigilkit/${p} → dist/`);
    else warn(`@sigilkit/${p} produced no dist/`);
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
  ok("setup complete — dependencies installed and every workspace built.");
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
