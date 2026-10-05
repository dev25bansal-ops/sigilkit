#!/usr/bin/env node
/**
 * Removes generated artifacts (CQ-6).
 *
 * Most of what this deletes is disposable: the wallet-e2e harness alone leaves ~100 MB on disk
 * (a 21.7 MB extension zip, its extracted tree, a Playwright profile) plus Foundry's out/cache and
 * the packages' dist/coverage trees. All of that is reproducible from source and none of it is
 * tracked by git. Run this to reclaim the space.
 *
 * ## broadcast/ is NOT reproducible — DEBT-05
 *
 * An earlier version of this header asserted that everything it removed was reproducible. That was
 * false for `broadcast/`.
 * `broadcast/Deploy.s.sol/<chainId>/run-*.json` holds the *deployment record*: per-transaction
 * receipt, contract address, gas used, and the `deployedBytecode` as it existed on chain at
 * deploy time. Re-running `forge script` does not reproduce it — a redeploy produces a
 * **different** address, and the historical addresses/bytecode cannot be derived from the
 * contracts at all. Once the chain is gone, the record is gone. It is also `.gitignore`d, so
 * `git checkout` will not bring it back: recovery needs an **archive RPC** (and the original
 * deployer key) to re-collect it, and if no archive node covered those blocks it is lost
 * permanently.
 *
 * So `broadcast/` is **protected by default**: it is never part of a plain `npm run clean`.
 * Removing it takes an explicit `--include-broadcast` *plus* a confirmation (interactive
 * prompt, or `--yes` for non-TTY callers). Nothing here is ever deleted silently.
 *
 * A scan of the local tree found no deployer private keys, mnemonics, keystores or
 * passphrases under `broadcast/`: every file is a `run-*.json` for chain 31337, and the only
 * key-shaped values inside them are `blockHash`, `transactionHash` and log `data` — no
 * `privateKey`/`private_key` field exists anywhere in the schema. The caution below is kept
 * anyway, because `broadcast/` is written by local tooling and a non-standard signer config can
 * leave credential-adjacent material there. Note the count grows with every local deploy, so
 * treat the "no secrets" result as a property of the tree at scan time, not a permanent fact.
 *
 *   node scripts/clean.mjs                  # remove reproducible artifacts only (never broadcast/)
 *   node scripts/clean.mjs --dry            # report path/file-count/bytes, delete nothing
 *   node scripts/clean.mjs --include-broadcast   # also consider broadcast/ — prompts first
 *   node scripts/clean.mjs --include-broadcast --yes  # non-TTY: proceed without a prompt
 */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Workspace packages — kept in one place so per-package artifacts cannot drift apart. */
export const PACKAGES = ["core", "indexer", "mcp", "demo-agent"];

/** Generated paths, relative to the repo root. Never add a tracked source path here. */
export const REPRODUCIBLE_TARGETS = [
  "out",
  "cache",
  "coverage",
  ...PACKAGES.map((p) => `packages/${p}/dist`),
  // Every package writes a coverage report; listing only core left three behind.
  ...PACKAGES.map((p) => `packages/${p}/coverage`),
  "packages/core/test-results",
  "packages/demo-agent/fleet-manifest.json",
  "packages/core/test/wallet-e2e/metamask",
  "packages/core/test/wallet-e2e/metamask.zip",
  "packages/core/test/wallet-e2e/.playwright-profile",
  "packages/core/test/wallet-e2e/.coinbase-out",
];

/**
 * Irreversible targets: excluded unless the caller explicitly asks for them. Anything listed
 * here is only ever reached through `--include-<name>`, and still needs a confirmation.
 */
export const IRREVERSIBLE_TARGETS = ["broadcast"];

/** Full catalogue, in report order. */
export const ALL_TARGETS = [...REPRODUCIBLE_TARGETS, ...IRREVERSIBLE_TARGETS];

/**
 * Paths that require confirmation before deletion, whatever list they appear in. `outputs/` is
 * named here even though it is not a target: it is a gitignored scratch directory that
 * `SK-01` marks as credential-adjacent, so if anyone ever adds it to a target list it inherits
 * the double-confirmation instead of quietly becoming disposable.
 */
export const DANGEROUS_PATHS = ["broadcast", "outputs"];

/** Tests only: run the same logic against a temporary fixture root. */
export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- argument parsing -----------------------------------------------------------------------

export function parseArgs(argv = []) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  return {
    dry: flags.has("--dry"),
    yes: flags.has("--yes"),
    includeBroadcast: flags.has("--include-broadcast"),
    root: (() => {
      const i = argv.indexOf("--root");
      return i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : null;
    })(),
    help: flags.has("--help") || flags.has("-h"),
  };
}

/**
 * Tokens `parseArgs` does not recognise, in argv order.
 *
 * Returned separately rather than folded into {@link parseArgs}'s result so the parse contract
 * stays exactly the five documented fields. Every flag used to be read out of a
 * `Set(argv.filter((a) => a.startsWith("--")))`, so an unknown flag joined the Set and was then
 * silently discarded: `node scripts/clean.mjs --dryy` printed the same plan as `--dry` and
 * exited 0, and `--root` mistyped as `--rooot` reported a clean run against the wrong root.
 * This is the one script here that deletes directories, so a flag it did not understand must
 * not be the difference between a dry run and a real one.
 *
 * `--root` consumes the token after it: that directory is this flag's value, not a flag.
 */
export function unknownFlags(argv = []) {
  const KNOWN = new Set(["--dry", "--yes", "--include-broadcast", "--root", "--help", "-h"]);
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (KNOWN.has(arg)) {
      if (arg === "--root") i += 1;
      continue;
    }
    unknown.push(arg);
  }
  return unknown;
}

// --- target planning ------------------------------------------------------------------------

/** Split a list of repo-relative paths into confirmable and free-to-delete buckets. */
export function classifyTargets(targets = ALL_TARGETS) {
  const safe = [];
  const dangerous = [];
  for (const rel of targets) (DANGEROUS_PATHS.includes(rel) ? dangerous : safe).push(rel);
  return { safe, dangerous };
}

/**
 * Build the deletion plan. `broadcast/` is opt-in: without `includeBroadcast` it is reported
 * as skipped so `--dry` still shows the user that a non-reproducible tree is sitting there.
 */
export function planTargets({ includeBroadcast = false } = {}) {
  const { safe, dangerous } = classifyTargets(REPRODUCIBLE_TARGETS);
  const broadcast = IRREVERSIBLE_TARGETS.filter((rel) => rel === "broadcast");
  return {
    safe,
    dangerous: includeBroadcast ? broadcast : [],
    skipped: includeBroadcast ? [] : broadcast,
  };
}

/**
 * Decide whether a confirmable target may be deleted.
 *
 * Fail-closed: a non-TTY caller (CI, `npm run` from a pipeline, cron) that has not passed
 * `--yes` is **refused**, not silently skipped. Skipping would report success while leaving
 * the tree in place, which is exactly the "it said it cleaned but didn't" failure.
 */
export function decideConfirmation({ dangerousTargets = [], isTTY = false, yes = false } = {}) {
  if (dangerousTargets.length === 0) return { mode: "none", reason: "no confirmable targets" };
  if (yes) return { mode: "allow", reason: "--yes given explicitly" };
  if (isTTY) return { mode: "prompt", reason: "interactive terminal, awaiting typed confirmation" };
  return {
    mode: "refuse",
    reason:
      "not a terminal and no --yes: refusing rather than deleting unrecoverable data, " +
      "and rather than silently skipping it. Re-run with --include-broadcast --yes to proceed.",
  };
}

// --- measurement ----------------------------------------------------------------------------

/**
 * Recursively count files and bytes. Symlinks are counted but never followed, so a link loop
 * cannot hang the walk; an unreadable entry is counted as an error for the caller to surface
 * rather than aborting the whole report.
 */
export function measureTree(abs, fs = { existsSync, lstatSync, readdirSync }) {
  let files = 0;
  let bytes = 0;
  const errors = [];

  const walk = (path) => {
    let st;
    try {
      st = fs.lstatSync(path);
    } catch (err) {
      errors.push(`${path}: ${err.code ?? err.message}`);
      return;
    }
    if (!st.isDirectory()) {
      files += 1;
      bytes += st.size;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(path, { withFileTypes: true });
    } catch (err) {
      errors.push(`${path}: ${err.code ?? err.message}`);
      files += 1;
      return;
    }
    for (const entry of entries) walk(join(path, entry.name));
  };

  walk(abs);
  return { files, bytes, errors };
}

// --- removal, with post-condition verification ------------------------------------------------

/**
 * Delete a path and *verify* it is gone.
 *
 * `rmSync(..., { force: true })` swallows a missing path and can be silent about a path it
 * failed to remove, so the old loop reported "removed" for a tree that was still on disk. The
 * post-condition `!existsSync(abs)` is the actual assertion, and a surviving path is an error
 * that drives a non-zero exit.
 */
export function removeVerified(abs, fs = { existsSync, rmSync }) {
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, reason: `rm failed: ${err.code ?? err.message}` };
  }
  if (fs.existsSync(abs)) {
    return { ok: false, reason: "still present after rmSync returned (post-check failed)" };
  }
  return { ok: true };
}

export const formatBytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// --- the run ----------------------------------------------------------------------------------

/** Default confirmation prompt. Injected in tests so no test ever opens a terminal. */
async function promptForConfirmation(paths, { fs = { existsSync }, isTTY = false } = {}) {
  if (!isTTY) return false;
  const present = paths.filter((rel) => fs.existsSync(rel.abs));
  const lines = [
    "",
    "WARNING — the following paths CANNOT be regenerated from source:",
    ...present.map((p) => `  ${p.rel}  (${p.files} files, ${formatBytes(p.bytes)})`),
    "",
    "Deleting broadcast/ destroys the on-chain deployment record (addresses, receipts and",
    "deployedBytecode for every chain). It is gitignored, so git cannot restore it, and",
    "recovery needs an archive RPC. Make sure no sensitive residue (private key, mnemonic,",
    "keystore) was written there before you continue.",
    "",
    'Type "yes" to delete them permanently, anything else to abort: ',
  ];
  process.stdout.write(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("")).trim().toLowerCase();
    return answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Execute a plan. All side effects go through `deps` so tests can drive it with a temporary
 * fixture root, a stub `fs` and a stubbed prompt.
 *
 * Returns a result object; `status` is the intended process exit code.
 */
export async function runClean(options = {}, deps = {}) {
  const {
    fs = { existsSync, lstatSync, readdirSync, rmSync },
    log = console.log,
    prompt = promptForConfirmation,
  } = deps;
  // `isTTY` may arrive on either side: the CLI fills it from the real process, tests from
  // `options`. Reading only one of them would let a caller silently get the other behaviour.
  const isTTY = options.isTTY ?? deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const root = options.root ?? DEFAULT_ROOT;
  const dry = options.dry ?? false;
  const yes = options.yes ?? false;
  const plan = planTargets({ includeBroadcast: options.includeBroadcast ?? false });

  const absent = [];
  const measured = (list) =>
    list
      .map((rel) => {
        const abs = join(root, rel);
        if (!fs.existsSync(abs)) {
          absent.push(rel);
          return null;
        }
        const { files, bytes, errors } = measureTree(abs, fs);
        for (const e of errors) log(`  warning  could not fully read ${e}`);
        return { rel, abs, files, bytes };
      })
      .filter(Boolean);

  const safe = measured(plan.safe);
  const dangerous = measured(plan.dangerous);
  const all = [...safe, ...dangerous];
  const failures = [];
  const removed = [];

  if (plan.skipped.length) {
    const skippedPresent = plan.skipped.filter((rel) => fs.existsSync(join(root, rel)));
    if (skippedPresent.length) {
      log(
        `skipped  ${skippedPresent.join(", ")} — deployment record, not reproducible from source.\n` +
          "          Pass --include-broadcast to consider it (prompts before deleting).",
      );
    }
  }

  if (dry) {
    const label = (p) =>
      `would remove  ${p.rel.padEnd(48)} ${String(p.files).padStart(5)} files  ${formatBytes(p.bytes)}`;
    for (const p of all) log(label(p));
  } else {
    const verdict = decideConfirmation({ dangerousTargets: dangerous.map((p) => p.rel), isTTY, yes });
    if (verdict.mode === "refuse") {
      log(`refused: ${verdict.reason}`);
      return { status: 1, removed: 0, failed: 0, failures: [], refused: true, plan };
    }
    if (verdict.mode === "prompt") {
      const confirmed = await prompt(dangerous, { fs, isTTY });
      if (!confirmed) {
        log("refused: confirmation declined; nothing was deleted.");
        return { status: 1, removed: 0, failed: 0, failures: [], refused: true, plan };
      }
    }
    for (const p of all) {
      const outcome = removeVerified(p.abs, fs);
      if (outcome.ok) {
        removed.push(p);
        log(`removed  ${p.rel.padEnd(48)} ${String(p.files).padStart(5)} files  ${formatBytes(p.bytes)}`);
      } else {
        const message = `${p.rel}: ${outcome.reason}`;
        failures.push(message);
        log(`ERROR    ${message}`);
      }
    }
  }

  const totalBytes = all.reduce((n, p) => n + p.bytes, 0);
  const totalFiles = all.reduce((n, p) => n + p.files, 0);
  if (all.length === 0) {
    log("nothing to clean — no generated artifacts found.");
  } else if (dry) {
    log(
      `\nwould reclaim ${formatBytes(totalBytes)} (${totalFiles} files) across ${all.length} path(s).` +
        "\nnothing was deleted.",
    );
  } else {
    log(
      `\nreclaimed ${formatBytes(removed.reduce((n, p) => n + p.bytes, 0))}` +
        ` (${removed.reduce((n, p) => n + p.files, 0)} files) across ${removed.length} path(s).`,
    );
  }

  return {
    status: failures.length ? 1 : 0,
    removed: removed.length,
    failed: failures.length,
    failures,
    refused: false,
    plan,
    totalBytes,
    totalFiles,
  };
}

export const USAGE = [
  "usage: node scripts/clean.mjs [--dry] [--include-broadcast] [--yes] [--root <dir>]",
  "",
  "  --dry                 report paths, file counts and bytes; delete nothing",
  "  --include-broadcast   also consider broadcast/ (prompts, or --yes for non-TTY)",
  "  --yes                 skip the confirmation prompt; required for dangerous targets in CI",
  "  --root <dir>          run against another root (test fixture)",
].join("\n");

async function main() {
  const argv = process.argv.slice(2);
  // Checked before `parseArgs`, because a flag the parser does not know is discarded by the
  // parser: reading the options first and rejecting afterwards would mean the run had already
  // been planned from arguments nobody validated. Exit 2 — "you asked wrongly" — kept distinct
  // from exit 1, which this script also uses for "the clean was refused or incomplete".
  const unknown = unknownFlags(argv);
  if (unknown.length > 0) {
    process.stderr.write(`clean: unrecognized argument(s): ${unknown.join(", ")}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const result = await runClean({ ...options, root: options.root ?? DEFAULT_ROOT });
  if (result.status !== 0) {
    process.exitCode = result.status;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
