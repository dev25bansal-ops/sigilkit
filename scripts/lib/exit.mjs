/**
 * Exit-code contract and throwable-message extraction — extracted, not yet migrated.
 *
 * ── THE CONTRACT BEING PINNED ───────────────────────────────────────────────────
 *   0  the check ran and passed
 *   1  the check ran and failed (a finding, a drift, a failed child)
 *   2  the check could not be evaluated as asked (bad flags, missing tool, unreadable input)
 *
 * Code 2 exists so a caller can tell "your repository is wrong" from "your invocation or
 * environment is wrong". Only three scripts honour all three today (see the table in
 * `scripts/ARCH-2026-09-26.md`); several collapse a usage error into 1, and
 * `check-package-artifacts.mjs:313` returns *any* non-zero the child produced, so a child's
 * own 7 arrives as the guard's verdict and is indistinguishable from a real finding.
 *
 * ── WHERE THIS CAME FROM ────────────────────────────────────────────────────────
 * `err instanceof Error ? err.message : String(err)` written out at eight sites:
 *
 *   scripts/check-doc-counts.mjs:90, 141, 720, 902
 *   scripts/benchmark-indexer.mjs:327, 340, 468, 750
 *
 * Two of them additionally differ in a way that matters:
 *
 *   scripts/check-doc-counts.mjs:182-184   exitStatusFromError — `err.status` if numeric,
 *                                         else 1. The only child-status passthrough in
 *                                         the tree, and it is what makes `--write`'s
 *                                         re-verification exit code meaningful.
 *   scripts/benchmark-indexer.mjs:589      `String(error)` with *no* Error branch, so a
 *                                         thrown `Error` lands in a report as
 *                                         `"Error: message"`. A divergence, not a
 *                                         decision: migrating it to `messageOf` normalises
 *                                         the text.
 *
 * ── WHO SHOULD ADOPT IT ──────────────────────────────────────────────────────────
 * Every script that formats an error, plus the two CI jobs that branch on the code. Import
 * `EXIT` for the three constants, `messageOf` for display text, and
 * `exitStatusFromChild` only where a child's code is genuinely being forwarded.
 */

/** The three-valued exit contract. Frozen so a typo is a TypeError, not a silent 0. */
export const EXIT = Object.freeze({
  /** Ran to completion, nothing to report. */
  OK: 0,
  /** Ran and found something wrong. */
  FAIL: 1,
  /** Could not run as asked: bad flags, missing tool, unreadable input. */
  USAGE: 2,
});

/**
 * The verdict vocabulary for {@link announce}. Deliberately NOT the same set as the exit codes:
 * there are four verdicts and three codes, because `unreadable-input` and `tool-missing` are
 * different facts that share EXIT.USAGE. A caller that needs the distinction reads the line,
 * not the code.
 */
export const VERDICT = Object.freeze({
  /** The check ran and everything it examined was true. */
  PASS: "pass",
  /** The check ran and found a real defect in the repository. */
  DRIFT: "drift",
  /** The repository could not be read as the check requires. */
  UNREADABLE_INPUT: "unreadable-input",
  /** A required external tool was absent or refused to run. */
  TOOL_MISSING: "tool-missing",
});

/**
 * Emits ONE machine-readable verdict line, then returns the exit code to use.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * An exit code alone cannot separate "your repository is wrong" from "I could not run", and
 * that is not hypothetical: `check-doc-counts.mjs` exits 1 for a missing README, for count
 * drift, AND for an `ERR_MODULE_NOT_FOUND` raised during ESM resolution — which happens
 * *before* `main()` is entered, so no in-process `process.exit` can intercept it. A CI step
 * that branches on `$?` therefore reads a broken dependency tree as a documentation defect,
 * and a broken dependency tree is exactly the condition under which nobody trusts a report.
 *
 * So the code stays as it is — changing it would break the existing CI convention, which is a
 * larger change than this problem warrants — and the caller gets an unambiguous stdout line to
 * branch on instead. Emitted on **stdout** so it survives `2>&1` merging and is greppable in a
 * CI log; the human prose keeps its own stream as before.
 *
 * @param {string} gate script name, e.g. `"check-doc-counts"`
 * @param {string} verdict one of {@link VERDICT}
 * @param {object} [extra] additional JSON fields, e.g. `{ problems: 3 }`
 * @param {(text: string) => void} [write] defaults to `process.stdout.write`
 * @returns {number} the exit code matching the verdict, for `process.exit(...)`
 */
export function announce(gate, verdict, extra = {}, write = (t) => process.stdout.write(t)) {
  write(`${JSON.stringify({ gate, verdict, ...extra })}\n`);
  switch (verdict) {
    case VERDICT.PASS:
      return EXIT.OK;
    case VERDICT.DRIFT:
      return EXIT.FAIL;
    // Both "could not evaluate" verdicts map to USAGE. The line is what tells them apart.
    case VERDICT.UNREADABLE_INPUT:
    case VERDICT.TOOL_MISSING:
      return EXIT.USAGE;
    default:
      // An unknown verdict must never be reported as success. A typo in a gate's own
      // announcement is precisely the bug class this file exists to prevent.
      throw new TypeError(`announce: unknown verdict ${JSON.stringify(verdict)}`);
  }
}

/**
 * The display message of a thrown value, whatever it was.
 *
 * A `catch` in this tree can receive a non-`Error` — `JSON.parse` on some inputs, a
 * rejected value from a worker, a `DOMException`-shaped object — and `String(err)` on an
 * `Error` prefixes `"Error: "`, which is noise in a message that already says what failed.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function messageOf(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return String(err);
}

/**
 * The exit status a failed child process reported, defaulting to 1 (fail closed).
 *
 * Deliberately conservative: a child that died on a signal, or that was killed, has no
 * `status`, and a guard must not report "the tool said 2 (usage error)" when the tool simply
 * vanished. Returns {@link EXIT.FAIL} in that case.
 *
 * Only `sync-facts.mjs` and `check-doc-counts.mjs` have a caller today. Do **not** adopt it
 * in a gate that runs a fixed command whose code is its own verdict — see the
 * `check-package-artifacts.mjs:313` note in the header.
 *
 * @param {unknown} err the value `spawnSync`/`execFileSync` threw
 * @returns {number} a code suitable for `process.exit`
 */
export function exitStatusFromChild(err) {
  return typeof err?.status === "number" ? err.status : EXIT.FAIL;
}

/**
 * Reports a fatal problem on stderr and returns {@link EXIT.USAGE}.
 *
 * The shape every CLI in this tree converged on by hand: `<tool>: <what went wrong>` then
 * the usage line. Returned rather than thrown, and the caller assigns it, so the decision to
 * exit stays at the entry point and a test can assert the code without spawning.
 *
 * @param {string} tool script name, e.g. `"verify"`
 * @param {string} message
 * @param {string} [usage] one-line usage; omitted means "no usage line to print"
 * @param {(text: string) => void} [write] defaults to `process.stderr.write`
 * @returns {number} {@link EXIT.USAGE}
 */
export function reportUsage(tool, message, usage, write = (t) => process.stderr.write(t)) {
  write(`${tool}: ${message}\n`);
  if (usage) write(`${usage}\n`);
  return EXIT.USAGE;
}
