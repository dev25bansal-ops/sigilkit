/**
 * Tool-level validation for the MCP surface.
 *
 * The JSON-RPC layer only checks that `required` fields are present; everything else
 * (shapes, ranges, hex lengths) is validated inside the tools. These tests pin the
 * error messages an agent will actually see, so a bad argument produces an actionable
 * sentence rather than a raw TypeError from deep inside a helper.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SigilIndexer } from "@sigilkit/indexer";
import { handleMessage, TOOLS, __setAuditDbRootsForTests } from "../src/server.js";

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

/** Calls a tool and returns the parsed text payload. */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = (await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  const content = res.result?.content ?? [];
  return { isError: res.result?.isError === true, text: content.map((c) => c.text).join("\n") };
}

const tempDirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "sigilkit-mcp-"));
  tempDirs.push(dir);
  const db = join(dir, "audit.db");
  const ix = new SigilIndexer(db, 8453);
  ix.close();
  return db;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("protocol basics", () => {
  it("advertises all four tools", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    expect(res.result.tools.map((t) => t.name).sort()).toEqual([
      "audit_query",
      "build_scope",
      "decode_error",
      "validate_request",
    ]);
    for (const t of res.result.tools) expect(t.inputSchema).toBeDefined();
  });

  it("reports the package version in initialize", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(res.result.serverInfo.name).toBe("sigilkit-mcp");
    expect(res.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects an unknown method with -32601", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "nope" })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it("rejects an unknown tool", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ghost" } })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32602);
  });

  it("reports missing required arguments before dispatch", async () => {
    const { isError, text } = await callTool("decode_error", {});
    expect(isError).toBe(true);
    expect(text).toContain("missing required argument(s): data");
  });
});

describe("validate_request validation", () => {
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

  it("accepts a well-formed request", async () => {
    const { isError, text } = await callTool("validate_request", { request, scope });
    expect(isError).toBe(false);
    expect(JSON.parse(text).ok).toBe(true);
  });

  it("names the offending scope field for a non-numeric cap", async () => {
    const { isError, text } = await callTool("validate_request", { request, scope: { ...scope, perActionCap: "ten" } });
    expect(isError).toBe(true);
    expect(text).toContain("scope.perActionCap");
  });

  it("rejects a non-object scope", async () => {
    const { isError, text } = await callTool("validate_request", { request, scope: "everything" });
    expect(isError).toBe(true);
    expect(text).toContain("scope: expected an object");
  });

  it("validates watchlist entries positionally", async () => {
    const { isError, text } = await callTool("validate_request", {
      request,
      scope: { ...scope, tokenWatchlist: [ALICE, "nope"] },
    });
    expect(isError).toBe(true);
    expect(text).toContain("scope.tokenWatchlist[1]");
  });

  it("rejects a non-object windowState", async () => {
    const { isError, text } = await callTool("validate_request", { request, scope, windowState: 5 });
    expect(isError).toBe(true);
    expect(text).toContain("windowState");
  });
});

describe("build_scope validation", () => {
  const base = { expiresAt: 4_000_000_000, perActionCap: "10", perWindowCap: "50" };
  const zeroRoot = "0x" + "0".repeat(64);

  // SEC-03: omitting `targets` used to yield the allow-all root 0, so an agent that
  // simply forgot the whitelist got a grant covering every target. That is now an
  // error, and allow-all requires the explicit opt-in below.
  it("rejects a missing targets list instead of building an allow-all root", async () => {
    const { isError, text } = await callTool("build_scope", base);
    expect(isError).toBe(true);
    // `targets` is a declared required argument, so the JSON-RPC layer refuses the
    // call before the tool body runs. Defence in depth: even a direct call must fail.
    expect(text).toContain("targets");
  });

  it("guards an absent targets list inside the tool itself", () => {
    // Bypasses the protocol layer to prove the tool's own ValidationError guard is
    // not dead code: the empty-list branch must not depend on the required check.
    // Either way the call is refused — nothing here can return the allow-all root.
    const tool = TOOLS.find((t) => t.name === "build_scope")!;
    expect(() => tool.run({ ...base })).toThrowError(/targets: expected an array/);
    expect(() => tool.run({ ...base, targets: [] })).toThrowError(/at least one target is required/);
  });

  it("rejects an empty targets array", async () => {
    const { isError, text } = await callTool("build_scope", { ...base, targets: [] });
    expect(isError).toBe(true);
    expect(text).toContain("at least one target is required");
  });

  it("builds the allow-all root only when allowAllTargets is explicitly set", async () => {
    const { isError, text } = await callTool("build_scope", { ...base, targets: [], allowAllTargets: true });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { scope: { merkleRoot: string }; leaves: string[]; leafKinds: string[] };
    expect(parsed.scope.merkleRoot).toBe(zeroRoot);
    expect(parsed.leaves).toEqual([]);
    expect(parsed.leafKinds).toEqual([]);
  });

  it("builds leaves for valid targets", async () => {
    const { isError, text } = await callTool("build_scope", {
      ...base,
      targets: [{ target: ALICE, selector: "0x12345678" }],
    });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { scope: { merkleRoot: string }; leaves: string[] };
    expect(parsed.leaves).toHaveLength(1);
    expect(parsed.scope.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a malformed target address", async () => {
    const { isError, text } = await callTool("build_scope", { ...base, targets: [{ target: "0x1", selector: "0x12345678" }] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].target");
  });

  // The scope the tool assembles must be one the CHAIN accepts. SessionKeyManager.sol
  // reverts InvalidScope on perActionCap == 0 and perWindowCap < perActionCap, and core's
  // encode7579InstallData throws on the same two — a scope assembled here that dies at
  // grant time wastes the agent's effort and hides the cause. These pin the mirror.
  it("rejects a zero perActionCap, which the chain would refuse at grant time", async () => {
    const { isError, text } = await callTool("build_scope", {
      ...base, perActionCap: "0", perWindowCap: "50",
      targets: [{ target: ALICE, selector: "0x12345678" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("perActionCap");
  });

  it("rejects perWindowCap below perActionCap — unexecutable on-chain", async () => {
    const { isError, text } = await callTool("build_scope", {
      ...base, perActionCap: "50", perWindowCap: "10",
      targets: [{ target: ALICE, selector: "0x12345678" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("perWindowCap");
  });

  it('rejects enforceNativeDelta given as the JSON STRING "false"', async () => {
    // The tool previously built this field with a bare Boolean(), which reads the
    // string "false" as TRUE — silently turning balance-delta enforcement ON where the
    // caller asked for it off, and diverging from validate_request's typed refusal.
    // Now both paths use coerceBoolean: a non-boolean is an error, never a guess.
    const { isError, text } = await callTool("build_scope", {
      ...base, enforceNativeDelta: "false",
      targets: [{ target: ALICE, selector: "0x12345678" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("enforceNativeDelta");
  });

  it("still accepts enforceNativeDelta as a real boolean", async () => {
    const { isError } = await callTool("build_scope", {
      ...base, enforceNativeDelta: true,
      targets: [{ target: ALICE, selector: "0x12345678" }],
    });
    expect(isError).toBe(false);
  });

  it("requires a 4-byte selector", async () => {
    const { isError, text } = await callTool("build_scope", { ...base, targets: [{ target: ALICE, selector: "0x12" }] });
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].selector");
  });

  it("rejects a non-array targets value", async () => {
    const { isError, text } = await callTool("build_scope", { ...base, targets: "all" });
    expect(isError).toBe(true);
    expect(text).toContain("targets: expected an array");
  });

  it("rejects a missing expiresAt", async () => {
    const { isError, text } = await callTool("build_scope", { perActionCap: "1", perWindowCap: "1", targets: [{ target: ALICE, selector: "0x12345678" }] });
    expect(isError).toBe(true);
    expect(text).toContain("expiresAt");
  });
});

/**
 * SEC-03: `targetLeaf`'s third argument (the calldata to bind) was structurally
 * unreachable from build_scope, so pinned/argument-bound leaves could not be built
 * at all and every grant was wildcard (any calldata for the selector). These tests
 * pin the reachable path: `data` ⇒ pinned leaf ⇒ a root that actually commits to
 * the arguments.
 */
describe("build_scope pinned leaves", () => {
  const base = { expiresAt: 4_000_000_000, perActionCap: "10", perWindowCap: "50" };
  // transfer(address,uint256) with a 32-byte recipient and a 32-byte amount.
  const TRANSFER_SELECTOR = "0xa9059cbb";
  const DATA_A = "0x" + "11".repeat(64);
  const DATA_B = "0x" + "22".repeat(64);

  const scopeWith = (data?: string) => ({
    ...base,
    targets: [{ target: ALICE, selector: TRANSFER_SELECTOR, ...(data === undefined ? {} : { data }) }],
  });

  it("binds the leaf to the supplied calldata and reports leafKind=pinned", async () => {
    const { isError, text } = await callTool("build_scope", scopeWith(DATA_A));
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { scope: { merkleRoot: string }; leaves: string[]; leafKinds: string[] };
    expect(parsed.leafKinds).toEqual(["pinned"]);
    expect(parsed.leaves).toHaveLength(1);
    // Single-leaf tree: root == leaf, and it must be a real (nonzero) commitment.
    expect(parsed.scope.merkleRoot).toBe(parsed.leaves[0]);
    expect(parsed.scope.merkleRoot).not.toBe("0x" + "0".repeat(64));
  });

  it("produces a different leaf and root for different calldata", async () => {
    const a = JSON.parse((await callTool("build_scope", scopeWith(DATA_A))).text) as { scope: { merkleRoot: string }; leaves: string[] };
    const b = JSON.parse((await callTool("build_scope", scopeWith(DATA_B))).text) as { scope: { merkleRoot: string }; leaves: string[] };
    expect(a.leaves[0]).not.toBe(b.leaves[0]);
    expect(a.scope.merkleRoot).not.toBe(b.scope.merkleRoot);
  });

  it("does not collapse distinct calldata into one leaf inside a multi-target scope", async () => {
    // Same (target, selector) twice with different data: the root must commit to both.
    const { isError, text } = await callTool("build_scope", {
      ...base,
      targets: [
        { target: ALICE, selector: TRANSFER_SELECTOR, data: DATA_A },
        { target: ALICE, selector: TRANSFER_SELECTOR, data: DATA_B },
      ],
    });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { scope: { merkleRoot: string }; leaves: string[]; leafKinds: string[] };
    expect(parsed.leafKinds).toEqual(["pinned", "pinned"]);
    expect(new Set(parsed.leaves).size).toBe(2);
  });

  it("differs from the wildcard leaf for the same (target, selector)", async () => {
    const wildcard = JSON.parse((await callTool("build_scope", scopeWith())).text) as { leaves: string[]; leafKinds: string[] };
    const pinned = JSON.parse((await callTool("build_scope", scopeWith(DATA_A))).text) as { leaves: string[] };
    expect(wildcard.leafKinds).toEqual(["wildcard"]);
    expect(pinned.leaves[0]).not.toBe(wildcard.leaves[0]);
  });

  it("rejects non-hex calldata", async () => {
    const { isError, text } = await callTool("build_scope", scopeWith("not hex"));
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].data");
  });

  it("rejects odd-length calldata", async () => {
    const { isError, text } = await callTool("build_scope", scopeWith("0x123"));
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].data");
  });

  it("rejects calldata above the 4096-byte cap", async () => {
    const { isError, text } = await callTool("build_scope", scopeWith("0x" + "ab".repeat(4097)));
    expect(isError).toBe(true);
    expect(text).toContain("targets[0].data");
    expect(text).toContain("4096");
  });

  it("accepts calldata at exactly the 4096-byte cap", async () => {
    const { isError, text } = await callTool("build_scope", scopeWith("0x" + "ab".repeat(4096)));
    expect(isError).toBe(false);
    expect(JSON.parse(text).leafKinds).toEqual(["pinned"]);
  });

  it("rejects a targets array longer than 256 entries", async () => {
    const targets = Array.from({ length: 257 }, () => ({ target: ALICE, selector: TRANSFER_SELECTOR }));
    const { isError, text } = await callTool("build_scope", { ...base, targets });
    expect(isError).toBe(true);
    expect(text).toContain("at most 256");
  });

  it("accepts exactly 256 targets", async () => {
    const targets = Array.from({ length: 256 }, () => ({ target: ALICE, selector: TRANSFER_SELECTOR }));
    const { isError, text } = await callTool("build_scope", { ...base, targets });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { leaves: string[]; leafKinds: string[] };
    expect(parsed.leaves).toHaveLength(256);
    expect(parsed.leafKinds).toHaveLength(256);
  });

  it("reports the correct leafKind per entry in a mixed scope", async () => {
    const { isError, text } = await callTool("build_scope", {
      ...base,
      targets: [
        { target: ALICE, selector: TRANSFER_SELECTOR, data: DATA_A },
        { target: ALICE, selector: "0xdeadbeef" },
      ],
    });
    expect(isError).toBe(false);
    expect(JSON.parse(text).leafKinds).toEqual(["pinned", "wildcard"]);
  });

  it("treats empty calldata (0x) as pinned, not wildcard", async () => {
    // 0x hashes to a non-zero keccak digest, so this must be a pinned leaf; conflating
    // it with the wildcard sentinel would silently widen a grant.
    const { isError, text } = await callTool("build_scope", scopeWith("0x"));
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { leaves: string[]; leafKinds: string[] };
    expect(parsed.leafKinds).toEqual(["pinned"]);
    expect(parsed.leaves[0]).not.toBe(JSON.parse((await callTool("build_scope", scopeWith())).text).leaves[0]);
  });
});

describe("decode_error validation", () => {
  it("decodes a known selector", async () => {
    const { isError, text } = await callTool("decode_error", { data: "0x12345678" });
    expect(isError).toBe(false);
    expect(JSON.parse(text).name).toBeDefined();
  });

  it("rejects non-hex input", async () => {
    const { isError, text } = await callTool("decode_error", { data: "not hex" });
    expect(isError).toBe(true);
    expect(text).toContain("data");
  });
});

/**
 * SEC-04: `audit_query` no longer accepts an arbitrary `db` path. The path must resolve
 * inside a root the operator allowlisted in `SIGILKIT_AUDIT_DB_ROOT`, and when that variable
 * is unset the tool refuses EVERY path (fail-closed). The rejections are deliberately uniform
 * and never echo the path, so the tool is not a filesystem existence oracle.
 *
 * The allowlist is latched at module load in production, so these tests drive it through the
 * `__setAuditDbRootsForTests` hook. Every test that installs a root installs its OWN sandbox
 * directory (never the shared tmpdir), and `afterEach` resets the allowlist to "unset" — which
 * is the fail-closed default, so a leak can only ever make a later test stricter, never looser.
 */
describe("audit_query validation", () => {
  /** Sandbox dirs, cleaned up after each test along with the allowlist reset. */
  const sandboxes: string[] = [];

  /** Allowlists nothing, which is the fail-closed production default. */
  const clearAllowlist = (): void => __setAuditDbRootsForTests({});

  /**
   * Creates a sandbox with an allowlisted `allowed/` root (holding a real indexer database)
   * plus a sibling `outside/` dir that is deliberately NOT allowlisted, so a rejection can
   * only be caused by the path rule and not by the file being absent. Installs the allowlist.
   */
  function sandboxWithRoot(): { root: string; outside: string; db: string } {
    const base = join(tmpdir(), `sigilkit-mcp-val-${process.pid}-${Date.now()}-${sandboxes.length}`);
    const root = join(base, "allowed");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    sandboxes.push(base);
    const db = join(root, "audit.db");
    new SigilIndexer(db, 8453).close();
    // A real, existing database outside the allowlist: every rejection below is then
    // attributable to policy rather than to a missing file.
    new SigilIndexer(join(outside, "loot.db"), 8453).close();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    return { root, outside, db };
  }

  /**
   * A fresh empty store with its own directory allowlisted, for the argument-validation cases
   * that must fail for their *argument* and nothing else. Without this they would pass only
   * because `query`/`agentId`/`chainId` are checked before the path is touched — a real
   * dependency on that ordering, and one worth making explicit rather than incidental.
   */
  function tempDbAllowed(): string {
    const db = tempDb();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: dirname(db) });
    return db;
  }

  afterEach(() => {
    // Reset first: never leave a stale allowlist pointing at a directory we are about to
    // delete. With `isolate: false` these tests share a worker with the other files, and
    // AUDIT_DB_ROOTS is module-global state.
    clearAllowlist();
    while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
  });

  it("rejects an unknown query mode", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDbAllowed(), query: "everything" });
    expect(isError).toBe(true);
    expect(text).toContain("spend | actions | summary");
  });

  it("reports a missing database instead of creating one", async () => {
    // Inside the allowlist, but nothing is there: DATABASE_NOT_FOUND, and no file is made.
    const { root } = sandboxWithRoot();
    const absent = join(root, "sigilkit-definitely-absent.db");

    const { isError, text } = await callTool("audit_query", { db: absent, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DATABASE_NOT_FOUND");
    // The rejection is uniform, so it must not confirm or deny the path.
    expect(text).not.toContain(absent);
    // Still strictly read-only: a refused path must not be created as a side effect.
    expect(existsSync(absent)).toBe(false);
  });

  it("returns the same error for a missing file and a missing directory", async () => {
    // The core SEC-04 guard: "no such file" vs "no such directory" must be byte-identical,
    // otherwise the pair is a probe that tells an agent which guessed paths exist. Pin the
    // whole message, not just the code, so a future rewording of one site cannot drift.
    const { root } = sandboxWithRoot();
    const missingFile = await callTool("audit_query", { db: join(root, "absent.db"), query: "summary" });
    const missingDir = await callTool("audit_query", { db: join(root, "absent-dir"), query: "summary" });

    expect(missingFile.isError).toBe(true);
    expect(missingDir.isError).toBe(true);
    expect(missingFile.text).toContain("DATABASE_NOT_FOUND");
    expect(missingDir.text).toContain("DATABASE_NOT_FOUND");
    expect(missingFile.text).toBe(missingDir.text);
  });

  it("refuses a real database outside the allowlisted root (DB_NOT_ALLOWED)", async () => {
    // The file exists and is a perfectly good audit store — only policy rejects it.
    const { outside } = sandboxWithRoot();
    const db = join(outside, "loot.db");

    const { isError, text } = await callTool("audit_query", { db, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
    expect(text).not.toContain("DATABASE_NOT_FOUND");
    // Never echo the guess back, or the refusal becomes a way to test path validity.
    expect(text).not.toContain(db);
    expect(text).not.toContain("loot.db");
  });

  it("refuses every path when no root is allowlisted (fail-closed default)", async () => {
    // A real, valid database that the old contract would have served happily. With the
    // variable unset the tool must be inert: refusing is the only safe default, because
    // silently falling back to "any path goes" would restore the existence oracle.
    const db = tempDb();
    clearAllowlist();

    const { isError, text } = await callTool("audit_query", { db, query: "summary" });
    expect(isError).toBe(true);
    expect(text).toContain("DB_NOT_ALLOWED");
    // The operator needs to be told how to fix it, so the variable name is echoed...
    expect(text).toContain("SIGILKIT_AUDIT_DB_ROOT");
    // ...but nothing about the path that was refused.
    expect(text).not.toContain(db);
    expect(text).not.toContain("audit.db");
  });

  it("refuses a `..` escape that lands outside the allowlisted root", async () => {
    const { root, outside, db } = sandboxWithRoot();

    // Built by concatenation, not `join`: `join` would normalize the `..` away and the test
    // would degenerate into the plain absolute-path case. The escape target is a real,
    // existing, valid database, so again only the path rule can reject it.
    const escape = `${root}/../outside/loot.db`;
    expect(escape).toContain("..");

    const escaped = await callTool("audit_query", { db: escape, query: "summary" });
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toContain("DB_NOT_ALLOWED");
    expect(escaped.text).not.toContain("DATABASE_NOT_FOUND");
    expect(escaped.text).not.toContain("loot.db");
    // The same path spelled absolutely must be refused identically — the rule is
    // containment of the RESOLVED path, not a textual ban on the `..` character.
    const absolute = await callTool("audit_query", { db: join(outside, "loot.db"), query: "summary" });
    expect(absolute.text).toBe(escaped.text);

    // And a `..` that stays inside the root is legitimate: it resolves back into `allowed`.
    const backIn = await callTool("audit_query", { db: `${root}/../allowed/audit.db`, query: "summary" });
    expect(backIn.isError).toBe(false);
    expect(JSON.parse(backIn.text).summary).toBeDefined();
    expect(db).toBe(join(root, "audit.db"));
  });

  it("requires a 32-byte agent id for spend", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDbAllowed(), query: "spend", agentId: "0x1234" });
    expect(isError).toBe(true);
    expect(text).toContain("agentId");
  });

  it("returns a summary for an empty store", async () => {
    // SEC-04: the happy path now needs the allowlist, or the tool is inert by design.
    const { db } = sandboxWithRoot();

    const { isError, text } = await callTool("audit_query", { db });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { summary: string; chains: number[] };
    expect(parsed.summary).toContain("audited actions");
    expect(parsed.chains).toEqual([]);
  });

  it("aggregates spend across chains when chainId is omitted", async () => {
    const { db } = sandboxWithRoot();
    const agentId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const { isError, text } = await callTool("audit_query", { db, query: "spend", agentId });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { totalWei: string; chainId: number | null };
    expect(parsed.totalWei).toBe("0");
    expect(parsed.chainId).toBeNull();
  });

  it("rejects a non-positive chainId", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDbAllowed(), chainId: 0 });
    expect(isError).toBe(true);
    expect(text).toContain("chainId");
  });
});

describe("tool registry", () => {
  it("every tool declares a JSON-schema object input", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
