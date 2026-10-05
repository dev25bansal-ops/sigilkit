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
 *            split into total declarations and those declaring `returns (bool)`, plus
 *            `present` — false when contracts/ was not there, so an all-zero count cannot
 *            pass for a measurement of an empty repository
 *   ci       workflow files with their configured job ids and display names, plus `present`
 *            for the same reason; `jobDetails` adds per-job `{name, blocking, condition}`
 *            gating posture (blocking = no `continue-on-error: true` and no `if:` gate)
 *   evidence STATIC_INVENTORY marker and the executed=false flags
 *
 * Exit codes: 0 = inventory produced, 1 = inventory could not be produced.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

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
 * Uses the `yaml` package — the same parser `validate-workflows.mjs` already guards these
 * workflows with, and the same one `check-doc-counts.mjs` counts jobs with, so all three
 * readers now agree by construction instead of by coincidence. The hand-rolled
 * indentation reader this replaced is pinned by the differential test in
 * `assurance-inventory.test.mjs`: it read `name: >-` as the literal display name `">-"`,
 * and it silently dropped a job when a job id or the `jobs:` key carried a trailing
 * comment — a quiet edit to the CI-inventory number this script publishes.
 *
 * It reports what is declared and nothing about whether the job ran.
 */
export function parseWorkflowJobs(text) {
  const jobs = jobsMapping(text);
  return Object.entries(jobs).map(([id, job]) => ({
    id,
    // An unnamed job — or a reusable-workflow call, which carries no `name:` — is
    // reported under its id, which is also what GitHub displays for it.
    name: typeof job?.name === "string" ? job.name : id,
  }));
}

/**
 * Per-job gating posture for a workflow, in the same order as `parseWorkflowJobs`.
 *
 * `blocking` is true only when the job carries neither a `continue-on-error: true`
 * nor an `if:` condition — i.e. the job runs on every trigger and can fail the run.
 * `condition` carries the `if:` expression text when one gates the job, else null.
 * This is still declared-configuration data, not a run outcome.
 */
export function parseWorkflowJobDetails(text) {
  const jobs = jobsMapping(text);
  return Object.entries(jobs).map(([id, job]) => {
    const name = typeof job?.name === "string" ? job.name : id;
    const condition = job?.if == null ? null : String(job.if);
    const continueOnError = job?.["continue-on-error"] === true;
    return { name, blocking: !continueOnError && condition === null, condition };
  });
}

/**
 * The `jobs:` mapping of a workflow, or `{}` when the file declares none.
 *
 * A non-mapping `jobs:`, a document that is not a mapping at all, and a `jobs:` block that
 * is empty are all "no jobs declared" rather than an error: this is a read-only inventory,
 * and one file it cannot interpret must not take the whole snapshot down. A genuinely
 * malformed document is a different matter — it is `validate-workflows.mjs`'s gate, which
 * fails the build, so letting the parse error propagate is safe, and it keeps a broken
 * workflow from being reported as one that simply declares no jobs.
 */
function jobsMapping(text) {
  const doc = parseYaml(text) ?? {};
  if (typeof doc !== "object" || Array.isArray(doc)) return {};
  const jobs = doc.jobs;
  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) return {};
  return jobs;
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

/**
 * Whether the two directories this inventory counts from were actually there.
 *
 * `listSolidityFiles` answers `[]` for a missing `contracts/`, and `inventoryCi` answers
 * `{files: [], jobNames: [], jobDetails: []}` for a missing `.github/workflows/`. Both are
 * the right answer to "what is in there" and both are indistinguishable from "there is
 * nothing". A snapshot taken against the wrong `--root`, or against a checkout that failed
 * halfway, therefore emitted a complete, well-formed document with every count at zero and
 * no reader could tell it apart from a real measurement of an empty repository.
 *
 * The counts themselves are unchanged — they still say what is there. This says whether there
 * was anything to count. A directory that exists but holds no matching file is `true`: that
 * is a measurement, not a missing input.
 */
export function inventoryInputs(root) {
  return {
    contracts: existsSync(join(root, "contracts")),
    workflows: existsSync(join(root, ".github", "workflows")),
  };
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

/** Reads workflow files and returns the configured job names and gating postures. */
export function inventoryCi(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return { files: [], jobNames: [], jobDetails: [] };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort((a, b) => a.localeCompare(b));
  const workflows = files.map((name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const jobs = parseWorkflowJobs(text);
    // `parseWorkflowJobs` already resolves an unnamed job to its id, so the object is
    // passed through unchanged and the published shape stays byte-identical to before.
    return { file: `.github/workflows/${name}`, jobs, jobDetails: parseWorkflowJobDetails(text) };
  });
  return {
    files: workflows,
    jobNames: workflows.flatMap((w) => w.jobs.map((j) => j.name)),
    jobDetails: workflows.flatMap((w) => w.jobDetails),
  };
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
  const inputs = inventoryInputs(root);
  return {
    schema: SCHEMA,
    kind: KIND,
    mode: KIND,
    tool: { script: "scripts/assurance-inventory.mjs", node: process.version, readOnly: true },
    git: inventoryGit(root),
    source: {
      root: "contracts",
      present: inputs.contracts,
      filesScanned: source.filesScanned,
      halmos: source.properties["check_"],
      echidna: source.properties["echidna_"],
    },
    ci: {
      present: inputs.workflows,
      jobNames: ci.jobNames,
      jobCount: ci.jobNames.length,
      // Sibling of `jobNames`, not a replacement: `jobNames` stays a plain string array
      // for consumers that read it as one, while `jobDetails` exposes per-job gating
      // posture so a configured job is not read as an enforcing one.
      jobDetails: ci.jobDetails,
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
  source.present                         false when contracts/ is missing; the counts are then empty
  ci.jobNames                            configured job names from .github/workflows/*.yml
  ci.jobDetails                          per-job {name, blocking, condition} gating posture
  ci.present                             false when .github/workflows/ is missing; counts then empty
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
