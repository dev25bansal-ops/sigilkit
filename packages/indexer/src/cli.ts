#!/usr/bin/env node
/**
 * sigilkit-indexer — backfill / watch / query the SigilKit audit trail.
 *
 * Write commands (`backfill`, `watch`) open the database read-write; every query
 * command opens it READ-ONLY, so a query can never create a file, table, index or row.
 * `--chain-id` on a query is a filter — omit it to aggregate every chain in the store.
 *
 * Configuration falls back to the environment (see `.env.example`), so a service can be
 * configured once and invoked without repeating flags:
 *
 *   SIGILKIT_RPC_URL, SIGILKIT_MANAGER, SIGILKIT_DB_PATH, SIGILKIT_INDEXER_CHAIN_ID,
 *   SIGILKIT_CONFIRMATIONS, SIGILKIT_MAX_BLOCK_RANGE, SIGILKIT_LOG_LEVEL, SIGILKIT_LOG_FORMAT
 *
 * Exit codes: 0 success · 1 runtime failure · 2 usage error.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createPublicClient, http, type Address, type Chain, type Hash } from "viem";
import { runCli, UserError, type CliSpec } from "@sigilkit/core/cli";
import { indexerChainId, loadDotEnv, loadServiceConfig, loggerFor } from "@sigilkit/core/config";
import { LOG_LEVELS } from "@sigilkit/core/logger";
import { SigilIndexer } from "./indexer.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Environment fallbacks applied when the matching flag is absent. */
const ENV_MANAGER = "SIGILKIT_MANAGER";

const SPEC: CliSpec = {
  name: "sigilkit-indexer",
  version: pkg.version,
  summary:
    "Index SigilKit ActionLogged / WindowCharged events into SQLite and query the audit trail.",
  usage: [
    "sigilkit-indexer backfill --manager <address> [--rpc <url>] [--from <block>] [--to <block>]",
    "sigilkit-indexer watch    --manager <address> [--rpc <url>]",
    "sigilkit-indexer spend    --agent <hash> [--chain-id <id>] [--json]",
    "sigilkit-indexer actions  --agent <hash> [--limit <n>] [--chain-id <id>] [--json]",
    "sigilkit-indexer window   --key <address> [--chain-id <id>] [--json]",
    "sigilkit-indexer summary  [--chain-id <id>] [--json]",
  ],
  commands: [
    { name: "backfill", description: "Index a historical block range and persist the cursor" },
    { name: "watch", description: "Follow live events until interrupted (Ctrl+C)" },
    { name: "spend", description: "Cumulative native spend for one agent" },
    { name: "actions", description: "Recent audited actions for one agent" },
    { name: "window", description: "Latest window charge recorded for a session key" },
    { name: "summary", description: "Row counts and chains present in the store" },
  ],
  flags: [
    { name: "--rpc", value: "<url>", description: "JSON-RPC endpoint (env: SIGILKIT_RPC_URL)" },
    { name: "--manager", value: "<address>", description: `SessionKeyManager address (env: ${ENV_MANAGER})` },
    { name: "--db", value: "<path>", description: "SQLite audit database (env: SIGILKIT_DB_PATH)" },
    { name: "--from", value: "<block>", description: "First block to index (default: persisted cursor, else 0)" },
    { name: "--to", value: "<block>", description: "Last block to index (default: head − confirmations)" },
    { name: "--confirmations", value: "<n>", description: "Blocks to stay behind the head (env: SIGILKIT_CONFIRMATIONS, default 12)" },
    { name: "--max-range", value: "<n>", description: "Max block span per eth_getLogs call (env: SIGILKIT_MAX_BLOCK_RANGE, default 2000)" },
    { name: "--chain-id", value: "<id>", description: "Chain id to index, or to filter a query by (env: SIGILKIT_INDEXER_CHAIN_ID)" },
    { name: "--agent", value: "<hash>", description: "Agent id, 32-byte hash (spend, actions)" },
    { name: "--key", value: "<address>", description: "Session key address (window)" },
    { name: "--limit", value: "<n>", description: "Maximum rows to print (actions, default 20)" },
    { name: "--json", description: "Emit machine-readable JSON instead of text" },
    {
      name: "--log-level",
      value: "<level>",
      choices: LOG_LEVELS,
      description: "Diagnostics verbosity (env: SIGILKIT_LOG_LEVEL, default info)",
    },
  ],
  examples: [
    "sigilkit-indexer backfill --rpc http://127.0.0.1:8545 --manager 0x1234…abcd --confirmations 0",
    "sigilkit-indexer watch --manager 0x1234…abcd",
    "sigilkit-indexer spend --agent 0xdead…beef --json",
  ],
  notes: [
    "ENVIRONMENT",
    "  Every flag above with an env fallback can be set once in the environment or a .env",
    "  file; the flag always wins. See docs/CONFIGURATION.md for the full table.",
    "",
    "EXIT CODES",
    "  0  success            1  runtime failure            2  usage error",
  ],
};

/** Builds a viem chain shim for an arbitrary chain id (no registry lookup needed). */
function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as Chain;
}

await runCli(SPEC, process.argv.slice(2), async (args, command) => {
  // `.env` first, so `cp .env.example .env` works as documented. Real env vars win.
  loadDotEnv();
  const config = loadServiceConfig();
  // The flag overrides the environment, like every other option.
  const log = loggerFor({ ...config, logLevel: args.oneOf("--log-level", LOG_LEVELS) ?? config.logLevel }, "indexer");
  const json = args.has("--json");

  const chainId = args.int("--chain-id", { min: 1 }) ?? indexerChainId(process.env, config.chainId);
  const dbPath = args.get("--db") ?? config.dbPath;
  const manager = (args.address("--manager") ?? process.env[ENV_MANAGER]) as Address | undefined;
  if (manager !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(manager)) {
    throw new UserError(`${ENV_MANAGER} must be a 20-byte hex address, got "${manager}"`, `example: ${ENV_MANAGER}=0x1234…abcd`);
  }

  if (command === "backfill" || command === "watch") {
    const rpc = args.url("--rpc") ?? config.rpcUrl;
    if (!manager) {
      throw new UserError(
        `--manager (or ${ENV_MANAGER}) is required for ${command}`,
        `pass --manager <address> — the deployed SessionKeyManager to index.`,
      );
    }
    const client = createPublicClient({ chain: chainFor(chainId, rpc), transport: http(rpc) });
    const indexer = new SigilIndexer(dbPath, chainId, {
      confirmations: args.int("--confirmations", { min: 0 }) ?? config.confirmations,
      maxBlockRange: args.int("--max-range", { min: 1 }) ?? config.maxBlockRange,
      logger: log,
    });

    try {
      const stored = await indexer.backfill(
        client,
        manager,
        args.bigint("--from", { min: 0n }),
        args.bigint("--to", { min: 0n }),
      );
      if (json) {
        process.stdout.write(
          JSON.stringify({ command, chainId, manager, stored, summary: indexer.summary(chainId) }) + "\n",
        );
      } else {
        log.info(`backfill stored ${stored} event(s)`, { chainId, manager });
        log.info(indexer.summary(chainId));
      }

      if (command === "watch") {
        log.info("watching for live events — press Ctrl+C to stop");
        const stop = indexer.watch(client, manager);
        await new Promise<void>((resolve) => {
          let closing = false;
          const shutdown = (signal: string): void => {
            if (closing) return;
            closing = true;
            log.info(`received ${signal}, shutting down`);
            // A7: await the watch loop's drain, not a fire-and-forget stop(). The
            // disposer resolves once the in-flight tick has actually finished, so the
            // `finally { indexer.close() }` below can never close the database under a
            // tick that is mid-write.
            void stop().then(resolve, resolve);
          };
          process.on("SIGINT", () => shutdown("SIGINT"));
          process.on("SIGTERM", () => shutdown("SIGTERM"));
        });
      }
    } finally {
      indexer.close();
    }
    return 0;
  }

  // ── query path: strictly read-only ────────────────────────────────────────────
  const filter = args.has("--chain-id") ? chainId : undefined;

  // Validate every command-specific argument BEFORE opening the database: a typo in
  // --agent should be reported as a typo, not as "unable to open database file".
  const required = <T>(name: string, read: () => T | undefined): T => {
    args.require(name);
    return read() as T;
  };
  const agentId = command === "spend" || command === "actions" ? required("--agent", () => args.hash32("--agent")) : undefined;
  const key = command === "window" ? required("--key", () => args.address("--key")) : undefined;
  const limit = command === "actions" ? (args.int("--limit", { min: 1 }) ?? 20) : 20;

  if (!existsSync(dbPath)) {
    throw new UserError(`audit database not found: ${dbPath}`, `index some events first: sigilkit-indexer backfill --manager <address> --db ${dbPath}`);
  }

  let indexer: SigilIndexer;
  try {
    indexer = new SigilIndexer(dbPath, chainId, { readOnly: true, logger: log });
  } catch (err) {
    throw new UserError(
      `could not open ${dbPath} read-only: ${err instanceof Error ? err.message : String(err)}`,
      "the file may be missing, locked by another process, or not a SQLite database.",
    );
  }

  try {
    if (command === "spend") {
      const totalWei = indexer.spendByAgent(agentId as Hash, filter);
      if (json) {
        process.stdout.write(
          JSON.stringify({
            agentId,
            chainId: filter ?? null,
            totalWei: totalWei.toString(),
            totalEth: SigilIndexer.formatWei(totalWei.toString()),
          }) + "\n",
        );
      } else {
        process.stdout.write(`${SigilIndexer.formatWei(totalWei.toString())} ETH total spend\n`);
      }
    } else if (command === "actions") {
      // A6: `--limit` threads all the way into the query layer instead of a
      // caller-side `.slice(-limit)` — the SQL fetches the newest N rows through the
      // index and never materialises the rest.
      const rows = indexer.actionsForAgent(agentId as Hash, filter, limit);
      if (json) {
        process.stdout.write(JSON.stringify({ agentId, chainId: filter ?? null, count: rows.length, actions: rows }) + "\n");
      } else {
        if (rows.length === 0) process.stdout.write("no actions recorded\n");
        for (const a of rows) {
          process.stdout.write(
            `[${new Date(a.ts * 1000).toISOString()}] chain=${a.chainId} ${a.selector} on ${a.target} value=${a.value} tx=${a.txHash} log=${a.logIndex}\n`,
          );
        }
      }
    } else if (command === "window") {
      const charge = indexer.latestWindowCharge(key as Address, filter);
      if (json) {
        process.stdout.write(JSON.stringify({ key, chainId: filter ?? null, charge }) + "\n");
      } else if (charge) {
        process.stdout.write(
          `windowStart=${charge.windowStart} spentThisWindow=${charge.spentThisWindow} wei (last charge ${charge.value} wei in tx ${charge.txHash})\n`,
        );
      } else {
        process.stdout.write("no charges recorded\n");
      }
    } else {
      // summary
      const summary = indexer.summary(filter);
      if (json) {
        process.stdout.write(JSON.stringify({ chainId: filter ?? null, chains: indexer.chainIds(), summary }) + "\n");
      } else {
        process.stdout.write(summary + "\n");
      }
    }
    return 0;
  } finally {
    indexer.close();
  }
}, {
  // AC-33: Node 24's experimental node:sqlite aborts on Windows when process.exit
  // interrupts the loop with a sqlite finalization queued (`Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)` — reproduced even when the exit is deferred one
  // macrotask; measured child exit 0xC0000409). Set the exit code and let the loop drain
  // naturally; an unref'd 5s watchdog force-exits if a transport keeps the loop alive.
  io: {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    exit: (code) => {
      process.exitCode = code;
      const watchdog = setTimeout(() => process.exit(code), 5_000);
      watchdog.unref();
    },
  },
});
