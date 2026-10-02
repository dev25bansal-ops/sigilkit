/**
 * Tests for `scripts/lib/fs-json.mjs`.
 *
 * The three readers are here because the tree has *three different answers* to "what should
 * happen when this file is unreadable". Each reader's failure behaviour is pinned so a
 * migrating gate inherits the one its own documentation argues for.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_SUFFIXES,
  WORKSPACES,
  isWorkflowFile,
  listDir,
  readJson,
  readJsonOrNull,
  readText,
  workflowFiles,
} from "./fs-json.mjs";

/** A throwaway root; every test that touches disk gets its own, removed on teardown. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sigilkit-lib-fs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, text) {
  const path = join(root, ...rel.split("/"));
  writeFileSync(path, text);
  return path;
}

test("the shared enumerations hold the values four and three scripts each restate", () => {
  assert.deepEqual([...WORKSPACES], ["core", "indexer", "mcp", "demo-agent"]);
  assert.deepEqual([...WORKFLOW_SUFFIXES], [".yml", ".yaml"]);
});

test("WORKSPACES and WORKFLOW_SUFFIXES are frozen", () => {
  assert.throws(() => {
    "use strict";
    WORKSPACES.push("new-pkg");
  });
  assert.throws(() => {
    "use strict";
    WORKFLOW_SUFFIXES.push(".yml.yaml");
  });
});

test("isWorkflowFile accepts both suffixes and rejects everything else", () => {
  assert.equal(isWorkflowFile("ci.yml"), true);
  assert.equal(isWorkflowFile("ci.yaml"), true);
  assert.equal(isWorkflowFile("a.b.yml"), true);
  assert.equal(isWorkflowFile("ci.json"), false);
  assert.equal(isWorkflowFile("ci.yml.bak"), false);
  assert.equal(isWorkflowFile("README.md"), false);
  assert.equal(isWorkflowFile(""), false);
  // A file named exactly ".yml" is accepted, because all four open-coded copies used a
  // bare `endsWith` and would have accepted it too. Pinned as parity, not endorsed: an
  // extraction must not smuggle in a behaviour change, and a dotfile with no stem is not
  // a shape `.github/workflows/` ever takes. Tightening it is a separate, deliberate act.
  assert.equal(isWorkflowFile(".yml"), true, "parity with the four originals");
});

test("isWorkflowFile is case-sensitive, as all four open-coded copies were", () => {
  assert.equal(isWorkflowFile("CI.YML"), false);
});

test("workflowFiles filters then sorts, and returns a new array", () => {
  const entries = ["publish.yaml", "README.md", "ci.yml", "notes.txt", "ci.yaml"];
  const out = workflowFiles(entries);
  assert.deepEqual(out, ["ci.yaml", "ci.yml", "publish.yaml"]);
  assert.notEqual(out, entries);
  assert.deepEqual(
    entries,
    ["publish.yaml", "README.md", "ci.yml", "notes.txt", "ci.yaml"],
    "the input must not be mutated",
  );
});

test("workflowFiles handles an empty and a junk listing", () => {
  assert.deepEqual(workflowFiles([]), []);
  assert.deepEqual(workflowFiles(undefined), []);
});

test("readText reads utf-8 and takes an injected reader", (t) => {
  const root = fixture(t);
  const path = write(root, "a.txt", "héllo ✓");
  assert.equal(readText(path), "héllo ✓");
  assert.equal(readText("ignored", { readFileSync: () => "from the stub" }), "from the stub");
});

test("readText propagates a real read failure rather than swallowing it", (t) => {
  const root = fixture(t);
  assert.throws(() => readText(join(root, "absent.txt")));
});

test("readJsonOrNull returns the parsed object", (t) => {
  const root = fixture(t);
  const path = write(root, "ok.json", '{"a":1,"b":[2,3]}');
  assert.deepEqual(readJsonOrNull(path), { a: 1, b: [2, 3] });
});

test("readJsonOrNull returns null for a missing file and for malformed JSON, without throwing", (t) => {
  const root = fixture(t);
  assert.equal(readJsonOrNull(join(root, "absent.json")), null);
  const bad = write(root, "bad.json", "{ not json ");
  assert.equal(readJsonOrNull(bad), null);
  assert.doesNotThrow(() => readJsonOrNull(bad));
});

test("readJsonOrNull's null is the whole contract: it never distinguishes absent from unparseable", (t) => {
  // Documented in the module header. Asserted so a future "improvement" that starts
  // distinguishing the two has to change this test on purpose.
  const root = fixture(t);
  const bad = write(root, "bad.json", "nope");
  assert.equal(readJsonOrNull(join(root, "absent.json")), readJsonOrNull(bad));
});

test("readJson parses a valid file", (t) => {
  const root = fixture(t);
  const path = write(root, "ok.json", '{"name":"sigilkit"}');
  assert.deepEqual(readJson(path), { name: "sigilkit" });
});

test("readJson rethrows with the path attached, for a gate to record as a finding", (t) => {
  const root = fixture(t);
  const bad = write(root, "bad.json", "<html>");
  assert.throws(
    () => readJson(bad),
    (err) => {
      assert.match(err.message, /could not be parsed as JSON/);
      assert.equal(err.path, bad, "the error must carry the path, not only a message");
      return true;
    },
  );
});

test("readJson distinguishes 'unreadable' from 'unparseable' in its message", (t) => {
  const root = fixture(t);
  const absent = join(root, "absent.json");
  assert.throws(
    () => readJson(absent),
    (err) => {
      assert.match(err.message, /could not be read/);
      assert.equal(err.path, absent);
      return true;
    },
  );
});

test("readJson accepts an injected reader, as check-package-artifacts.mjs:284 does", () => {
  const calls = [];
  const io = {
    readFileSync: (p, enc) => {
      calls.push([p, enc]);
      return '{"workspaces":["packages/*"]}';
    },
  };
  assert.deepEqual(readJson(join("x", "package.json"), io), { workspaces: ["packages/*"] });
  assert.deepEqual(calls, [[join("x", "package.json"), "utf8"]]);
});

test("listDir returns sorted entries, and [] for a path that is not a directory", (t) => {
  const root = fixture(t);
  write(root, "b.txt", "");
  write(root, "a.txt", "");
  assert.deepEqual(listDir(root), ["a.txt", "b.txt"]);
  assert.deepEqual(listDir(join(root, "a.txt")), [], "a file is not a directory");
  assert.deepEqual(listDir(join(root, "nope")), []);
});

test("listDir takes an injected reader and swallows its throw", () => {
  assert.deepEqual(listDir("ignored", { readdirSync: () => ["z", "a"] }), ["a", "z"]);
  assert.deepEqual(
    listDir("ignored", {
      readdirSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    }),
    [],
  );
});

test("listDir never returns undefined for a reader that yields nothing", () => {
  assert.deepEqual(listDir("ignored", { readdirSync: () => undefined }), []);
});

test("every lib module ships a test beside it", () => {
  // The module headers cite `scripts/...:line` as extraction evidence, and the migration
  // plan in scripts/ARCH-2026-09-26.md is a checklist of files — a module that lost its
  // test would quietly fall out of both.
  const here = dirname(fileURLToPath(import.meta.url));
  const siblings = listDir(here);
  for (const module of ["paths.mjs", "exit.mjs", "reporter.mjs", "cli.mjs", "fs-json.mjs"]) {
    assert.ok(siblings.includes(module), `${module} must live in scripts/lib/`);
    assert.ok(siblings.includes(module.replace(/\.mjs$/, ".test.mjs")), `${module} needs a test`);
  }
});
