#!/usr/bin/env node
/**
 * Workflow validator (TD-9).
 *
 * Guards against the defect class that silently disabled every CI job in this repo:
 * a mis-indented step made `.github/workflows/ci.yml` unparseable, and GitHub rejects
 * the ENTIRE workflow file rather than skipping the offending step — so ten jobs went
 * dark with no signal anywhere in the repository.
 *
 * Two layers:
 *   1. Parse every workflow with a real YAML parser (a parse error is fatal).
 *   2. Structurally assert the shape GitHub requires, which catches the subtler
 *      variant where the YAML *does* parse but a step was folded into a scalar
 *      (e.g. `working-directory: packages/core - uses: actions/upload-artifact@v4`).
 *
 * Exits non-zero with a file:line:col pointer on the first failure of each kind.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".github", "workflows");

// This gate inspects the repository it is *installed in*, and takes no options. A `--root`
// would read as "check that other tree" and be silently dropped, so a caller would get a
// clean verdict about a repository it never looked at. Rejecting is the honest answer: a
// caller that meant another checkout can `cd` there, and one that mistyped a flag learns so.
// Exit 2 = "could not run as asked", which is what this is — never a finding, never a pass.
// Written inline instead of via `reportUsage` from `scripts/lib/exit.mjs` on purpose: this
// script is copied *alone* into fixture repositories by its own test suite
// (`validate-workflows.test.mjs:50-60`), so importing a sibling module would make every one
// of those fixtures fail to load with ERR_MODULE_NOT_FOUND. Two duplicated lines beat a
// broken suite — and the contract is already spelled out once, in `scripts/lib/exit.mjs:4-13`.
if (process.argv.length > 2) {
  console.error(`validate-workflows: takes no arguments, got ${process.argv.slice(2).join(" ")}`);
  console.error(`it validates the workflows in the repository this script lives in (${DIR}).`);
  process.exit(2);
}

if (!existsSync(DIR)) {
  console.error(`no workflow directory at ${DIR}`);
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
if (files.length === 0) {
  console.error(`no workflow files found in ${DIR}`);
  process.exit(1);
}

let failed = 0;
const problems = [];

function fail(file, message, pos) {
  failed++;
  const where = pos ? `${file}:${pos.line}:${pos.col}` : file;
  problems.push(`${where}  ${message}`);
}

for (const name of files.sort()) {
  const path = join(DIR, name);
  const text = readFileSync(path, "utf8");
  const doc = parseDocument(text, { prettyErrors: true });

  // Layer 1 — parse.
  for (const err of doc.errors) {
    const lp = Array.isArray(err.linePos) ? err.linePos[0] : null;
    fail(name, `YAML parse error: ${err.message.split("\n")[0]}`, lp);
  }
  if (doc.errors.length > 0) continue;

  const wf = doc.toJS() ?? {};

  // Layer 2 — structural shape.
  if (!wf.jobs || typeof wf.jobs !== "object" || Array.isArray(wf.jobs)) {
    fail(name, "workflow has no `jobs` mapping");
    continue;
  }

  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const at = `${name} → jobs.${jobName}`;
    if (!job || typeof job !== "object") {
      fail(at, "job is not a mapping");
      continue;
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      fail(at, "job has no `steps` list");
      continue;
    }
    job.steps.forEach((step, i) => {
      const at2 = `${at}.steps[${i}]`;
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        fail(at2, "step is not a mapping (likely a mis-indented or folded step)");
        return;
      }
      const keys = Object.keys(step);
      const hasUses = keys.includes("uses");
      const hasRun = keys.includes("run");
      if (hasUses && hasRun) {
        fail(at2, "step declares both `uses` and `run`");
      } else if (!hasUses && !hasRun) {
        fail(at2, `step has neither \`uses\` nor \`run\` (keys: ${keys.join(", ") || "none"})`);
      }
      if (hasRun && typeof step.run !== "string") {
        fail(at2, `\`run\` must be a string, got ${Array.isArray(step.run) ? "array" : typeof step.run}`);
      }
      // A folded step often leaves a stray key glued to the previous scalar.
      if (typeof step["working-directory"] === "string" && /\s-\s|\buses:/.test(step["working-directory"])) {
        fail(at2, `\`working-directory\` looks like it swallowed a following step: ${JSON.stringify(step["working-directory"])}`);
      }
    });
  }
}

if (failed > 0) {
  console.error(`workflow validation FAILED — ${failed} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`workflow validation OK — ${files.length} file(s): ${files.join(", ")}`);
