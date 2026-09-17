import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the actual CLI from an isolated repository layout, never rename/delete local dist.
function check(t, instruction, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-docker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./check-dockerfile.mjs", import.meta.url), join(root, "scripts/check-dockerfile.mjs"));
  const inputs = { Dockerfile: `FROM node:24 AS runtime\nWORKDIR /app\n${instruction}\n`, ...files };
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
