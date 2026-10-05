#!/usr/bin/env node
/**
 * CI waiver guard (TD-6 follow-up).
 *
 * `docs/CI-WAIVERS.md` is a real register: dated removal criteria, hard expiries, and
 * rule #3 ("red runs don't reset silently"). Before this script it was unenforced paper
 * work — adding `continue-on-error: true` to a job without adding a row was invisible,
 * and an expired row never turned any job red. Governance that cannot fail a build is
 * not governance, so this is the machine half of the register: the `workflow-lint` job
 * runs it, and a failure blocks the PR.
 *
 * Checks, all derived from the register's own rules:
 *   1. Every job-level `continue-on-error: true` in `.github/workflows/*.y(a)ml` has a
 *      register row                                                   → FAIL (rule #1)
 *   2. A register row with no matching waiver left is stale            → WARN
 *      (--strict → FAIL), because the register must be deleted the day the waiver is
 *   3. A register row whose Expiry has passed while the waiver is still
 *      `continue-on-error: true` in YAML                                → FAIL (rule #2):
 *      remove it, or replace the row with a written justification + a new dated criterion
 *   4. `continue-on-error` used in a confusing place                     → WARN:
 *      - step-level only: an ungoverned second way to make a check non-blocking
 *      - job-level *and* step-level in one job: redundant, and it hides which step is unreliable
 *      - a non-literal value (`${{ ... }}`): not machine-verifiable
 *
 * Expiry semantics follow the register: "Expiry is a deadline, not a suggestion" and
 * ci.yml's own wording is "remove on or after <expiry>", so a waiver is expired once
 * `today >= expiry`. Dates are compared as UTC calendar days, so the result never
 * depends on the runner's timezone.
 *
 * The join key between the two sides is the job name (as written in the job cell of the
 * register's table). The search covers every workflow file, not just `ci.yml`, so a
 * waiver added to a new workflow is checked the same way.
 *
 * Table selection is deliberately narrow: a table is the waiver register only if its
 * header has a `Job…`, a `Waiver…` and an `Expiry…` column. `docs/CI-WAIVERS.md` also
 * carries a static-analysis triage table with a "Criterion to remove" and an "Expiry"
 * column; those rows describe Slither findings, not CI jobs, and must never be read as
 * stale waivers. If no waiver table is found at all this script fails closed — deleting
 * or mangling the table must not turn the check green.
 *
 * Exit code: 0 clean (warnings allowed), 1 on any failure, 2 when the check could not run
 * as asked (an unrecognised argument). Flags: `--strict` escalates stale rows, unknown job
 * names and step-level `continue-on-error` to failures; `--today=YYYY-MM-DD` overrides the
 * evaluation date for rehearsing an expiry locally.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument, isCollection, isPair, isScalar } from "yaml";

import { messageOf, reportUsage } from "./lib/exit.mjs";
import { parseArgs, usage } from "./lib/cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const REGISTER = join(ROOT, "docs", "CI-WAIVERS.md");
const MS_PER_DAY = 86_400_000;

const TOOL = "check-waivers";

/** The flags this gate accepts. Anything else is a usage error, not a silently dropped token. */
const FLAGS = Object.freeze({
  strict: { type: "boolean", describe: "escalate stale rows, unknown job names and step-level continue-on-error to failures" },
  today: { type: "string", placeholder: "YYYY-MM-DD", describe: "evaluate expiry as of this UTC date" },
});

const USAGE = usage([`usage: ${TOOL} [--strict] [--today=YYYY-MM-DD]`], FLAGS);

// --- dates ------------------------------------------------------------------------------

/** Parses a strict `YYYY-MM-DD` into a UTC day number; null if malformed or not a real day. */
export function isoToDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  // Rejects overflow dates that Date would silently roll over (2026-02-30 → 2026-03-02).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(t / MS_PER_DAY);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// --- YAML side: job-level and step-level `continue-on-error` ----------------------------

/** Maps a character offset to a 1-based line number. */
function makeLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const keyOf = (pair) => (isScalar(pair.key) ? String(pair.key.value) : null);
const isContinueOnError = (pair) => keyOf(pair) === "continue-on-error";

/**
 * 1-based line number of a CST node. yaml v2 keeps `range` on the key/value nodes, not on
 * the Pair wrapper, so this reads `value.range` and falls back to the key for a null value.
 */
function lineOf(lineAt, pair) {
  const range = (pair.value && pair.value.range) || (pair.key && pair.key.range);
  return Array.isArray(range) ? lineAt(range[0]) : 1;
}

/** A short, human-recognisable label for a step (its name, or the first line of its run). */
function stepLabel(step) {
  if (!isCollection(step)) return "<malformed step>";
  for (const pair of step.items) {
    if (keyOf(pair) === "name" && isScalar(pair.value)) return String(pair.value.value);
  }
  for (const pair of step.items) {
    if (keyOf(pair) === "uses" && isScalar(pair.value)) return String(pair.value.value);
  }
  for (const pair of step.items) {
    if (keyOf(pair) === "run" && isScalar(pair.value)) {
      return String(pair.value.value).split("\n")[0].trim();
    }
  }
  return "<unnamed step>";
}

/**
 * Parses one workflow file.
 * Returns `{ jobLevel, stepLevel, nonLiteral, errors }` where `jobLevel` entries are the
 * waivers the register must cover and `stepLevel`/`nonLiteral` are advisory findings.
 */
export function parseWorkflow(text, label) {
  const out = { jobLevel: [], stepLevel: [], nonLiteral: [], errors: [] };
  const doc = parseDocument(text, { prettyErrors: true });
  for (const err of doc.errors) {
    const lp = Array.isArray(err.linePos) ? err.linePos[0] : null;
    out.errors.push(`${label}${lp ? `:${lp.line}:${lp.col}` : ""}  YAML parse error: ${err.message.split("\n")[0]}`);
  }
  if (out.errors.length > 0) return out;

  const wf = doc.toJS() ?? {};
  if (!wf.jobs || typeof wf.jobs !== "object" || Array.isArray(wf.jobs)) {
    out.errors.push(`${label}  workflow has no \`jobs\` mapping — cannot check its waivers`);
    return out;
  }

  const lineAt = makeLocator(text);

  for (const [jobName, job] of Object.entries(wf.jobs)) {
    const jobNode = doc.getIn(["jobs", jobName], true);
    if (!isCollection(jobNode)) continue;

    let jobLevelCount = 0;
    for (const pair of jobNode.items) {
      if (!isContinueOnError(pair)) continue;
      jobLevelCount++;
      const value = pair.value && isScalar(pair.value) ? pair.value.value : undefined;
      const at = lineOf(lineAt, pair);
      if (value === true) {
        out.jobLevel.push({ file: label, job: jobName, line: at, count: jobLevelCount });
      } else if (value === false) {
        continue; // explicitly not a waiver
      } else {
        out.nonLiteral.push({ file: label, job: jobName, line: at, value: value === undefined ? "null" : String(value) });
      }
    }

    // `continue-on-error` is job-level; `job` is the plain JS value from toJS(), not a
    // CST scalar, so gate on that object before descending into its steps.
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const steps = doc.getIn(["jobs", jobName, "steps"], true);
    if (!isCollection(steps)) continue;
    steps.items.forEach((stepPair, i) => {
      if (!isCollection(stepPair)) return;
      for (const pair of stepPair.items) {
        if (!isContinueOnError(pair)) continue;
        const value = pair.value && isScalar(pair.value) ? pair.value.value : undefined;
        out.stepLevel.push({
          file: label,
          job: jobName,
          index: i,
          line: lineOf(lineAt, pair),
          label: stepLabel(stepPair),
          value: value === undefined ? "null" : String(value),
          jobLevelCount,
        });
      }
    });
  }
  return out;
}

// --- Markdown side: the register table --------------------------------------------------

/** Splits a `| a | b |` line into trimmed cells, tolerating escaped `\|`. */
function splitRow(line) {
  const cells = [];
  let cur = "";
  for (let i = 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  // A leading/trailing pipe yields empty first/last cells; drop exactly those.
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

const isDelimiterRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
const findCol = (header, re) => header.findIndex((c) => re.test(c));
const isBlankish = (s) => s === "" || /^[-–—n\/a]+$/i.test(s.trim());

/**
 * Parses the register table out of `docs/CI-WAIVERS.md`.
 * Returns `{ rows, tableLine, errors, warnings }`; `errors` is fatal if the table cannot be
 * located or a row is unreadable, so the guard fails closed instead of passing vacuously.
 */
export function parseRegister(text, label = "docs/CI-WAIVERS.md") {
  const out = { rows: [], tableLine: null, errors: [], warnings: [] };
  const lines = text.split(/\r?\n/);

  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim().startsWith("|")) continue;
    const header = splitRow(raw.trim());
    const next = lines[i + 1] === undefined ? [] : splitRow(lines[i + 1].trim());
    if (!isDelimiterRow(next)) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      const cells = splitRow(lines[j].trim());
      if (!isDelimiterRow(cells)) rows.push({ cells, line: j + 1 });
      j++;
    }
    tables.push({ header, headerLine: i + 1, rows });
    i = j - 1;
  }

  // Job / Waiver / Expiry in the header — the slither triage table matches neither the
  // `Job…` nor the `Waiver…` column, so it can never be mistaken for the register.
  const table = tables.find(
    (t) => findCol(t.header, /^\s*job\b/i) >= 0 && findCol(t.header, /waiver/i) >= 0 && findCol(t.header, /expiry/i) >= 0,
  );
  if (!table) {
    out.errors.push(
      `${label}  no CI waiver table found (expected a table with Job, Waiver and Expiry columns) — the register must stay machine-readable`,
    );
    return out;
  }
  out.tableLine = table.headerLine;

  const jobCol = findCol(table.header, /^\s*job\b/i);
  const waiverCol = findCol(table.header, /waiver/i);
  const expiryCol = findCol(table.header, /expiry/i);
  const criterionCol = findCol(table.header, /criterion/i);
  if (criterionCol < 0) {
    out.warnings.push(
      `${label}:${table.headerLine}  register table has no 'Criterion to remove' column — rule #1's dated criterion is no longer machine-checked`,
    );
  }

  for (const row of table.rows) {
    const at = (i) => (i >= 0 && i < row.cells.length ? row.cells[i] : "");
    const jobCell = at(jobCol).replace(/`/g, "").trim();
    const where = `${label}:${row.line}`;

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobCell)) {
      out.errors.push(`${where}  cannot read a job name from the register row (got ${JSON.stringify(at(jobCol))})`);
      continue;
    }

    // Rule #2 needs a hard, checkable date — accept the date anywhere in the Expiry cell
    // so an explanatory phrase ("on or after 2026-10-12") still parses.
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(at(expiryCol))?.[1] ?? null;
    let expiry = null;
    if (!iso) {
      out.errors.push(`${where}  jobs.${jobCell}: no ISO date (YYYY-MM-DD) in the Expiry column (got ${JSON.stringify(at(expiryCol))}) — rule #2 requires a hard expiry`);
    } else {
      expiry = isoToDay(iso);
      if (expiry === null) out.errors.push(`${where}  jobs.${jobCell}: Expiry ${iso} is not a real calendar date`);
    }

    if (criterionCol >= 0 && isBlankish(at(criterionCol))) {
      out.errors.push(`${where}  jobs.${jobCell}: empty 'Criterion to remove' — rule #1 requires a dated removal criterion, and a waiver with no criterion is exactly what TD-6 was about`);
    }

    const waiverText = at(waiverCol);
    if (!/continue-on-error/i.test(waiverText)) {
      out.warnings.push(
        `${where}  jobs.${jobCell}: the Waiver column does not mention continue-on-error (got ${JSON.stringify(waiverText)}) — this row is registered but not machine-verified by this check`,
      );
    }

    // The row is kept even when its date is unreadable: it is still a *registration*, so
    // keeping it stops rule #1 from double-reporting the same defect, while `expiry: null`
    // means rule #2 has nothing to compare. The register error above is the reported cause.
    out.rows.push({ job: jobCell, expiry, expiryIso: iso, line: row.line, criterion: at(criterionCol) });
  }

  return out;
}

// --- cross-check ------------------------------------------------------------------------

/**
 * Compares the waivers found in YAML with the register rows. Pure: everything it needs is
 * passed in, so the five lifecycle scenarios are testable without touching the repo.
 * `today` is a `YYYY-MM-DD` string; `strict` escalates advisory findings to failures.
 */
export function crossCheck(yamlFindings, register, { today, strict = false } = {}) {
  const failures = [];
  const warnings = [];
  const day = isoToDay(today ?? todayIso());
  if (day === null) failures.push(`invalid evaluation date: ${JSON.stringify(today)}`);

  const jobLevel = yamlFindings.jobLevel;
  const stepLevel = yamlFindings.stepLevel;

  // Effective expiry per job: the earliest dated row wins, so a waiver cannot be quietly
  // extended by appending a second, later row. A row with no readable date is already
  // reported by parseRegister; it must not act as an expiry.
  const registered = new Map();
  for (const row of register.rows) {
    const prev = registered.get(row.job);
    if (!prev) {
      registered.set(row.job, row);
      continue;
    }
    const earliest = [row, prev]
      .filter((r) => r.expiry !== null)
      .sort((a, b) => a.expiry - b.expiry)[0];
    const shown = earliest ? earliest.expiryIso : "none";
    warnings.push(
      `docs/CI-WAIVERS.md:${row.line}  jobs.${row.job}: registered more than once (also line ${prev.line}); the earliest Expiry (${shown}) is used — delete the duplicate row`,
    );
    registered.set(row.job, earliest ?? row);
  }

  // 1. YAML waiver with no register row → FAIL (rule #1).
  for (const w of jobLevel) {
    if (registered.has(w.job)) continue;
    failures.push(
      `${w.file}:${w.line}  jobs.${w.job}: has \`continue-on-error: true\` but no row in docs/CI-WAIVERS.md — rule #1: a new waiver needs a dated criterion and a hard expiry, committed in the same change`,
    );
  }

  // 2. Register row with no waiver left → stale (WARN, or FAIL with --strict).
  const waivedJobs = new Set(jobLevel.map((w) => w.job));
  for (const row of register.rows) {
    if (waivedJobs.has(row.job)) continue;
    const expired = day !== null && row.expiry !== null && row.expiry <= day;
    const message =
      `docs/CI-WAIVERS.md:${row.line}  jobs.${row.job}: registered but no \`continue-on-error\` in any workflow — the waiver is gone` +
      `${expired ? ` (and it expired ${row.expiryIso})` : ""}; delete this row` +
      `${yamlFindings.knownJobs.has(row.job) ? "" : " — the job name matches no workflow, check for a typo or a renamed job"}`;
    (strict ? failures : warnings).push(message);
  }

  // 3. Expired expiry while the waiver is still live → FAIL (rule #2).
  if (day !== null) {
    for (const row of register.rows) {
      if (!waivedJobs.has(row.job) || row.expiry === null) continue;
      if (row.expiry > day) continue;
      const w = jobLevel.find((x) => x.job === row.job);
      failures.push(
        `docs/CI-WAIVERS.md:${row.line}  jobs.${row.job}: waiver expired ${row.expiryIso} (today is ${today}) but is still \`continue-on-error: true\` in ${w.file}:${w.line} — remove the waiver, or replace this row with a written justification, a new dated criterion and a new Expiry (rule #2)`,
      );
    }
  }

  // 4. Misplaced / dynamic `continue-on-error` → WARN (or FAIL with --strict).
  for (const s of stepLevel) {
    const redundant = s.jobLevelCount > 0;
    const message = `${s.file}:${s.line}  jobs.${s.job}.steps[${s.index}] "${s.label}": step-level \`continue-on-error${
      s.value === "true" ? ": true" : `: ${s.value}`
    }\` — ${
      redundant
        ? "the job is already waived, so this flag is redundant and hides which step is unreliable"
        : "this is an ungoverned second way to make a check non-blocking; move it to the job level and register it, or drop it"
    }`;
    if (strict) failures.push(message);
    else warnings.push(message);
  }
  for (const n of yamlFindings.nonLiteral) {
    const message = `${n.file}:${n.line}  jobs.${n.job}: \`continue-on-error: ${n.value}\` is not a literal boolean — a computed waiver cannot be machine-checked; use \`true\` and register it`;
    if (strict) failures.push(message);
    else warnings.push(message);
  }

  return { failures, warnings, expiredJobs: [...registered.values()].filter((r) => day !== null && r.expiry <= day).map((r) => r.job) };
}

/** Reads the workflows + register from disk, runs the cross-check and prints a report. */
export function runChecks({ today = todayIso(), strict = false, workflowDir = WORKFLOW_DIR, register = REGISTER } = {}) {
  if (!existsSync(workflowDir)) {
    return { failures: [`no workflow directory at ${workflowDir}`], warnings: [], waived: 0, rows: 0, files: 0, tableLine: null };
  }
  const files = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  if (files.length === 0) {
    return { failures: [`no workflow files found in ${workflowDir}`], warnings: [], waived: 0, rows: 0, files: 0, tableLine: null };
  }
  if (!existsSync(register)) {
    return { failures: [`no waiver register at ${register} — waivers must be registered, not remembered`], warnings: [], waived: 0, rows: 0, files: files.length, tableLine: null };
  }

  const jobLevel = [];
  const stepLevel = [];
  const nonLiteral = [];
  const knownJobs = new Set();
  const errors = [];
  for (const name of files) {
    const text = readFileSync(join(workflowDir, name), "utf8");
    const parsed = parseWorkflow(text, name);
    jobLevel.push(...parsed.jobLevel);
    stepLevel.push(...parsed.stepLevel);
    nonLiteral.push(...parsed.nonLiteral);
    errors.push(...parsed.errors);
    if (parsed.errors.length === 0) {
      const jobs = parseDocument(text).toJS()?.jobs;
      if (jobs && typeof jobs === "object") for (const j of Object.keys(jobs)) knownJobs.add(j);
    }
  }

  const parsedRegister = parseRegister(readFileSync(register, "utf8"));
  // If a workflow could not be parsed its jobs were never enumerated, so every
  // cross-checked verdict would be derived from a partial view ("the waiver is gone" for
  // jobs that merely failed to load). Report the parse error alone and stop: it is already
  // fatal, and guessing here would send someone to delete a row that is still live.
  if (errors.length > 0) {
    return {
      failures: [...errors, ...parsedRegister.errors],
      warnings: parsedRegister.warnings,
      waived: jobLevel.length,
      rows: parsedRegister.rows.length,
      files: files.length,
      tableLine: parsedRegister.tableLine,
    };
  }
  const { failures, warnings } = crossCheck(
    { jobLevel, stepLevel, nonLiteral, knownJobs },
    parsedRegister,
    { today, strict },
  );
  return {
    failures: [...parsedRegister.errors, ...failures],
    warnings: [...parsedRegister.warnings, ...warnings],
    waived: jobLevel.length,
    rows: parsedRegister.rows.length,
    files: files.length,
    tableLine: parsedRegister.tableLine,
  };
}

function main(argv = process.argv.slice(2)) {
  // Every other argv element used to be discarded, so `--stric`, `--root=…` or a stray
  // positional silently ran the plain check and exited 0 — a caller who believed --strict
  // was on got a run that escalated nothing. An unrecognised argument is exit 2.
  let flags;
  try {
    flags = parseArgs(argv, FLAGS);
  } catch (err) {
    process.exit(reportUsage(TOOL, messageOf(err), USAGE));
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const strict = flags.strict;
  const today = flags.today ?? todayIso();

  const result = runChecks({ today, strict });

  if (result.warnings.length > 0) {
    console.log(`waiver check warnings — ${result.warnings.length} (run with --strict to fail on these):\n`);
    for (const w of result.warnings) console.log(`  ${w}`);
    console.log("");
  }

  if (result.failures.length > 0) {
    console.error(`waiver check FAILED — ${result.failures.length} problem(s) (evaluated ${today}${strict ? ", --strict" : ""}):\n`);
    for (const f of result.failures) console.error(`  ${f}`);
    console.error("\nSee docs/CI-WAIVERS.md — rules #1 (no new waiver without a row) and #2 (expiry is a deadline).");
    process.exit(1);
  }

  console.log(
    `waiver check OK — ${result.waived} waiver(s) in ${result.files} workflow file(s), all registered in docs/CI-WAIVERS.md (${result.rows} row(s)), evaluated ${today}${strict ? ", --strict" : ""}`,
  );
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = pathToFileURL(entry).href;
  return process.platform === "win32"
    ? resolved.toLowerCase() === import.meta.url.toLowerCase()
    : resolved === import.meta.url;
}

if (isDirectInvocation()) main();
