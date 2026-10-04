import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  collect,
  evaluateReport,
  evaluateVitest,
  meetsFloor,
  parseNodeFloor,
  parseVersion,
  sanitizePath,
} from "./check-runtime.mjs";

const SCRIPT = fileURLToPath(new URL("./check-runtime.mjs", import.meta.url));

// Pure unit tests: no filesystem, no spawning, no external test runner is imported or executed.

const runtimeAt = (version, floor) => ({ version, required: `>=${floor}`, compatible: meetsFloor(version, floor) });

// ── DEBT-06 · collect(): the only code in this script that touches the disk ─────────
// `collect()` was reported as "never called". It is called — once, by `main()`, the CLI
// entry — but nothing tested it, so the disk-touching path was bare. These tests drive it
// against temporary fixtures so the real repository is never read or written.

/** Builds an isolated repository layout under the OS temp dir. */
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** A package.json carrying only the fields `collect` reads. */
const manifest = (extra = {}) => JSON.stringify({ name: "fixture", ...extra });
const vitestManifest = (version) => JSON.stringify({ name: "vitest", version });

test("collect reports the running runtime against the declared engine floor", (t) => {
  const root = fixture(t, { "package.json": manifest({ engines: { node: ">=24" } }) });
  const report = collect({ root });

  assert.equal(report.tool, "check-runtime");
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)), "generatedAt must be an ISO timestamp");
  assert.equal(report.root, sanitizePath(root), "the report must name the root it inspected");
  assert.equal(report.platform, process.platform);
  assert.equal(report.arch, process.arch);

  // The runtime block is read from the *process*, not from the fixture: this check exists
  // precisely to report the interpreter that is actually running.
  assert.equal(report.runtime.version, process.version);
  assert.equal(report.runtime.execPath, sanitizePath(process.execPath));
  assert.equal(report.runtime.required, ">=24");
  assert.equal(report.runtime.floor, "24.0.0");
  assert.equal(report.runtime.compatible, meetsFloor(process.version, [24, 0, 0]));
});

test("collect resolves vitest from the root and from every workspace", (t) => {
  const root = fixture(t, {
    "package.json": manifest({ engines: { node: ">=24" }, workspaces: ["packages/*"] }),
    "node_modules/vitest/package.json": vitestManifest("5.0.0"),
    "packages/core/package.json": JSON.stringify({ name: "@sigilkit/core" }),
    "packages/core/node_modules/vitest/package.json": vitestManifest("5.0.0"),
    "packages/mcp/package.json": JSON.stringify({ name: "@sigilkit/mcp" }),
    "packages/mcp/node_modules/vitest/package.json": vitestManifest("4.0.0"),
  });
  const { vitest } = collect({ root });

  assert.equal(vitest.root.version, "5.0.0");
  assert.match(vitest.root.entry, /node_modules[/\\]vitest[/\\]package\.json$/);
  // The mismatching workspace is named, not merely counted: "some workspace differs" is
  // not actionable, and this is the whole output of the check.
  assert.deepEqual(vitest.mismatched, ["@sigilkit/mcp"]);
  assert.deepEqual(vitest.unresolved, []);
  assert.equal(vitest.consistent, false);
  assert.equal(vitest.workspaces.length, 2);
  assert.equal(vitest.workspaces.find((w) => w.name === "@sigilkit/core").matchesRoot, true);
});

test("collect skips workspace entries that are not packages", (t) => {
  const root = fixture(t, {
    "package.json": manifest({ workspaces: ["packages/*"] }),
    "node_modules/vitest/package.json": vitestManifest("5.0.0"),
    "packages/core/package.json": JSON.stringify({ name: "@sigilkit/core" }),
    "packages/core/node_modules/vitest/package.json": vitestManifest("5.0.0"),
    // A bare directory and a stray file inside packages/ must not be read as workspaces;
    // both would throw or be reported as a workspace that does not exist.
    "packages/README.md": "# not a package\n",
  });
  mkdirSync(join(root, "packages", "scratch"), { recursive: true });
  writeFileSync(join(root, "packages", "stray.txt"), "x");

  const { vitest } = collect({ root });
  assert.deepEqual(vitest.workspaces.map((w) => w.name), ["@sigilkit/core"]);
  assert.equal(vitest.consistent, true);
});

test("collect reports an unresolvable workspace instead of failing", (t) => {
  const root = fixture(t, {
    "package.json": manifest({ workspaces: ["packages/*"] }),
    "node_modules/vitest/package.json": vitestManifest("5.0.0"),
    "packages/core/package.json": JSON.stringify({ name: "@sigilkit/core" }),
  });
  const { vitest } = collect({ root });

  // vitest is hoisted in this layout, so the workspace resolves through the root — the
  // point is that a *missing* resolution is reported as data, never thrown.
  assert.equal(vitest.workspaces[0].resolvable, true);
  assert.equal(vitest.consistent, true);
});

test("collect survives a root with no package.json and no vitest installed", (t) => {
  const root = fixture(t, {});
  const report = collect({ root });

  // No manifest means no declared floor, so the built-in default applies and the report
  // says so (`required: ""`) rather than inventing a requirement the repo never made.
  assert.equal(report.runtime.required, "");
  assert.equal(report.runtime.floor, "24.0.0");
  assert.equal(report.vitest.root.version, null);
  assert.deepEqual(report.vitest.workspaces, []);
  // An unresolved root is not a consistency pass: there is nothing to be consistent with.
  assert.equal(report.vitest.consistent, false, "no root vitest means nothing is consistent");
});

test("an unresolved root vitest fails the check instead of reporting no diagnosis", (t) => {
  // Regression: `evaluateVitest` read the root as truthy, and an unresolved root is a
  // truthy `{version: null}` object. So a machine with no vitest installed reported
  // "consistent", got verdict "no diagnosis", and exited 0 — a diagnostic that reports
  // success precisely when it could not inspect anything.
  const root = fixture(t, { "package.json": manifest({ engines: { node: ">=24" } }) });
  const report = collect({ root });
  assert.equal(report.vitest.root.version, null, "fixture must not resolve vitest");

  const verdict = evaluateReport(report);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.conclusion, /vitest is not resolvable from the repository root/);
});

test("evaluateVitest treats an unresolved root as inconsistent even with no workspaces", () => {
  assert.equal(evaluateVitest({ version: null, entry: null }, []).consistent, false);
  assert.equal(evaluateVitest(null, []).consistent, false);
  assert.equal(evaluateVitest({ version: "5.0.0", entry: "/r/v" }, []).consistent, true);
});

test("collect honours a literal (non-glob) workspace entry", (t) => {
  const root = fixture(t, {
    "package.json": manifest({ workspaces: ["tools"] }),
    "node_modules/vitest/package.json": vitestManifest("5.0.0"),
    "tools/package.json": JSON.stringify({ name: "@sigilkit/tools" }),
    "tools/node_modules/vitest/package.json": vitestManifest("5.0.0"),
  });
  const { vitest } = collect({ root });
  assert.deepEqual(vitest.workspaces.map((w) => w.name), ["tools"]);
  assert.equal(vitest.consistent, true);
});

test("collect's own report is one evaluateReport accepts", (t) => {
  // collect() and evaluateReport() are the two halves of the CLI; a shape drift between
  // them would only show up as a crash at the entry point.
  const root = fixture(t, { "package.json": manifest({ engines: { node: ">=24" } }) });
  const report = collect({ root });
  const verdict = evaluateReport(report);
  assert.equal(typeof verdict.ok, "boolean");
  assert.equal(verdict.exitCode, verdict.ok ? 0 : 1);
  assert.ok(Array.isArray(verdict.reasons));
});

test("CLI prints the runtime report and exits 0 on a healthy repository", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^check-runtime: node v\d+\.\d+\.\d+/m);
  assert.match(result.stdout, /required: .* — compatible/);
  assert.match(result.stdout, /vitest root: /);
  assert.match(result.stdout, /^OK: no diagnosis:/m);
});

test("CLI --json emits the report plus its verdict as parseable JSON", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Exactly collect()'s keys plus `verdict`; the documented shape is the contract.
  assert.deepEqual(Object.keys(payload).sort(), [
    "arch",
    "generatedAt",
    "npm",
    "platform",
    "root",
    "runtime",
    "tool",
    "verdict",
    "vitest",
  ]);
  assert.equal(payload.tool, "check-runtime");
  assert.equal(payload.verdict.ok, true);
  assert.equal(payload.verdict.exitCode, 0);
  // `--json` is machine-readable, so the report must not be contaminated by the
  // human-readable banner that the default mode prints.
  assert.doesNotMatch(result.stdout, /^check-runtime:/m);
});

test("CLI never writes to the inspected repository", (t) => {
  // The script advertises itself as read-only; assert it against a throwaway root rather
  // than trusting the promise, since `collect()` is the only code that touches disk.
  const root = fixture(t, { "package.json": manifest({ engines: { node: ">=24" } }) });
  const listingBefore = readdirSync(root, { recursive: true }).sort();
  const result = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr);
  // The CLI takes no --root flag: it always inspects its own repository. Running it from
  // elsewhere must still succeed, and must not create, delete or touch anything in `root`.
  // `generatedAt` is a clock reading and differs between two collect() calls, so the
  // filesystem listing — not the report — is what "writes nothing" actually means.
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), listingBefore);
});

test("parseVersion reads majors, minors and patch levels", () => {
  assert.deepEqual(parseVersion("v24.12.0"), [24, 12, 0]);
  assert.deepEqual(parseVersion("24"), [24, 0, 0]);
  assert.deepEqual(parseVersion("22.22.2-2"), [22, 22, 2]);
  assert.equal(parseVersion("not-a-version"), null);
});

test("parseNodeFloor extracts the declared engine floor", () => {
  assert.deepEqual(parseNodeFloor({ node: ">=24" }).floor, [24, 0, 0]);
  assert.deepEqual(parseNodeFloor({ node: ">=24.1.2" }).floor, [24, 1, 2]);
  assert.equal(parseNodeFloor({ node: ">=24" }).specified, true);
  assert.deepEqual(parseNodeFloor({}).floor, [24, 0, 0]);
  assert.equal(parseNodeFloor({}).specified, false);
});

test("meetsFloor enforces the node 24 floor", () => {
  assert.equal(meetsFloor("24.0.0", [24, 0, 0]), true);
  assert.equal(meetsFloor("v24.12.0", [24, 0, 0]), true);
  assert.equal(meetsFloor("25.1.0", [24, 0, 0]), true);
  assert.equal(meetsFloor("23.99.99", [24, 0, 0]), false);
  assert.equal(meetsFloor("22.22.2", [24, 0, 0]), false);
  assert.equal(meetsFloor("24.0.0", [24, 1, 0]), false);
  assert.equal(meetsFloor("bogus", [24, 0, 0]), false);
});

test("evaluateReport fails an incompatible runtime", () => {
  const verdict = evaluateReport({
    runtime: runtimeAt("22.22.2", 24),
    vitest: evaluateVitest({ version: "5.0.0", entry: "/r/vitest" }, [{ name: "@sigilkit/core", version: "5.0.0" }]),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.conclusion, /below the required floor/);
});

test("evaluateReport fails on differing workspace vitest versions", () => {
  const vitest = evaluateVitest({ version: "5.0.0", entry: "/r/vitest" }, [
    { name: "@sigilkit/core", version: "5.0.0", entry: "/r/vitest" },
    { name: "@sigilkit/mcp", version: "4.0.0", entry: "/r/node_modules/vitest" },
  ]);
  assert.equal(vitest.consistent, false);
  assert.deepEqual(vitest.mismatched, ["@sigilkit/mcp"]);

  const verdict = evaluateReport({ runtime: runtimeAt("24.12.0", 24), vitest });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.conclusion, /differs from root: @sigilkit\/mcp/);
});

test("evaluateReport fails when a workspace cannot resolve vitest", () => {
  const vitest = evaluateVitest({ version: "5.0.0", entry: "/r/vitest" }, [
    { name: "@sigilkit/indexer", version: null, entry: null },
  ]);
  assert.deepEqual(vitest.unresolved, ["@sigilkit/indexer"]);
  const verdict = evaluateReport({ runtime: runtimeAt("24.12.0", 24), vitest });
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.conclusion, /not resolvable in: @sigilkit\/indexer/);
});

test("evaluateReport reports no diagnosis when runtime and vitest agree", () => {
  const vitest = evaluateVitest({ version: "5.0.0", entry: "/r/vitest" }, [
    { name: "@sigilkit/core", version: "5.0.0", entry: "/r/vitest" },
    { name: "@sigilkit/mcp", version: "5.0.0", entry: "/r/vitest" },
  ]);
  const verdict = evaluateReport({ runtime: runtimeAt("24.12.0", 24), vitest });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.exitCode, 0);
  assert.deepEqual(verdict.reasons, []);
  assert.match(verdict.conclusion, /^no diagnosis:/);
});

test("sanitizePath leaves non-strings untouched", () => {
  assert.equal(sanitizePath(null), null);
  assert.equal(sanitizePath(42), 42);
});

// ── DEBT-06 · is `collect()` dead code? ───────────────────────────────────────────────
// RESOLVED 2026-10-04. This block used to assert the OPPOSITE of what it should have: that
// no manifest script, workflow or gate ran check-runtime.mjs. That assertion was accurate
// and it was the problem — a guard with a full test suite that CI executes, while the
// diagnostic the suite exists for was wired into nothing. `npm run verify` reported a clean
// run of a guard it never invoked.
//
// It is now a `verify.mjs` step (`--only=runtime`), and the test below asserts THAT. Inverting
// it is the point: a test that documented the gap would have blocked the fix, and a test that
// only checked the new wiring would let the manifest/workflow halves rot silently. So all
// three wiring sites are still checked — now as a floor rather than a ceiling.

test("check-runtime is wired into the verify gate (DEBT-06 closed)", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  // 1. Still not a standalone manifest script: the gate is the entry point, so a second
  //    caller here would mean two ways to run the same guard and drift between them.
  const scripts = Object.entries(manifest.scripts).map(([name, cmd]) => `${name}: ${cmd}`);
  const invoking = scripts.filter((line) => line.includes("check-runtime"));
  assert.deepEqual(invoking, [], "a package script now calls check-runtime; keep ONE entry point");

  // 2. No workflow runs it directly. `ci.yml` *does* name the file — but only
  //    `check-runtime.test.mjs`, i.e. it runs the tests for the script. Running a suite
  //    that exercises collect() is not the same as running the diagnostic, so the check
  //    looks for the CLI specifically rather than for the substring.
  const workflowDir = join(ROOT, ".github", "workflows");
  const offenders = [];
  for (const name of readdirSync(workflowDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    for (const line of readFileSync(join(workflowDir, name), "utf8").split(/\r?\n/)) {
      if (/\bcheck-runtime\.mjs\b/.test(line) && !/check-runtime\.test\.mjs/.test(line)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], "a workflow now runs check-runtime; update the DEBT-06 note");

  // 3. The verify gate runs the script's tests AND the diagnostic itself. Both halves are
  //    asserted: the suite keeps the collector honest, and the step is what makes the
  //    diagnostic produce a signal in `npm run verify` rather than only on demand.
  const verifySource = readFileSync(join(ROOT, "scripts", "verify.mjs"), "utf8");
  assert.match(verifySource, /"scripts\/check-runtime\.test\.mjs"/, "its test suite should still be gated");
  // The load-bearing assertion: the gate runs the DIAGNOSTIC, not just its tests. The
  // `helpers` list names `check-runtime.test.mjs`, so a naive substring match would pass on
  // the test alone — this requires the bare `scripts/check-runtime.mjs` step invocation.
  assert.match(
    verifySource,
    /"scripts\/check-runtime\.mjs"/,
    "verify.mjs must invoke scripts/check-runtime.mjs as a step, not only list its test",
  );

  // `collect()` is called from exactly one place — `main()` — and is therefore not
  // unreachable dead code. It is reachable and gated: the CLI on demand, and every
  // `npm run verify` through the `runtime` step.
  const source = readFileSync(SCRIPT, "utf8");
  assert.equal(source.match(/\bcollect\(/g)?.length, 2, "collect() should be defined once and called once");
});
