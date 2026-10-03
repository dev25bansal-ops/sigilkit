import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runBlocks, scriptReferences } from "./check-tracked-refs.mjs";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "check-tracked-refs.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── runBlocks: locating every run: body ────────────────────────────────────────────────────────

test("runBlocks: finds a plain scalar run: body", () => {
  const text = ["jobs:", "  a:", "    steps:", "      - run: node scripts/one.mjs", "      - run: node scripts/two.mjs"].join("\n");
  assert.deepEqual(scriptReferences(runBlocks(text)), ["scripts/one.mjs", "scripts/two.mjs"]);
});

test("runBlocks: finds a folded run: body and every line in it", () => {
  const text = [
    "jobs:", "  a:", "    steps:", "      - run: >-",
    "          node scripts/folded.mjs",
    "          && node scripts/second.mjs",
    "      - run: node scripts/after.mjs",
  ].join("\n");
  // The regression this pins: the first version advanced `i` by the number of collected
  // lines, which overshoots and drops later blocks. `after.mjs` is the canary — it sits past
  // the folded block, exactly where the truncation ate it.
  assert.deepEqual(scriptReferences(runBlocks(text)), ["scripts/after.mjs", "scripts/folded.mjs", "scripts/second.mjs"]);
});

test("runBlocks: a deeply indented body line does not end the block early", () => {
  const text = [
    "      - run: |", // literal block
    "          cat <<'EOF' >> scripts/out.txt",
    "              deeply indented continuation",
    "          EOF",
    "          node scripts/after-heredoc.mjs",
    "      - run: node scripts/last.mjs",
  ].join("\n");
  const refs = scriptReferences(runBlocks(text));
  assert.ok(refs.includes("scripts/after-heredoc.mjs"), `deep body lines must stay in the block, got ${refs}`);
  assert.ok(refs.includes("scripts/last.mjs"), `the following step must still be found, got ${refs}`);
});

test("runBlocks: an inline comment and a comment-only line are not run: bodies", () => {
  const text = [
    "      # - run: node scripts/commented-out.mjs",
    "      - run: node scripts/real.mjs # trailing note about scripts/inline.mjs",
  ].join("\n");
  assert.deepEqual(scriptReferences(runBlocks(text)), ["scripts/real.mjs"]);
});

test("runBlocks: a shallower line ends the block, and the next step is found", () => {
  const text = [
    "      - run: node scripts/first.mjs",
    "      - name: not a run step",
    "        run: node scripts/second.mjs",
  ].join("\n");
  assert.deepEqual(scriptReferences(runBlocks(text)), ["scripts/first.mjs", "scripts/second.mjs"]);
});

// ── scriptReferences: what counts as a reference ─────────────────────────────────────────────

test("scriptReferences: a trailing shell delimiter is not part of the path", () => {
  assert.deepEqual(scriptReferences('node scripts/a.mjs && node scripts/b.mjs'), ["scripts/a.mjs", "scripts/b.mjs"]);
  assert.deepEqual(scriptReferences('bash scripts/c.sh'), ["scripts/c.sh"]);
  assert.deepEqual(scriptReferences('for f in scripts/*.mjs'), ["scripts/*.mjs"]);
});

test("scriptReferences: a quoted path is extracted without the quotes", () => {
  assert.deepEqual(scriptReferences('bash "scripts/install-x.sh"'), ["scripts/install-x.sh"]);
  assert.deepEqual(scriptReferences("bash 'scripts/install-y.sh'"), ["scripts/install-y.sh"]);
});

test("scriptReferences: a traversal segment is refused rather than extracted", () => {
  // A reference that climbs out of the repo is not a path this gate should go looking for, and
  // it is exactly the shape a hostile workflow would use to make the gate walk elsewhere.
  assert.deepEqual(scriptReferences("node scripts/../etc/passwd"), []);
  assert.deepEqual(scriptReferences("node scripts/./x.mjs"), []);
});

test("scriptReferences: a comment naming a deliberately absent file is not a reference", () => {
  // The regression that matters most for real workflows: SEC-07's own before-state is recorded
  // in a ci.yml comment. Demanding that file be committed would demand committing the thing
  // whose absence is the fix.
  const text = "# into bash (`bash <(curl -sSf .../main/scripts/download-actionlint.bash)`), so anyone";
  assert.deepEqual(scriptReferences(text), []);
});

test("scriptReferences: a scripts/ path under another directory is not repo-root scripts/", () => {
  // The IGNORED set this gate used to carry could never fire (tokens were always
  // scripts/-prefixed), so a reference to a sibling tree's scripts dir was misread as a
  // repo-root one and flagged. The anchor refuses mid-path matches outright now.
  assert.deepEqual(scriptReferences("bash vault/data/scripts/setup.sh"), []);
});

test("scriptReferences: a shell-relative ./scripts/ path is still the gate's subject", () => {
  assert.deepEqual(scriptReferences("node ./scripts/check-vectors.mjs"), ["scripts/check-vectors.mjs"]);
});

// ── the gate end to end, against the real repository ─────────────────────────────────────────

test("the real repository passes: every workflow-invoked path is committed", () => {
  // Written against the live tree. This assertion was flipped from the *failing* state
  // (exit 1) to the passing state on 2026-10-02 in the same commit that committed the
  // thirteen workflow-invoked scripts that were missing from HEAD — the previous pin
  // asserted red on purpose, and its own comment required the flip to happen in the
  // committing change. The pin now guards the committed state: any NEW workflow reference
  // to an uncommitted script fails this test in CI and locally.
  //
  // No count in the name: the assertion below checks the gate's verdict, not a number,
  // and a title claiming "thirteen" would go stale silently the moment the list moved.
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const payload = JSON.parse(spawnSync(process.execPath, [SCRIPT, "--json"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout);
  assert.equal(res.status, 0, `expected the gate to pass with every reference committed\n${res.stdout}${res.stderr}`);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.missing, [], "the gate must not name any uncommitted references");
});

test("the gate skips, and passes, when git cannot answer", () => {
  // Fail-open is a hard requirement: a tarball install or vendored checkout has no .git, and a
  // gate that cannot answer its question must not report a false red.
  //
  // The gate must be COPIED into the fixture, not merely given it as `cwd`. ROOT comes from the
  // script's own location (`dirname(import.meta.url) + "/.."`), so running the real script with
  // `cwd` set elsewhere still inspects this repository and reports its real untracked files.
  // That first version of this test asserted exit 0 and watched a correct failure go by — the
  // fixture looked non-git and was not, because the copied path, not the cwd, is the input.
  const dir = mkdtempSync(join(tmpdir(), "tracked-refs-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "scripts", "check-tracked-refs.mjs"));
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "jobs:\n  a:\n    steps:\n      - run: node scripts/x.mjs\n");
    const res = spawnSync(process.execPath, [join(dir, "scripts", "check-tracked-refs.mjs")], { encoding: "utf8" });
    assert.equal(res.status, 0, `no-git must fail open, got ${res.status}\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /SKIP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
