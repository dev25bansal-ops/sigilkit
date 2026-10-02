import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the actual CLI from an isolated repository layout, never rename/delete local dist.
//
// P0-ZERO: every fixture now gets a `.dockerignore` by default, because the real repository has
// one (29 rules) and a container-building repo without it is not a state worth modelling — the
// guard now fails loudly on its absence (see the dedicated negative control below). Previously
// the fixture omitted it, which was only harmless while absence and "ignores nothing" were the
// same observation. Pass `noDockerignore: true` to exercise the absent case deliberately.
function check(t, instruction, files = {}, { noDockerignore = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-docker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./check-dockerfile.mjs", import.meta.url), join(root, "scripts/check-dockerfile.mjs"));
  // The gate imports ./lib/exit.mjs and ./lib/cli.mjs relative to itself; a fixture with
  // only the script copied dies with ERR_MODULE_NOT_FOUND before reaching any Dockerfile
  // (same wrong-reason failure the check-doc-counts fixture had, one suite over).
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const lib of ["exit.mjs", "cli.mjs"]) {
    copyFileSync(new URL(`./lib/${lib}`, import.meta.url), join(root, "scripts", "lib", lib));
  }
  const dockerignore = noDockerignore ? {} : { ".dockerignore": "node_modules\n.git\ndist\n" };
  const inputs = { Dockerfile: `FROM node:24 AS runtime\nWORKDIR /app\n${instruction}\n`, ...dockerignore, ...files };
  for (const [path, content] of Object.entries(inputs)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [join(root, "scripts/check-dockerfile.mjs")], {
    cwd: root, encoding: "utf8",
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

const callers = [
  ["Dockerfile exec ENTRYPOINT", (path) => [`ENTRYPOINT ["node", "${path}"]`, {}]],
  ["Dockerfile shell CMD", (path) => [`CMD node ${path}`, {}]],
  ["compose entrypoint", (path) => ["CMD [\"--help\"]", {
    "docker-compose.yml": `services:\n  mcp:\n    entrypoint: ["node", "${path}"]\n`,
  }]],
];

for (const [name, caller] of callers) {
  for (const [scenario, target, files, expected] of [
    ["accepts source-backed output before build", "packages/mcp/dist/cli.js", { "packages/mcp/src/cli.ts": "export {};" }, 0],
    ["accepts nested source-backed output before build", "packages/mcp/dist/commands/cli.js", {
      "packages/mcp/src/commands/cli.ts": "export {};",
    }, 0],
    ["accepts mts output before build", "packages/mcp/dist/cli.mjs", { "packages/mcp/src/cli.mts": "export {};" }, 0],
    ["accepts cts output before build", "packages/mcp/dist/cli.cjs", { "packages/mcp/src/cli.cts": "export {};" }, 0],
    ["rejects mismatched source extension", "packages/mcp/dist/cli.mjs", { "packages/mcp/src/cli.ts": "export {};" }, 1],
    ["accepts existing built output", "packages/mcp/dist/cli.js", { "packages/mcp/dist/cli.js": "export {};" }, 0],
    ["rejects unknown packages", "packages/missing/dist/cli.js", {}, 1],
    ["rejects misspelled prebuild output", "packages/mcp/dist/clii.js", { "packages/mcp/src/cli.ts": "export {};" }, 1],
    ["rejects missing output in a built package", "packages/mcp/dist/cli.js", {
      "packages/mcp/src/cli.ts": "export {};", "packages/mcp/dist/index.js": "export {};",
    }, 1],
    ["rejects missing non-dist scripts", "scripts/missing.js", {}, 1],
    ["accepts existing non-dist scripts", "scripts/start.js", { "scripts/start.js": "export {};" }, 0],
  ]) {
    test(`${name}: ${scenario}`, (t) => {
      const [instruction, compose] = caller(target);
      const result = check(t, instruction, { ...compose, ...files });
      assert.equal(result.status, expected, result.output);
      if (expected === 1) {
        assert.match(result.output, /references a missing script:/);
        assert.ok(result.output.includes(target), result.output);
      }
    });
  }
}

/**
 * Regression (injected false negative): `checkRuntimeTarget` ended with
 * `if (!target || !/\.(js|mjs|cjs)$/.test(target)) return;`, so any entrypoint whose
 * target was not already a `.js`/`.mjs`/`.cjs` path was **skipped silently** — a renamed
 * image entrypoint exited 0 and the broken image was only discovered on a machine with a
 * Docker daemon. Injection proof against the pre-fix code: renaming the real
 * `ENTRYPOINT ["node", "packages/indexer/dist/cli.js"]` to `…/cli.js-gone`, to `…/cli`
 * (extension dropped) and to `…/cli.txt` each returned exit 0.
 *
 * Every case below is a target that does NOT exist, so every one must fail. The
 * extension filter is gone: what is now exempt is a leading `-` (an argument to the
 * runtime, not a script path), and nothing else.
 */
test("Dockerfile exec ENTRYPOINT: a target that is not a .js path is still checked", (t) => {
  // A real `dist/cli.js` exists, so each case points at a sibling that does not.
  for (const target of [
    "packages/mcp/dist/cli.js-gone", // suffix appended after the extension
    "packages/mcp/dist/cli", // extension dropped entirely
    "packages/mcp/dist/cli.txt", // extension replaced
    "packages/mcp/dist/cli.JS.bak", // extension buried mid-name
    "packages/mcp/dist/sub/../cli.js-gone", // traversal that must not be normalised away
  ]) {
    const result = check(t, `ENTRYPOINT ["node", "${target}"]`, {
      "packages/mcp/dist/cli.js": "export {};",
      "packages/mcp/src/cli.ts": "export {};",
    });
    assert.equal(result.status, 1, `${target} should fail, got ${result.status}\n${result.output}`);
    assert.ok(result.output.includes(target), `${target} must be named in the complaint:\n${result.output}`);
  }
});

test("Dockerfile exec ENTRYPOINT: a runtime flag argument is exempt, not reported as a path", (t) => {
  // `--enable-source-maps` is an argument to node, not a script: reporting it as a missing
  // script would be a false positive, which is the other half of the same bug.
  const result = check(t, `ENTRYPOINT ["node", "--enable-source-maps", "packages/mcp/dist/cli.js"]`, {
    "packages/mcp/dist/cli.js": "export {};",
  });
  assert.equal(result.status, 0, result.output);
});

test("Dockerfile exec ENTRYPOINT: a non-path, non-flag target is reported as unverifiable", (t) => {
  // `${ENTRYPOINT_SCRIPT}` cannot be resolved from the working tree. Failing closed is the
  // point: an unresolvable target is not the same as a target that exists.
  const result = check(t, `ENTRYPOINT ["node", "$SCRIPT"]`, {});
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /not a verifiable script path/);
});

/**
 * P0-ZERO negative control: an absent `.dockerignore` is a FINDING, not an empty rule set.
 *
 * Injection proof against the pre-fix code: `dockerignorePatterns()` returned `[]` when the file
 * was missing, so this exact fixture exited 0 — and because `isIgnored` consults an empty rule
 * list, every "COPY source is excluded by .dockerignore" assertion became vacuous at the same
 * time. The guard was structurally incapable of noticing that its own input had been deleted.
 * The two cases below pin both halves of the fix: absent fails, present-but-empty passes.
 */
test(".dockerignore absent is a finding, not an empty rule set", (t) => {
  const missing = check(t, `ENTRYPOINT ["node", "scripts/start.js"]`, { "scripts/start.js": "export {};" }, { noDockerignore: true });
  assert.equal(missing.status, 1, `a missing .dockerignore must fail, got ${missing.status}\n${missing.output}`);
  assert.match(missing.output, /\.dockerignore is missing/);

  // Present but with no rules is a real, authorable state and must still pass: the guard
  // distinguishes *absent* from *empty*, and must not invent a requirement of non-emptiness.
  const empty = check(t, `ENTRYPOINT ["node", "scripts/start.js"]`, { "scripts/start.js": "export {};", ".dockerignore": "\n# nothing ignored\n" });
  assert.equal(empty.status, 0, `an empty .dockerignore is legal, got ${empty.status}\n${empty.output}`);
  assert.match(empty.output, /0 \.dockerignore rule\(s\)/);
});

test("compose entrypoint: a renamed MCP script is caught, not skipped", (t) => {
  // The compose branch used to select its target with `/\.(js|mjs|cjs)$/`, so the same
  // rename that slipped past the Dockerfile branch also slipped past this one.
  for (const target of ["packages/mcp/dist/cli.js-gone", "packages/mcp/dist/cli"]) {
    const result = check(t, `CMD ["--help"]`, {
      "docker-compose.yml": `services:\n  mcp:\n    entrypoint: ["node", "${target}"]\n`,
      "packages/mcp/dist/cli.js": "export {};",
    });
    assert.equal(result.status, 1, `${target} should fail, got ${result.status}\n${result.output}`);
    assert.ok(result.output.includes(target), result.output);
  }
});
