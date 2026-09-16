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
import { createRequire } from "node:module";
import type { Address, Hash, Hex } from "viem";
import {
  assertAddress,
  assertBigInt,
  assertHash32,
  assertHex,
  assertNonEmptyString,
  assertOneOf,
  assertUint,
  createLogger,
  decodeSigilKitError,
  parseActionRequest,
  targetLeaf,
  merkleRoot,
  validateAgainstScope,
  ValidationError,
  type Logger,
  type Scope,
} from "@sigilkit/core";
import { SigilIndexer } from "@sigilkit/indexer";
import { readEnvChoice } from "@sigilkit/core/config";
import { LOG_FORMATS, LOG_LEVELS } from "@sigilkit/core/logger";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** MCP speaks JSON-RPC over stdout, so all diagnostics go to stderr. */
const defaultLogger: Logger = createLogger({
  scope: "mcp",
  level: readEnvChoice(process.env, "SIGILKIT_LOG_LEVEL", LOG_LEVELS, "info"),
  format: readEnvChoice(process.env, "SIGILKIT_LOG_FORMAT", LOG_FORMATS, "text"),
  out: (line) => process.stderr.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as Hash;

function coerceScope(raw: unknown): Scope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("scope", "expected an object");
  }
  const r = raw as Record<string, unknown>;
  const watchlist = r.tokenWatchlist ?? [];
  if (!Array.isArray(watchlist)) {
    throw new ValidationError("scope.tokenWatchlist", "expected an array of addresses");
  }
  return {
    expiresAt: r.expiresAt === undefined ? 0 : assertUint(r.expiresAt, "scope.expiresAt", { min: 0 }),
    windowSeconds: r.windowSeconds === undefined ? 600 : assertUint(r.windowSeconds, "scope.windowSeconds", { min: 1 }),
    perActionCap: r.perActionCap === undefined ? 0n : assertBigInt(r.perActionCap, "scope.perActionCap", { min: 0n }),
    perWindowCap: r.perWindowCap === undefined ? 0n : assertBigInt(r.perWindowCap, "scope.perWindowCap", { min: 0n }),
    merkleRoot: r.merkleRoot === undefined ? ZERO_ROOT : assertHash32(r.merkleRoot, "scope.merkleRoot"),
    countersignAbove: r.countersignAbove === undefined ? 0n : assertBigInt(r.countersignAbove, "scope.countersignAbove", { min: 0n }),
    enforceNativeDelta: r.enforceNativeDelta === undefined ? false : Boolean(r.enforceNativeDelta),
    tokenWatchlist: watchlist.map((a, i) => assertAddress(a, `scope.tokenWatchlist[${i}]`)),
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
      const scope = coerceScope(args.scope);
      const rawWindow = args.windowState;
      if (rawWindow !== undefined && (rawWindow === null || typeof rawWindow !== "object")) {
        throw new ValidationError("windowState", "expected an object {windowStart, spentThisWindow}");
      }
      const ws = rawWindow as Record<string, unknown> | undefined;
      return validateAgainstScope({
        request,
        scope,
        merkleProof: undefined,
        windowState: ws
          ? {
              windowStart: assertUint(ws.windowStart ?? 0, "windowState.windowStart", { min: 0 }),
              spentThisWindow: assertBigInt(ws.spentThisWindow ?? "0", "windowState.spentThisWindow", { min: 0n }),
            }
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
      const rawTargets = args.targets ?? [];
      if (!Array.isArray(rawTargets)) {
        throw new ValidationError("targets", "expected an array of {target, selector}");
      }
      const targets = rawTargets.map((t, i) => {
        if (t === null || typeof t !== "object" || Array.isArray(t)) {
          throw new ValidationError(`targets[${i}]`, "expected an object {target, selector}");
        }
        const entry = t as Record<string, unknown>;
        return {
          target: assertAddress(entry.target, `targets[${i}].target`),
          selector: assertHex(entry.selector, `targets[${i}].selector`, { bytes: 4 }),
        };
      });

      let root = ZERO_ROOT;
      let leaves: Hex[] = [];
      if (targets.length > 0) {
        leaves = targets.map((t) => targetLeaf(t.target, t.selector));
        root = merkleRoot(leaves);
      }
      return {
        scope: {
          expiresAt: assertUint(args.expiresAt, "expiresAt", { min: 1 }),
          windowSeconds: args.windowSeconds === undefined ? 600 : assertUint(args.windowSeconds, "windowSeconds", { min: 1 }),
          perActionCap: assertBigInt(args.perActionCap, "perActionCap", { min: 0n }).toString(),
          perWindowCap: assertBigInt(args.perWindowCap, "perWindowCap", { min: 0n }).toString(),
          merkleRoot: root,
          countersignAbove: args.countersignAbove === undefined ? "0" : assertBigInt(args.countersignAbove, "countersignAbove", { min: 0n }).toString(),
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
    run: (args) => decodeSigilKitError(assertHex(args.data, "data")),
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
      const db = assertNonEmptyString(args.db, "db");
      if (!existsSync(db)) return { error: `database not found: ${db}` };
      const query = assertOneOf(args.query ?? "summary", "query", ["spend", "actions", "summary"] as const);
      const filter = args.chainId === undefined ? undefined : assertUint(args.chainId, "chainId", { min: 1 });
      // BUG-9: this tool advertises itself as read-only, so it must not create
      // directories, run DDL, or write a single row. readOnly opens with SQLite's
      // readOnly flag and skips mkdir/migrate/schema entirely.
      const ix = new SigilIndexer(db, filter ?? 0, { readOnly: true, logger: defaultLogger });
      try {
        if (query === "spend") {
          const agentId = assertHash32(args.agentId, "agentId");
          return { agentId, chainId: filter ?? null, totalWei: ix.spendByAgent(agentId, filter).toString() };
        }
        if (query === "actions") {
          const agentId = assertHash32(args.agentId, "agentId");
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
        serverInfo: { name: "sigilkit-mcp", version: pkg.version },
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

/** Stdio entry: newline-delimited JSON-RPC in, responses out. Returns a stop function. */
export function serveStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  logger: Logger = defaultLogger,
): () => void {
  const rl = createInterface({ input });

  /** A closed pipe (client exited) must not crash the server with an unhandled EPIPE. */
  const write = (payload: Record<string, unknown>): void => {
    try {
      output.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      logger.warn("failed to write response; client may have disconnected", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected a JSON object" } });
      return;
    }
    void handleMessage(msg as Parameters<typeof handleMessage>[0])
      .then((res) => {
        if (res) write(res);
      })
      .catch((err: unknown) => {
        // handleMessage is written not to throw; if it ever does, report it in-band
        // rather than leaving the client waiting for a response that never comes.
        const id = (msg as { id?: number | string | null }).id ?? null;
        logger.error("unhandled error while dispatching request", {}, err);
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: `internal error: ${err instanceof Error ? err.message : String(err)}` },
        });
      });
  });

  rl.on("close", () => logger.debug("stdin closed; server idle"));

  logger.info("sigilkit-mcp listening on stdio", { version: pkg.version });
  return () => rl.close();
}
