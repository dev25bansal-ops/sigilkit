/**
 * Tests for `scripts/lib/cli.mjs`.
 *
 * `runSync`'s two outcome modes are the point of the module: the tree currently has five
 * wrappers that disagree about whether a failed child is a finding. Each mode is pinned
 * against a real child process, not a stub, because the disagreement is about `spawnSync`
 * semantics (a non-zero `status`, a spawn `error`, a signal) and a stub would not exercise
 * the branch that actually differs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Outcome, isUsageError, parseArgs, runJsonSync, runSync, usage } from "./cli.mjs";
import { EXIT } from "./exit.mjs";

const NODE = process.execPath;
const ECHO = (text) => [NODE, "-e", `process.stdout.write(${JSON.stringify(text)})`];
const EXIT_WITH = (code) => [NODE, "-e", `process.exit(${code})`];
const FAIL_WITH = (text) => [NODE, "-e", `process.stderr.write(${JSON.stringify(text)}); process.exit(3)`];

test("parseArgs defaults every declared flag, so a caller never reads undefined", () => {
  const spec = {
    quick: { type: "boolean" },
    only: { type: "string", default: "" },
    rows: { type: "number", default: 1000 },
  };
  assert.deepEqual(parseArgs([], spec), { quick: false, only: "", rows: 1000 });
});

test("parseArgs adds `help` only when asked, so a flag spec never shadows it implicitly", () => {
  assert.equal("help" in parseArgs([], { quick: { type: "boolean" } }), false);
  assert.equal(parseArgs(["--help"], { quick: { type: "boolean" } }).help, true);
});

test("parseArgs reads a boolean flag in either position", () => {
  const spec = { quick: { type: "boolean" }, list: { type: "boolean" } };
  assert.deepEqual(parseArgs(["--quick", "--list"], spec), { quick: true, list: true });
  assert.deepEqual(parseArgs(["--list", "--quick"], spec), { quick: true, list: true });
});

test("parseArgs accepts --key=value and --key value alike", () => {
  const spec = { root: { type: "string" } };
  assert.equal(parseArgs(["--root=/tmp/x"], spec).root, "/tmp/x");
  assert.equal(parseArgs(["--root", "/tmp/x"], spec).root, "/tmp/x");
  // And with a Windows path, which is the real caller on this platform.
  assert.equal(parseArgs(["--root=C:/tmp/x"], spec).root, "C:/tmp/x");
});

test("parseArgs does not swallow the next flag as a value", () => {
  const spec = { root: { type: "string" }, strict: { type: "boolean" } };
  assert.throws(
    () => parseArgs(["--root", "--strict"], spec),
    (err) => isUsageError(err) && /--root needs a value/.test(err.message),
  );
});

test("parseArgs accepts an empty --key= value, which is a value and not a missing one", () => {
  assert.equal(parseArgs(["--only="], { only: { type: "string" } }).only, "");
});

test("parseArgs treats --help and -h as a query, never as an error", () => {
  const spec = { strict: { type: "boolean" } };
  assert.equal(parseArgs(["--help"], spec).help, true);
  assert.equal(parseArgs(["-h"], spec).help, true);
  assert.equal(parseArgs(["--strict", "--help"], spec).strict, true);
});

test("parseArgs rejects an unknown flag by default, so a typo cannot silently disable a check", () => {
  assert.throws(
    () => parseArgs(["--jsno"], { json: { type: "boolean" } }),
    (err) => isUsageError(err) && /unrecognized argument "--jsno"/.test(err.message),
  );
});

test("parseArgs rejects a stray positional by default", () => {
  assert.throws(
    () => parseArgs(["oops"], { json: { type: "boolean" } }),
    (err) => isUsageError(err) && /unexpected argument "oops"/.test(err.message),
  );
});

test("parseArgs ignores both under allowUnknown, for the four scripts that are lenient today", () => {
  const spec = { json: { type: "boolean" } };
  const out = parseArgs(["--jsno", "oops", "--json"], spec, { allowUnknown: true });
  assert.equal(out.json, true);
});

test("parseArgs refuses a value on a boolean flag", () => {
  assert.throws(
    () => parseArgs(["--json=yes"], { json: { type: "boolean" } }),
    (err) => isUsageError(err) && /--json takes no value/.test(err.message),
  );
});

test("parseArgs refuses a non-numeric number, so a benchmark bound cannot become NaN", () => {
  assert.throws(
    () => parseArgs(["--rows=lots"], { rows: { type: "number" } }),
    (err) => isUsageError(err) && /must be a number/.test(err.message),
  );
});

test("parseArgs applies coerce, so a bound check can be part of the spec", () => {
  const spec = {
    rows: {
      type: "number",
      default: 1000,
      coerce: (n) => {
        if (n < 1 || n > 1000) throw Object.assign(new Error("out of range"), { usageError: true });
        return n;
      },
    },
  };
  assert.equal(parseArgs(["--rows=250"], spec).rows, 250);
  assert.throws(() => parseArgs(["--rows=1001"], spec), (err) => isUsageError(err));
});

test("parseArgs enforces choices on a string flag", () => {
  const spec = { today: { type: "string", choices: ["2026-01-01", "2026-12-31"] } };
  assert.equal(parseArgs(["--today=2026-12-31"], spec).today, "2026-12-31");
  assert.throws(
    () => parseArgs(["--today=nonsense"], spec),
    (err) => isUsageError(err) && /must be one of/.test(err.message),
  );
});

test("a later occurrence of a flag wins, as it did in every open-coded parser", () => {
  assert.equal(parseArgs(["--only=a", "--only=b"], { only: { type: "string" } }).only, "b");
});

test("usage renders one aligned line per declared flag, with its default", () => {
  const text = usage(
    ["usage: clean [--dry] [--root <dir>]"],
    {
      dry: { type: "boolean", describe: "report only" },
      root: { type: "string", placeholder: "<dir>", describe: "another root" },
      rows: { type: "number", default: 1000 },
    },
    ["note: nothing is deleted without a confirmation"],
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "usage: clean [--dry] [--root <dir>]");
  assert.ok(lines.some((l) => l.includes("--dry") && l.includes("report only")));
  assert.ok(lines.some((l) => l.includes("--root <dir>") && l.includes("another root")));
  assert.ok(lines.some((l) => l.includes("(default: 1000)")));
  assert.equal(lines.at(-1), "note: nothing is deleted without a confirmation");
});

test("runSync captures stdout and returns the trimmed text on success", () => {
  const [file, ...args] = ECHO("  hello  ");
  const r = runSync(file, args);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.text, "hello");
  assert.equal(r.stdout, "  hello  ", "the raw buffer is preserved alongside the trimmed text");
  assert.equal(r.error, null);
});

test("runSync in REQUIRE mode reports a non-zero exit as an error carrying the child's code", () => {
  const [file, ...args] = EXIT_WITH(7);
  const r = runSync(file, args, { outcome: Outcome.REQUIRE });
  assert.equal(r.ok, false);
  assert.equal(r.code, 7);
  assert.equal(r.text, null, "a failed command's output must not be readable as a fact");
  assert.equal(r.error.status, 7, "the child's code is preserved for a caller that forwards it");
  assert.match(r.error.message, /exited 7/);
});

test("runSync in REQUIRE mode includes the child's stderr in the message", () => {
  const [file, ...args] = FAIL_WITH("forge not found");
  const r = runSync(file, args, { outcome: Outcome.REQUIRE });
  assert.equal(r.code, 3);
  assert.match(r.error.message, /forge not found/);
  assert.equal(r.stderr, "forge not found");
});

test("runSync in TOLERATE mode turns the same failure into a plain falsy result", () => {
  // The exact pair of behaviours that disagrees in the tree today:
  //   assurance-inventory.mjs:255-258  → TOLERATE  (git is a best-effort fact)
  //   check-doc-counts.mjs:716-723     → REQUIRE   (forge is a required tool)
  const [file, ...args] = EXIT_WITH(1);
  const tolerated = runSync(file, args, { outcome: Outcome.TOLERATE });
  assert.equal(tolerated.ok, false);
  assert.equal(tolerated.code, 1);
  assert.equal(tolerated.error, null, "a tolerated failure is not an exception");
  assert.equal(tolerated.text, null);

  const required = runSync(file, args, { outcome: Outcome.REQUIRE });
  assert.equal(required.ok, false);
  assert.ok(required.error instanceof Error);
});

test("runSync TOLERATE is the default, so a new caller cannot accidentally fail on a probe", () => {
  // Documented as REQUIRE above; pinned here because a probe is the common case and the
  // stricter reading must be chosen deliberately.
  const [file, ...args] = EXIT_WITH(1);
  const r = runSync(file, args, { outcome: Outcome.TOLERATE });
  assert.equal(r.error, null);
  assert.equal(r.ok, false);
});

test("runSync reports a command that cannot be spawned at all, without throwing", () => {
  const r = runSync("definitely-not-a-real-command-9f3a", ["--version"], { outcome: Outcome.TOLERATE });
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.text, null);
  assert.ok(r.error, "a spawn failure is an error even in TOLERATE mode — nothing ran");
});

test("runSync merges env over process.env and leaves it alone otherwise", () => {
  const [file, ...args] = [NODE, "-e", "process.stdout.write(String(process.env.SIGILKIT_PROBE ?? 'unset'))"];
  assert.equal(runSync(file, args).text, "unset");
  assert.equal(runSync(file, args, { env: { SIGILKIT_PROBE: "set" } }).text, "set");
});

test("runSync honours a cwd", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const [file, ...args] = [NODE, "-e", "process.stdout.write(process.cwd())"];
  assert.equal(runSync(file, args, { cwd: here }).text.replace(/[\\/]$/, ""), here.replace(/[\\/]$/, ""));
});

test("runSync's TOLERATE mode still distinguishes a clean run from a failed one", () => {
  const [okFile, ...okArgs] = ECHO("fine");
  const [badFile, ...badArgs] = EXIT_WITH(2);
  const ok = runSync(okFile, okArgs, { outcome: Outcome.TOLERATE });
  const bad = runSync(badFile, badArgs, { outcome: Outcome.TOLERATE });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "fine");
  assert.equal(bad.ok, false);
  assert.equal(bad.text, null);
  // A probe's caller must be able to branch on `.ok` alone.
  assert.notEqual(ok.ok, bad.ok);
});

test("runJsonSync parses a JSON payload and returns null on anything else", () => {
  const [file, ...args] = [NODE, "-e", "process.stdout.write(JSON.stringify({v:1}))"];
  assert.deepEqual(runJsonSync(file, args), { v: 1 });
  const [text, ...textArgs] = ECHO("not json");
  assert.equal(runJsonSync(text, textArgs), null);
  const [bad, ...badArgs] = EXIT_WITH(1);
  assert.equal(runJsonSync(bad, badArgs), null);
  const [none, ...noneArgs] = [NODE, "-e", "process.exit(0)"];
  assert.equal(runJsonSync(none, noneArgs), null, "empty output is not a fact");
});

test("EXIT is the contract runSync is designed around, and is importable from here", () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAIL, 1);
  assert.equal(EXIT.USAGE, 2);
});
