import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateReport,
  evaluateVitest,
  meetsFloor,
  parseNodeFloor,
  parseVersion,
  sanitizePath,
} from "./check-runtime.mjs";

// Pure unit tests: no filesystem, no spawning, no external test runner is imported or executed.

const runtimeAt = (version, floor) => ({ version, required: `>=${floor}`, compatible: meetsFloor(version, floor) });

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
