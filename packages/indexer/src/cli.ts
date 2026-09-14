/**
 * sigilkit-indexer CLI — backfill/watch/query over the ActionLog database.
 *
 *   node dist/cli.js backfill --rpc http://127.0.0.1:8545 --manager 0x… --db audit.db [--from 0]
 *                             [--confirmations 12] [--max-range 2000]
 *   node dist/cli.js watch    --rpc … --manager 0x… --db audit.db
 *   node dist/cli.js spend    --db audit.db --agent 0x… [--chain-id 8453]
 *   node dist/cli.js actions  --db audit.db --agent 0x… [--limit 20] [--chain-id 8453]
 *   node dist/cli.js window   --db audit.db --key 0x… [--chain-id 8453]
 *   node dist/cli.js summary  --db audit.db [--chain-id 8453]
 *
 * Query commands open the database READ-ONLY: a query never creates a file, table,
 * index or row. `--chain-id` on a query is a FILTER (omit it to aggregate all chains).
 */
import { createPublicClient, http, type Address, type Chain } from "viem";
import { SigilIndexer } from "./indexer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string): number | undefined {
  const v = arg(name);
  return v === undefined ? undefined : Number(v);
}

const WRITE_COMMANDS = new Set(["backfill", "watch"]);

async function main() {
  const cmd = process.argv[2];
  const dbPath = arg("db") ?? "sigilkit-audit.db";
  const chainId = Number(arg("chain-id") ?? 31337);
  const isWrite = WRITE_COMMANDS.has(cmd ?? "");

  if (isWrite) {
    const rpc = arg("rpc");
    const manager = arg("manager") as Address | undefined;
    if (!rpc || !manager) throw new Error("backfill/watch need --rpc and --manager");
    const client = createPublicClient({
      chain: { id: chainId, name: "indexer-target", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as Chain,
      transport: http(rpc),
    });
    const indexer = new SigilIndexer(dbPath, chainId, {
      confirmations: num("confirmations"),
      maxBlockRange: num("max-range"),
    });
    const from = arg("from") !== undefined ? BigInt(arg("from")!) : undefined;
    const stored = await indexer.backfill(client, manager, from);
    console.log(`backfill: ${stored} SigilKit events stored — ${indexer.summary()}`);
    if (cmd === "watch") {
      console.log("watching for live events… (Ctrl+C to stop)");
      const stop = indexer.watch(client, manager);
      process.on("SIGINT", () => {
        stop();
        indexer.close();
        process.exit(0);
      });
    } else {
      indexer.close();
    }
    return;
  }

  // Query path: strictly read-only (BUG-9). `--chain-id` scopes the query; omitted
  // means every chain in the store.
  const filter = arg("chain-id") === undefined ? undefined : chainId;
  const indexer = new SigilIndexer(dbPath, chainId, { readOnly: true });
  try {
    if (cmd === "spend") {
      const agent = arg("agent") as `0x${string}` | undefined;
      if (!agent) throw Error("spend needs --agent");
      console.log(SigilIndexer.formatWei(indexer.spendByAgent(agent, filter).toString()), "ETH total spend");
    } else if (cmd === "actions") {
      const agent = arg("agent") as `0x${string}` | undefined;
      if (!agent) throw Error("actions needs --agent");
      const limit = Number(arg("limit") ?? 20);
      for (const a of indexer.actionsForAgent(agent, filter).slice(-limit)) {
        console.log(`[${new Date(a.ts * 1000).toISOString()}] chain=${a.chainId} ${a.selector} on ${a.target} value=${a.value} tx=${a.txHash} log=${a.logIndex}`);
      }
    } else if (cmd === "window") {
      const key = arg("key") as `0x${string}` | undefined;
      if (!key) throw Error("window needs --key");
      const c = indexer.latestWindowCharge(key, filter);
      console.log(c ? `windowStart=${c.windowStart} spentThisWindow=${c.spentThisWindow} wei (last charge ${c.value} wei in tx ${c.txHash})` : "no charges recorded");
    } else if (cmd === "summary") {
      console.log(indexer.summary(filter));
    } else {
      console.log("commands: backfill|watch|spend|actions|window|summary  (see file header)");
      process.exitCode = cmd === undefined ? 0 : 1;
    }
  } finally {
    indexer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
