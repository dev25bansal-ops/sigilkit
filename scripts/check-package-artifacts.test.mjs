import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  allowedFilesFor,
  checkPackageArtifacts,
  checkWorkspace,
  detectStaleDistDuplication,
  discoverWorkspacePackages,
  extractEntryTargets,
  isInAllowedFiles,
  isRelativeTarget,
  normalizeTarget,
} from "./check-package-artifacts.mjs";

// ---------------------------------------------------------------------------
// Pure function coverage — no filesystem, fixtures are plain objects/predicates.
// ---------------------------------------------------------------------------

test("normalizeTarget strips ./ and normalises separators", () => {
  assert.equal(normalizeTarget("./dist/index.js"), "dist/index.js");
  assert.equal(normalizeTarget(".\\dist\\index.js"), "dist/index.js");
  assert.equal(normalizeTarget("dist//nested/./x.js"), "dist/nested/x.js");
});

test("isRelativeTarget accepts package-relative paths only", () => {
  for (const ok of ["./dist/index.js", "dist/index.js", "./dist/nested/x.d.ts"]) {
    assert.equal(isRelativeTarget(ok), true, ok);
  }
  for (const bad of ["/abs/index.js", "C:/abs/index.js", "C:\\abs\\index.js", "../outside.js", "dist/../../escape.js", "", "   ", 42, null]) {
    assert.equal(isRelativeTarget(bad), false, String(bad));
  }
});

test("allowedFilesFor defaults only when absent and strips /** suffixes", () => {
  assert.deepEqual(allowedFilesFor({}), ["dist"]);
  assert.deepEqual(allowedFilesFor({ files: [] }), []);
  assert.deepEqual(allowedFilesFor({ files: ["dist/**", "README.md"] }), ["dist", "README.md"]);
});

test("isInAllowedFiles enforces the files[] allow-list", () => {
  const allowed = allowedFilesFor({ files: ["dist", "README.md"] });
  assert.equal(isInAllowedFiles("./dist/index.js", allowed), true);
  assert.equal(isInAllowedFiles("dist", allowed), true);
  assert.equal(isInAllowedFiles("./src/index.js", allowed), false);
  assert.equal(isInAllowedFiles("./dist-evil/index.js", allowed), false);
});

test("extractEntryTargets walks main/types/bin/exports", () => {
  const targets = extractEntryTargets({
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    bin: { "sigilkit-mcp": "./dist/cli.js" },
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./cli": { default: "./dist/cli.js" },
    },
  });
  const values = targets.map((entry) => entry.target).sort();
  assert.deepEqual(values, [
    "./dist/cli.js",
    "./dist/cli.js",
    "./dist/index.d.ts",
    "./dist/index.d.ts",
    "./dist/index.js",
    "./dist/index.js",
  ]);
  assert.ok(targets.every((entry) => ["main", "types", "bin", "exports"].includes(entry.field)));
});

test("detectStaleDistDuplication flags duplicated mirrors but not nested-only layouts", () => {
  assert.equal(detectStaleDistDuplication({ distEntries: ["index.js"], nestedEntries: [] }).stale, false);
  assert.equal(detectStaleDistDuplication({ distEntries: ["src"], nestedEntries: [] }).stale, true);
  assert.equal(
    detectStaleDistDuplication({ distEntries: ["index.js", "src"], nestedEntries: ["index.js"] }).stale,
    true,
  );
  assert.equal(
    detectStaleDistDuplication({ distEntries: ["index.js", "src"], nestedEntries: ["only-in-src.js"] }).stale,
    false,
  );
});

test("checkPackageArtifacts is pure and classifies each target", () => {
  const manifest = {
    name: "@sigilkit/x",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { default: "./dist/index.js" }, "./cli": { default: "./dist/cli.js" } },
  };
  const present = new Set(["dist/index.js", "dist/index.d.ts", "dist/cli.js"]);
  const ok = checkPackageArtifacts({ name: "@sigilkit/x", manifest, exists: (p) => present.has(p) });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.checked.every((entry) => entry.status === "ok"), true);

  const missing = checkPackageArtifacts({ name: "@sigilkit/x", manifest, exists: () => false });
  assert.equal(missing.errors.length, 4);
  assert.ok(missing.errors.every((line) => line.includes("target is missing")));

  const outside = checkPackageArtifacts({
    name: "@sigilkit/x",
    manifest: { main: "./src/index.js" },
    exists: () => true,
  });
  assert.equal(outside.checked[0].status, "outside-files");

  const absolute = checkPackageArtifacts({
    name: "@sigilkit/x",
    manifest: { main: "/tmp/index.js" },
    exists: () => true,
  });
  assert.equal(absolute.checked[0].status, "not-relative");
});

test("checkPackageArtifacts skips private packages", () => {
  const result = checkPackageArtifacts({
    name: "@sigilkit/demo-agent",
    manifest: { private: true, main: "./dist/gone.js" },
    exists: () => false,
  });
  assert.equal(result.private, true);
  assert.deepEqual(result.errors, []);
});

test("checkWorkspace reports a stale dist/src mirror as a warning, not an error", () => {
  const packages = [
    { name: "@sigilkit/x", dir: "packages/x", manifest: { main: "./dist/index.js" } },
  ];
  const results = checkWorkspace({
    packages,
    exists: () => true,
    listDist: () => ["index.js", "src"],
    listNested: () => ["index.js"],
  });
  assert.deepEqual(results[0].errors, []);
  assert.equal(results[0].warnings.length, 1);
  assert.match(results[0].warnings[0], /stale duplicated tree/);
});

test("discoverWorkspacePackages reads the workspaces globs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-discover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
  for (const name of ["a", "b"]) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name: `@sigilkit/${name}` }));
  }
  mkdirSync(join(root, "packages", "not-a-package"), { recursive: true });

  const found = discoverWorkspacePackages({ readFileSync, readdirSync, existsSync }, root);
  assert.deepEqual(found.map((entry) => entry.name).sort(), ["@sigilkit/a", "@sigilkit/b"]);
  assert.deepEqual(found.map((entry) => entry.dir).sort(), ["packages/a", "packages/b"]);
});

// ---------------------------------------------------------------------------
// CLI coverage — isolated temp fixture roots; the project's own dist is untouched.
// ---------------------------------------------------------------------------

function makeFixture(t, { packages = {}, files = {}, rootManifest } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    new URL("./check-package-artifacts.mjs", import.meta.url),
    join(root, "scripts/check-package-artifacts.mjs"),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(rootManifest ?? { name: "fixture", private: true, workspaces: ["packages/*"] }, null, 2),
  );
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify(manifest, null, 2));
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runCli(root, args = []) {
  const result = spawnSync(process.execPath, [join(root, "scripts/check-package-artifacts.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

const publicManifest = {
  name: "@sigilkit/fixture",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  bin: { "fixture-cli": "./dist/cli.js" },
  files: ["dist", "README.md"],
};

test("CLI exits 0 when every entry target exists", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: publicManifest },
    files: {
      "packages/fixture/dist/index.js": "export {};",
      "packages/fixture/dist/index.d.ts": "export {};",
      "packages/fixture/dist/cli.js": "export {};",
    },
  });
  const result = runCli(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /package artifacts OK/);
  assert.match(result.output, /NOT a clean-install smoke test/);
});

test("CLI exits 1 for a missing entry target and names it", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: publicManifest },
    files: {
      "packages/fixture/dist/index.js": "export {};",
      "packages/fixture/dist/index.d.ts": "export {};",
      // dist/cli.js intentionally absent
    },
  });
  const result = runCli(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /target is missing: \.\/dist\/cli\.js/);
});

test("CLI exits 1 when a target escapes files[]", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: { ...publicManifest, main: "./src/index.js" } },
    files: {
      "packages/fixture/src/index.js": "export {};",
      "packages/fixture/dist/index.d.ts": "export {};",
      "packages/fixture/dist/cli.js": "export {};",
    },
  });
  const result = runCli(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /outside files\[\]/);
});

test("CLI exits 1 when a target is absolute", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: { ...publicManifest, types: "/tmp/index.d.ts" } },
    files: {
      "packages/fixture/dist/index.js": "export {};",
      "packages/fixture/dist/cli.js": "export {};",
    },
  });
  const result = runCli(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /target is not relative/);
});

test("CLI skips private packages entirely", (t) => {
  const root = makeFixture(t, {
    packages: { "demo-agent": { name: "@sigilkit/demo-agent", private: true, main: "./dist/gone.js" } },
  });
  const result = runCli(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /skip {2}@sigilkit\/demo-agent \(private\)/);
});

test("CLI warns about a stale dist/src mirror without failing", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: publicManifest },
    files: {
      "packages/fixture/dist/index.js": "export {};",
      "packages/fixture/dist/index.d.ts": "export {};",
      "packages/fixture/dist/cli.js": "export {};",
      "packages/fixture/dist/src/index.js": "export {};",
    },
  });
  const result = runCli(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /stale duplicated tree/);
  assert.match(result.output, /warning, not a failure/);
});

test("CLI --json emits machine-readable results", (t) => {
  const root = makeFixture(t, {
    packages: { fixture: publicManifest },
    files: { "packages/fixture/dist/index.js": "export {};" },
  });
  const result = runCli(root, ["--json"]);
  assert.equal(result.status, 1, result.output);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.errors.length, 3);
  assert.equal(parsed.results.length, 1);
});

test("unsupported manifest forms fail explicitly instead of skipping validation", () => {
  for (const manifest of [
    { exports: ["./dist/index.js", "./dist/fallback.js"] },
    { exports: { ".": { default: ["./dist/index.js"] } } },
    { exports: { "./*": "./dist/*.js" } },
    { exports: 42 },
    { main: 42 },
    { types: null },
    { bin: ["./dist/cli.js"] },
    { bin: { cli: false } },
    { files: "dist" },
    ...["dist/*.js", "!dist/private", "dist/{a,b}", "dist/[ab]", "../dist", "/dist", "", 42].map((entry) => ({ files: [entry] })),
    { main: "./dist/*.js" },
  ]) {
    const result = checkPackageArtifacts({ name: "fixture", manifest, exists: () => true });
    assert.ok(result.errors.some((error) => error.includes("unsupported")), JSON.stringify(manifest));
  }
});

test("empty allowlist stays empty; package.json and null exports are handled", () => {
  const denied = checkPackageArtifacts({ name: "fixture", manifest: { files: [], main: "./dist/index.js" }, exists: () => true });
  assert.equal(denied.checked[0].status, "outside-files");
  const result = checkPackageArtifacts({
    name: "fixture",
    manifest: { files: [], exports: { "./package.json": "./package.json", "./private": null } },
    exists: (path) => path === "package.json",
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.checked.length, 1);
  assert.equal(checkPackageArtifacts({ name: "fixture", manifest: { exports: "" }, exists: () => true }).checked[0].status, "not-relative");
});

test("CLI rejects a directory masquerading as an entry-point file", (t) => {
  const root = makeFixture(t, { packages: { fixture: { main: "./dist/index.js" } } });
  mkdirSync(join(root, "packages/fixture/dist/index.js"), { recursive: true });
  const result = runCli(root, ["--json"]);
  assert.equal(result.status, 1, result.output);
  assert.match(JSON.parse(result.output).errors[0], /not a regular file/);
});

test("CLI reports unsupported export arrays as structured errors", (t) => {
  const root = makeFixture(t, { packages: { fixture: { exports: ["./dist/missing.js"] } } });
  const result = runCli(root, ["--json"]);
  assert.equal(result.status, 1, result.output);
  assert.match(JSON.parse(result.output).errors[0], /unsupported exports/);
});

test("workspace discovery supports explicit paths, object form and overlapping patterns", (t) => {
  const root = makeFixture(t, {
    rootManifest: { workspaces: { packages: ["packages/fixture", "packages/*", "./packages/fixture"] } },
    packages: { fixture: { name: "fixture" } },
  });
  const found = discoverWorkspacePackages({ readFileSync, readdirSync, existsSync }, root);
  assert.deepEqual(found.map(({ dir }) => dir), ["packages/fixture"]);
});

test("unsupported or empty workspace discovery fails in JSON mode", (t) => {
  const root = makeFixture(t, { packages: { fixture: { private: true } } });
  for (const workspaces of [["packages/**"], ["packages/{a,b}"], ["../packages/*"], ["packages/missing"], [], "packages/*", { packages: "packages/*" }]) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
    const result = runCli(root, ["--json"]);
    assert.equal(result.status, 1, JSON.stringify(workspaces));
    assert.equal(JSON.parse(result.output).errors.length, 1);
  }
});
