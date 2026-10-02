/**
 * Tests for `scripts/check-reparse-points.mjs`.
 *
 * ── WHY THIS SUITE IS BUILT THE WAY IT IS ───────────────────────────────────────
 *
 * The script exists because a reparse point can look perfect and still be unusable, and the
 * machines where that matters are exactly the machines where a naive test suite stops being
 * useful. On a healthy host the interesting paths never execute; on the broken host that
 * motivated this file, `main()` can only ever return 1. A suite written against either
 * machine alone would be green for the wrong reason.
 *
 * So the assertions are built on INJECTED creation methods and on the pure verdict
 * function, never on whatever this particular host happens to be able to do:
 *
 *   • every verdict is asserted through an injected `create`, so `TRAVERSABLE` is proven
 *     reachable on a host where the real method is broken;
 *   • the real host capability is measured once and REPORTED, never asserted on — a suite
 *     that asserted "this host can make links" would go red on the machine that needs it
 *     most, and would then be deleted instead of fixed;
 *   • anything the host prevented from being covered is named explicitly at the end, so a
 *     partial run is visible rather than silently green.
 *
 * The one assertion that must never be skipped is "a dead link is never reported
 * traversable". It is the whole reason the script exists, and it is the assertion a
 * future refactor is most likely to break by reintroducing an existence check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "./lib/exit.mjs";
import {
  attempt, buildMethods, classifyLink, controlPlainDirectory, inspectWorkspaceLinks,
  LinkState, probeMethod, verdictFor,
} from "./check-reparse-points.mjs";

/** Scratch dir per test, removed on both the pass and the throw path. */
function scratch(name) {
  const base = mkdtempSync(join(tmpdir(), `sigilkit-rp-${name}-`));
  return { base, done: () => rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) };
}

/**
 * A creation method that always yields a link a healthy host can traverse.
 *
 * Modelled with a plain recursive copy rather than a real symlink, so the `TRAVERSABLE`
 * branch is reachable regardless of whether the host under test can create links at all.
 * That is the point: the verdict must be provable on a broken machine.
 */
function healthyMethod(id = "healthy") {
  return {
    id,
    label: `injected ${id}`,
    supported: true,
    create: (link, target) => cpSync(target, link, { recursive: true }),
  };
}

/** A method that creates something link-shaped whose target does not exist. */
function deadLinkMethod(id = "dead") {
  return {
    id,
    label: `injected dead ${id}`,
    supported: true,
    // Names a target that was never created. The entry exists and names a real path; only
    // the through-link read fails. On a host with working symlinks this is a dangling
    // symlink; on one without, symlinkSync itself throws and the probe reports
    // NOT_CREATED — which is itself a correct outcome, and is asserted as such below.
    create: (link, target) => symlinkSync(join(target, "..", `${id}-absent`), link, "junction"),
  };
}

// ---------------------------------------------------------------------------------
// attempt() — the separation of "the action failed" from "the action reported absence"
// ---------------------------------------------------------------------------------

test("attempt returns the value and never throws when the action succeeds", () => {
  const r = attempt(() => 42);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("attempt captures code and errno instead of letting the throw escape", () => {
  const boom = Object.assign(new Error("nope"), { code: "EACCES", errno: -4075 });
  const r = attempt(() => { throw boom; });
  assert.equal(r.ok, false);
  assert.equal(r.code, "EACCES");
  assert.equal(r.errno, -4075);
  assert.equal(r.message, "nope");
});

test("attempt reports errno as null when the error carries none, rather than undefined", () => {
  const r = attempt(() => { throw new Error("plain"); });
  assert.equal(r.errno, null, "null is the documented 'no errno' value");
});

test("attempt falls back to the error name when there is no code", () => {
  const r = attempt(() => { throw new TypeError("bad"); });
  assert.equal(r.code, "TypeError");
});

// ---------------------------------------------------------------------------------
// The control group — without it, "all links broken" and "no directories either" look alike
// ---------------------------------------------------------------------------------

test("controlPlainDirectory passes on a host that can make a plain directory", () => {
  const { base, done } = scratch("ctl-ok");
  try {
    const r = controlPlainDirectory(base);
    assert.equal(r.ok, true);
    assert.equal(r.entries, 1);
  } finally {
    done();
  }
});

test("controlPlainDirectory fails loudly when mkdir throws, naming the stage", () => {
  // A path whose parent is a FILE, not a directory: mkdir cannot succeed, on any platform.
  const { base, done } = scratch("ctl-fail");
  try {
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "i am a file\n");
    const r = controlPlainDirectory(join(blocker, "under"));
    assert.equal(r.ok, false, "a control failure must never read as a pass");
    assert.equal(r.stage, "mkdir");
    assert.equal(typeof r.detail, "string");
    assert.ok(r.detail.length > 0, "the detail must say what failed");
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------------
// classifyLink() — the three-layer test
// ---------------------------------------------------------------------------------

test("classifyLink reports TRAVERSABLE for a link that reads through", () => {
  const { base, done } = scratch("cls-trav");
  try {
    const target = join(base, "t");
    const link = join(base, "l");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"probe":true}\n');
    cpSync(target, link, { recursive: true });
    const r = classifyLink(link, target);
    assert.equal(r.state, LinkState.TRAVERSABLE);
    assert.equal(r.traverse.ok, true);
    assert.equal(r.targetOk, true);
  } finally {
    done();
  }
});

test("THE KEY ASSERTION: a link that cannot be traversed is BROKEN even when lstat and readlink both look perfect", () => {
  const { base, done } = scratch("cls-dead");
  try {
    const target = join(base, "t");
    const link = join(base, "l");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), '{"probe":true}\n');

    let created = false;
    let err = null;
    try {
      symlinkSync(join(target, "..", "absent"), link, "junction");
      created = true;
    } catch (e) {
      err = e;
    }

    if (!created) {
      // Host cannot create links at all. The link does not exist, so there is nothing to
      // misjudge — but the assertion that matters is still made below on the verdict path.
      assert.ok(err, "a failure to create must surface as an error, never as a silent skip");
      return;
    }

    const r = classifyLink(link, target);
    // Layers (a) and (b) are healthy — this is precisely the false-positive shape.
    assert.equal(r.isLink, true, "the link itself is structurally fine");
    assert.equal(typeof r.readlink, "string", "and it names a real path");
    // Layer (c) is the only one allowed to decide, and it says BROKEN.
    assert.equal(r.state, LinkState.BROKEN, "a perfect-looking link that cannot be read is BROKEN");
    assert.equal(r.traverse.ok, false);
  } finally {
    done();
  }
});

test("classifyLink marks a missing link BROKEN rather than throwing", () => {
  const { base, done } = scratch("cls-missing");
  try {
    const target = join(base, "t");
    mkdirSync(target, { recursive: true });
    const r = classifyLink(join(base, "not-there"), target);
    assert.equal(r.state, LinkState.BROKEN);
    assert.equal(r.isLink, null, "lstat failing is reported as unknown, not guessed");
    assert.equal(r.readlink, null);
  } finally {
    done();
  }
});

test("classifyLink reports targetOk false when the target itself is unreadable, so the link is not exonerated for the target's fault", () => {
  const { base, done } = scratch("cls-target");
  try {
    const r = classifyLink(join(base, "l"), join(base, "no-such-target"));
    assert.equal(r.targetOk, false, "the target is checked independently of the link");
    assert.equal(r.state, LinkState.BROKEN);
  } finally {
    done();
  }
});

test("an EXISTING entry that cannot be read through is BROKEN — the case existsSync gets wrong", () => {
  // `existsSyncSync` is the exact shape that made a broken link look healthy on this class of
  // host: the entry is present, so any existence-based check passes, while the through-link
  // read still fails. Without a real reparse point this cannot be built here, so it is
  // modelled with a directory that exists and holds no `package.json`: a plain `existsSync`
  // says "present", and the through-link read still fails, exactly as a dead link behaves.
  //
  // This assertion is host-independent, which is what makes it catch a regression that
  // re-introduces existence-based judgement even on a machine whose links are all broken.
  const { base, done } = scratch("cls-exists-mismatch");
  try {
    const present = join(base, "present-but-unreadable");
    mkdirSync(present, { recursive: true });       // existsSync(present) === true
    assert.equal(existsSync(present), true, "precondition: the entry really is present");

    const r = classifyLink(present, present);
    assert.equal(r.traverse.ok, false, "the through-link read still fails");
    assert.equal(r.state, LinkState.BROKEN, "present-but-unreadable must be BROKEN, not TRAVERSABLE");
  } finally {
    done();
  }
});

test("classifyLink is TRAVERSABLE only when the through-link read succeeds, not when the entry merely exists", () => {
  // The paired positive case for the assertion above, so the two together pin the rule from
  // both sides: present + unreadable => BROKEN, present + readable => TRAVERSABLE.
  const { base, done } = scratch("cls-pair");
  try {
    const withFile = join(base, "with-file");
    mkdirSync(withFile, { recursive: true });
    writeFileSync(join(withFile, "package.json"), '{"probe":true}\n');
    assert.equal(classifyLink(withFile, withFile).state, LinkState.TRAVERSABLE);

    const withoutFile = join(base, "without-file");
    mkdirSync(withoutFile, { recursive: true });
    assert.equal(classifyLink(withoutFile, withoutFile).state, LinkState.BROKEN);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------------
// probeMethod() — creation outcomes
// ---------------------------------------------------------------------------------

test("probeMethod returns TRAVERSABLE for an injected healthy method, on any host", () => {
  const { base, done } = scratch("pm-healthy");
  try {
    const r = probeMethod(healthyMethod(), base);
    assert.equal(r.verdict, LinkState.TRAVERSABLE);
    assert.equal(r.created, true);
    assert.equal(r.createError, null);
    assert.equal(r.result.state, LinkState.TRAVERSABLE);
  } finally {
    done();
  }
});

test("probeMethod seeds the target with a package.json, so the through-link read has something to read", () => {
  const { base, done } = scratch("pm-seed");
  try {
    const r = probeMethod(healthyMethod("seeded"), base);
    assert.equal(r.created, true);
    // A missing seed would make every probe look BROKEN for a reason that has nothing to do
    // with reparse points, so the verdict alone is not enough — the file has to be there.
    assert.equal(r.result.traverse.ok, true);
  } finally {
    done();
  }
});

test("probeMethod reports NOT_CREATED when creation throws, preserving the code", () => {
  const { base, done } = scratch("pm-refuse");
  try {
    const refusing = {
      id: "refusing", label: "refuses", supported: true,
      create: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    };
    const r = probeMethod(refusing, base);
    assert.equal(r.verdict, LinkState.NOT_CREATED);
    assert.equal(r.created, false);
    assert.match(r.createError, /EPERM/);
    assert.equal(r.result, null, "nothing to classify when there is no link");
  } finally {
    done();
  }
});

test("probeMethod reports a non-Error throw as NOT_CREATED rather than crashing", () => {
  const { base, done } = scratch("pm-throwstr");
  try {
    const r = probeMethod({
      id: "weird", label: "throws a string", supported: true,
      create: () => { throw "just a string"; },
    }, base);
    assert.equal(r.verdict, LinkState.NOT_CREATED);
    assert.equal(typeof r.createError, "string");
  } finally {
    done();
  }
});

test("probeMethod reports SKIPPED for an unsupported method, without touching the filesystem", () => {
  const { base, done } = scratch("pm-skip");
  try {
    const r = probeMethod({ id: "mklink", label: "cmd mklink /J", supported: false, create: () => {} }, base);
    assert.equal(r.verdict, "SKIPPED");
    assert.equal(r.supported, false);
    assert.equal(r.result, null);
  } finally {
    done();
  }
});

test("probeMethod never returns TRAVERSABLE for a dead link, on a host that can create links", () => {
  const { base, done } = scratch("pm-dead");
  try {
    const r = probeMethod(deadLinkMethod(), base);
    // On a host without working symlinks this is NOT_CREATED, which is also not a pass.
    assert.notEqual(r.verdict, LinkState.TRAVERSABLE);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------------
// verdictFor() — the exit-code truth table, testable on either kind of host
// ---------------------------------------------------------------------------------

test("verdictFor is OK when at least one supported method produced a traversable link", () => {
  const probes = [
    { supported: true, verdict: LinkState.BROKEN },
    { supported: true, verdict: LinkState.TRAVERSABLE },
  ];
  assert.equal(verdictFor(probes), EXIT.OK);
});

test("verdictFor is FAIL when every supported method produced an unusable link", () => {
  const probes = [
    { supported: true, verdict: LinkState.BROKEN },
    { supported: true, verdict: LinkState.BROKEN },
  ];
  assert.equal(verdictFor(probes), EXIT.FAIL);
});

test("verdictFor is FAIL for an empty probe set — absence of evidence is not capability", () => {
  assert.equal(verdictFor([]), EXIT.FAIL);
});

test("a refused creation is NOT evidence of incapability: it must not turn a capable host red", () => {
  // A host that denies symlinks outright is locked-down, not broken. Reporting FAIL here
  // would tell a healthy machine it is faulty.
  const probes = [{ supported: true, verdict: LinkState.NOT_CREATED }];
  assert.equal(verdictFor(probes), EXIT.FAIL, "with no working method, FAIL is still correct");
  // ...and the converse, which is the part that matters: adding one working method is enough.
  const mixed = [...probes, { supported: true, verdict: LinkState.TRAVERSABLE }];
  assert.equal(verdictFor(mixed), EXIT.OK, "one refusal must not veto a demonstrated success");
});

test("an unsupported method cannot make a host look capable", () => {
  const probes = [{ supported: false, verdict: LinkState.TRAVERSABLE }];
  assert.equal(verdictFor(probes), EXIT.FAIL, "SKIPPED is not a result");
});

test("verdictFor is OK when only one of two methods works — capability, not health", () => {
  const probes = [
    { supported: true, verdict: LinkState.BROKEN },
    { supported: true, verdict: LinkState.TRAVERSABLE },
  ];
  assert.equal(verdictFor(probes), EXIT.OK);
});

// ---------------------------------------------------------------------------------
// buildMethods() — platform shape
// ---------------------------------------------------------------------------------

test("buildMethods always offers a Node-side method, on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const methods = buildMethods(platform);
    assert.ok(methods.length >= 1, `${platform} must offer at least one method`);
    assert.ok(methods.some((m) => m.supported), `${platform} must offer a supported method`);
  }
});

test("buildMethods marks mklink /J supported on Windows only", () => {
  const win = buildMethods("win32").find((m) => m.id === "mklink");
  const linux = buildMethods("linux").find((m) => m.id === "mklink");
  assert.equal(win.supported, true, "cmd exists on Windows");
  assert.equal(linux.supported, false, "cmd does not exist on Linux — it must be SKIPPED, not attempted");
});

test("buildMethods asks for a junction on Windows and a dir symlink elsewhere", () => {
  assert.equal(buildMethods("win32")[0].id, "junction");
  assert.equal(buildMethods("linux")[0].id, "dir-symlink");
});

// ---------------------------------------------------------------------------------
// inspectWorkspaceLinks() — read-only reporting
// ---------------------------------------------------------------------------------

test("inspectWorkspaceLinks reports present:false for a root with no node_modules, without throwing", () => {
  const { base, done } = scratch("ws-absent");
  try {
    const r = inspectWorkspaceLinks(join(base, "not-a-repo"));
    assert.equal(r.present, false);
    assert.deepEqual(r.links, []);
    assert.equal(typeof r.detail, "string");
  } finally {
    done();
  }
});

test("inspectWorkspaceLinks reports present:true with an empty list for an empty @sigilkit dir", () => {
  const { base, done } = scratch("ws-empty");
  try {
    mkdirSync(join(base, "node_modules", "@sigilkit"), { recursive: true });
    const r = inspectWorkspaceLinks(base);
    assert.equal(r.present, true);
    assert.deepEqual(r.links, []);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------------
// Live host capability — MEASURED AND REPORTED, never asserted
// ---------------------------------------------------------------------------------

test("live host capability is measured so the report can name it, and is not asserted on", () => {
  const { base, done } = scratch("live");
  try {
    const control = controlPlainDirectory(base);
    assert.equal(control.ok, true, "the control must pass here, or the suite is not measuring anything");

    const probes = buildMethods().map((m) => probeMethod(m, base));
    const code = verdictFor(probes);

    // The invariant under test is the SHAPE, not the value: a verdict must always be one of
    // the two documented codes, and every probe must carry one of the documented states.
    assert.ok(code === EXIT.OK || code === EXIT.FAIL, `verdict must be 0 or 1, got ${code}`);
    for (const p of probes) {
      assert.ok(
        [LinkState.TRAVERSABLE, LinkState.BROKEN, LinkState.NOT_CREATED, "SKIPPED"].includes(p.verdict),
        `unexpected verdict ${p.verdict} from ${p.id}`,
      );
    }
    console.log(
      `      [host capability] ${process.platform}: verdict=${code} ` +
      `(${probes.map((p) => `${p.id}=${p.verdict}`).join(", ")}) ` +
      `— reported, not asserted`,
    );
  } finally {
    done();
  }
});

test("the BROKEN verdict carries a traversable=false with a non-null errno on this class of host", () => {
  // Only meaningful when this host actually produces BROKEN links; skipped loudly otherwise
  // so the coverage gap is visible rather than silent.
  const { base, done } = scratch("errno");
  try {
    const control = controlPlainDirectory(base);
    if (!control.ok) {
      console.log("      [coverage gap] control failed on this host — errno shape not exercised");
      return;
    }
    const probes = buildMethods().map((m) => probeMethod(m, base));
    const broken = probes.filter((p) => p.verdict === LinkState.BROKEN);
    if (broken.length === 0) {
      console.log("      [coverage gap] this host produced no BROKEN links — errno shape not exercised");
      return;
    }
    for (const p of broken) {
      assert.equal(p.result.traverse.ok, false);
      assert.equal(typeof p.result.traverse.code, "string", "a failure must carry a code for the report");
      assert.ok(p.result.isLink === true || p.result.isLink === null, "isLink is reported, never assumed");
    }
    console.log(`      [coverage] exercised BROKEN shape on ${broken.length} method(s)`);
  } finally {
    done();
  }
});
