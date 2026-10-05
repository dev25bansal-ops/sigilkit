#!/usr/bin/env node
/**
 * Host reparse-point capability probe (read-only; creates nothing inside the repository).
 *
 *   node scripts/check-reparse-points.mjs
 *   node scripts/check-reparse-points.mjs --json
 *   node scripts/check-reparse-points.mjs --workspace-links
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────────
 *
 * This asks ONE question about **this machine**:
 *
 *     "Can this host create a symbolic link / junction AND traverse through it?"
 *
 * It is a statement about the host's filesystem subsystem. It is NOT a health check for
 * the repository, the dependency tree, or `node_modules`. Those are separate facts with
 * separate owners:
 *
 *   • dependency tree present       -> `npm ls`, `scripts/check-package-artifacts.mjs`
 *   • workspace links traversable   -> the `--workspace-links` flag below
 *   • host can host reparse points  -> THIS SCRIPT
 *
 * A green run here means "links will work on this host". It says nothing about whether any
 * particular link exists, and nothing about whether the dependency tree is installed. Do not
 * wire it into a job whose name implies it gates dependency health: on a Linux CI runner it
 * is structurally always green, so as a dependency gate it would certify nothing.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────────
 *
 * A reparse point can exist, be structurally perfect, name a target that exists, and still
 * be unusable. Every one of these is true of a broken junction:
 *
 *     lstat(link).isSymbolicLink()   -> true          (the link itself is fine)
 *     readlink(link)                 -> a real path    (and the target reads fine directly)
 *     stat(link) / readdir(link)     -> throws UNKNOWN errno=-4094
 *
 * So the first two checks are a **false-positive generator**: a tool that reports only
 * "does this path exist" will call that link healthy. Worse, the answer differs by API —
 * on the host this was written for, `Test-Path` in PowerShell reported `True` for a link
 * that Node's own `existsSync` reported `false` for. A broken link reported as healthy is
 * worse than a false negative, because it removes the signal entirely.
 *
 * The three-layer test below asserts only on the third layer, because that is the only one
 * that cannot be satisfied by a link that does not work. Git already prints a symptom of
 * this in the repo — `could not open directory '.sigilkit-junction-probe/': Function not
 * implemented` — under its own wording, which is why the shape went unrecognised.
 *
 * ── EXIT CODES ───────────────────────────────────────────────────────────────────
 *
 *   0  the host CAN create a reparse point and traverse through it
 *   1  the host CANNOT (it creates them, but they do not traverse)
 *   2  the probe could not evaluate: bad flags, or the host is too broken to even create a
 *      plain directory. A code-2 run is NOT a clean bill of health — it means "no verdict",
 *      and must never be read as "links work".
 *
 * ── SIDE EFFECTS ─────────────────────────────────────────────────────────────────
 *
 * Every experiment happens in a fresh directory under the OS temp dir, and is removed
 * afterwards (including on the failure paths, via `finally`). A removal the host refuses is
 * reported on stderr and turns a clean pass into exit 2 — it is never discarded. The
 * repository is only ever read. Pass `--workspace-links` to additionally *inspect*
 * `node_modules/@sigilkit/*`; that mode reads only and writes nothing.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
  lstatSync, readlinkSync, statSync, existsSync, symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT, messageOf, reportUsage } from "./lib/exit.mjs";
import { parseArgs, usage } from "./lib/cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = "check-reparse-points";
const IS_WINDOWS = process.platform === "win32";

const USAGE = usage(
  [`usage: ${TOOL} [--json] [--workspace-links]`],
  {
    json: { type: "boolean", describe: "machine-readable report" },
    "workspace-links": { type: "boolean", describe: "also inspect node_modules/@sigilkit/* (read-only)" },
  },
);

/**
 * The errno Windows returns when a reparse point cannot be resolved.
 *
 * Recorded so a report carries the observed value rather than assuming a reader knows it.
 * No code branches on this: a through-link failure is a failure whatever the errno, and
 * matching on the number would mean a host that reports a different one reads as healthy.
 */
const REPARSE_ERRNO = -4094;

/** @readonly @enum {string} */
export const LinkState = Object.freeze({
  /** Created, well-formed, and readable through. */
  TRAVERSABLE: "TRAVERSABLE",
  /** Created and well-formed, but unreadable through — a dead reparse point. */
  BROKEN: "BROKEN",
  /** Never became a link; creation itself failed or was refused. */
  NOT_CREATED: "NOT_CREATED",
});

/**
 * Runs one filesystem action, returning a result object instead of throwing.
 *
 * The distinction this preserves is the whole point of the script: "the action failed" and
 * "the action reports absence" are different answers, and a probe that collapses them
 * (existsSync-style) is exactly what produced the false positives this replaces.
 *
 * @param {() => unknown} fn
 * @returns {{ok: true, value: any} | {ok: false, code: string, errno: number|null, message: string}}
 */
export function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? err?.name ?? "Error",
      errno: typeof err?.errno === "number" ? err.errno : null,
      message: messageOf(err),
    };
  }
}

/**
 * The three-layer test. A link is judged ONLY on layer (c).
 *
 * Layers (a) and (b) are returned because they are what a naive existence check stops at,
 * and because "isLink=true, readlink ok, through-link broken" is the exact fingerprint
 * that makes this diagnosis unambiguous rather than merely suspicious.
 *
 * @param {string} link
 * @param {string} target the path the link is expected to name
 * @returns {{state: string, isLink: boolean|null, readlink: string|null, targetOk: boolean, traverse: object}}
 */
export function classifyLink(link, target) {
  const lst = attempt(() => lstatSync(link));
  const rl = attempt(() => readlinkSync(link));
  // The target must be readable on its own. Otherwise a failure at (c) could be the
  // target's fault, and the link would be exonerated for the wrong reason.
  const targetOk = existsSync(target);
  const trav = attempt(() => readFileSync(join(link, "package.json"), "utf8"));
  return {
    state: trav.ok ? LinkState.TRAVERSABLE : LinkState.BROKEN,
    isLink: lst.ok ? Boolean(lst.value.isSymbolicLink()) : null,
    readlink: rl.ok ? rl.value : null,
    targetOk,
    traverse: trav.ok
      ? { ok: true }
      : { ok: false, code: trav.code, errno: trav.errno, message: trav.message },
  };
}

/**
 * Probes one creation method end to end.
 *
 * @param {{id: string, label: string, supported: boolean, create: (link: string, target: string) => void}} method
 * @param {string} base scratch directory
 */
export function probeMethod(method, base) {
  const target = join(base, `${method.id}-target`);
  const link = join(base, `${method.id}-link`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), '{"probe":true}\n');

  if (!method.supported) {
    return { id: method.id, label: method.label, supported: false, created: false, createError: null, result: null, verdict: "SKIPPED" };
  }

  let createError = null;
  try {
    method.create(link, target);
  } catch (err) {
    createError = `${err?.code ?? err?.name ?? "Error"}${typeof err?.errno === "number" ? ` errno=${err.errno}` : ""}`;
  }
  if (createError !== null) {
    return { id: method.id, label: method.label, supported: true, created: false, createError, result: null, verdict: LinkState.NOT_CREATED };
  }

  const result = classifyLink(link, target);
  return { id: method.id, label: method.label, supported: true, created: true, createError: null, result, verdict: result.state };
}

/** Windows-only `mklink /J`, so at least one path does not go through Node. */
function mklinkJunction(link, target) {
  execFileSync("cmd.exe", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
}

/**
 * The creation methods to try.
 *
 * Three exist so the verdict cannot rest on one code path. On the machine that motivated
 * this script, all of them produced well-formed, untraversable links — a single method
 * would have been equally damning, but a host where only `mklink` is broken would look
 * identical if the other two were never attempted.
 */
export function buildMethods(platform = process.platform) {
  const win = platform === "win32";
  return [
    {
      id: win ? "junction" : "dir-symlink",
      label: win ? "fs.symlinkSync(type='junction')" : "fs.symlinkSync(type='dir')",
      supported: true,
      create: (link, target) => symlinkSync(target, link, win ? "junction" : "dir"),
    },
    {
      id: "mklink",
      label: "cmd mklink /J",
      supported: win,
      create: mklinkJunction,
    },
  ];
}

/**
 * The exit code implied by a set of probe results.
 *
 * Extracted from `main()` so the truth table can be tested directly. That matters more than
 * it looks: on a host where links are broken, the real `main()` can only ever return 1, so
 * the `0` branch is otherwise never executed by the test run — and an unexecuted branch is
 * not a tested branch. Testing it here means the suite is meaningful on a healthy machine and
 * on a broken one.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *   • Capability, not health — ONE traversable method is enough. A host where only `mklink`
 *     is broken is a capable host.
 *   • A method that could not be created is not evidence of anything. A host that refuses
 *     symlinks for lack of privilege must not be reported as incapable, or the check would
 *     tell a locked-down-but-healthy machine that it is broken.
 *
 * @param {{supported: boolean, verdict: string}[]} probes
 * @returns {number} {@link EXIT.OK} when at least one supported method produced a
 *   traversable link, {@link EXIT.FAIL} otherwise
 */
export function verdictFor(probes) {
  return probes.some((p) => p.supported && p.verdict === LinkState.TRAVERSABLE) ? EXIT.OK : EXIT.FAIL;
}

/**
 * The control that makes a code-1 verdict trustworthy.
 *
 * If a plain directory cannot be created or traversed, then nothing this script reports
 * about reparse points is evidence of anything — the host is failing at a level below the
 * question being asked. That is exit 2, not exit 1.
 *
 * @param {string} base
 * @returns {{ok: true, entries: number} | {ok: false, stage: string, detail: string}}
 */
export function controlPlainDirectory(base) {
  const dir = join(base, "control-plain");
  const created = attempt(() => mkdirSync(dir, { recursive: true }));
  if (!created.ok) return { ok: false, stage: "mkdir", detail: `${created.code} ${created.message}` };
  writeFileSync(join(dir, "package.json"), '{"control":true}\n');
  const listed = attempt(() => readdirSync(dir).length);
  if (!listed.ok) return { ok: false, stage: "readdir", detail: `${listed.code} ${listed.message}` };
  const read = attempt(() => readFileSync(join(dir, "package.json"), "utf8"));
  if (!read.ok) return { ok: false, stage: "read", detail: `${read.code} ${read.message}` };
  return { ok: true, entries: listed.value };
}

/** Reads the repository's workspace links, if asked. Read-only. */
export function inspectWorkspaceLinks(root = ROOT) {
  const dir = join(root, "node_modules", "@sigilkit");
  const listing = attempt(() => readdirSync(dir));
  if (!listing.ok) return { present: false, detail: `${listing.code} ${listing.message}`, links: [] };
  const links = listing.value
    .filter((name) => attempt(() => lstatSync(join(dir, name))).ok)
    .map((name) => {
      const link = join(dir, name);
      const lst = attempt(() => lstatSync(link));
      const rl = attempt(() => readlinkSync(link));
      const trav = attempt(() => statSync(link).isDirectory());
      return {
        name,
        isLink: lst.ok ? Boolean(lst.value.isSymbolicLink()) : null,
        readlink: rl.ok ? rl.value : null,
        traversable: trav.ok,
        code: trav.ok ? null : trav.code,
        errno: trav.ok ? null : trav.errno,
      };
    });
  return { present: true, links };
}

function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv, {
      json: { type: "boolean" },
      "workspace-links": { type: "boolean" },
    });
  } catch (err) {
    return reportUsage(TOOL, messageOf(err), USAGE);
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  const base = mkdtempSync(join(tmpdir(), "sigilkit-reparse-"));
  let control = null;
  let probes = [];
  let code;
  try {
    control = controlPlainDirectory(base);
    if (!control.ok) {
      code = EXIT.USAGE;
    } else {
      probes = buildMethods().map((m) => probeMethod(m, base));
      // Capability, not health: a host that can make even ONE traversable link can host
      // reparse points. A method that failed to create tells us nothing either way.
      code = verdictFor(probes);
    }
  } finally {
    // Remove the scratch tree even on the failure paths. force:true is required: the dead
    // links this script exists to detect are exactly the ones a plain rmdir refuses.
    const cleaned = attempt(() => rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }));
    // A refused cleanup used to be surfaced only when no verdict existed yet, so on every
    // normal path it was discarded — leaving a tree of dead reparse points on disk with
    // nothing in the output saying so. It always reports now, and it escalates the code
    // only when the run would otherwise be a clean pass: an existing FAIL stays FAIL, since
    // code 2 there would replace "links do not work here" with "no verdict".
    if (!cleaned.ok) {
      process.stderr.write(`${TOOL}: could not remove the scratch directory ${base} (${cleaned.message}) — remove it by hand\n`);
      if (code === undefined || code === EXIT.OK) code = EXIT.USAGE;
    }
  }

  const report = {
    ok: code === EXIT.OK,
    exit: code,
    platform: process.platform,
    observedReparseErrno: REPARSE_ERRNO,
    control,
    probes,
    workspaceLinks: flags["workspace-links"] ? inspectWorkspaceLinks() : null,
    note:
      "Reports whether THIS HOST can create and traverse a reparse point. Not a " +
      "dependency-tree or repository health check — see the header before using it as a gate.",
  };

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return code;
  }

  const out = [];
  if (!control.ok) {
    out.push(`${TOOL}: the host failed the plain-directory control (${control.stage}: ${control.detail}).`);
    out.push("No verdict on reparse points — a control failure means the host is failing below the question being asked.");
  } else {
    out.push(`host reparse-point capability — ${report.ok ? "CAPABLE" : "NOT CAPABLE"} (${process.platform})`);
    out.push(`  control: plain directory create + read OK (${control.entries} entries)`);
    for (const p of probes) {
      if (!p.supported) { out.push(`  ${p.label.padEnd(30)} SKIPPED (not supported here)`); continue; }
      if (p.verdict === LinkState.NOT_CREATED) { out.push(`  ${p.label.padEnd(30)} NOT CREATED (${p.createError})`); continue; }
      const r = p.result;
      out.push(
        `  ${p.label.padEnd(30)} ${r.state}` +
          `  isLink=${r.isLink} readlink=${r.readlink ? "ok" : "none"}` +
          `  throughLink=${r.traverse.ok ? "readable" : `${r.traverse.code}${r.traverse.errno ? ` errno=${r.traverse.errno}` : ""}`}`,
      );
    }
    if (!report.ok) {
      out.push("");
      out.push("  Every method that created a link produced one that cannot be traversed.");
      out.push("  This is a host-level fault, not a repository fault: it reproduces in a clean");
      out.push("  temp directory with no repo involvement, and on more than one volume.");
      out.push("  Reinstalling node_modules or re-running `mklink /J` cannot fix it. Link-based");
      out.push("  installs do not work here; use an environment whose reparse-point");
      out.push("  implementation is intact, or install with copying instead of linking.");
    }
  }

  const ws = report.workspaceLinks;
  if (ws) {
    out.push("");
    out.push(ws.present
      ? `  workspace links (node_modules/@sigilkit): ${ws.links.length} entr${ws.links.length === 1 ? "y" : "ies"}`
      : `  workspace links (node_modules/@sigilkit): unreadable (${ws.detail})`);
    for (const l of ws.links ?? []) {
      out.push(`    ${l.name.padEnd(14)} isLink=${l.isLink}  traversable=${l.traversable}${l.code ? ` (${l.code} errno=${l.errno})` : ""}`);
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return code;
}

const invokedDirectly =
  process.argv[1] &&
  (process.platform === "win32"
    ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase()
    : pathToFileURL(process.argv[1]).href === import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
