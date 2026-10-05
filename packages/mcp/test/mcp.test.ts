/**
 * MCP server tests (E14): protocol-level (initialize/tools list/call) over the
 * handleMessage dispatcher, plus end-to-end over the stdio transport with a spawned
 * child process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { handleMessage, serveStdio, __setAuditDbRootsForTests } from "../src/server.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SigilIndexer } from "@sigilkit/indexer";

const HERE = dirname(fileURLToPath(import.meta.url));

async function callTool(name: string, args: Record<string, unknown>, id = 99) {
  const res = await handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const content = (res!.result as { content: Array<{ text: string }>; isError?: boolean }).content[0]!.text;
  return { text: content, isError: (res!.result as { isError?: boolean }).isError === true };
}

describe("sigilkit-mcp protocol (E14)", () => {
  it("initializes and lists the tool surface", async () => {
    const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((init!.result as Record<string, unknown>).serverInfo).toMatchObject({ name: "sigilkit-mcp" });

    const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (list!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(["validate_request", "build_scope", "decode_error", "audit_query"]);
  });

  it("validate_request accepts an in-scope request and rejects over-cap with the reason", async () => {
    const request = {
      agentId: "0x" + "11".repeat(32),
      target: "0x0000000000000000000000000000000000000001",
      selector: "0x32145f90",
      value: "0",
      nonce: "0",
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: "0x" + "22".repeat(32),
      data: "0x",
    };
    const scope = {
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      windowSeconds: 600,
      perActionCap: "1000000000000000000",
      perWindowCap: "2000000000000000000",
      countersignAbove: "0",
    };
    const ok = await handleMessage({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "validate_request", arguments: { request, scope } },
    });
    const okText = (ok!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(okText)).toEqual({ ok: true });

    const over = await handleMessage({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: {
        name: "validate_request",
        arguments: {
          request: { ...request, value: "2000000000000000000" },
          scope,
        },
      },
    });
    const overText = (over!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(overText)).toMatchObject({ ok: false });
    expect(JSON.parse(overText).reason).toContain("per-action cap exceeded");
  });

  it("build_scope computes the v2 whitelist root over the target list", async () => {
    const res = await handleMessage({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: {
        name: "build_scope",
        arguments: {
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          perActionCap: "1000000000000000000",
          perWindowCap: "5000000000000000000",
          targets: [{ target: "0x0000000000000000000000000000000000009001", selector: "0x32145f90" }],
        },
      },
    });
    const out = JSON.parse((res!.result as { content: Array<{ text: string }> }).content[0]!.text);
    // Single-leaf tree: root == leaf; nonzero (whitelist regime).
    expect(out.scope.merkleRoot).toBe(out.leaves[0]);
    expect(out.scope.merkleRoot).not.toBe("0x" + "0".repeat(64));
  });

  it("decode_error returns the named error with args", async () => {
    const data =
      keccak256(toHex("PerActionCapExceeded(uint256,uint256)")).slice(0, 10) +
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1200n, 500n]).slice(2);
    const res = await handleMessage({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "decode_error", arguments: { data } },
    });
    const out = JSON.parse((res!.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(out.name).toBe("PerActionCapExceeded");
    expect(out.args).toEqual(["1200", "500"]); // JSON.stringify renders bigints as strings
  });

  it("serves tools/call end-to-end over stdio", async () => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [join(HERE, "..", "dist", "cli.js")],
      { stdio: "pipe" },
    );

    // B8: the child is spawned against `dist/`, which is exactly what a broken workspace
    // junction makes unresolvable — so here the failure path is the COMMON path, not an edge
    // case. With no explicit settle, that path never resolves the promise at all: the only
    // thing that ended it was vitest's 5s testTimeout, so an unresolvable dist cost 5,021ms of
    // pure waiting — 79% of this file's 6.3s wall clock, for a test whose success path is
    // sub-second. Worse, a hang-until-timeout hides the cause: the timeout message says
    // nothing about the `ERR_MODULE_NOT_FOUND` that actually produced it.
    //
    // So settle on whichever comes first — a reply, the child dying, or a deadline — and
    // always wait for `close` so the process is reaped before the assertions run. Killing
    // without awaiting `close` races the assertions and can leave a live handle behind.
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "stdio child did not answer within 4000ms — is dist/ built and are workspace deps resolvable?",
          ),
        );
      }, 4_000);
      // unref so a forgotten timer can never hold the process open; the rejection is what
      // actually ends the test, this only stops a stray handle from outliving it.
      timer.unref?.();

      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
        fn();
      };
      function onData(chunk: Buffer): void {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch (err) {
            settle(() => child.kill());
            reject(new Error(`child emitted unparseable JSON: ${err instanceof Error ? err.message : String(err)}`));
            return;
          }
          // Reap first, then resolve: `close` is what guarantees no handle outlives the test.
          settle(() => child.kill());
          child.once("close", () => resolve(parsed));
          return;
        }
      }
      function onError(err: Error): void {
        settle(() => {});
        reject(new Error(`stdio child failed to start: ${err.message}`));
      }
      function onClose(code: number | null): void {
        settle(() => {});
        reject(new Error(`stdio child exited (code ${code}) before answering`));
      }

      child.stdout.on("data", onData);
      child.on("error", onError);
      child.on("close", onClose);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    });

    void serveStdio; // transport exercised via the spawned process above
    expect(response.result).toEqual({});
    expect(response.id).toBe(1);
  });

  it("audit_query is strictly read-only: no file creation, no DDL (BUG-9)", async () => {
    const missing = join(tmpdir(), `sigilkit-mcp-missing-${process.pid}-${Date.now()}.db`);
    const noDdl = join(tmpdir(), `sigilkit-mcp-noddl-${process.pid}-${Date.now()}.db`);
    // SEC-04: tmpdir must be an allowlisted root for these paths to be reachable at all.
    // The "database not found" contract is now DB_NOT_FOUND_MESSAGE (which contains
    // "no audit database at that path"), so assert the code rather than the old prose.
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: tmpdir() });

    try {
      // A path that does not exist must NOT be created — not even the directory.
      const absent = await callTool("audit_query", { db: missing, query: "summary" });
      expect(absent.text).toContain("DATABASE_NOT_FOUND");
      expect(existsSync(missing)).toBe(false);

      // A valid-but-foreign database must not gain the SigilKit schema. Previously the
      // SigilIndexer constructor ran CREATE TABLE/CREATE INDEX unconditionally.
      const raw = new DatabaseSync(noDdl);
      raw.exec("CREATE TABLE unrelated (x INTEGER)");
      raw.close();

      const foreign = await callTool("audit_query", { db: noDdl, query: "summary" });
      expect(foreign.isError).toBe(true);
      // SEC-04: "no such table: actions" would confirm the guessed path IS a database, so
      // it is masked; the no-DDL guarantee is now checked directly on the file below.
      expect(foreign.text).toContain("DATABASE_NOT_FOUND");
      expect(foreign.text).not.toMatch(/no such table/);

      const check = new DatabaseSync(noDdl);
      const tables = (
        check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
      ).map((t) => t.name);
      check.close();
      expect(tables).toEqual(["unrelated"]); // schema untouched
    } finally {
      __setAuditDbRootsForTests({});
      rmSync(missing, { force: true });
      rmSync(noDdl, { force: true });
    }
  });

  it("audit_query reads an existing indexer database and reports chains", async () => {
    const path = join(tmpdir(), `sigilkit-mcp-db-${process.pid}-${Date.now()}.db`);
    const ix = new SigilIndexer(path, 8453);
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: tmpdir() });
    ix.storeAction({
      agentId: ("0x" + "11".repeat(32)) as `0x${string}`,
      target: "0x0000000000000000000000000000000000009001",
      selector: "0x32145f90",
      value: 10n ** 16n,
      rationaleHash: ("0x" + "33".repeat(32)) as `0x${string}`,
      timestamp: 1_700_000_000,
      txHash: ("0x" + "a1".repeat(32)) as `0x${string}`,
      blockNumber: 1n,
      logIndex: 0,
    });
    ix.close();
    try {
      const res = await callTool("audit_query", { db: path, query: "summary" });
      const out = JSON.parse(res.text);
      expect(out.summary).toContain("1 audited actions");
      expect(out.chains).toEqual([8453]);

      const spend = await callTool("audit_query", {
        db: path,
        query: "spend",
        agentId: "0x" + "11".repeat(32),
        chainId: 8453,
      });
      expect(JSON.parse(spend.text).totalWei).toBe((10n ** 16n).toString());
    } finally {
      __setAuditDbRootsForTests({});
      rmSync(path, { force: true });
    }
  });
});

/**
 * SEC-04 — the `audit_query` database allowlist.
 *
 * The tool used to accept any path and hand it to SQLite. Together with a differentiated
 * "database not found: <path>" reply, that made it a filesystem existence oracle: an agent
 * could probe candidate paths and learn which files exist and which are SQLite stores, one
 * guess at a time. These tests pin the closed-world contract:
 *   - unset allowlist  ⇒ every path refused (fail-closed, never "open anything");
 *   - set allowlist    ⇒ only real paths under a configured root, with a database extension;
 *   - every rejection  ⇒ one of two uniform codes that never echo the path.
 */
describe("audit_query database allowlist (SEC-04)", () => {
  // One sandbox per test: a root dir containing a real indexer database, plus a sibling
  // dir outside the root so escape attempts have somewhere to land.
  const dirs: string[] = [];
  const withRoot = (): string => {
    const base = join(tmpdir(), `sigilkit-sec04-${process.pid}-${Date.now()}-${dirs.length}`);
    const root = join(base, "allowed");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const ix = new SigilIndexer(join(root, "audit.db"), 8453);
    ix.close();
    dirs.push(base);
    return root;
  };
  /** The `outside` sibling of the sandbox most recently created by `withRoot`. */
  const OUTSIDE_DIR = () => join(dirs[dirs.length - 1]!, "outside");

  afterEach(() => {
    __setAuditDbRootsForTests({});
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses every db path when SIGILKIT_AUDIT_DB_ROOT is unset (fail-closed)", async () => {
    // A real, perfectly good database — but no allowlist, so it is unreachable.
    const base = join(tmpdir(), `sigilkit-sec04-unset-${process.pid}-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const db = join(base, "audit.db");
    new SigilIndexer(db, 8453).close();
    try {
      __setAuditDbRootsForTests({});
      const res = await callTool("audit_query", { db, query: "summary" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("DB_NOT_ALLOWED");
      expect(res.text).toContain("SIGILKIT_AUDIT_DB_ROOT");
      // The rejection must not confirm anything about the file.
      expect(res.text).not.toContain(db);
      expect(res.text).not.toContain("audit.db");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("serves a database that resolves inside a configured root", async () => {
    const root = withRoot();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    const res = await callTool("audit_query", { db: join(root, "audit.db"), query: "summary" });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text).summary).toContain("0 audited actions");
  });

  it("refuses `..` traversal out of the root, and refuses a sibling directory", async () => {
    const root = withRoot();
    const outside = OUTSIDE_DIR();
    // Place a real database outside the allowlisted root so only the path rule can reject it.
    new SigilIndexer(join(outside, "loot.db"), 8453).close();

    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });

    // `..` escape: resolves to a real, existing database that is NOT under the root.
    const escape = await callTool("audit_query", { db: join(root, "..", "outside", "loot.db"), query: "summary" });
    expect(escape.isError).toBe(true);
    expect(escape.text).toContain("DB_NOT_ALLOWED");

    // Absolute path elsewhere on the disk.
    const absolute = await callTool("audit_query", { db: join(outside, "loot.db"), query: "summary" });
    expect(absolute.isError).toBe(true);
    expect(absolute.text).toContain("DB_NOT_ALLOWED");

    // `..` back into the root is fine — the rule is containment, not the `..` character.
    const backIn = await callTool("audit_query", { db: join(root, "..", "allowed", "audit.db"), query: "summary" });
    expect(backIn.isError).toBe(false);
    expect(JSON.parse(backIn.text).summary).toBeDefined();
  });

  it("refuses a UNC path and a device/pipe path", async () => {
    const root = withRoot();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    // `\\` and `//` are rejected on the raw input, before any resolution.
    for (const bad of ["\\\\server\\share\\audit.db", "//server/share/audit.db", "\\\\?\\C:\\x.db", "\\\\.\\pipe\\x.db"]) {
      const res = await callTool("audit_query", { db: bad, query: "summary" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("DB_NOT_ALLOWED");
      expect(res.text).not.toContain(bad);
    }
  });

  it("refuses a path whose extension is not a database extension", async () => {
    const root = withRoot();
    // A real file, inside the root, but not named like a database.
    writeFileSync(join(root, "notes.txt"), "top secret");
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    const res = await callTool("audit_query", { db: join(root, "notes.txt"), query: "summary" });
    expect(res.isError).toBe(true);
    // Reported as "not found", not as a bad extension, so the reply does not confirm the
    // file exists even though it does.
    expect(res.text).toContain("DATABASE_NOT_FOUND");
    expect(res.text).not.toContain(".txt");
  });

  it("returns the same error for a missing file and a missing directory (no oracle)", async () => {
    const root = withRoot();
    __setAuditDbRootsForTests({ SIGILKIT_AUDIT_DB_ROOT: root });
    const missingFile = join(root, "nope.db");
    const missingDir = join(root, "nope-dir");

    const file = await callTool("audit_query", { db: missingFile, query: "summary" });
    const dir = await callTool("audit_query", { db: missingDir, query: "summary" });
    // Byte-identical replies: an agent cannot tell a missing file from a missing directory,
    // or either from "exists but is not a database".
    expect(file.text).toBe(dir.text);
    expect(file.text).toContain("DATABASE_NOT_FOUND");
    expect(file.isError).toBe(true);
  });
});

