/**
 * Tests for `scripts/lib/reporter.mjs`.
 *
 * The colour decision is duplicated on purpose between `verify.mjs:136-148` and
 * `packages/core/src/logger.ts:416-427`, and the two are documented as having to agree. The
 * truth table below is therefore the shared specification: if a migration changes one of
 * them, this test is where the disagreement shows up first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SGR,
  STATUS,
  STATUS_WIDTH,
  bareWord,
  colorsEnabled,
  createReporter,
  envFlag,
  paint,
  statusWord,
} from "./reporter.mjs";
import { EXIT } from "./exit.mjs";

const ESC = /\u001b\[/;

/** A reporter writing into arrays instead of the real streams. */
function harness(options = {}) {
  const out = [];
  const err = [];
  const reporter = createReporter({
    name: options.name ?? "gate",
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    handlePipeErrors: false,
    colors: options.colors ?? false,
    ...options,
  });
  return { reporter, out, err, stdout: () => out.join(""), stderrText: () => err.join("") };
}

test("SGR carries exactly the six attributes the two existing copies use", () => {
  assert.deepEqual(Object.keys(SGR).sort(), ["bold", "cyan", "dim", "green", "red", "yellow"]);
  assert.equal(SGR.reset, undefined, "reset is applied by paint, never selected by a caller");
});

test("the colour truth table matches verify.mjs:136-142 and logger.ts:416-424", () => {
  const cases = [
    ["NO_COLOR wins over FORCE_COLOR", { NO_COLOR: "1", FORCE_COLOR: "1" }, true, false],
    ["NO_COLOR is honoured when empty", { NO_COLOR: "" }, true, false],
    ["NO_COLOR is honoured at 0", { NO_COLOR: "0" }, true, false],
    ["TERM=dumb disables", { TERM: "dumb", FORCE_COLOR: "1" }, true, false],
    ["CI disables even with a TTY", { CI: "true" }, true, false],
    ["CI=false is still not CI", { CI: "false", FORCE_COLOR: "1" }, false, true],
    ["CI=0 is still not CI", { CI: "0", FORCE_COLOR: "1" }, false, true],
    ["FORCE_COLOR enables despite a pipe", { FORCE_COLOR: "1" }, false, true],
    ["FORCE_COLOR=0 does not enable", { FORCE_COLOR: "0" }, false, false],
    ["FORCE_COLOR=0 on a TTY falls through to the TTY", { FORCE_COLOR: "0" }, true, true],
    ["a pipe with no env is off", {}, false, false],
    ["a TTY with no env is on", {}, true, true],
  ];
  for (const [name, env, isTty, expected] of cases) {
    assert.equal(colorsEnabled(env, isTty), expected, name);
  }
});

test("the same table holds when only the environment is supplied and isTTY is the real one", () => {
  assert.equal(colorsEnabled({ NO_COLOR: "1" }, true), false);
  assert.equal(colorsEnabled({ FORCE_COLOR: "1" }, false), true);
  assert.equal(colorsEnabled({}, process.stdout.isTTY === true), process.stdout.isTTY === true);
});

test("envFlag reads presence, and treats empty / 0 / false as off", () => {
  assert.equal(envFlag({ A: "1" }, "A"), true);
  assert.equal(envFlag({ A: "yes" }, "A"), true);
  assert.equal(envFlag({ A: "TRUE" }, "A"), true);
  assert.equal(envFlag({ A: "" }, "A"), false);
  assert.equal(envFlag({ A: "0" }, "A"), false);
  assert.equal(envFlag({ A: "false" }, "A"), false);
  assert.equal(envFlag({ A: "FALSE" }, "A"), false);
  assert.equal(envFlag({}, "A"), false);
});

test("paint is a no-op when colour is off, so padding never depends on escapes", () => {
  assert.equal(paint("bold red", "FAIL", false), "FAIL");
  assert.equal(paint("", "text", true), "text");
  assert.equal(paint("not-an-sgr", "text", true), "text", "an unknown name paints nothing");
});

test("paint emits one reset for a composite style", () => {
  const painted = paint("bold red", "FAIL", true);
  assert.equal(painted, `\u001b[${SGR.bold}m\u001b[${SGR.red}mFAIL\u001b[0m`);
  assert.equal(painted.split("\u001b[0m").length - 1, 1);
});

test("paint ignores an unknown attribute but still honours the known ones", () => {
  assert.equal(paint("bold nope red", "x", true), `\u001b[${SGR.bold}m\u001b[${SGR.red}mx\u001b[0m`);
});

test("the status table spells every verdict as a word, never a glyph", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.word])),
    {
      passed: "PASS",
      failed: "FAIL",
      skipped: "SKIP",
      timedOut: "TIMEOUT",
      warn: "WARN",
      ok: "OK",
    },
  );
  assert.equal(STATUS_WIDTH, Math.max(...Object.values(STATUS).map((s) => s.word.length)));
  assert.ok(STATUS_WIDTH >= "TIMEOUT".length);
});

test("statusWord pads to a fixed width, so a report is column-aligned with colour on or off", () => {
  const strip = (s) => s.replace(/\u001b\[\d+m/g, "");
  for (const key of Object.keys(STATUS)) {
    assert.equal(statusWord(key, false).length, STATUS_WIDTH, key);
    assert.equal(strip(statusWord(key, true)).length, STATUS_WIDTH, `${key}, coloured`);
  }
  // The visible text is the word; the rest of the cell is spaces, never escapes.
  assert.equal(statusWord("passed", false), "PASS".padEnd(STATUS_WIDTH));
  assert.equal(statusWord("failed", false), "FAIL".padEnd(STATUS_WIDTH));
  assert.equal(statusWord("timedOut", false), "TIMEOUT".padEnd(STATUS_WIDTH));
  assert.equal(statusWord("passed", false).trimEnd(), "PASS");
});

test("statusWord colours the padded word without changing its visible length", () => {
  // Strip escapes BEFORE trimming: a coloured cell ends with the reset sequence, not a
  // space, so trimming first would be a no-op and the assertion would compare "FAIL   "
  // against "FAIL".
  const strip = (s) => s.replace(/\u001b\[\d+m/g, "");
  const plain = statusWord("failed", false);
  const painted = statusWord("failed", true);
  assert.notEqual(plain, painted);
  assert.equal(strip(painted), plain);
  assert.equal(strip(painted).trimEnd(), "FAIL");
  assert.equal(strip(painted).length, plain.length);
});

test("bareWord omits the column padding, so a standalone label is not pushed right", () => {
  for (const key of Object.keys(STATUS)) {
    assert.equal(bareWord(key, false), STATUS[key].word, key);
  }
  assert.equal(bareWord("failed", false), "FAIL");
  assert.equal(bareWord("nonsense", false), "WARN");
  assert.equal(bareWord("failed", true).replace(/\u001b\[\d+m/g, ""), "FAIL");
});

test("statusWord falls back to a word for an undeclared status, never an empty cell", () => {
  assert.equal(statusWord("nonsense", false).trimEnd(), "WARN");
  assert.equal(statusWord(undefined, false).trimEnd(), "WARN");
});

test("say and sayError write a newline-terminated line to their own stream", () => {
  const { reporter, out, err } = harness();
  reporter.say();
  reporter.say("hello");
  reporter.sayError("bad");
  assert.deepEqual(out, ["\n", "hello\n"]);
  assert.deepEqual(err, ["bad\n"]);
});

test("ok/warn/fail spell the verdict in words", () => {
  const { reporter, stdout, stderrText } = harness();
  reporter.ok("all good");
  reporter.warn("forge missing");
  reporter.fail("3 problems");
  assert.match(stdout(), /^OK\s+all good$/m);
  assert.match(stderrText(), /^WARN\s+forge missing$/m);
  assert.match(stderrText(), /^FAIL\s+3 problems$/m);
});

test("problem prefixes each finding with the FAIL word, so it survives a colourless log", () => {
  const { reporter, stderrText } = harness();
  reporter.problem("README says 54, actual is 86");
  assert.equal(stderrText(), `  FAIL README says 54, actual is 86\n`);
  assert.doesNotMatch(stderrText(), ESC);
});

test("the verb layout keeps check-package-artifacts.mjs's four-column vocabulary", () => {
  const { reporter, stdout } = harness({ name: "package artifacts" });
  reporter.check("@sigilkit/core", "4/4 entry target(s) OK");
  reporter.skip("@sigilkit/demo-agent (private)");
  assert.equal(stdout(), "check @sigilkit/core — 4/4 entry target(s) OK\nskip  @sigilkit/demo-agent (private)\n");
});

test("report returns OK and writes only to stdout when there are no findings", () => {
  const { reporter, out, err, stdout } = harness();
  const code = reporter.report([], { footer: ["(static checks only)"] });
  assert.equal(code, EXIT.OK);
  assert.equal(err.length, 0, "a clean run must not write to stderr");
  assert.match(stdout(), /^gate OK$/m);
  assert.match(stdout(), /static checks only/);
});

test("report returns FAIL, writes a header and one line per finding, and touches stdout not at all", () => {
  const { reporter, out, err, stderrText } = harness();
  const code = reporter.report(["a: wrong", "b: missing"], {
    header: "dockerfile/compose problems (2)",
    footer: ["run --help"],
  });
  assert.equal(code, EXIT.FAIL);
  assert.equal(out.length, 0, "a failing run must leave stdout clean for a consumer");
  assert.equal(stderrText(), "dockerfile/compose problems (2)\n  a: wrong\n  b: missing\nrun --help\n");
});

test("report supplies a default header naming the tool and the count", () => {
  const { reporter, stderrText } = harness({ name: "vector corpus" });
  reporter.report(["x"]);
  assert.equal(stderrText(), "vector corpus FAILED — 1 problem(s)\n  x\n");
});

test("verdict is report under the name two gates already use", () => {
  const { reporter, stderrText } = harness({ name: "sync-facts" });
  assert.equal(reporter.verdict([]), EXIT.OK);
  assert.equal(reporter.verdict(["drift"]), EXIT.FAIL);
  assert.match(stderrText(), /sync-facts FAILED — 1 problem\(s\)/);
});

test("the EPIPE guard swallows a closed downstream pipe instead of killing the gate", () => {
  // `verify.mjs:287-311`: a gate piped into `head` raises EPIPE, which surfaces as an
  // unhandled 'error' event and takes the whole gate down mid-run.
  for (const code of ["EPIPE", "ERR_STREAM_DESTROYED"]) {
    const reporter = createReporter({
      name: "gate",
      stdout: () => {
        throw Object.assign(new Error("write EPIPE"), { code });
      },
      stderr: () => {
        throw Object.assign(new Error("write EPIPE"), { code });
      },
      handlePipeErrors: false,
      colors: false,
    });
    assert.doesNotThrow(() => reporter.say("line"), code);
    assert.doesNotThrow(() => reporter.sayError("line"), code);
    assert.doesNotThrow(() => reporter.report([]), code);
    assert.doesNotThrow(() => reporter.problem("detail"), code);
  }
});

test("the EPIPE guard rethrows every other write error — a gate must not hide a real fault", () => {
  const reporter = createReporter({
    name: "gate",
    stdout: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
    stderr: () => {},
    handlePipeErrors: false,
    colors: false,
  });
  assert.throws(() => reporter.say("line"), (err) => err.code === "EACCES");
});

test("createReporter reports the colour decision it was given", () => {
  assert.equal(harness({ colors: true }).reporter.colors, true);
  assert.equal(harness({ colors: false }).reporter.colors, false);
  // Omitted: the decision comes from the environment, not from a default of true.
  const derived = createReporter({ name: "x", stdout: () => {}, stderr: () => {}, handlePipeErrors: false });
  assert.equal(derived.colors, colorsEnabled());
});

test("a reporter never emits a bare status with no colour and no word", () => {
  for (const colors of [true, false]) {
    const { reporter, stdout, stderrText } = harness({ colors });
    reporter.ok("done");
    reporter.warn("careful");
    reporter.fail("broken");
    reporter.problem("detail");
    for (const text of [stdout(), stderrText()]) {
      assert.doesNotMatch(text, /[\u2713\u2717\u26a0]/, "no glyph may carry a verdict");
    }
  }
});
