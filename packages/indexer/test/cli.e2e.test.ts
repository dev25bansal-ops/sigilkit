/**
 * CLI end-to-end (AC-33): the backfill process must exit 0 after a successful run.
 * Reproduces the Windows/Node-24 abort (`UV_HANDLE_CLOSING` assert → exit 127) that
 * surfaced after "backfill stored N event(s)" in the 2026-09-22 E2E evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeAbiParameters, keccak256, pad, toHex, type Hash, type Hex } from "viem";

const MANAGER = "0x0000000000000000000000000000000000000042" as const;
const AGENT: Hash = ("0x" + "11".repeat(32)) as Hash;
const TARGET = "0x0000000000000000000000000000000000009001" as const;
const SELECTOR: Hex = "0x32145f90" as Hex;
const RATIONALE: Hash = ("0x" + "33".repeat(32)) as Hash;
const HEAD = 7n;

const blockHashFor = (n: bigint): Hash => ("0x" + n.toString(16).padStart(64, "0")) as Hash;

/** Canonical ActionLogged log (same shape the on-chain ActionLogger emits). */
const ACTION_LOG = {
  address: MANAGER,
  topics: [
    keccak256(toHex("ActionLogged(bytes32,address,bytes4,uint256,bytes32,uint48)")),
    pad(AGENT),
    pad(TARGET),
    pad(SELECTOR),
  ],
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
    [10n ** 16n, RATIONALE, 1_700_000_000n],
  ),
  blockNumber: "0x4",
  transactionHash: "0x" + "d1".repeat(32),
  blockHash: blockHashFor(4n),
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
};

let server: Server;
let rpcUrl: string;
const dbFor = (n: number): string => join(tmpdir(), `sigilkit-ac33-${process.pid}-${n}.db`);
// Precomputed outside the Promise executor so the executor's `resolve` parameter
// cannot shadow node:path's resolve.
const CLI_ENTRY = resolve(__dirname, "../src/cli.ts");
const PKG_ROOT = resolve(__dirname, "..");

function respond(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const { method, params } = JSON.parse(body || "{}") as { method: string; params: unknown[] };
      if (method === "eth_chainId") return respond(res, "0x7a69");
      if (method === "eth_blockNumber") return respond(res, toHex(HEAD));
      if (method === "eth_getBlockByNumber") {
        const p = (params as unknown[])[0] as string | { blockNumber?: string };
        const n = BigInt(typeof p === "string" ? p : (p.blockNumber ?? 0));
        return respond(res, { number: toHex(n), hash: blockHashFor(n) });
      }
      if (method === "eth_getLogs") return respond(res, [ACTION_LOG]);
      respond(res, null);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no test rpc address");
  rpcUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const dbPath of [dbFor(1), dbFor(2)]) {
    try { rmSync(dbPath, { force: true }); } catch { /* tmp file may be gone */ }
    for (const suffix of ["-shm", "-wal"]) {
      try { rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
});

function runCli(args: string[]): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  // Async spawn: spawnSync would block this worker's loop and deadlock the in-worker stub RPC.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
      cwd: PKG_ROOT,
      env: { ...process.env, SIGILKIT_RPC_URL: rpcUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("sigilkit-indexer CLI (AC-33)", () => {
  it("exits 0 after a successful backfill that stores an event", async () => {
    const run = await runCli(["backfill", "--manager", MANAGER, "--confirmations", "0", "--db", dbFor(1)]);
    expect(run.code, `exit ${run.code ?? run.signal}; stderr=${run.stderr.slice(0, 600)}`).toBe(0);
    expect(run.stdout).toContain("stored 1 event(s)");
  });

  it("exits 1 with operator guidance when the chain is younger than the default confirmations (AC-32)", async () => {
    const run = await runCli(["backfill", "--manager", MANAGER, "--db", dbFor(2)]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--confirmations 0");
  });
});