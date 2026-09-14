/**
 * @sigilkit/mcp — MCP (Model Context Protocol) server exposing SigilKit to agent
 * frameworks (enhancement E14). The compromised-agent threat model maps directly:
 * the model can ASK for actions through these tools, but the wallet path bounds
 * what it can DO — every proposed action is validated against the scope with the
 * same zero-gas logic the SDK uses, and every executed action is on-chain auditable
 * via the indexer.
 *
 * Minimal stdio MCP: newline-delimited JSON-RPC 2.0 (initialize / tools/list /
 * tools/call / ping). Deliberately protocol-minimal — no SDK dependency beyond
 * @sigilkit/core — so it stays stable across MCP spec churn.
 */
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import type { Address, Hash, Hex } from "viem";
import {
  decodeSigilKitError,
  parseActionRequest,
  targetLeaf,
  merkleRoot,
  validateAgainstScope,
  type Scope,
} from "@sigilkit/core";
import { SigilIndexer } from "@sigilkit/indexer";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const SCOPE_EXAMPLE: Scope = {
  expiresAt: 0,
  windowSeconds: 600,
  perActionCap: 0n,
  perWindowCap: 0n,
  merkleRoot: ("0x" + "0".repeat(64)) as Hash,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function coerceScope(raw: Record<string, unknown>): Scope {
  return {
    expiresAt: Number(raw.expiresAt ?? 0),
    windowSeconds: Number(raw.windowSeconds ?? 600),
    perActionCap: BigInt((raw.perActionCap as string) ?? "0"),
    perWindowCap: BigInt((raw.perWindowCap as string) ?? "0"),
    merkleRoot: (raw.merkleRoot as Hash) ?? SCOPE_EXAMPLE.merkleRoot,
    countersignAbove: BigInt((raw.countersignAbove as string) ?? "0"),
    enforceNativeDelta: Boolean(raw.enforceNativeDelta ?? false),
    tokenWatchlist: (raw.tokenWatchlist as Address[]) ?? [],
  };
}

/** The tool surface. Each tool is a pure, auditable operation — no key material. */
export const TOOLS: ToolDef[] = [
  {
    name: "validate_request",
    description:
      "Zero-gas policy check of an ActionRequest against a session-key scope, exactly mirroring the on-chain enforcement (caps, window, expiry, whitelist membership). Returns ok:false with the precise reason when the wallet would reject the action.",
    inputSchema: {
      type: "object",
      required: ["request", "scope"],
      properties: {
        request: { type: "object", description: "ActionRequest (value/nonce as strings or numbers)" },
        scope: { type: "object", description: "Scope (bigint caps as strings)" },
        windowState: { type: "object", description: "Optional {windowStart, spentThisWindow} from getWindowState" },
      },
    },
    run: (args) => {
      const request = parseActionRequest(args.request);
      const scope = coerceScope(args.scope as Record<string, unknown>);
      const windowState = args.windowState as { windowStart: number; spentThisWindow: string } | undefined;
      return validateAgainstScope({
        request,
        scope,
        merkleProof: undefined,
        windowState: windowState
          ? { windowStart: windowState.windowStart, spentThisWindow: BigInt(windowState.spentThisWindow) }
          : undefined,
      });
    },
  },
  {
    name: "build_scope",
    description:
      "Builds a Scope grant spec and the Merkle root over a target list (v2 wildcard leaves). Owners pass this to grantSessionKey; the returned root whitelists exactly the (target, selector) pairs for any calldata — pin exact calldata with argument-bound leaves instead.",
    inputSchema: {
      type: "object",
      required: ["expiresAt", "perActionCap", "perWindowCap"],
      properties: {
        expiresAt: { type: "number" },
        windowSeconds: { type: "number" },
        perActionCap: { type: "string" },
        perWindowCap: { type: "string" },
        countersignAbove: { type: "string" },
        enforceNativeDelta: { type: "boolean" },
        targets: {
          type: "array",
          description: "Whitelist entries [{target, selector}] — omitted ⇒ allow-all root (0)",
          items: { type: "object", properties: { target: { type: "string" }, selector: { type: "string" } } },
        },
      },
    },
    run: (args) => {
      const targets = (args.targets as Array<{ target: string; selector: string }>) ?? [];
      let root = ("0x" + "0".repeat(64)) as Hash;
      let leaves: Hex[] = [];
      if (targets.length > 0) {
        leaves = targets.map((t) => targetLeaf(t.target as Address, t.selector as Hex));
        root = merkleRoot(leaves);
      }
      return {
        scope: {
          expiresAt: Number(args.expiresAt),
          windowSeconds: Number(args.windowSeconds ?? 600),
          perActionCap: args.perActionCap,
          perWindowCap: args.perWindowCap,
          merkleRoot: root,
          countersignAbove: (args.countersignAbove as string) ?? "0",
          enforceNativeDelta: Boolean(args.enforceNativeDelta ?? false),
          tokenWatchlist: [],
        },
        leaves,
        note: "merkleRoot 0 = allow ALL targets (dangerous). Use pinned leaves (targetLeaf with data) to bind exact calldata.",
      };
    },
  },
  {
    name: "decode_error",
    description: "Decodes SigilKit revert data into a named error with arguments (e.g. PerActionCapExceeded(value, cap)).",
    inputSchema: { type: "object", required: ["data"], properties: { data: { type: "string", description: "0x revert data" } } },
    run: (args) => decodeSigilKitError(args.data as Hex),
  },
  {
    name: "audit_query",
    description:
      "Queries the indexer's SQLite database (built by @sigilkit/indexer): cumulative spend per agent, recent audited actions, or a summary. Strictly read-only: the database is opened with SQLite's readOnly flag, so no directory, table, index or row is ever created or modified. Pass chainId to scope a query to one chain; omit it to aggregate across every chain in the store.",
    inputSchema: {
      type: "object",
      required: ["db"],
      properties: {
        db: { type: "string", description: "Path to the indexer SQLite database" },
        query: { type: "string", enum: ["spend", "actions", "summary"], description: "Default: summary" },
        agentId: { type: "string" },
        chainId: {
          type: "number",
          description: "Optional chain filter. Omit to aggregate across all chains in the store.",
        },
      },
    },
    run: (args) => {
      const db = String(args.db);
      if (!existsSync(db)) return { error: `database not found: ${db}` };
      // BUG-9: this tool advertises itself as read-only, so it must not create
      // directories, run DDL, or write a single row. readOnly opens with SQLite's
      // readOnly flag and skips mkdir/migrate/schema entirely.
      const filter = args.chainId === undefined ? undefined : Number(args.chainId);
      const ix = new SigilIndexer(db, filter ?? 0, { readOnly: true });
      try {
        const query = String(args.query ?? "summary");
        if (query === "spend") {
          const agentId = args.agentId as Hash | undefined;
          if (!agentId) return { error: "spend needs agentId" };
          return { agentId, chainId: filter ?? null, totalWei: ix.spendByAgent(agentId, filter).toString() };
        }
        if (query === "actions") {
          const agentId = args.agentId as Hash | undefined;
          if (!agentId) return { error: "actions needs agentId" };
          return { agentId, chainId: filter ?? null, actions: ix.actionsForAgent(agentId, filter) };
        }
        return { summary: ix.summary(filter), chains: ix.chainIds() };
      } finally {
        // Always release the handle — Windows keeps an exclusive file lock otherwise.
        ix.close();
      }
    },
  },
];

/** Dispatches one JSON-RPC message; returns the response object or null (notification). */
export async function handleMessage(msg: {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { id, method, params = {} } = msg;
  if (!method) return null;
  const respond = (result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });

  switch (method) {
    case "initialize":
      return respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sigilkit-mcp", version: "0.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return respond({});
    case "tools/list":
      return respond({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = params.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool: ${name}`);
      // Enforce the tool's declared `required` fields before dispatch: the JSON-RPC
      // layer does not validate them, and a missing argument would otherwise surface
      // as a cryptic TypeError from inside the handler (e.g. "reading 'slice'").
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      const missing = required.filter((k) => args[k] === undefined);
      if (missing.length > 0) {
        return respond({
          content: [{ type: "text", text: `missing required argument(s): ${missing.join(", ")}` }],
          isError: true,
        });
      }
      try {
        const result = await tool.run(args);
        return respond({
          content: [{ type: "text", text: JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
        });
      } catch (err) {
        return respond({
          content: [{ type: "text", text: `tool error: ${err instanceof Error ? err.message : err}` }],
          isError: true,
        });
      }
    }
    default:
      return id === undefined || id === null ? null : error(-32601, `method not found: ${method}`);
  }
}

/** Stdio entry: newline-delimited JSON-RPC in, responses out. */
export function serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Parameters<typeof handleMessage>[0];
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    void handleMessage(msg).then((res) => {
      if (res) output.write(`${JSON.stringify(res)}\n`);
    });
  });
}
