/**
 * sigilkit-indexer CLI — backfill/watch/query over the ActionLog database.
 *
 *   node dist/cli.js backfill --rpc http://127.0.0.1:8545 --manager 0x… --db audit.db [--from 0] [--watch]
 *   node dist/cli.js spend   --db audit.db --agent 0x…
 *   node dist/cli.js actions --db audit.db --agent 0x… [--limit 20]
 *   node dist/cli.js window  --db audit.db --key 0x…
 *   node dist/cli.js summary --db audit.db
 */
import { createPublicClient, http, type Address, type Chain } from "viem";
import { SigilIndexer } from "./indexer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  const dbPath = arg("db") ?? "sigilkit-audit.db";
  const chainId = Number(arg("chain-id") ?? 31337);

  if (cmd === "backfill" || cmd === "watch") {
    const rpc = arg("rpc");
    const manager = arg("manager") as Address | undefined;
    if (!rpc || !manager) throw new Error("backfill/watch need --rpc and --manager");
    const client = createPublicClient({
      chain: { id: chainId, name: "indexer-target", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as Chain,
      transport: http(rpc),
    });
    const indexer = new SigilIndexer(dbPath, chainId);
    const from = arg("from") !== undefined ? BigInt(arg("from")!) : undefined;
    const stored = await indexer.backfill(client, manager, from);
    console.log(`backfill: ${stored} SigilKit events stored — ${indexer.summary()}`);
    if (cmd === "watch") {
      console.log("watching for live events… (Ctrl+C to stop)");
      const stop = indexer.watch(client, manager);
      process.on("SIGINT", () => {
        stop();
        process.exit(0);
      });
    }
    return;
  }

  const indexer = new SigilIndexer(dbPath, chainId);
  if (cmd === "spend") {
    const agent = arg("agent") as `0x${string}` | undefined;
    if (!agent) throw Error("spend needs --agent");
    console.log(SigilIndexer.formatWei(indexer.spendByAgent(agent).toString()), "ETH total spend");
  } else if (cmd === "actions") {
    const agent = arg("agent") as `0x${string}` | undefined;
    if (!agent) throw Error("actions needs --agent");
    const limit = Number(arg("limit") ?? 20);
    for (const a of indexer.actionsForAgent(agent).slice(-limit)) {
      console.log(`[${new Date(a.ts * 1000).toISOString()}] ${a.selector} on ${a.target} value=${a.value} tx=${a.txHash}`);
    }
  } else if (cmd === "window") {
    const key = arg("key") as `0x${string}` | undefined;
    if (!key) throw Error("window needs --key");
    const c = indexer.latestWindowCharge(key);
    console.log(c ? `windowStart=${c.windowStart} spentThisWindow=${c.spentThisWindow} wei (last charge ${c.value} wei in tx ${c.txHash})` : "no charges recorded");
  } else if (cmd === "summary") {
    console.log(indexer.summary());
  } else {
    console.log("commands: backfill|watch|spend|actions|window|summary  (see file header)");
    process.exitCode = cmd === undefined ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
