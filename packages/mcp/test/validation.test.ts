/**
 * Tool-level validation for the MCP surface.
 *
 * The JSON-RPC layer only checks that `required` fields are present; everything else
 * (shapes, ranges, hex lengths) is validated inside the tools. These tests pin the
 * error messages an agent will actually see, so a bad argument produces an actionable
 * sentence rather than a raw TypeError from deep inside a helper.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigilIndexer } from "@sigilkit/indexer";
import { handleMessage, TOOLS } from "../src/server.js";

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

  it("builds an allow-all root when no targets are given", async () => {
    const { isError, text } = await callTool("build_scope", base);
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { scope: { merkleRoot: string }; leaves: string[] };
    expect(parsed.scope.merkleRoot).toBe("0x" + "0".repeat(64));
    expect(parsed.leaves).toEqual([]);
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
    const { isError, text } = await callTool("build_scope", { perActionCap: "1", perWindowCap: "1" });
    expect(isError).toBe(true);
    expect(text).toContain("expiresAt");
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

describe("audit_query validation", () => {
  it("rejects an unknown query mode", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDb(), query: "everything" });
    expect(isError).toBe(true);
    expect(text).toContain("spend | actions | summary");
  });

  it("reports a missing database instead of creating one", async () => {
    const { isError, text } = await callTool("audit_query", { db: join(tmpdir(), "sigilkit-definitely-absent.db") });
    expect(isError).toBe(false);
    expect(text).toContain("database not found");
  });

  it("requires a 32-byte agent id for spend", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDb(), query: "spend", agentId: "0x1234" });
    expect(isError).toBe(true);
    expect(text).toContain("agentId");
  });

  it("returns a summary for an empty store", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDb() });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { summary: string; chains: number[] };
    expect(parsed.summary).toContain("audited actions");
    expect(parsed.chains).toEqual([]);
  });

  it("aggregates spend across chains when chainId is omitted", async () => {
    const db = tempDb();
    const agentId = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const { isError, text } = await callTool("audit_query", { db, query: "spend", agentId });
    expect(isError).toBe(false);
    const parsed = JSON.parse(text) as { totalWei: string; chainId: number | null };
    expect(parsed.totalWei).toBe("0");
    expect(parsed.chainId).toBeNull();
  });

  it("rejects a non-positive chainId", async () => {
    const { isError, text } = await callTool("audit_query", { db: tempDb(), chainId: 0 });
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
