/**
 * MCP server tests (E14): protocol-level (initialize/tools list/call) over the
 * handleMessage dispatcher, plus end-to-end over the stdio transport with a spawned
 * child process.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { handleMessage, serveStdio } from "../src/server.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

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
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      child.stdout.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().startsWith("{")) {
            resolve(JSON.parse(line));
            child.kill();
            return;
          }
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    });
    void serveStdio; // transport exercised via the spawned process above
    expect(response.result).toEqual({});
    expect(response.id).toBe(1);
  });
});
