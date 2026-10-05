/**
 * Tests for `scripts/lib/exit.mjs`.
 *
 * `EXIT` is the contract CI's `continue-on-error` and the `--only`/`--json` consumers read,
 * so the three constants are pinned as literals — a reordering or a rename must fail here
 * rather than in a pipeline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EXIT, VERDICT, announce, exitStatusFromChild, messageOf, reportUsage } from "./exit.mjs";

/**
 * `announce` exists because an exit code cannot separate "the repository is wrong" from
 * "I could not run" — and that is a live ambiguity, not a hypothetical one: `check-doc-counts.mjs`
 * exits 1 for a missing README, for count drift, and for an `ERR_MODULE_NOT_FOUND` raised during
 * ESM resolution before `main()` is ever entered. These tests pin the mapping AND the
 * fail-closed behaviour of a typo'd verdict, since a mistyped verdict in a gate's own
 * announcement is the exact bug class this module exists to prevent.
 */
test("announce: each verdict maps to the documented exit code", () => {
  const lines = [];
  const write = (t) => lines.push(t);
  assert.equal(announce("g", VERDICT.PASS, {}, write), EXIT.OK);
  assert.equal(announce("g", VERDICT.DRIFT, {}, write), EXIT.FAIL);
  // Both "could not evaluate" verdicts share USAGE — the LINE is what separates them.
  assert.equal(announce("g", VERDICT.UNREADABLE_INPUT, {}, write), EXIT.USAGE);
  assert.equal(announce("g", VERDICT.TOOL_MISSING, {}, write), EXIT.USAGE);
  assert.equal(lines.length, 4);
});

test("announce: unreadable-input and tool-missing are distinguishable on stdout despite sharing a code", () => {
  // This is the whole point of the line. Two runs, the same exit code, different facts.
  const a = [];
  const b = [];
  announce("check-doc-counts", VERDICT.UNREADABLE_INPUT, { missing: "README.md" }, (t) => a.push(t));
  announce("check-doc-counts", VERDICT.TOOL_MISSING, { tool: "forge" }, (t) => b.push(t));
  assert.notDeepEqual(JSON.parse(a[0]), JSON.parse(b[0]));
  assert.equal(JSON.parse(a[0]).verdict, "unreadable-input");
  assert.equal(JSON.parse(b[0]).verdict, "tool-missing");
  assert.equal(JSON.parse(a[0]).missing, "README.md");
  assert.equal(JSON.parse(b[0]).tool, "forge");
});

test("announce: the line is one parseable JSON object carrying the gate name, verdict and extras", () => {
  const lines = [];
  announce("check-doc-counts", VERDICT.DRIFT, { problems: 3 }, (t) => lines.push(t));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].endsWith("\n"), true, "the line must be newline-terminated for log grepping");
  const doc = JSON.parse(lines[0]);
  assert.deepEqual(doc, { gate: "check-doc-counts", verdict: "drift", problems: 3 });
});

test("announce: an unknown verdict throws rather than defaulting to success", () => {
  // Fail closed. A typo must never be laundered into a green run.
  assert.throws(() => announce("g", "PASS", {}, () => {}), TypeError);
  assert.throws(() => announce("g", "", {}, () => {}), TypeError);
});

test("VERDICT is frozen and holds exactly the four documented values", () => {
  assert.deepEqual(Object.values(VERDICT).sort(), ["drift", "pass", "tool-missing", "unreadable-input"]);
  assert.throws(() => {
    "use strict";
    VERDICT.PASS = "green";
  });
});

test("the exit contract is 0 / 1 / 2", () => {
  assert.deepEqual(Object.values(EXIT).sort(), [0, 1, 2]);
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAIL, 1);
  assert.equal(EXIT.USAGE, 2);
});

test("EXIT is frozen, so a mutation is a TypeError in strict mode rather than a silent drift", () => {
  assert.throws(() => {
    "use strict";
    EXIT.FAIL = 7;
  });
});

test("messageOf unwraps an Error to its message with no 'Error: ' prefix", () => {
  assert.equal(messageOf(new Error("boom")), "boom");
  assert.equal(messageOf(new TypeError("bad type")), "bad type");
});

test("messageOf passes a bare string through unchanged", () => {
  assert.equal(messageOf("already text"), "already text");
});

test("messageOf accepts an Error-shaped plain object, which a rejected worker value can be", () => {
  assert.equal(messageOf({ message: "from a worker" }), "from a worker");
});

test("messageOf falls back to String() for anything else", () => {
  assert.equal(messageOf(42), "42");
  assert.equal(messageOf(null), "null");
  assert.equal(messageOf(undefined), "undefined");
  assert.equal(messageOf({ code: "ENOENT" }), "[object Object]");
});

test("messageOf never throws, whatever it is handed", () => {
  for (const value of [Symbol("s"), () => {}, BigInt(7)]) {
    assert.doesNotThrow(() => messageOf(value));
    assert.equal(typeof messageOf(value), "string");
  }
});

test("exitStatusFromChild forwards a numeric child status", () => {
  assert.equal(exitStatusFromChild({ status: 7 }), 7);
  assert.equal(exitStatusFromChild({ status: 0 }), 0);
});

test("exitStatusFromChild defaults to FAIL, never to a guessed usage error", () => {
  assert.equal(exitStatusFromChild(new Error("killed")), EXIT.FAIL);
  assert.equal(exitStatusFromChild({}), EXIT.FAIL);
  assert.equal(exitStatusFromChild({ status: "7" }), EXIT.FAIL, "a string status is not a number");
  assert.equal(exitStatusFromChild(undefined), EXIT.FAIL);
  assert.equal(exitStatusFromChild(null), EXIT.FAIL);
});

test("reportUsage prints 'tool: message' then the usage line, and returns USAGE", () => {
  const written = [];
  const code = reportUsage("verify", "--only=nope matches no step", "usage: verify [--quick]", (t) =>
    written.push(t),
  );
  assert.equal(code, EXIT.USAGE);
  assert.deepEqual(written, ["verify: --only=nope matches no step\n", "usage: verify [--quick]\n"]);
});

test("reportUsage omits the usage line when none is supplied", () => {
  const written = [];
  assert.equal(reportUsage("clean", "unknown argument \"--dryy\"", undefined, (t) => written.push(t)), EXIT.USAGE);
  assert.deepEqual(written, ["clean: unknown argument \"--dryy\"\n"]);
});

test("reportUsage defaults to stderr", () => {
  const original = process.stderr.write;
  const written = [];
  process.stderr.write = (t) => {
    written.push(t);
    return true;
  };
  try {
    reportUsage("check-runtime", "root is not a directory");
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(written, ["check-runtime: root is not a directory\n"]);
});
