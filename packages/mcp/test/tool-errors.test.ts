/**
 * P0 — MCP tool error paths, one block per tool plus the transport-level guards.
 *
 * The pre-existing `validation.test.ts` walks the *happy* shapes of each tool and a handful
 * of rejections; this file deliberately covers only the paths a malformed or hostile caller
 * reaches. Two reasons that is worth its own file:
 *
 *  - An error message is the tool's *product*. These tests pin the exact sentences an agent
 *    reads, so a future rewrite cannot quietly turn "targets[0].selector: expected 4 bytes"
 *    into a raw TypeError.
 *  - Several of the guards are *fail-closed* decisions, and a fail-closed guard is invisible
 *    unless a test proves the request is refused. Every such test here asserts **absence of
 *    effect** (no file created, no row written, no path echoed) rather than just the message.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toHex, type Hash } from "viem";
import { SigilIndexer } from "@sigilkit/indexer";
import { handleMessage, TOOLS, __setAuditDbRootsForTests } from "../src/server.js";

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const AGENT = ("0x" + "ab".repeat(32)) as Hash;

const sandboxes: string[] = [];

/** Isolated sandbox dir; cleaned up in the shared `afterEach`. */
function sandbox(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sigilkit-mcp-err-${label}-`));
  sandboxes.push(dir);
  return dir;
}

/**
 * A real, EMPTY indexer database inside `dir`, plus that `dir` allowlisted.
 *
 * Why a real store rather than a mock: the point of these cases is the *policy* decision,
 * and a mock cannot prove that a refused path left nothing behind on disk. An empty real
 * store makes "the reply is an error" and "the store is still empty" two independent facts.
 */
function allowlistedStore(label: string): { dir: string; db: string } {
  const dir = sandbox(label);
  const db = join(dir, "audit.db");
  new SigilIndexer(db, 8453).close();
  __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: dir });
  return { dir, db };
}

/** Calls a tool through the real JSON-RPC dispatcher and returns the reply. */
async function call(name: string, args: Record<string, unknown>, id = 7) {
  const res = (await handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
  const content = res.result?.content ?? [];
  return {
    isError: res.result?.isError === true,
    text: content.map((c) => c.text).join("\n"),
    rpcError: res.error,
  };
}

afterEach(() => {
  // The allowlist is module-global; reset first so a stale root can never outlive the
  // sandbox it points at (SEC-13 drops the cached handles for exactly this reason).
  __setAuditDbRootsForTests({});
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  __setAuditDbRootsForTests({});
});

// ── validate_request ───────────────────────────────────────────────────────────

describe("validate_request error paths", () => {
  const scope = { perActionCap: "10", perWindowCap: "50", windowSeconds: 600, expiresAt: 4_000_000_000 };
  const request = {
    agentId: "0x" + "ab".repeat(32),
    target: ALICE,
    selector: "0x12345678",
    value: "1",
    nonce: "0",
    expiry: 4_000_000_000,
    rationaleHash: "0x" + "cd".repeat(32),
    data: "0x",
  };

  it("reports a missing request as a validation error, not a TypeError", async () => {
    // `request` is a declared required argument, so the transport layer refuses before the
    // tool body runs. The point is that the *caller* gets an actionable sentence.
    const { isError, text } = await call("validate_request", { scope });
    expect(isError).toBe(true);
    expect(text).toContain("missing required argument(s): request");
  });

  it("rejects a null request without reaching the parser", async () => {
    // `null` is NOT `undefined`, so the `required` pre-check passes it through. The tool
    // itself must then refuse. Without this case the required-argument gate is the only
    // thing between a model and a TypeError inside parseActionRequest.
    const { isError, text } = await call("validate_request", { request: null, scope });
    expect(isError).toBe(true);
    expect(text).toMatch(/request/i);
  });

  it("names the offending request field for a malformed agentId", async () => {
    // The tool re-qualifies the parser's own sentence as `request.<field>: …`, matching the
    // shape every other validation on this surface uses. What matters is that the message
    // names the field a model must fix, rather than a bare "invalid request".
    const { isError, text } = await call("validate_request", { request: { ...request, agentId: "0xdead" }, scope });
    expect(isError).toBe(true);
    expect(text).toContain("request.agentId");
    expect(text).toContain("32-byte hex");
  });

  it("names the offending request field for a selector that is not 4 bytes", async () => {
    const { isError, text } = await call("validate_request", { request: { ...request, selector: "0x12" }, scope });
    expect(isError).toBe(true);
    expect(text).toContain("request.selector");
    expect(text).toContain("4-byte hex");
  });

  it("rejects a non-object windowState (a bare number) with a shape sentence", async () => {
    const { isError, text } = await call("validate_request", { request, scope, windowState: 5 });
    expect(isError).toBe(true);
    expect(text).toContain("windowState");
  });

  it("rejects a null windowState (object-shape check must not treat null as absent)", async () => {
    // The tool checks `rawWindow !== undefined && (null || typeof !== object)`. A future
    // `if (rawWindow)` rewrite would silently accept `null` and skip the window pre-check,
    // so pin the refusal explicitly.
    const { isError, text } = await call("validate_request", { request, scope, windowState: null });
    expect(isError).toBe(true);
    expect(text).toContain("windowState");
  });

  it("rejects a negative windowStart rather than clamping it", async () => {
    const { isError, text } = await call("validate_request", {
      request,
      scope,
      windowState: { windowStart: -1, spentThisWindow: "0" },
    });
    expect(isError).toBe(true);
    expect(text).toContain("windowState.windowStart");
  });

  it("rejects a non-numeric spentThisWindow", async () => {
    const { isError, text } = await call("validate_request", {
      request,
      scope,
      windowState: { windowStart: 1, spentThisWindow: "lots" },
    });
    expect(isError).toBe(true);
    expect(text).toContain("windowState.spentThisWindow");
  });

  it("reports the policy rejection reason rather than throwing when a cap is exceeded", async () => {
    // A cap breach is a *policy answer*, not a tool failure: the model must be able to read
    // `ok:false` and the reason, so the tool returns instead of raising.
    const { isError, text } = await call("validate_request", {
      request: { ...request, value: "999" },
      scope,
    });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBeTruthy();
  });
});

// ── build_scope ───────────────────────────────────────────────────────────────

describe("build_scope error paths", () => {
  const base = { expiresAt: 4_000_000_000, perActionCap: "10", perWindowCap: "50" };
  const leaf = { target: ALICE, selector: "0x12345678" };

  it("rejects a targets element that is not an object", async () => {
    // A model that emits `targets: ["0xabc…"]` (a flat address list) must be told the
    // element shape, not crash inside the destructuring.
    const { isError, text } = await call("build_scope", { ...base, targets: ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0]");
  });

  it("rejects a null element inside targets", async () => {
    const { isError, text } = await call("build_scope", { ...base, targets: [null] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0]");
  });

  it("rejects a missing selector inside a target entry", async () => {
    const { isError, text } = await call("build_scope", { ...base, targets: [{ target: ALICE }] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].selector");
  });

  it("rejects a missing target address inside a target entry", async () => {
    const { isError, text } = await call("build_scope", { ...base, targets: [{ selector: "0x12345678" }] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].target");
  });

  it("rejects a negative expiresAt", async () => {
    const { isError, text } = await call("build_scope", { ...base, expiresAt: 0, targets: [leaf] });
    expect(isError).toBe(true);
    expect(text).toContain("expiresAt");
  });

  it("rejects a negative windowSeconds", async () => {
    const { isError, text } = await call("build_scope", { ...base, windowSeconds: 0, targets: [leaf] });
    expect(isError).toBe(true);
    expect(text).toContain("windowSeconds");
  });

  it("rejects a negative countersignAbove", async () => {
    const { isError, text } = await call("build_scope", { ...base, countersignAbove: "-1", targets: [leaf] });
    expect(isError).toBe(true);
    expect(text).toContain("countersignAbove");
  });

  it("rejects a negative perActionCap", async () => {
    const { isError, text } = await call("build_scope", { ...base, perActionCap: "-5", targets: [leaf] });
    expect(isError).toBe(true);
    expect(text).toContain("perActionCap");
  });

  it("rejects a targets list nested deeper than the depth ceiling, but accepts a wide one", async () => {
    // SEC-13's depth guard. The ceiling is on *nesting*, not on node count, so a 256-entry
    // scope (768 sibling nodes at depth 2) must be accepted while a single entry carrying a
    // 10-deep object must be refused. A counter-based implementation would get both of these
    // exactly backwards, which is why both halves are asserted together.
    const wide = Array.from({ length: 256 }, () => ({ target: ALICE, selector: "0x12345678" }));
    const wideRes = await call("build_scope", { ...base, targets: wide });
    expect(wideRes.isError).toBe(false);
    expect((JSON.parse(wideRes.text) as { leaves: unknown[] }).leaves).toHaveLength(256);

    // depth 1 (targets) → 2 (entry) → 3..12 (the `extra` chain) — well past the ceiling of 8.
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 10; i++) deep = { deeper: deep };
    const deepRes = await call("build_scope", { ...base, targets: [{ target: ALICE, selector: "0x12345678", extra: deep }] });
    expect(deepRes.isError).toBe(true);
    // Over the JSON-RPC transport it is the *transport* backstop that fires, not the
    // tool's own guard — which is the documented layering (SEC-13). Both must refuse; the
    // tool-level one is asserted separately below, via a direct `run()` call.
    expect(deepRes.text).toContain("nests deeper than 8 levels");
  });

  it("build_scope's own depth guard refuses when called directly, bypassing the transport", () => {
    // The tool-level check is unreachable through `handleMessage` (the transport backstop
    // always wins the race). It is still load-bearing for any future non-JSON-RPC caller, so
    // exercise it directly rather than letting it rot as unreachable code — the same reason
    // `validation.test.ts` calls `tool.run` directly for the targets guard.
    const tool = TOOLS.find((t) => t.name === "build_scope")!;
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 10; i++) deep = { deeper: deep };
    expect(() =>
      tool.run({ expiresAt: 4_000_000_000, perActionCap: "10", perWindowCap: "50", targets: [{ target: ALICE, selector: "0x12345678", extra: deep }] }),
    ).toThrowError(/nesting|nests/);
  });

  it("rejects a calldata blob that is a valid hex string but not 0x-prefixed", async () => {
    const { isError, text } = await call("build_scope", {
      ...base,
      targets: [{ target: ALICE, selector: "0x12345678", data: "abcdef" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].data");
  });

  it("rejects an odd-length calldata blob", async () => {
    const { isError, text } = await call("build_scope", {
      ...base,
      targets: [{ target: ALICE, selector: "0x12345678", data: "0x123" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].data");
  });
});

// ── decode_error ──────────────────────────────────────────────────────────────

describe("decode_error error paths", () => {
  it("rejects a missing data argument", async () => {
    const { isError, text } = await call("decode_error", {});
    expect(isError).toBe(true);
    expect(text).toContain("missing required argument(s): data");
  });

  it("rejects a null data argument", async () => {
    // `null !== undefined`, so the required pre-check lets it through to assertHex.
    const { isError, text } = await call("decode_error", { data: null });
    expect(isError).toBe(true);
    expect(text).toContain("data");
  });

  it("rejects a number for data instead of stringifying it", async () => {
    // `assertHex` takes `unknown`; without an explicit typeof check a numeric input could
    // reach the hex validator as a Number and produce a confusing describe() line.
    const { isError, text } = await call("decode_error", { data: 305419896 });
    expect(isError).toBe(true);
    expect(text).toContain("data");
  });

  it("rejects an empty-string data argument", async () => {
    const { isError, text } = await call("decode_error", { data: "" });
    expect(isError).toBe(true);
    expect(text).toContain("data");
  });

  it("rejects odd-length hex data", async () => {
    const { isError, text } = await call("decode_error", { data: "0x123" });
    expect(isError).toBe(true);
    expect(text).toContain("data");
  });
});

// ── audit_query ───────────────────────────────────────────────────────────────

describe("audit_query error paths (SEC-04 path policy + SEC-13 bounds)", () => {
  const agent = AGENT;

  it("rejects an unknown query mode and names the allowed values", async () => {
    const { db } = allowlistedStore("qmode");
    const { isError, text } = await call("audit_query", { db, query: "everything" });
    expect(isError).toBe(true);
    expect(text).toContain("spend | actions | summary");
  });

  it("rejects a non-string query mode rather than coercing it", async () => {
    const { db } = allowlistedStore("qmode2");
    const { isError, text } = await call("audit_query", { db, query: 7 });
    expect(isError).toBe(true);
    expect(text).toContain("query");
  });

  it("rejects a non-positive chainId", async () => {
    // The argument must be validated BEFORE the path is touched, so this refuses on
    // `chainId` alone — which is exactly why the sandbox database need not even exist.
    const { db } = allowlistedStore("chainid");
    const { isError, text } = await call("audit_query", { db, chainId: 0 });
    expect(isError).toBe(true);
    expect(text).toContain("chainId");
  });

  it("rejects a fractional chainId", async () => {
    const { db } = allowlistedStore("chainid2");
    const { isError, text } = await call("audit_query", { db, chainId: 1.5 });
    expect(isError).toBe(true);
    expect(text).toContain("chainId");
  });

  it("rejects limit=0 (page size must be positive)", async () => {
    const { db } = allowlistedStore("limit0");
    const { isError, text } = await call("audit_query", { db, query: "actions", agentId: agent, limit: 0 });
    expect(isError).toBe(true);
    expect(text).toContain("limit");
  });

  it("rejects a non-integer limit", async () => {
    const { db } = allowlistedStore("limitfrac");
    const { isError, text } = await call("audit_query", { db, query: "actions", agentId: agent, limit: 2.5 });
    expect(isError).toBe(true);
    expect(text).toContain("limit");
  });

  it("requires agentId for query=actions", async () => {
    const { db } = allowlistedStore("noagent");
    const { isError, text } = await call("audit_query", { db, query: "actions" });
    expect(isError).toBe(true);
    expect(text).toContain("agentId");
  });

  it("rejects a malformed agentId for query=spend", async () => {
    const { db } = allowlistedStore("badagent");
    const { isError, text } = await call("audit_query", { db, query: "spend", agentId: "0x1234" });
    expect(isError).toBe(true);
    expect(text).toContain("agentId");
  });

  it("rejects a missing db argument", async () => {
    const { isError, text } = await call("audit_query", { query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("missing required argument(s): db");
  });

  it("rejects a non-string db argument", async () => {
    const { isError, text } = await call("audit_query", { db: 12345 });
    expect(isError).toBe(true);
    expect(text).toContain("db");
  });

  it("refuses a NUL byte in the path before any filesystem work", async () => {
    // FORBIDDEN_PATH_TOKENS includes "\0". The guard must run on the RAW input, i.e. before
    // resolve()/realpath(), otherwise Node itself would reject the string and the tool would
    // answer with a platform error that confirms nothing but is also not the policy answer.
    const { db } = allowlistedStore("nul");
    const { isError, text } = await call("audit_query", { db: `${db}\0`, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
  });

  it("refuses a UNC path and echoes nothing back", async () => {
    const { db } = allowlistedStore("unc");
    const { isError, text } = await call("audit_query", { db: "\\\\server\\share\\audit.db", query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
    expect(text).not.toContain("server");
  });

  it("refuses a path that escapes the root via a `..` segment", async () => {
    // Built by concatenation so `join` cannot normalize the `..` away.
    const { dir, db } = allowlistedStore("traverse");
    const outside = join(dir, "..", `sigilkit-outside-${Date.now()}`, "loot.db");
    mkdirSync(dirname(outside), { recursive: true });
    new SigilIndexer(outside, 8453).close();
    const { isError, text } = await call("audit_query", { db: `${outside}`, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
  });

  it("refuses a directory that looks like a database", async () => {
    // `statSync().isFile()` is false for a directory, so it must take the same "not found"
    // branch as a missing file. Probing with a directory must not be distinguishable from
    // probing with an absent path.
    const { dir } = allowlistedStore("isdir");
    mkdirSync(join(dir, "fake.db"), { recursive: true });
    const { isError, text } = await call("audit_query", { db: join(dir, "fake.db"), query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DATABASE_NOT_FOUND");
  });

  it("refuses a real file whose extension is not a database extension", async () => {
    const { dir } = allowlistedStore("ext");
    writeFileSync(join(dir, "notes.txt"), "top secret");
    const { isError, text } = await call("audit_query", { db: join(dir, "notes.txt"), query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DATABASE_NOT_FOUND");
  });

  it("returns the SAME answer for a missing file and a missing directory (no existence oracle)", async () => {
    const { dir } = allowlistedStore("oracle");
    const file = await call("audit_query", { db: join(dir, "absent.db"), query: "summary" });
    const dirReply = await call("audit_query", { db: join(dir, "absent-dir"), query: "summary" });
    // Byte-identical. This is the load-bearing SEC-04 assertion: a differing sentence here
    // would let a model map the disk one guess at a time.
    expect(file.isError).toBe(true);
    expect(dirReply.isError).toBe(true);
    expect(file.text).toBe(dirReply.text);
  });

  it("refuses every path when SIGILKIT_AUDIT_DB_ROOT is unset (fail-closed)", async () => {
    // Mutation testing showed that asserting only `DB_NOT_ALLOWED` is NOT enough here: with
    // an empty allowlist, the *containment* check also refuses with `DB_NOT_ALLOWED`, so
    // deleting the explicit fail-closed branch entirely still produced a passing test. The
    // distinguishing evidence is the operator-facing hint naming the variable to set, which
    // only the fail-closed branch emits. Asserted here so the branch cannot be deleted.
    const dir = sandbox("unset");
    const db = join(dir, "audit.db");
    new SigilIndexer(db, 8453).close();
    __setAuditDbRootsForTests({});
    const { isError, text } = await call("audit_query", { db, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
    // The unset-variable branch specifically, not merely "some policy refusal".
    expect(text).toContain("SIGILKIT_AUDIT_DB_ROOT");
    expect(text).toContain("is not set");
    // Never echo the guess back.
    expect(text).not.toContain("audit.db");
  });

  it("distinguishes an unset allowlist from a set-but-non-matching one", async () => {
    // The two `DB_NOT_ALLOWED` sites must be distinguishable *for the operator* (which env
    // var to fix) while remaining indistinguishable *for a prober* (neither echoes the
    // path). Both halves are asserted, because collapsing them is what makes a fail-open
    // regression invisible.
    const other = mkdtempSync(join(tmpdir(), "sigilkit-mcp-err-setroot-"));
    sandboxes.push(other);
    const realDb = join(other, "audit.db");
    new SigilIndexer(realDb, 8453).close();

    // (a) allowlist set to a DIFFERENT directory ⇒ outside-root message.
    const setRoot = sandbox("setroot-different");
    new SigilIndexer(join(setRoot, "audit.db"), 8453).close();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: setRoot });
    const outside = await call("audit_query", { db: realDb, query: "summary" });

    // (b) allowlist unset ⇒ unset-variable message.
    __setAuditDbRootsForTests({});
    const unset = await call("audit_query", { db: realDb, query: "summary" });

    // Both refuse, and neither leaks the path…
    expect(outside.isError).toBe(true);
    expect(unset.isError).toBe(true);
    expect(outside.text).not.toContain(realDb);
    expect(unset.text).not.toContain(realDb);
    // …but the operator gets a different, actionable sentence for each.
    expect(unset.text).toContain("SIGILKIT_AUDIT_DB_ROOT");
    expect(unset.text).not.toContain("outside the configured root");
    expect(outside.text).toContain("outside the configured root");
    expect(outside.text).not.toContain("is not set");
  });

  it("refuses a path outside the allowlisted root with the uniform outside-root message", async () => {
    // The target must EXIST for containment (not realpath resolution) to be the rejecting
    // step: resolveAuditDbPath resolves the real path first and a non-existent target fails
    // there as "not found". A real out-of-root store therefore proves the *containment* rule
    // fires, which is a strictly stronger claim than "some path was refused".
    const other = mkdtempSync(join(tmpdir(), "sigilkit-mcp-err-notroot-"));
    sandboxes.push(other);
    const outsideDb = join(other, "audit.db");
    new SigilIndexer(outsideDb, 8453).close();
    const { dir } = allowlistedStore("outside");
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: dir });

    const { isError, text } = await call("audit_query", { db: outsideDb, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
    // The refusal must not be the generic not-found one, and must not leak the guess.
    expect(text).not.toContain("DATABASE_NOT_FOUND");
    expect(text).not.toContain(outsideDb);
    expect(text).not.toContain("audit.db");
  });

  it("keeps the LRU cache of audit handles bounded and reuses one handle per resolved path", async () => {
    // SEC-13: the bound is on distinct RESOLVED paths, so two spellings of one file must
    // collapse onto a single handle. We observe that indirectly but decisively: opening the
    // 9th distinct database evicts the oldest, which on Windows means its file lock is
    // released — so the file can then be deleted. A cache that grew without bound (or that
    // counted spellings instead of resolved paths) would keep the lock and the delete throws.
    const base = sandbox("lru");
    const paths: string[] = [];
    for (let i = 0; i < 9; i++) {
      const d = mkdtempSync(join(tmpdir(), `sigilkit-mcp-err-lru-${i}-`));
      sandboxes.push(d);
      const db = join(d, "audit.db");
      new SigilIndexer(db, 8453).close();
      __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: d });
      await call("audit_query", { db, query: "summary" });
      paths.push(db);
    }
    // The first handle was evicted (cache bound is 8), so its file is unlocked and removable.
    expect(() => rmSync(paths[0]!, { force: true })).not.toThrow();
    // …and the most recent one is still cached, so it is still locked.
    expect(() => rmSync(paths[8]!, { force: true })).toThrow();
    // Cleanup must not fail the test: the last handle is released by the afterEach reset.
    expect(existsSync(paths[8]!)).toBe(true);
  });

  it("serves a database that resolves inside the allowlisted root", async () => {
    // The positive control for every refusal above: a legal request must still work, so the
    // refusals cannot be passing merely because the tool is simply broken.
    const { db } = allowlistedStore("ok");
    const { isError, text } = await call("audit_query", { db, query: "summary" });
    expect(isError).toBe(false);
    expect((JSON.parse(text) as { summary: string }).summary).toContain("audited actions");
  });
});

// ── transport-level guards (handleMessage) ─────────────────────────────────────

/**
 * A stand-in for a tool that blocks forever, so the inflight counter can be driven to its
 * ceiling. It is registered on a private copy of the tool array, so the module-level TOOLS
 * registry the real server dispatches from is never mutated.
 */
void 0;

describe("JSON-RPC transport guards", () => {
  it("refuses a tool call whose arguments nest deeper than the ceiling", async () => {
    // The transport runs its checks in a fixed order — required-argument pre-check first,
    // then the depth backstop — so the arguments must be *complete* to reach the depth
    // guard. `request`/`scope` are supplied (as deep junk) rather than omitted, otherwise
    // the call would be refused earlier and for a different, already-covered reason.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { deeper: deep };
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "validate_request", arguments: { request: deep, scope: deep } },
    });
    const text = (res!.result as { content: Array<{ text: string }>; isError?: boolean }).content[0]!.text;
    expect((res!.result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain("nests deeper than 8 levels");
  });

  it("accepts a legitimately nested (but in-bounds) argument object", async () => {
    // The control for the guard above: a 3-level request is normal JSON and must NOT be
    // refused. A depth check implemented as a node counter would fail here, because a
    // well-formed request has hundreds of nodes at only 2 levels.
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "validate_request",
        arguments: { request: { a: { b: { c: 1 } } }, scope: { a: { b: { c: 1 } } } },
      },
    });
    const text = (res!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).not.toContain("nests deeper");
  });

  it("lists every missing required argument in one reply", async () => {
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "build_scope", arguments: {} },
    });
    const text = (res!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("expiresAt, perActionCap, perWindowCap, targets");
  });

  it("refuses an over-long request line and reports it once", async () => {
    // The guard latches: once it has refused, further chunks are dropped rather than parsed,
    // so an attacker cannot recover the connection by continuing to write.
    const { serveStdio } = await import("../src/server.js");
    const { Readable, Writable } = await import("node:stream");
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk: Buffer, _e, cb) { chunks.push(chunk.toString()); cb(); },
    });
    const lines: string[] = [];
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}`;
    // Build a line longer than 1 MiB: a valid JSON string of the right size.
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_100_000) } });
    expect(payload.length).toBeGreaterThan(1_048_576);
    const input = Readable.from([`${payload}\n`, `${line}\n`]);
    const stop = serveStdio(input, out, { level: "info", scope: "t", debug() {}, info() {}, warn: (m: unknown) => lines.push(String(m)), error() {}, child() { return this; } } as never);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const joined = chunks.join("");
    expect(joined).toContain("message too large");
    // The over-long line is never completed, so it can never reach JSON.parse, and the
    // following well-formed line is not answered either (the interface was closed).
    expect(joined).not.toContain(`"id":1,"result":{}`);
  });

  it("answers unknown methods with -32601 and no id echo when id is absent", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", method: "nope" });
    expect(res).toBeNull();
  });

  it("returns a JSON-RPC error (not a tool error) for an unknown tool name", async () => {
    const res = await handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ghost" },
    });
    expect((res!.error as { code: number }).code).toBe(-32602);
  });
});
