/**
 * JSON/text file reading and the repo's little enumerations — extracted, not yet migrated.
 *
 * ── WHERE THIS CAME FROM ────────────────────────────────────────────────────────
 * `readFileSync(path, "utf8")` + `JSON.parse` + a `try`/`catch`, written out at:
 *
 *   scripts/check-runtime.mjs:121-127        readJson — returns null on any failure
 *   scripts/check-vectors.mjs:675            parse inline, no catch (caller has one)
 *   scripts/bootstrap.mjs:33                 parse inline, no catch
 *   scripts/check-package-artifacts.mjs:232  parse inline, no catch (injected `read`)
 *   scripts/check-package-artifacts.mjs:247  parse inline, no catch (injected `read`)
 *
 * The three *behaviours* differ and are preserved as three functions rather than one
 * option-flag:
 *
 *   • {@link readJsonOrNull} — swallow everything, return `null`. `check-runtime.mjs`'s
 *     shape: a diagnostic report must not stop a report that exists to explain the
 *     environment. The `null` is the whole contract — a caller that cannot distinguish
 *     "absent" from "unparseable" should not use it.
 *   • {@link readJson} — rethrow with the path attached. Right for a *gate*: "the file I
 *     was told to check is unreadable" is a finding, not an absence.
 *   • {@link readText} — plain text, no parse.
 *
 * Every reader takes its `fs` as a trailing optional argument (defaulting to the real
 * one) because the callers in this tree are already written that way —
 * `check-package-artifacts.mjs:231` injects `{ readFileSync, readdirSync, existsSync }` and
 * `sync-facts.mjs:1396` injects a five-method `io` object. Passing nothing keeps the
 * production call sites byte-identical to what they are today.
 *
 * ── THE ENUMERATIONS ────────────────────────────────────────────────────────────
 * Two facts stated in more than one script:
 *
 *   WORKSPACES — `clean.mjs:46` (exported), `check-doc-counts.mjs:63` (private),
 *                `check-doc-counts.mjs:583` (private), `bootstrap.mjs:146` (private)
 *   WORKFLOW_SUFFIXES — `validate-workflows.mjs:31`, `check-waivers.mjs:403`,
 *                       `check-doc-counts.mjs:854`, `assurance-inventory.mjs:234`
 *
 * `check-runtime.mjs:130-153` and `check-package-artifacts.mjs:231-270` each grow their own
 * `workspaces` glob expander. They are deliberately **not** unified here: one sorts and
 * fails closed on a missing base directory, the other throws on a missing required
 * manifest, and they disagree about `manifest.name` as a fallback key. Unifying them would
 * silently pick a winner. That is left to a migration with a test on both sides.
 */
import { readFileSync, readdirSync } from "node:fs";

/** The four workspace package directory names, in the order every consumer uses. */
export const WORKSPACES = Object.freeze(["core", "indexer", "mcp", "demo-agent"]);

/** Suffixes that make a file in `.github/workflows/` a workflow. */
export const WORKFLOW_SUFFIXES = Object.freeze([".yml", ".yaml"]);

/** True when a directory listing entry is a workflow file. */
export function isWorkflowFile(name) {
  return WORKFLOW_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Workflow files in a directory listing, sorted. Empty when there are none.
 *
 * Four open-coded copies, two of which are the *same expression in a different bracket
 * style*, which is why a grep for one spelling found only three of them:
 *
 *   validate-workflows.mjs:31    readdirSync(DIR).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
 *   check-waivers.mjs:403        … .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort()
 *   check-doc-counts.mjs:854     for (f of readdirSync(dir)) { if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue; … }
 *   assurance-inventory.mjs:234  … .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort(…)
 *
 * Sort differences worth preserving: `check-waivers.mjs` and `assurance-inventory.mjs` sort
 * *after* filtering, `validate-workflows.mjs:46` sorts the filtered array too, and
 * `assurance-inventory.mjs:235` uses `localeCompare` where the others use the default
 * comparator. For ASCII file names those agree, so this helper is safe to adopt — but a
 * caller that genuinely wants locale ordering should keep its own comparator.
 *
 * @param {string[]} entries
 * @returns {string[]}
 */
export function workflowFiles(entries) {
  return (entries ?? []).filter(isWorkflowFile).sort();
}

/**
 * Reads a UTF-8 text file.
 *
 * @param {string} path
 * @param {{ readFileSync?: typeof readFileSync }} [io] injected fs subset
 * @returns {string}
 */
export function readText(path, io = undefined) {
  return (io?.readFileSync ?? readFileSync)(path, "utf8");
}

/**
 * Reads and parses a JSON file, returning `null` on **any** failure.
 *
 * @param {string} path
 * @param {{ readFileSync?: typeof readFileSync }} [io] injected fs subset
 * @returns {unknown|null}
 */
export function readJsonOrNull(path, io = undefined) {
  try {
    return JSON.parse(readText(path, io));
  } catch {
    return null;
  }
}

/**
 * Reads and parses a JSON file, rethrowing with the path attached.
 *
 * For gates: an unreadable input is a failure of the check, and a message naming the file
 * is the difference between a five-second fix and an archaeology exercise. The wrapped
 * error carries `.path` so a caller can re-raise or record it without parsing the message.
 *
 * @param {string} path
 * @param {{ readFileSync?: typeof readFileSync }} [io] injected fs subset
 * @returns {unknown}
 * @throws {Error} with `.path` set
 */
export function readJson(path, io = undefined) {
  let text;
  try {
    text = readText(path, io);
  } catch (err) {
    const error = new Error(
      `${path}: could not be read — ${err instanceof Error ? err.message : String(err)}`,
    );
    error.path = path;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const error = new Error(
      `${path}: could not be parsed as JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
    error.path = path;
    throw error;
  }
}

/**
 * Directory entries, sorted, with an empty array for a directory that is not there.
 *
 * Two open-coded copies that differ only in which `fs` they closed over:
 *
 *   sync-facts.mjs:1401-1407        try { return readdirSync(at(rel)) } catch { return [] }
 *   check-package-artifacts.mjs:272 try { return statSync(dir).isDirectory() ? readdirSync(dir) : [] } catch { return [] }
 *
 * The `statSync` half of the second is what rejects a *file* where a directory was
 * expected; `readdirSync` alone already throws `ENOTDIR` for that, which the `catch`
 * turns into `[]`. Behaviour is therefore the same, and the second can drop the `statSync`
 * on migration — worth doing while the caller is in hand.
 *
 * @param {string} dir
 * @param {{ readdirSync?: typeof readdirSync }} [io] injected fs subset
 * @returns {string[]}
 */
export function listDir(dir, io = undefined) {
  try {
    return ((io?.readdirSync ?? readdirSync)(dir) ?? []).sort();
  } catch {
    return [];
  }
}
