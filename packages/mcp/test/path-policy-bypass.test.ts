/**
 * SEC-14 — path-policy bypass attempts against `audit_query`'s `db` allowlist.
 *
 * The SEC-04 fix replaced "any path" with an operator allowlist and a two-code error
 * contract. Those two properties are in tension, and this file pins where the balance
 * landed:
 *
 *  1. **No escape from the allowlist** — the containment rule is decided twice, lexically
 *     and again on the resolved path, so neither `..` nor a symlink can widen it.
 *  2. **No existence oracle** — the refusal must not reveal whether a guessed path is on
 *     disk. This is the property that was actually broken, and the regression test that
 *     pins it is the `EXISTS vs ABSENT` case below.
 *
 * Every case is written so that the rejection is attributable to the *path rule* rather
 * than to the file happening to be missing: the out-of-root targets are real, readable
 * files, and the in-root targets are real indexer stores. A test that only ever probes
 * absent paths would pass even with the oracle wide open.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigilIndexer } from "@sigilkit/indexer";
import { handleMessage, __setAuditDbRootsForTests } from "../src/server.js";

/** Calls `audit_query` through the real dispatcher and returns the reply text. */
async function query(db: unknown): Promise<{ isError: boolean; text: string }> {
  const res = (await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "audit_query", arguments: { db, query: "summary" } },
  })) as { result?: { content: Array<{ text: string }>; isError?: boolean } };
  const content = res.result?.content ?? [];
  return { isError: res.result?.isError === true, text: content.map((c) => c.text).join("\n") };
}

const sandboxes: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigilkit-sec14-"));
  sandboxes.push(dir);
  return dir;
}

/** True when a link was actually created (symlink creation needs a privilege on Windows). */
function trySymlink(target: string, path: string, type: "file" | "dir"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  __setAuditDbRootsForTests({});
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/**
 * `root` is allowlisted; `outside` is its real sibling and holds a real file. Both are
 * cleaned up in `afterEach`.
 */
function pair(): { root: string; outside: string; loot: string } {
  const root = sandbox();
  const outside = sandbox();
  const loot = join(outside, "loot.db");
  // A REAL SigilIndexer database, not a text file.
  //
  // This is load-bearing. The suite previously wrote "not-really-a-database", so removing
  // the post-realpath containment check (server.ts step 4) still produced an error — SQLite's
  // own "file is not a database" — and `expect(res.isError).toBe(true)` was satisfied by the
  // wrong cause. That made the containment check a surviving mutant: delete it and all 132
  // tests stay green, while an in-root symlink to a real out-of-root store gets SERVED.
  // With a real store at the target, step 4 is the only thing that can refuse it.
  const ix = new SigilIndexer(loot, 8453);
  ix.storeAction({
    agentId: ("0x" + "ab".repeat(32)) as `0x${string}`,
    target: ("0x" + "cd".repeat(20)) as `0x${string}`,
    selector: "0xdeadbeef",
    value: 1n,
    rationaleHash: ("0x" + "ef".repeat(32)) as `0x${string}`,
    timestamp: 1_700_000_000,
    txHash: ("0x" + "11".repeat(32)) as `0x${string}`,
    blockNumber: 1n,
    logIndex: 0,
  });
  ix.close();
  __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
  return { root, outside, loot };
}

describe("SEC-14: the db allowlist cannot be escaped", () => {
  it("refuses an out-of-root path whether or not the target exists", async () => {
    // The load-bearing oracle case. Before the fix these two differed:
    //   existing  -> DB_NOT_ALLOWED      (proves the path resolves)
    //   absent    -> DATABASE_NOT_FOUND  (proves it does not)
    // so the pair was a one-bit existence probe over the whole filesystem.
    const { outside, loot } = pair();
    const existing = await query(loot);
    const absent = await query(join(outside, "definitely-absent.db"));

    expect(existing.isError).toBe(true);
    expect(absent.isError).toBe(true);
    // Byte-identical: an agent cannot learn anything about the disk from this pair.
    expect(existing.text).toBe(absent.text);
    expect(existing.text).toContain("DB_NOT_ALLOWED");
    // …and the code no longer depends on existence, so it cannot be used to walk the disk
    // even if a future edit changes one of the two sentences.
    expect(existing.text).not.toContain("DATABASE_NOT_FOUND");
    // Never echo the guess back.
    expect(existing.text).not.toContain("loot.db");
  });

  it("gives the same refusal for several distinct out-of-root paths", async () => {
    // One uniform answer, not just a uniform answer for the exists/absent pair: an oracle
    // only needs a *stable* mapping from probe to answer to be useful.
    const { root, outside, loot } = pair();
    const replies = await Promise.all([
      query(loot),
      query(join(outside, "other.db")),
      query(`${root}/../${outside.split(/[\\/]/).pop()}/loot.db`),
      query(`${root}\\..\\${outside.split(/[\\/]/).pop()}\\loot.db`),
    ]);
    for (const r of replies) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("DB_NOT_ALLOWED");
    }
    for (const r of replies) expect(r.text).toBe(replies[0]!.text);
  });

  it("refuses a `..` escape that lands on a real file outside the root", async () => {
    const { root, outside } = pair();
    // Concatenated, never `join`ed: `join` would normalise the `..` away and the case
    // would degenerate into the plain absolute-path one.
    const escape = `${root}/../${outside.split(/[\\/]/).pop()}/loot.db`;
    expect(escape).toContain("..");

    const res = await query(escape);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("DB_NOT_ALLOWED");
    expect(res.text).not.toContain("loot.db");
  });

  it("refuses an in-root symlink that points outside the root", async () => {
    // The lexical pre-filter passes this one (the path *is* inside the root); only the
    // post-realpath containment check can catch it. Skipped where the platform refuses
    // to create the link, since a test that silently asserts nothing is worse than none.
    const { root, loot } = pair();
    const link = join(root, "link.db");
    if (!trySymlink(loot, link, "file")) return;

    const res = await query(link);
    // The assertion is *refusal*, not a specific code: on a host that cannot resolve
    // reparse points the resolver throws and the tool reports "not found" — which is
    // still a refusal, and still leaks nothing about the target. What must never happen is
    // the link being served.
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain("audited actions");
    expect(res.text).not.toContain("loot.db");
  });

  it("refuses an in-root directory symlink that points outside the root", async () => {
    const { root, outside } = pair();
    const link = join(root, "escape");
    if (!trySymlink(outside, link, "dir")) return;

    const res = await query(join(link, "loot.db"));
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain("audited actions");
    expect(res.text).not.toContain("loot.db");
  });

  it("still serves a real database inside the root (no over-blocking)", async () => {
    // The positive control. A containment rule tightened far enough to refuse everything
    // would pass every refusal case above, so the legitimate request must still work.
    const root = sandbox();
    const db = join(root, "audit.db");
    // A file whose *name* is a database extension, created without the indexer: the tool
    // must get far enough to open it, which is all this asserts.
    writeFileSync(db, "");
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });

    const res = await query(db);
    // Reaches the open, so the refusal (if any) is DATABASE_NOT_FOUND from SQLite — never
    // a policy refusal, which would mean containment itself had started rejecting it.
    expect(res.text).not.toContain("DB_NOT_ALLOWED");
  });

  it("does not let a nested path escape via a `..` that returns into the root", async () => {
    // `..` is not banned as a character: a path that walks out and back in is legitimate
    // and must still resolve. This is the anti-over-blocking counterpart to the escape
    // case — the rule is containment of the resolved path, not a textual filter.
    const { root } = pair();
    mkdirSync(join(root, "sub"), { recursive: true });
    const db = join(root, "sub", "audit.db");
    writeFileSync(db, "");
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });

    const viaDotDot = `${root}/sub/../sub/audit.db`;
    expect(viaDotDot).toContain("..");

    const res = await query(viaDotDot);
    expect(res.text).not.toContain("DB_NOT_ALLOWED");
  });

  it("refuses forbidden path shapes identically whether or not the target exists", async () => {
    // The shape guard runs on the raw string, before any syscall, so it cannot be an
    // oracle by construction. Pinned so a future reordering cannot move it after the
    // resolver and hand the difference back.
    const { loot } = pair();
    const absent = join(loot, "..", "nowhere", "x.db");
    for (const bad of [`${loot}\0`, absent, "\\\\server\\share\\audit.db", "//server/share/audit.db"]) {
      const res = await query(bad);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("DB_NOT_ALLOWED");
      expect(res.text).not.toContain("DATABASE_NOT_FOUND");
    }
  });

  it("distinguishes 'no allowlist configured' from 'path outside the allowlist'", async () => {
    // MUTATION GUARD. Both refusal points deliberately share the `DB_NOT_ALLOWED` code —
    // one code for "not allowed" is the whole point, since a second code would reopen the
    // existence oracle SEC-14 closed. The cost is that asserting the code alone cannot tell
    // the two apart, so deleting the fail-closed branch (step 2) leaves every other test in
    // this file green: an empty allowlist falls through to the containment check, which
    // returns the same code for the same reason.
    //
    // What *is* distinguishable is the operator-facing text: only step 2 tells the operator
    // how to fix it. So the evidence asserted here is the remediation hint, not the code.
    const dir = sandbox();
    const db = join(dir, "audit.db");
    writeFileSync(db, "");

    // (a) allowlist unset — must carry the "set SIGILKIT_AUDIT_DB_ROOT" instruction.
    __setAuditDbRootsForTests({});
    const unset = await query(db);
    expect(unset.isError).toBe(true);
    expect(unset.text).toContain("SIGILKIT_AUDIT_DB_ROOT");
    expect(unset.text).toContain("is not set");

    // (b) allowlist set, but this path is not under it — a *configured* operator must NOT
    //     be told to configure the thing they already configured.
    const other = sandbox();
    const elsewhere = join(other, "audit.db");
    writeFileSync(elsewhere, "");
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: dir });
    const configured = await query(elsewhere);
    expect(configured.isError).toBe(true);
    expect(configured.text).toContain("DB_NOT_ALLOWED");
    expect(configured.text).not.toContain("is not set");
    expect(configured.text).not.toContain("SIGILKIT_AUDIT_DB_ROOT");

    // (c) The two must differ. Without this, a mutation that collapses step 2 into the
    //     containment check would satisfy (a) and (b) independently while passing this file.
    expect(unset.text).not.toBe(configured.text);
  });
});

/**
 * SEC-14 companion: the `validate_request` field-prefix fix.
 *
 * `parseActionRequest` is the shared SDK parser and its own messages name the offending
 * field (`agentId must be 32-byte hex`). What it did not do was prefix that field with the
 * argument it came from, so a caller could not tell `request.agentId` from a `scope`
 * field, and the error was a bare `Error` rather than a `ValidationError` — making a
 * caller mistake indistinguishable from a genuine server fault.
 */
describe("SEC-14: validate_request names the argument that failed", () => {
  const scope = { perActionCap: "10", perWindowCap: "50", windowSeconds: 600, expiresAt: 4_000_000_000 };
  const request = {
    agentId: "0x" + "ab".repeat(32),
    target: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    selector: "0x12345678",
    value: "1",
    nonce: "0",
    expiry: 4_000_000_000,
    rationaleHash: "0x" + "cd".repeat(32),
    data: "0x",
  };

  async function validate(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const res = (await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "validate_request", arguments: args },
    })) as { result?: { content: Array<{ text: string }>; isError?: boolean } };
    const content = res.result?.content ?? [];
    return { isError: res.result?.isError === true, text: content.map((c) => c.text).join("\n") };
  }

  it("prefixes a malformed agentId with `request.`", async () => {
    const res = await validate({ request: { ...request, agentId: "0xdead" }, scope });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("request.agentId");
  });

  it("prefixes a malformed selector with `request.`", async () => {
    const res = await validate({ request: { ...request, selector: "0x12" }, scope });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("request.selector");
  });

  it("reports a non-object request as a validation error naming the argument", async () => {
    // `null` is not `undefined`, so the transport `required` check passes it through and
    // the tool itself has to refuse — otherwise the model gets a raw TypeError.
    for (const bad of [null, "everything", 42, []]) {
      const res = await validate({ request: bad, scope });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("request");
    }
  });

  it("still accepts a well-formed request (the prefix did not break the happy path)", async () => {
    const res = await validate({ request, scope });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text).ok).toBe(true);
  });
});
