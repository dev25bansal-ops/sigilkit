import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverSuites,
  registeredSuites,
  unregisteredSuites,
} from "./check-helper-suites.mjs";

/**
 * The pure helpers take their inputs as arguments precisely so these tests can exercise the
 * shapes that the real repository cannot show them: a suite that has not been written yet, a
 * `verify.mjs` whose list has been refactored away. Both are the states this guard exists to
 * make visible, and neither is reachable by editing the real files.
 */

/**
 * A `readdirSync` stand-in: emits Dirents for the given `scripts/`-relative paths.
 *
 * `parentPath` mirrors what Node really returns under `{recursive: true}` — the entry's
 * directory *as the caller named it* (verified against Node v24: a top-level entry reports
 * `"scripts"`, not `""`, and `entry.path` is `undefined`). Feeding `""` or absolute paths here
 * produced `scripts/D:/SigilKit/…`, so the fixture matches the real shape exactly.
 */
function fakeReadDir(dir, relPaths) {
  return (_dir, _opts) =>
    relPaths.map((p) => {
      const idx = p.lastIndexOf("/");
      return {
        name: p.slice(idx + 1),
        // Exactly what Node reports: the entry's directory as the caller named it, so a
        // top-level file reports the dir itself. The dir is a parameter because a fixture that
        // hard-codes "scripts" while the call passes "C:/repo/scripts" makes `relative()`
        // return an absolute path — which is how this test first failed.
        parentPath: idx === -1 ? dir : `${dir}/${p.slice(0, idx)}`,
        isFile: () => true,
      };
    });
}

test("discovery finds suites in nested subdirectories, not just the top level", () => {
  // The whole reason the hand-written list lost five suites: a flat scan cannot see scripts/lib/.
  // Inputs are relative to the `scriptsDir` argument, exactly as `readdirSync` reports them.
  const found = discoverSuites("C:/repo/scripts", fakeReadDir("C:/repo/scripts", [
    "a.test.mjs",
    "lib/deep.test.mjs",
  ]));
  assert.deepEqual(found, ["scripts/a.test.mjs", "scripts/lib/deep.test.mjs"]);
});

test("discovery ignores files that are not test suites", () => {
  const found = discoverSuites("C:/repo/scripts", fakeReadDir("C:/repo/scripts", [
    "a.mjs",
    "notes.md",
  ]));
  assert.deepEqual(found, []);
});

test("the registered list is read out of the literal argv array", () => {
  const source = [
    'await run(labelOf("helpers"), process.execPath, [',
    '  "--test",',
    '  "scripts/one.test.mjs",',
    '  "scripts/lib/two.test.mjs",',
    '  "scripts/last.test.mjs",',
    "  ]),",
  ].join("\n");
  // The list is delimited by the array's closing `]),`, not by any particular last entry — so
  // adding a suite to the end cannot silently fall outside the guard's view.
  assert.deepEqual(registeredSuites(source), [
    "scripts/last.test.mjs",
    "scripts/lib/two.test.mjs",
    "scripts/one.test.mjs",
  ]);
});

test("a verify.mjs with no recognisable suite list yields null, not an empty list", () => {
  // This is the load-bearing property. An empty list would make every discovered suite look
  // unregistered (a false alarm); the real danger is the opposite — a caller that treats "no
  // list" as "nothing to compare" and reports OK. `null` is what lets main() exit 2 instead.
  assert.equal(registeredSuites("const x = 1;\n"), null);
  // A `--test` flag with NO suite path after it is the same condition and must also be `null`:
  // the list was renamed, emptied or moved, and this guard cannot see its subject. Before
  // 2026-08-28 this case returned `[]` and 24 real suites were reported as drift.
  assert.equal(registeredSuites('await run(a, b, ["--test",]);'), null);
});

test("a single-line argv list IS readable — the old `]),` anchor wrongly rejected it", () => {
  // Regression, and a deliberate behaviour CHANGE. The previous implementation required the
  // literal `]),`, so a list written on one line (`["--test", "scripts/x.test.mjs",])`) parsed as
  // unreadable. Nothing about the domain required that: an argv list is a list of suite paths,
  // and this one is perfectly legible. The old test asserted `null` here, which meant it was
  // pinning the parser's accident rather than a property of the gate. The content-based parser
  // reads it correctly, and a suite on one line is a real thing a contributor may write.
  assert.deepEqual(
    registeredSuites('await run(a, b, ["--test", "scripts/x.test.mjs",]);'),
    ["scripts/x.test.mjs"],
  );
});

test("a doc comment containing the old `]),` literal cannot hijack the parse", () => {
  // THE 2026-08-28 INCIDENT, fossilised. `verify.mjs` gained a comment warning that a tuple
  // wrapper would break this guard's `]),` anchor — and that comment's own prose contained the
  // characters `]),`, so `indexOf` matched the COMMENT. The parser read 278 characters of
  // documentation containing zero suite paths, returned `[]`, and every one of the 24 real
  // suites was reported as drift. Not one of those 24 was real.
  //
  // The fix is not a different literal. It is that the block is delimited by its CONTENT (the
  // last line naming a suite), which prose cannot fake, so the guard is no longer sensitive to
  // what the documentation says about its own parser.
  const source = [
    'await run(labelOf("helpers"), process.execPath, [',
    '  "--test",',
    '  "scripts/real.test.mjs",',
    "  ])],",
    "])],",
    " * the shape `\"--test\", … ])` had when entries were bare thunks; a tuple wrapper changes",
    " * that text to `])],` and the guard cannot see its subject any more.",
    ' * `step("helpers", () => run(…, [ … ]),` still ends in `]),` so the anchor works.',
  ].join("\n");
  // The three decoy lines below all contain the old literal and none of them may be read.
  assert.deepEqual(registeredSuites(source), ["scripts/real.test.mjs"]);
});

test("prose after the list cannot register a suite that is not in the list", () => {
  // The same hazard from the other side. A comment mentioning a suite path after the list ends
  // must not be counted as registered — otherwise a suite could be "registered" by a sentence
  // and the guard would report no drift while the suite never ran.
  const source = [
    'await run(labelOf("helpers"), process.execPath, [',
    '  "--test",',
    '  "scripts/real.test.mjs",',
    "  ]),",
    " * we should probably also add scripts/imaginary.test.mjs one day",
  ].join("\n");
  assert.deepEqual(registeredSuites(source), ["scripts/real.test.mjs"]);
});

test("drift is the set difference in one direction only", () => {
  const discovered = ["scripts/a.test.mjs", "scripts/b.test.mjs"];
  assert.deepEqual(unregisteredSuites(discovered, ["scripts/a.test.mjs"]), ["scripts/b.test.mjs"]);
  // A registered suite that no longer exists is a different problem (a stale entry) and is not
  // this guard's business — reporting it here would fire on every deliberate deletion before
  // the file was removed, and it is the delete-then-prune order that makes that unfalsifiable.
  assert.deepEqual(unregisteredSuites(["scripts/a.test.mjs"], ["scripts/a.test.mjs", "scripts/gone.test.mjs"]), []);
});

test("an unreadable registered list is reported as unknown, never as 'no drift'", () => {
  assert.equal(unregisteredSuites(["scripts/a.test.mjs"], null), null);
});

test("an EMPTY registered list is also 'unknown', not 'every suite is unregistered'", () => {
  // The second half of the same fix, at the boundary the 2026-08-28 incident slipped through.
  // `unregisteredSuites` used to special-case only `null`, so an empty list compared as valid
  // and produced 24 false findings. An empty register and an unreadable one mean the same thing
  // to this guard — it has no list to compare against — so both must yield `null` (→ exit 2).
  assert.equal(unregisteredSuites(["scripts/a.test.mjs", "scripts/b.test.mjs"], []), null);
  // Sanity: a genuinely non-empty list still reports real drift, so the guard is not now
  // permanently mute.
  assert.deepEqual(unregisteredSuites(["scripts/a.test.mjs", "scripts/b.test.mjs"], ["scripts/a.test.mjs"]), ["scripts/b.test.mjs"]);
});
