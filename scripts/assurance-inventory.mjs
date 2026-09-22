#!/usr/bin/env node
/**
 * Assurance inventory (read-only).
 *
 * Mode: STATIC_INVENTORY — this script reads files and prints a JSON snapshot to stdout.
 * It executes nothing: Halmos and Slither are NOT run, no fuzzer is started, and no CI
 * run result is consulted. Configured CI job names are reported exactly as they are
 * declared in the workflow YAML; a declared job is not a passing job, so no green badge
 * is inferred from this output.
 *
 * Usage:
 *   node scripts/assurance-inventory.mjs [--root <dir>] [--compact]
 *   node scripts/assurance-inventory.mjs --help
 *
 * Options:
 *   --root <dir>   Repository root to inspect (default: this script's parent directory).
 *   --compact      Emit single-line JSON instead of the pretty-printed form.
 *   -h, --help     Print this help (documents the STATIC_INVENTORY mode) and exit.
 *
 * Output (stdout, JSON):
 *   git      commit hash when the repository is readable, plus a dirty flag
 *   source   counts of Solidity `check_*` (Halmos) and `echidna_*` property functions,
 *            split into total declarations and those declaring `returns (bool)`
 *   ci       workflow files with their configured job ids and display names
 *   evidence STATIC_INVENTORY marker and the executed=false flags
 *
 * Exit codes: 0 = inventory produced, 1 = inventory could not be produced.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const KIND = "STATIC_INVENTORY";
export const SCHEMA = "sigilkit.assurance-inventory/1";

/** Property-function prefixes and the tool each one belongs to. */
const PREFIXES = [
  { prefix: "check_", tool: "halmos" },
  { prefix: "echidna_", tool: "echidna" },
];

/**
 * Scans a Solidity source string for function declarations.
 *
 * Returns `[{ name, signature }]` where `signature` is the text from the `function`
 * keyword up to the body brace or the terminating semicolon. Comments and string
 * literals are skipped so a prefix mentioned in a comment is never counted.
 */
export function scanFunctionDeclarations(source) {
  const found = [];
  const declaration = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/y;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i) + 1;
      continue;
    }
    // A declaration cannot be glued to a preceding identifier (`myfunction foo(`).
    const boundary = i === 0 || !/[A-Za-z0-9_$]/.test(source[i - 1]);
    if (boundary) {
      declaration.lastIndex = i;
      const match = declaration.exec(source);
      if (match) {
        const end = findSignatureEnd(source, i + match[0].length - 1);
        found.push({ name: match[1], signature: source.slice(i, end) });
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

/** Index just past the signature that starts at `from` (the opening paren). */
function findSignatureEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) return source.length;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && (ch === "{" || ch === ";")) return i;
  }
  return source.length;
}

/** Index of the closing quote of the string literal starting at `from`. */
function skipString(source, from) {
  const quote = source[from];
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === quote) return i;
    if (source[i] === "\n") return i;
  }
  return source.length;
}

/** True when a declaration signature declares a boolean return. */
export function returnsBool(signature) {
  return /returns\s*\(\s*bool\b/.test(signature);
}

/**
 * Counts property functions per prefix in one file.
 * Returns `{ [prefix]: { functions, boolFunctions } }`.
 */
export function countPropertiesInSource(source) {
  const declarations = scanFunctionDeclarations(source);
  const result = {};
  for (const { prefix } of PREFIXES) {
    const hits = declarations.filter((d) => d.name.startsWith(prefix));
    result[prefix] = {
      functions: hits.length,
      boolFunctions: hits.filter((d) => returnsBool(d.signature)).length,
    };
  }
  return result;
}

/**
 * Parses a GitHub Actions workflow and returns its configured jobs in file order.
 *
 * A deliberately small reader: it walks the top-level `jobs:` block and takes each
 * 2-space-indented key as a job id and that job's first 4-space-indented `name:` as its
 * display name. It reports what is declared and nothing about whether the job ran.
 */
export function parseWorkflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inJobs = line.trim() === "jobs:";
      current = null;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = indent === 2 ? /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim()) : null;
    if (jobMatch) {
      current = { id: jobMatch[1], name: null };
      jobs.push(current);
      continue;
    }
    if (current && current.name === null && indent === 4) {
      const nameMatch = /^name:\s*(.+?)\s*$/.exec(line.trim());
      if (nameMatch) current.name = unquote(nameMatch[1]);
    }
  }
  return jobs;
}

/** Strips one layer of matching quotes from a YAML scalar. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Recursively lists `.sol` files under `dir`, sorted, as root-relative posix paths. */
export function listSolidityFiles(root, dir = join(root, "contracts")) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "lib" || entry.name === "node_modules" || entry.name === "out") continue;
      out.push(...listSolidityFiles(root, full));
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

/** Reads every `.sol` file and totals the property functions per prefix. */
export function inventorySource(root) {
  const files = listSolidityFiles(root);
  const totals = {};
  for (const { prefix, tool } of PREFIXES) {
    totals[prefix] = { tool, functions: 0, boolFunctions: 0, files: {} };
  }
  for (const rel of files) {
    const counts = countPropertiesInSource(readFileSync(join(root, rel), "utf8"));
    for (const { prefix } of PREFIXES) {
      const { functions, boolFunctions } = counts[prefix];
      if (functions === 0) continue;
      totals[prefix].functions += functions;
      totals[prefix].boolFunctions += boolFunctions;
      totals[prefix].files[rel] = { functions, boolFunctions };
    }
  }
  return { filesScanned: files.length, properties: totals };
}

/** Reads workflow files and returns the configured job names, per file. */
export function inventoryCi(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return { files: [], jobNames: [] };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort((a, b) => a.localeCompare(b));
  const workflows = files.map((name) => {
    const jobs = parseWorkflowJobs(readFileSync(join(dir, name), "utf8"));
    return {
      file: `.github/workflows/${name}`,
      jobs: jobs.map((job) => ({ id: job.id, name: job.name ?? job.id })),
    };
  });
  return { files: workflows, jobNames: workflows.flatMap((w) => w.jobs.map((j) => j.name)) };
}

/** Best-effort git identity. Never throws: a missing git is reported, not fatal. */
export function inventoryGit(root) {
  const commit = run(root, ["rev-parse", "HEAD"]);
  if (commit === null) return { available: false, commit: null, dirty: null };
  const status = run(root, ["status", "--porcelain"]);
  return { available: true, commit, dirty: status === null ? null : status !== "" };
}

function run(cwd, args) {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

/** Builds the full inventory object. */
export function buildInventory(root) {
  const source = inventorySource(root);
  const ci = inventoryCi(root);
  return {
    schema: SCHEMA,
    kind: KIND,
    mode: KIND,
    tool: { script: "scripts/assurance-inventory.mjs", node: process.version, readOnly: true },
    git: inventoryGit(root),
    source: {
      root: "contracts",
      filesScanned: source.filesScanned,
      halmos: source.properties["check_"],
      echidna: source.properties["echidna_"],
    },
    ci: {
      jobNames: ci.jobNames,
      jobCount: ci.jobNames.length,
      workflows: ci.files,
    },
    evidence: {
      kind: KIND,
      executed: { halmos: false, slither: false, echidna: false, forge: false },
      ciStatusInferred: false,
      notes: [
        "Static inventory only: files were read, no tool was executed.",
        "Halmos was NOT executed; check_ counts are source declarations, not verified specs.",
        "Slither was NOT executed; no analysis result is asserted here.",
        "CI job names are as declared in workflow YAML; no run outcome or green badge is inferred.",
      ],
    },
  };
}

const HELP = `assurance-inventory — read-only assurance snapshot

Mode: STATIC_INVENTORY
  Reads source and workflow files and prints JSON to stdout. Executes nothing:
  Halmos and Slither are not run, no fuzzer is started, and no CI run result is
  consulted. Declared CI jobs are listed as configured; passing status is not
  inferred and no green badge is claimed.

Usage:
  node scripts/assurance-inventory.mjs [options]

Options:
  --root <dir>   Repository root to inspect (default: this script's parent directory).
  --compact      Emit single-line JSON instead of the pretty-printed form.
  -h, --help     Print this help and exit.

Reports:
  git.commit / git.dirty                 revision when the repo is readable
  source.halmos / source.echidna         check_* and echidna_* declarations, bool vs total
  ci.jobNames                            configured job names from .github/workflows/*.yml
  evidence                               STATIC_INVENTORY marker, executed flags false
`;

function parseArgs(argv) {
  const options = { root: join(dirname(fileURLToPath(import.meta.url)), ".."), compact: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--compact") options.compact = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a directory");
      options.root = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`assurance-inventory: ${error.message}\n`);
    process.stderr.write("Run with --help for usage.\n");
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!existsSync(options.root) || !statSync(options.root).isDirectory()) {
    process.stderr.write(`assurance-inventory: not a directory: ${options.root}\n`);
    return 1;
  }
  const inventory = buildInventory(options.root);
  process.stdout.write(
    options.compact ? `${JSON.stringify(inventory)}\n` : `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
