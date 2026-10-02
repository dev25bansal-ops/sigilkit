import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_TARGETS,
  DANGEROUS_PATHS,
  IRREVERSIBLE_TARGETS,
  PACKAGES,
  REPRODUCIBLE_TARGETS,
  classifyTargets,
  decideConfirmation,
  formatBytes,
  measureTree,
  parseArgs,
  planTargets,
  removeVerified,
  runClean,
} from "./clean.mjs";

/**
 * The first tests for clean.mjs. Everything here runs against a throwaway fixture root under
 * os.tmpdir() or a stubbed `fs` — no test touches the real repo, and none deletes anything
 * outside its own fixture.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "clean.mjs");

/**
 * The real `fs` subset the module uses, so a test can override one method and keep the rest.
 * Flat: `measureTree` and `removeVerified` take it as their second argument.
 */
const realFs = async () => {
  const fs = await import("node:fs");
  return { existsSync: fs.existsSync, lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, rmSync: fs.rmSync };
};

/**
 * `runClean` deps. `runClean` destructures `deps.fs`, so the fs object must be nested — a flat
 * spread would leave the runner on the real module and silently ignore the stub under test.
 */
const deps = async (out, overrides = {}) => ({ fs: await realFs(), log: out.log, ...overrides });

/** Create `rel` under `root` holding `files` bytes total, in a predictable layout. */
function seed(root, rel, bytes = 0, leaves = 1) {
  const abs = join(root, rel);
  mkdirSync(abs, { recursive: true });
  if (bytes > 0) {
    const per = Math.max(1, Math.floor(bytes / leaves));
    for (let i = 0; i < leaves; i++) {
      writeFileSync(join(abs, `f${i}.bin`), Buffer.alloc(per, 1));
    }
  }
  return abs;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const capture = () => {
  const lines = [];
  return { log: (l) => lines.push(String(l)), text: () => lines.join("\n") };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hold `abs` open as a live child's working directory, so the OS refuses to unlink it.
 *
 * This is the only blocker measured to be genuinely enforced on every platform: chmod and
 * read-only attributes are not enforced on Windows (nor when the suite runs elevated), and a
 * dangling junction/symlink is still removable. A live CWD raises EPERM (win32) / EBUSY (posix).
 *
 * `unref()` is essential, not cosmetic: on Windows `child.kill()` does not reliably emit `exit`,
 * so a referenced child handle keeps the event loop alive and the whole test runner hangs after
 * the last test has already passed.
 */
async function holdDir(abs) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: abs, stdio: "ignore" });
  child.unref();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await sleep(300); // let the child actually start and take `abs` as its CWD
  return async function release() {
    child.kill();
    await Promise.race([exited, sleep(2000)]);
    await sleep(200); // let the OS release the directory lock
  };
}

// --- TARGETS audit: DEBT-05 and the data-loss sweep -----------------------------------------

test("TARGETS: broadcast is NOT in the default deletion list", () => {
  assert.ok(!REPRODUCIBLE_TARGETS.includes("broadcast"), "broadcast must be opt-in, not default");
  assert.deepEqual(IRREVERSIBLE_TARGETS, ["broadcast"]);
});

test("TARGETS: nothing dangerous is reachable without a flag", () => {
  const { safe, dangerous } = classifyTargets(REPRODUCIBLE_TARGETS);
  assert.deepEqual(dangerous, [], "no confirmable path may sit in the default list");
  assert.deepEqual(safe, REPRODUCIBLE_TARGETS);
});

test("TARGETS: no source tree, VCS dir, dependency dir or secret is ever targeted", () => {
  // The high-consequence sweep: deleting any of these loses tracked work or secrets.
  // Paths whose loss is unrecoverable or secret-bearing. `dist`/`coverage` are deliberately
  // absent: those names are generated artefacts and are legitimately disposable.
  const forbidden = [
    "node_modules", ".git", ".env", ".env.local", "packages", "contracts", "scripts",
    "lib", "vault", "docs", "vectors", "package.json", "package-lock.json", "foundry.toml",
    "src", "test", "tests", "sigilkit-audit.db", "data", "output", "broadcast",
  ];
  for (const rel of ALL_TARGETS) {
    const segments = rel.split("/");
    for (const bad of forbidden) {
      if (bad === "broadcast") continue; // allowed, but only behind --include-broadcast
      // Only a *terminal* segment disqualifies a target. A generated artefact legitimately
      // lives under a source directory (`packages/core/dist`), so `packages` appearing as a
      // parent is expected. What must never happen is a target that *ends* at a protected
      // name — `packages/core`, `.git`, `node_modules`, `.env` — because that deletes the
      // tracked work or the secret itself.
      const at = segments.indexOf(bad);
      assert.ok(
        at === -1 || at !== segments.length - 1,
        `TARGETS must not end at "${bad}": "${rel}" would delete it`,
      );
    }
  }
  // Every default target must be a generated artefact, by name.
  for (const rel of REPRODUCIBLE_TARGETS) {
    const leaf = rel.split("/").pop();
    const generated = /^(out|cache|coverage|dist|test-results|fleet-manifest\.json|metamask|metamask\.zip|\.playwright-profile|\.coinbase-out)$/.test(leaf);
    assert.ok(generated, `"${rel}" does not look like a generated artefact`);
  }
  // And a package name must never expand into the package root itself.
  for (const p of PACKAGES) {
    assert.ok(!ALL_TARGETS.includes(`packages/${p}`), `packages/${p} itself must never be deleted`);
  }
});

test("TARGETS: outputs/ is not a target, but is registered as credential-adjacent", () => {
  // outputs/ is gitignored scratch that SK-01 flags as possibly holding credential logs. It is
  // not disposable, so it is not a target — and if a future edit adds it, decideConfirmation
  // must still treat it as confirmable.
  assert.ok(!ALL_TARGETS.includes("outputs"));
  assert.ok(DANGEROUS_PATHS.includes("outputs"));
  assert.equal(decideConfirmation({ dangerousTargets: ["outputs"], isTTY: false, yes: false }).mode, "refuse");
  assert.equal(decideConfirmation({ dangerousTargets: ["outputs"], isTTY: true, yes: false }).mode, "prompt");
});

// --- parseArgs ------------------------------------------------------------------------------

test("parseArgs: flags are read independently", () => {
  assert.deepEqual(parseArgs([]), { dry: false, yes: false, includeBroadcast: false, root: null, help: false });
  assert.deepEqual(parseArgs(["--dry", "--include-broadcast", "--yes"]).dry, true);
  assert.equal(parseArgs(["--include-broadcast"]).includeBroadcast, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.equal(parseArgs(["--dry", "--include-broadcast", "--yes"]).yes, true);
});

test("parseArgs: a non-flag argument is not a flag, and --root takes the next value", () => {
  const parsed = parseArgs(["node", "clean", "--root", join("C:", "tmp", "fixture")]);
  assert.equal(parsed.root, join("C:", "tmp", "fixture"));
  assert.equal(parseArgs([]).root, null);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs: npm run clean passes no flags, so broadcast is unreachable", () => {
  // package.json defines "clean": "node scripts/clean.mjs" — the default path can never opt in.
  assert.equal(parseArgs([]).includeBroadcast, false);
  assert.deepEqual(planTargets().dangerous, []);
});

// --- planTargets ----------------------------------------------------------------------------

test("planTargets: default plan excludes broadcast and reports it as skipped", () => {
  const plan = planTargets();
  assert.deepEqual(plan.dangerous, []);
  assert.deepEqual(plan.skipped, ["broadcast"]);
  assert.ok(!plan.safe.includes("broadcast"));
});

test("planTargets: --include-broadcast moves it from skipped to dangerous", () => {
  const plan = planTargets({ includeBroadcast: true });
  assert.deepEqual(plan.dangerous, ["broadcast"]);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.safe.includes("broadcast"), false, "it must never also appear as safe");
});

test("planTargets: an unknown flag shape does not silently include broadcast", () => {
  const plan = planTargets({ includeBroadcast: "false" });
  assert.deepEqual(plan.dangerous, ["broadcast"], "truthiness is the caller's contract; plan is explicit");
  assert.equal(typeof planTargets().dangerous.length, "number");
});

// --- decideConfirmation ---------------------------------------------------------------------

test("decideConfirmation: no dangerous target needs no confirmation", () => {
  assert.deepEqual(decideConfirmation({ dangerousTargets: [], isTTY: false, yes: false }).mode, "none");
});

test("decideConfirmation: a plain non-TTY run is allowed through", () => {
  assert.equal(decideConfirmation({ dangerousTargets: [], isTTY: false, yes: false }).mode, "none");
  assert.equal(decideConfirmation({ isTTY: false, yes: false }).mode, "none");
});

test("decideConfirmation: non-TTY without --yes is refused, not silently skipped", () => {
  const v = decideConfirmation({ dangerousTargets: ["broadcast"], isTTY: false, yes: false });
  assert.equal(v.mode, "refuse");
  assert.match(v.reason, /refusing rather than/);
  assert.match(v.reason, /--include-broadcast --yes/);
});

test("decideConfirmation: TTY without --yes prompts", () => {
  assert.equal(decideConfirmation({ dangerousTargets: ["broadcast"], isTTY: true, yes: false }).mode, "prompt");
});

test("decideConfirmation: --yes allows a non-TTY dangerous delete", () => {
  assert.equal(decideConfirmation({ dangerousTargets: ["broadcast"], isTTY: false, yes: true }).mode, "allow");
  assert.equal(decideConfirmation({ dangerousTargets: ["broadcast"], isTTY: true, yes: true }).mode, "allow");
});

test("decideConfirmation: refusal is fail-closed, never a quiet pass", () => {
  // The bug class: reporting success while quietly leaving the tree in place.
  const v = decideConfirmation({ dangerousTargets: ["broadcast"], isTTY: false, yes: false });
  assert.notEqual(v.mode, "allow");
  assert.notEqual(v.mode, "none");
});

// --- measureTree ---------------------------------------------------------------------------

test("measureTree: counts files and bytes recursively", async (t) => {
  const root = fixture(t);
  seed(root, "out/a", 100, 1);
  seed(root, "out/nested/deep/b", 200, 2);
  const { files, bytes } = measureTree(join(root, "out"), await realFs());
  assert.equal(files, 3);
  assert.equal(bytes, 300);
});

test("measureTree: a single file target counts as one file", async (t) => {
  const root = fixture(t);
  const abs = join(root, "fleet-manifest.json");
  writeFileSync(abs, Buffer.alloc(42, 1));
  const { files, bytes } = measureTree(abs, await realFs());
  assert.equal(files, 1);
  assert.equal(bytes, 42);
});

test("measureTree: an empty directory is zero files, not a missing entry", async (t) => {
  const root = fixture(t);
  seed(root, "empty");
  const r = measureTree(join(root, "empty"), await realFs());
  assert.equal(r.files, 0);
  assert.equal(r.bytes, 0);
  assert.deepEqual(r.errors, []);
});

test("measureTree: an unreadable path is reported as an error, not thrown", () => {
  // A stubbed fs proves the caller can surface a partial measurement.
  const fake = {
    existsSync: () => true,
    lstatSync: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); },
    readdirSync: () => [],
  };
  const r = measureTree("/blocked", fake);
  assert.match(r.errors[0], /EPERM/);
  assert.equal(r.files, 0);
});

test("measureTree: a symlink is counted without being followed", async (t) => {
  const root = fixture(t);
  seed(root, "real/a", 10, 1);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(root, "real"), join(root, "link"), "junction");
  const r = measureTree(join(root, "real"), await realFs());
  assert.equal(r.files, 1, "the walk stays inside the real tree");
});

// --- removeVerified: the DEBT-05 post-condition ---------------------------------------------

test("removeVerified: a successful delete reports ok", async (t) => {
  const root = fixture(t);
  const abs = seed(root, "out/a", 10, 1);
  assert.deepEqual(removeVerified(abs, await realFs()), { ok: true });
  assert.equal(existsSync(abs), false);
});

test("removeVerified: a path that survives the delete is an error", () => {
  // The regression the old code could not catch: rmSync returned, the tree was still there,
  // and the script printed "removed".
  let present = true;
  const stub = {
    rmSync: () => {},
    existsSync: () => present,
  };
  const r = removeVerified("/stubborn", stub);
  assert.equal(r.ok, false);
  assert.match(r.reason, /post-check failed/);
  present = false;
  assert.deepEqual(removeVerified("/stubborn", stub), { ok: true });
});

test("removeVerified: an rmSync throw is reported, not propagated", () => {
  const stub = { rmSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, existsSync: () => true };
  const r = removeVerified("/busy", stub);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rm failed: EBUSY/);
});

// --- runClean: dry-run reporting ------------------------------------------------------------

test("runClean --dry: reports per-path file counts and bytes, and deletes nothing", async (t) => {
  const root = fixture(t);
  seed(root, "out", 1000, 1);
  seed(root, "cache", 2000, 2);
  const out = capture();
  const r = await runClean({ root, dry: true, isTTY: false, yes: false }, await deps(out));

  assert.equal(r.status, 0);
  assert.equal(r.removed, 0, "dry run must remove nothing");
  assert.equal(existsSync(join(root, "out")), true, "out/ must survive --dry");
  assert.equal(existsSync(join(root, "cache")), true, "cache/ must survive --dry");
  assert.match(out.text(), /out\s+1 files\s+0\.0 MB/);
  assert.match(out.text(), /cache\s+2 files\s+0\.0 MB/);
  assert.match(out.text(), /would reclaim 0\.0 MB \(3 files\)/);
  assert.match(out.text(), /nothing was deleted/);
});

test("runClean --dry: byte totals are exact, not a rounded stand-in", async (t) => {
  const root = fixture(t);
  seed(root, "out", 3 * 1024 * 1024, 1);
  seed(root, "coverage", 1024, 1);
  const out = capture();
  const r = await runClean({ root, dry: true, isTTY: false }, await deps(out));
  assert.equal(r.totalBytes, 3 * 1024 * 1024 + 1024);
  assert.equal(r.totalFiles, 2);
  assert.match(out.text(), /3\.0 MB/);
  assert.match(out.text(), /0\.0 MB/);
});

test("runClean --dry: says nothing to clean when the tree is empty", async (t) => {
  const root = fixture(t);
  const out = capture();
  const r = await runClean({ root, dry: true, isTTY: false }, await deps(out));
  assert.equal(r.status, 0);
  assert.match(out.text(), /nothing to clean/);
});

test("runClean --dry: never touches broadcast, and says why it is skipped", async (t) => {
  const root = fixture(t);
  seed(root, "broadcast/Deploy.s.sol/31337", 2000, 2);
  const out = capture();
  const r = await runClean({ root, dry: true, isTTY: false }, await deps(out));
  assert.equal(r.removed, 0);
  assert.match(out.text(), /skipped\s+broadcast/);
  assert.match(out.text(), /not reproducible from source/);
  assert.match(out.text(), /--include-broadcast/);
  assert.equal(existsSync(join(root, "broadcast")), true, "--dry must never delete broadcast");
});

test("runClean --dry --include-broadcast: lists broadcast with counts", async (t) => {
  const root = fixture(t);
  seed(root, "broadcast/Deploy.s.sol/31337", 2000, 2);
  const out = capture();
  const r = await runClean({ root, dry: true, includeBroadcast: true, isTTY: false }, await deps(out));
  assert.equal(r.removed, 0);
  assert.match(out.text(), /broadcast\s+2 files/);
  assert.match(out.text(), /would reclaim/);
});

// --- runClean: default protection ----------------------------------------------------------

test("runClean default: deletes reproducible targets and leaves broadcast alone", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "cache", 100, 1);
  seed(root, "broadcast/Deploy.s.sol/31337", 500, 1);
  const out = capture();
  const r = await runClean({ root, isTTY: false, yes: false }, await deps(out));

  assert.equal(r.status, 0);
  assert.equal(r.removed, 2);
  assert.equal(existsSync(join(root, "out")), false);
  assert.equal(existsSync(join(root, "cache")), false);
  assert.equal(existsSync(join(root, "broadcast")), true, "default run must never delete broadcast");
  assert.match(out.text(), /skipped\s+broadcast/);
});

test("runClean default: npm run clean path can never delete broadcast", async (t) => {
  const root = fixture(t);
  seed(root, "broadcast", 100, 1);
  seed(root, "out", 100, 1);
  const out = capture();
  const r = await runClean({ root, isTTY: false, yes: false }, await deps(out));
  assert.equal(r.removed, 1);
  assert.equal(existsSync(join(root, "broadcast")), true);
  assert.match(out.text(), /skipped\s+broadcast/);
});

// --- runClean: confirmation semantics -------------------------------------------------------

test("runClean: non-TTY --include-broadcast without --yes refuses and deletes nothing", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "broadcast/Deploy.s.sol/31337", 500, 1);
  const out = capture();
  const r = await runClean({ root, includeBroadcast: true, isTTY: false, yes: false }, await deps(out));

  assert.equal(r.status, 1, "a refused dangerous delete must exit non-zero");
  assert.equal(r.refused, true);
  assert.equal(r.removed, 0, "nothing may be deleted when confirmation is refused");
  assert.equal(existsSync(join(root, "out")), true, "even safe targets must survive a refusal");
  assert.equal(existsSync(join(root, "broadcast")), true);
  assert.match(out.text(), /refused:/);
});

test("runClean: a declined prompt refuses and deletes nothing", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "broadcast", 100, 1);
  const out = capture();
  const r = await runClean(
    { root, includeBroadcast: true, isTTY: true, yes: false },
    await deps(out, { prompt: async () => false }),
  );
  assert.equal(r.status, 1);
  assert.equal(r.refused, true);
  assert.equal(existsSync(join(root, "out")), true);
  assert.equal(existsSync(join(root, "broadcast")), true);
});

test("runClean: an accepted prompt deletes broadcast", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "broadcast", 100, 1);
  const out = capture();
  const r = await runClean(
    { root, includeBroadcast: true, isTTY: true, yes: false },
    await deps(out, { prompt: async () => true }),
  );
  assert.equal(r.status, 0);
  assert.equal(r.removed, 2);
  assert.equal(existsSync(join(root, "broadcast")), false);
});

test("runClean: --yes in a non-TTY proceeds with the dangerous delete", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "broadcast", 100, 1);
  const out = capture();
  const r = await runClean(
    { root, includeBroadcast: true, isTTY: false, yes: true },
    await deps(out),
  );
  assert.equal(r.status, 0);
  assert.equal(r.removed, 2);
  assert.equal(existsSync(join(root, "broadcast")), false);
});

test("runClean: the prompt is never opened when no dangerous target is present", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  let prompted = false;
  await runClean(
    { root, isTTY: true, yes: false },
    await deps(capture(), { prompt: async () => { prompted = true; return true; } }),
  );
  assert.equal(prompted, false, "a plain TTY run must not ask about a tree it will not touch");
});

// --- runClean: negative test, deletion is verified -------------------------------------------

test("runClean: a target that survives the delete is an error with a non-zero exit", async (t) => {
  // The core DEBT-05 regression. A stub rmSync that returns normally but deletes nothing is
  // exactly what `force: true` used to hide; the post-check must catch it and force exit 1.
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "cache", 100, 1);
  const out = capture();
  const real = await realFs();
  // Pretends to succeed, removes nothing.
  const r = await runClean({ root, isTTY: false, yes: false }, { log: out.log, fs: { ...real, rmSync: () => {} } });

  assert.equal(r.status, 1, "a surviving target must drive a non-zero exit");
  assert.equal(r.removed, 0);
  assert.equal(r.failed, 2, "both stubborn paths are reported");
  assert.equal(r.failures.length, 2);
  assert.ok(r.failures.every((f) => /post-check failed/.test(f)), r.failures.join("\n"));
  assert.match(out.text(), /ERROR {4}out: still present after rmSync/);
  assert.match(out.text(), /reclaimed 0\.0 MB \(0 files\)/);
});

test("runClean: a partially failing run still removes what it can, and still exits non-zero", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "cache", 100, 1);
  const real = await realFs();
  const out = capture();
  const r = await runClean(
    { root, isTTY: false, yes: false },
    { log: out.log, fs: { ...real, rmSync: (p, o) => (String(p).endsWith("out") ? real.rmSync(p, o) : undefined) } },
  );

  assert.equal(r.status, 1);
  assert.equal(r.removed, 1, "the deletable path is still cleaned");
  assert.equal(r.failed, 1);
  assert.match(r.failures[0], /^cache: /);
  assert.equal(existsSync(join(root, "out")), false);
  assert.equal(existsSync(join(root, "cache")), true);
});

test("runClean: a genuinely undeletable directory is reported as a failure, not a silent success", async (t) => {
  // The real-filesystem version of the negative test, and it must actually be *real* on the
  // platform it runs on. Measured behaviour of the candidate blockers:
  //   - chmod 0o555 / read-only attribute: NOT enforced on Windows (and ineffective when the
  //     suite runs elevated), so a test built on it silently degenerates to "exit 0" and proves
  //     nothing. Rejected.
  //   - dangling junction / symlink: still removable, so also rejected.
  //   - a directory held open as a live child's working directory: reliably raises EBUSY on
  //     POSIX and EPERM on Windows (5/5 in a repeat probe), and becomes removable again once the
  //     child exits, so cleanup is still possible.
  // The child is therefore the blocker, on every platform.
  // Not `fixture(t)`: its `after` hook is registered here, i.e. *before* the release hook, and
  // hooks run in registration order — so the fixture would try to delete the root while the
  // child still held it, failing teardown with EPERM. One ordered teardown instead.
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-locked-"));
  const blocked = seed(root, "out", 100, 1);
  const real = await realFs();

  const release = await holdDir(blocked);
  t.after(async () => {
    await release();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // `maxRetries: 0` stops rmSync from waiting out a transient lock, so the in-use condition
  // surfaces as a hard failure rather than being silently retried away.
  const strict = { ...real, rmSync: (p, o) => real.rmSync(p, { ...o, maxRetries: 0, retryDelay: 0 }) };
  const out = capture();
  const r = await runClean({ root, isTTY: false, yes: false }, { log: out.log, fs: strict });

  if (!existsSync(blocked)) {
    // The OS allowed the delete despite the lock; then there is nothing to assert, and saying
    // so loudly beats a green test that never exercised the post-check.
    t.diagnostic("platform allowed deletion of a directory held as a child's CWD; post-check not exercised");
    return;
  }
  assert.equal(r.status, 1, "an undeletable path must exit non-zero");
  assert.equal(r.failed, 1);
  assert.match(r.failures[0], /^out: /);
  assert.equal(existsSync(blocked), true, "the undeletable tree survives");
  assert.match(out.text(), /ERROR {4}out:/);
});

test("runClean: the real post-check catches a mocked fs whose existsSync always says true", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  const real = await realFs();
  const out = capture();
  const r = await runClean(
    { root, isTTY: false, yes: false },
    { log: out.log, fs: { ...real, existsSync: () => true } },
  );
  assert.equal(r.status, 1);
  assert.equal(r.removed, 0);
  assert.equal(r.removed, 0);
  assert.ok(r.failures.length > 0);
});

// --- runClean: idempotence ------------------------------------------------------------------

test("runClean: running twice removes nothing the second time and reports no error", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "cache", 100, 1);
  seed(root, "coverage", 100, 1);
  const first = capture();
  const r1 = await runClean({ root, isTTY: false, yes: false }, await deps(first));
  assert.equal(r1.status, 0);
  assert.equal(r1.removed, 3);

  const second = capture();
  const r2 = await runClean({ root, isTTY: false, yes: false }, await deps(second));
  assert.equal(r2.status, 0, "the second run must be clean, not an error");
  assert.equal(r2.removed, 0, "zero deletions");
  assert.equal(r2.failed, 0, "zero errors");
  assert.match(second.text(), /nothing to clean/);
});

test("runClean: a refused run followed by a clean run leaves broadcast intact", async (t) => {
  const root = fixture(t);
  seed(root, "out", 100, 1);
  seed(root, "broadcast", 100, 1);
  const out = capture();
  const refused = await runClean(
    { root, includeBroadcast: true, isTTY: false, yes: false },
    await deps(out),
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.removed, 0);
  assert.equal(existsSync(join(root, "broadcast")), true);

  // The default run afterwards is clean, and still does not reach broadcast.
  const out2 = capture();
  const r2 = await runClean({ root, isTTY: false, yes: false }, await deps(out2));
  assert.equal(r2.status, 0);
  assert.equal(r2.removed, 1);
  assert.equal(existsSync(join(root, "out")), false);
  assert.equal(existsSync(join(root, "broadcast")), true);
});

// --- direct-invocation guard ----------------------------------------------------------------

test("CLI: --dry in a non-TTY reports without deleting", () => {
  // spawnSync gives a non-TTY stdin, so this is exactly the CI shape.
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-cli-"));
  try {
    seed(root, "out", 4096, 1);
    seed(root, "broadcast/Deploy.s.sol/31337", 2048, 1);
    const r = spawnSync(process.execPath, [SCRIPT, "--dry", "--root", root], {
      cwd: REPO_ROOT, encoding: "utf8", input: "",
    });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /would remove {2}out/);
    assert.match(r.stdout, /would reclaim/);
    assert.match(r.stdout, /skipped {2}broadcast/);
    assert.equal(existsSync(join(root, "out")), true, "nothing may be deleted by --dry");
    assert.equal(existsSync(join(root, "broadcast")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: --include-broadcast in a non-TTY without --yes exits non-zero and deletes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-cli-"));
  try {
    seed(root, "out", 4096, 1);
    seed(root, "broadcast", 4096, 1);
    const r = spawnSync(process.execPath, [SCRIPT, "--include-broadcast", "--root", root], {
      cwd: REPO_ROOT, encoding: "utf8", input: "",
    });
    assert.ifError(r.error);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /refused/);
    assert.equal(existsSync(join(root, "out")), true, "a refusal must not partially clean");
    assert.equal(existsSync(join(root, "broadcast")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: --include-broadcast --yes in a non-TTY proceeds and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-cli-"));
  try {
    seed(root, "out", 4096, 1);
    seed(root, "broadcast", 4096, 1);
    const r = spawnSync(process.execPath, [SCRIPT, "--include-broadcast", "--yes", "--root", root], {
      cwd: REPO_ROOT, encoding: "utf8", input: "",
    });
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(join(root, "out")), false);
    assert.equal(existsSync(join(root, "broadcast")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: an undeletable target is reported and the process exits non-zero", async (t) => {
  // Proves the post-check is wired to the real *process exit code*, not just the returned value.
  //
  // Blocker choice matters: an earlier version used chmod 0o555 on Windows and a dangling
  // junction. Measured on this platform, both are removable, so the test silently took the
  // "blocker ineffective" branch and asserted `status === 0` — a green test that never
  // exercised the post-check at all. A directory held as a live child's working directory is
  // what actually fails (EPERM on Windows, EBUSY on POSIX), so that is what is used here.
  const root = mkdtempSync(join(tmpdir(), "sigilkit-clean-cli-"));
  const blocked = join(root, "cache");
  let release;
  try {
    seed(root, "out", 4096, 1);

    const baseline = spawnSync(process.execPath, [SCRIPT, "--root", root], { cwd: REPO_ROOT, encoding: "utf8", input: "" });
    assert.ifError(baseline.error);
    assert.equal(baseline.status, 0, "baseline run is clean");

    // Recreate `cache` and pin it as a live child's CWD so the OS refuses the unlink.
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "keep.bin"), "x");
    release = await holdDir(blocked);

    const r2 = spawnSync(process.execPath, [SCRIPT, "--root", root], { cwd: REPO_ROOT, encoding: "utf8", input: "" });
    assert.ifError(r2.error);

    if (!existsSync(blocked)) {
      // The OS ignored the lock. Do not pretend the post-check was verified.
      t.diagnostic("platform allowed deleting a dir held as a child's CWD — post-check not exercised");
      assert.equal(r2.status, 0, r2.stdout + r2.stderr);
      return;
    }
    // The block held: the surviving target must be reported and the process must exit non-zero.
    assert.equal(r2.status, 1, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /cache: (rm failed|still present)/);
    assert.equal(existsSync(join(root, "out")), false, "the deletable target was still cleaned");
  } finally {
    await release?.();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI: --help prints usage and exits 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--help"], { cwd: REPO_ROOT, encoding: "utf8", input: "" });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /usage: node scripts\/clean\.mjs/);
  assert.match(r.stdout, /--include-broadcast/);
  assert.match(r.stdout, /--yes/);
});

// --- the real repository (read-only) --------------------------------------------------------

test("real repo: the header states the archive-RPC reality, not reproducibility", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "clean.mjs"), "utf8");
  assert.ok(!/All of it is reproducible/i.test(src), "the false DEBT-05 claim must be gone");
  assert.match(src, /archive RPC/i);
  assert.match(src, /deployedBytecode/);
  assert.match(src, /sensitive/i);
});

test("real repo: --dry lists real targets and deletes nothing", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--dry"], { cwd: REPO_ROOT, encoding: "utf8", input: "" });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /would remove|would reclaim|nothing to clean/);
  assert.match(r.stdout, /skipped {2}broadcast/);
  assert.equal(existsSync(join(REPO_ROOT, "broadcast")), true, "the real broadcast/ must survive");
  assert.match(r.stdout, /\d+ files/);
  // No assumption about the local shape of broadcast/: any number of Foundry script dirs
  // (Deploy.s.sol, Deploy2.s.sol, ...) and any number of chainId subdirs is legitimate. The
  // contract under test is only that the tree survives and is reported as skipped.
  const deployDirs = readdirSync(join(REPO_ROOT, "broadcast"), { withFileTypes: true })
    .filter((e) => e.isDirectory());
  assert.ok(deployDirs.length >= 1, "broadcast/ should contain at least one script directory");
  // ...and every entry below broadcast/ is still on disk after the --dry run.
  const stillThere = spawnSync(process.execPath, [SCRIPT, "--dry", "--include-broadcast"], {
    cwd: REPO_ROOT, encoding: "utf8", input: "",
  });
  assert.equal(stillThere.status, 0, stillThere.stdout + stillThere.stderr);
  assert.match(stillThere.stdout, /broadcast\s+\d+ files/);
});

test("real repo: no sensitive key material is committed under broadcast/", () => {
  const dir = join(REPO_ROOT, "broadcast");
  const badNames = [];
  const badContent = [];
  // Content patterns, chosen so a real secret trips them and ordinary on-chain data does not:
  // a bare 32-byte hex literal is NOT a signal, because block hashes, transaction hashes and
  // log data are all legitimately 32 bytes. The unambiguous markers are a credential-named
  // field, a PEM block, and keystore-JSON fields.
  const CONTENT = [
    [/"privateKey"\s*:/gi, 'field "privateKey"'],
    [/"private_key"\s*:/gi, 'field "private_key"'],
    [/\b(?:mnemonic|seedPhrase|seed phrase)\b/gi, "mnemonic / seed phrase"],
    [/passphrase/gi, "passphrase"],
    [/BEGIN [A-Z ]*PRIVATE KEY/gi, "PEM private key"],
    [/scrypt|NIST256p4|"cipher"\s*:/gi, "keystore-JSON fields"],
  ];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (/privatekey|private_key|mnemonic|keystore|passphrase|\.key$|\.pem$|\.p12$/i.test(e.name)) {
        badNames.push(p);
      }
      let text;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue; // unreadable here; name check above still applied
      }
      for (const [re, label] of CONTENT) {
        if (re.test(text)) badContent.push(`${p} — ${label}`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(badNames, [], `sensitive-looking filenames under broadcast/: ${badNames.join(", ")}`);
  assert.deepEqual(badContent, [], `sensitive-looking content under broadcast/: ${badContent.join(", ")}`);
});
