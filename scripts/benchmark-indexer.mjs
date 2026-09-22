#!/usr/bin/env node
/**
 * Bounded, offline, reproducible benchmark for the *built* SigilIndexer.
 *
 * What it measures — and only this:
 *   `SigilIndexer.storeAction()` from `packages/indexer/dist/index.js`, once per row,
 *   on a fresh indexer, in two storage modes:
 *     - `memory` — `new SigilIndexer(":memory:", chainId, { logger: silentLogger() })`
 *     - `disk`   — `new SigilIndexer("<temp>/…sqlite", chainId, { logger: silentLogger() })`
 *
 * It deliberately does **not** measure a tuned or hypothetical path. No `PRAGMA`
 * journal/synchronous tuning, no batched transaction, no prepared-statement cache, no
 * `src/` shortcuts: the class is constructed with its documented defaults and the timed
 * region contains nothing but the `storeAction` loop. Rows are unique on the natural key
 * `(chain_id, tx_hash, log_index)`, so this is the pure-INSERT first-index case, which is
 * the dominant production path (the upsert conflict branch is exercised elsewhere).
 *
 * Bounds: `--rows` 1..1000 (default 1000), `--reps` 1..3 (default 3), so a run is a few
 * seconds to a couple of minutes even on a cold NTFS volume where every commit fsyncs.
 *
 * Offline: synthetic data only, deterministic PRNG, no RPC client, no network, no
 * contract fixtures. Nothing in the security surface is touched.
 *
 * Runtime: the repository declares `engines.node >= 24` (node:sqlite is the storage
 * engine). The floor is **enforced before any database work**: `runBenchmark` calls
 * `assertRuntimeFloor` as its first statement, before the dist lookup, the dynamic
 * imports, the temp-directory mkdir and any `SigilIndexer` construction. On Node < 24 the
 * run aborts with a non-zero exit code instead of emitting a report, so no number from an
 * unsupported runtime can be mistaken for a Node 24 measurement.
 *
 * Each run exclusively creates `outputs/review-2026-09-17/benchmark-run-<id>/fixtures/`.
 * Owned database and sidecar paths are registered before construction and removed after
 * close. Refused cleanup is preserved in the diagnostic report and fails completion.
 * Existing reports and databases are never overwritten or reused.
 *
 *   node scripts/benchmark-indexer.mjs
 *   node scripts/benchmark-indexer.mjs --rows=250 --reps=2 --seed=7
 *
 * Writes `outputs/review-2026-09-17/benchmark-run-<id>/benchmark.json`.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, totalmem, type as osType } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── bounds and defaults ─────────────────────────────────────────────────────────

export const MAX_ROWS = 1000;
export const DEFAULT_ROWS = 1000;
export const MAX_REPS = 3;
export const DEFAULT_REPS = 3;
export const DEFAULT_SEED = 20260917;
export const REQUIRED_NODE_MAJOR = 24;
export const CHAIN_ID = 8453;
export const MODES = ["memory", "disk"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "outputs", "review-2026-09-17");
const REPORT_PATH = join(OUT_DIR, "benchmark-run-*", "benchmark.json");
const INDEXER_ENTRY = join(ROOT, "packages", "indexer", "dist", "index.js");
const FILE_PREFIX = "bench-indexer-";
const SCHEMA = "sigilkit.benchmark.indexer/1";

/** Used only for the lazy `node:sqlite` version probe, which is synchronous. */
const require = createRequire(import.meta.url);

// ── pure helpers (unit-tested in benchmark-indexer.test.mjs) ────────────────────

/** Round to `digits` decimals, keeping the value a number (not a string). */
export function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Median of a numeric list; `[]` → 0; even length → mean of the two middles. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Throughput of `rows` writes over `elapsedMs`; non-positive elapsed → 0, never Infinity. */
export function rowsPerSecond(rows, elapsedMs) {
  if (!(elapsedMs > 0)) return 0;
  return rows / (elapsedMs / 1000);
}

/** Parses `process.versions.node` (with or without a leading `v`). */
export function parseNodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version));
  return match ? Number(match[1]) : 0;
}

/** Records the runtime and whether it satisfies the repository's `engines.node >= 24`. */
export function checkRuntime(nodeVersion, requiredMajor = REQUIRED_NODE_MAJOR) {
  const major = parseNodeMajor(nodeVersion);
  return {
    node: String(nodeVersion),
    major,
    requiredMajor,
    satisfiesRequired: major >= requiredMajor,
  };
}

/**
 * Hard runtime floor. Returns the {@link checkRuntime} record when the process satisfies
 * `engines.node >= 24`, otherwise throws.
 *
 * This is a guard, not a label: it is called before any filesystem or SQLite work, so an
 * unsupported runtime can never produce a report at all (previously the run completed and
 * merely flagged itself `authoritative: false`).
 */
export function assertRuntimeFloor(nodeVersion, requiredMajor = REQUIRED_NODE_MAJOR) {
  const runtime = checkRuntime(nodeVersion, requiredMajor);
  if (!runtime.satisfiesRequired) {
    throw new Error(
      `unsupported runtime: Node ${runtime.node} (major ${runtime.major}) is below the required Node ${requiredMajor} (engines.node). ` +
        `Re-run with Node ${requiredMajor}+, e.g. \`"C:/Program Files/nodejs/node.exe" scripts/benchmark-indexer.mjs\`. ` +
        `No database was opened and no report was written.`,
    );
  }
  return runtime;
}

/**
 * CLI parsing. Strict `--key=value` form only, so a typo fails loudly instead of being
 * silently ignored, and every numeric option is range-checked against the hard caps.
 */
export function parseArgs(argv) {
  const out = { rows: DEFAULT_ROWS, reps: DEFAULT_REPS, seed: DEFAULT_SEED, help: false };
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    const match = /^--([a-z]+)=(.*)$/.exec(token);
    if (!match) {
      throw new Error(`unknown argument "${token}" (expected --key=value, or --help)`);
    }
    const [, key, raw] = match;
    if (!["rows", "reps", "seed"].includes(key)) {
      throw new Error(`unknown option "--${key}" (expected --rows, --reps, --seed, --help)`);
    }
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`--${key} must be an integer, got "${raw}"`);
    }
    const value = Number(raw);
    if (key === "rows") {
      if (value < 1 || value > MAX_ROWS) {
        throw new Error(`--rows must be between 1 and ${MAX_ROWS} (got ${value}); the benchmark is deliberately bounded`);
      }
    } else if (key === "reps") {
      if (value < 1 || value > MAX_REPS) {
        throw new Error(`--reps must be between 1 and ${MAX_REPS} (got ${value}); the benchmark is deliberately bounded`);
      }
    } else if (value < 0 || value > 0xffffffff) {
      throw new Error(`--seed must be between 0 and 4294967295 (got ${value})`);
    }
    out[key] = value;
  }
  return out;
}

/** mulberry32 — small, fast, fully deterministic from a 32-bit seed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (bytes, rnd) => {
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(rnd() * 256).toString(16).padStart(2, "0");
  return `0x${s}`;
};

/**
 * Deterministic synthetic ActionLogged records. Every row has a distinct `txHash`, so the
 * natural key never collides and each `storeAction` is a real INSERT. Agents, targets and
 * selectors are drawn from small fixed pools to keep the shape realistic (repeat actors,
 * repeat spend targets) without inventing distribution claims.
 */
export function makeSyntheticRows(rows, seed, chainId = CHAIN_ID) {
  const rnd = prng(seed);
  const agents = Array.from({ length: 8 }, () => hex(32, rnd));
  const targets = Array.from({ length: 16 }, () => hex(20, rnd));
  const selectors = Array.from({ length: 4 }, () => hex(4, rnd));
  const baseBlock = 21_000_000;
  const baseTs = 1_760_000_000;
  const out = [];
  for (let i = 0; i < rows; i++) {
    out.push({
      chainId,
      agentId: agents[i % agents.length],
      target: targets[Math.floor(rnd() * targets.length)],
      selector: selectors[Math.floor(rnd() * selectors.length)],
      value: BigInt(1 + Math.floor(rnd() * 1_000_000)) * 10n ** 12n,
      rationaleHash: hex(32, rnd),
      timestamp: baseTs + i,
      txHash: hex(32, rnd),
      blockNumber: BigInt(baseBlock + i),
      logIndex: 0,
      blockHash: hex(32, rnd),
    });
  }
  return out;
}

/** Aggregates the shape of a generated dataset (pure; used for the report and read-back checks). */
export function shapeOf(rows, chainId = CHAIN_ID) {
  const agents = new Set();
  const targets = new Set();
  const selectors = new Set();
  const txHashes = new Set();
  const perTarget = new Map();
  let total = 0n;
  let min = null;
  let max = null;
  let firstBlock = null;
  let lastBlock = null;
  for (const r of rows) {
    agents.add(r.agentId);
    targets.add(r.target);
    selectors.add(r.selector);
    txHashes.add(r.txHash);
    perTarget.set(r.target, (perTarget.get(r.target) ?? 0) + 1);
    total += r.value;
    if (min === null || r.value < min) min = r.value;
    if (max === null || r.value > max) max = r.value;
    const block = Number(r.blockNumber);
    if (firstBlock === null || block < firstBlock) firstBlock = block;
    if (lastBlock === null || block > lastBlock) lastBlock = block;
  }
  let largestTarget = null;
  for (const [target, count] of perTarget) {
    if (!largestTarget || count > largestTarget.count) largestTarget = { target, count };
  }
  return {
    rows: rows.length,
    chainId,
    uniqueAgents: agents.size,
    uniqueTargets: targets.size,
    uniqueSelectors: selectors.size,
    uniqueTxHashes: txHashes.size,
    keyCollisions: rows.length - txHashes.size,
    firstBlock,
    lastBlock,
    blockSpan: firstBlock === null ? 0 : lastBlock - firstBlock,
    minValueWei: min === null ? "0" : min.toString(),
    maxValueWei: max === null ? "0" : max.toString(),
    totalValueWei: total.toString(),
    largestTarget,
  };
}

/** Median-of-reps summary for one storage mode. */
export function summarizeReps(reps, rows) {
  const elapsed = reps.map((r) => r.elapsedMs);
  const rate = reps.map((r) => r.rowsPerSecond);
  const rss = reps.map((r) => r.memory.rssDeltaBytes);
  const heap = reps.map((r) => r.memory.heapUsedDeltaBytes);
  return {
    reps: reps.length,
    rowsPerRep: rows,
    elapsedMs: { median: round(median(elapsed), 3), min: round(Math.min(...elapsed), 3), max: round(Math.max(...elapsed), 3) },
    rowsPerSecond: { median: round(median(rate), 1), min: round(Math.min(...rate), 1), max: round(Math.max(...rate), 1) },
    rssDeltaBytes: { median: Math.round(median(rss)), min: Math.min(...rss), max: Math.max(...rss) },
    heapUsedDeltaBytes: { median: Math.round(median(heap)), min: Math.min(...heap), max: Math.max(...heap) },
  };
}

/** Exact paths this run may create for one on-disk database (SQLite sidecar names). */
export function tempArtifacts(dbPath) {
  return [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`];
}

/**
 * Deletes exactly the files this run created and nothing else.
 *
 * Two deliberate properties. (1) Containment: a path that is not inside `tempDir` is
 * refused rather than deleted, so the benchmark can never reach outside its own temp
 * directory. (2) Non-fatal: a deletion the host refuses (a sandbox bulk-delete guard, a
 * lingering Windows lock) is recorded in `refused` and the run still produces its report —
 * a cleanup problem must not destroy the measurement. `rm`/`exists`/`readdir` are
 * injectable so this is unit-testable without touching the filesystem.
 */
export function cleanupArtifacts(createdFiles, {
  tempDir,
  tempDirPreExisted,
  rm = rmSync,
  rmdir = rmdirSync,
  exists = existsSync,
  readdir = readdirSync,
  lstat = lstatSync,
} = {}) {
  const root = resolve(tempDir);
  const attempted = [...createdFiles];
  const refused = [];
  const removedFiles = [];

  let rootSafe = false;
  try { rootSafe = !exists(tempDir) || !lstat(tempDir).isSymbolicLink(); }
  catch (err) { refused.push({ path: tempDir, reason: String(err) }); }
  for (const path of attempted) {
    if (!rootSafe || dirname(resolve(path)) !== root) {
      refused.push({ path, reason: "refused: path is outside the benchmark temp directory or its root is a symlink" });
      continue;
    }
    try {
      if (!exists(path)) continue;
      rm(path, { force: true });
      if (!exists(path)) removedFiles.push(path);
      else refused.push({ path, reason: "file still exists after removal" });
    } catch (err) {
      refused.push({ path, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  let tempDirRemoved = false;
  let leftoverFiles = [];
  try {
    if (rootSafe && !tempDirPreExisted && exists(tempDir) && readdir(tempDir).length === 0) {
      rmdir(tempDir);
      tempDirRemoved = !exists(tempDir);
    }
    if (rootSafe && exists(tempDir)) leftoverFiles = readdir(tempDir);
  } catch (err) {
    refused.push({ path: tempDir, reason: err instanceof Error ? err.message : String(err) });
    leftoverFiles = ["<directory could not be inspected or removed>"];
  }

  return {
    tempDir,
    tempDirPreExisted,
    tempDirRemoved,
    ownedPaths: attempted,
    createdFiles: removedFiles.concat(refused.filter((r) => attempted.includes(r.path)).map((r) => r.path)),
    removedFiles,
    refused,
    leftoverFiles,
  };
}

export function validateWorkload({ rows, reps, seed }) {
  for (const [key, value, min, max] of [["rows", rows, 1, MAX_ROWS], ["reps", reps, 1, MAX_REPS], ["seed", seed, 0, 0xffffffff]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
}

export function measurementValidity(config, dataset, environment, results) {
  let workloadValid = true;
  try { validateWorkload(config ?? {}); } catch { workloadValid = false; }
  const runtimeEligible = environment?.runtime?.satisfiesRequired === true;
  const completed = workloadValid && MODES.every((mode) =>
    Array.isArray(results?.[mode]?.reps) && results[mode].reps.length === config.reps &&
    results[mode].reps.every((r, i) => r.rep === i + 1 && r.mode === mode && r.completed === true));
  const correctness = completed && dataset?.rows === config.rows && dataset?.keyCollisions === 0 &&
    MODES.every((mode) => results[mode].reps.every((r) =>
      ["fresh", "wholeTable", "targetRows", "agentSpendWei", "allAgentRows"].every((key) => r.verified?.[key]?.ok === true)));
  const timingValid = completed && MODES.every((mode) => results[mode].reps.every((r) =>
    Number.isFinite(r.elapsedMs) && r.elapsedMs > 0 && Number.isFinite(r.rowsPerSecond) && r.rowsPerSecond > 0));
  return { runtimeEligible, workloadValid, completed, correctness, timingValid,
    valid: runtimeEligible && completed && correctness && timingValid };
}

export function assertValidReport(report) {
  if (report.validity?.valid !== true) {
    const error = new Error("benchmark validation failed; diagnostic report is not performance evidence");
    error.report = report;
    throw error;
  }
}

/** Assembles a diagnostic report; invalid runs retain raw records but no summaries. */
export function buildReport({ generatedAt, config, dataset, environment, results, cleanup, warnings, notes, target, build, fixture, errors = [] }) {
  const validity = measurementValidity(config, dataset, environment, results);
  validity.buildIdentified = build?.stable === true && /^[a-f0-9]{64}$/.test(build?.digest ?? "");
  validity.fixtureOwned = fixture?.exclusive === true;
  validity.cleanupComplete = cleanup?.tempDirRemoved === true && cleanup?.refused?.length === 0 && cleanup?.leftoverFiles?.length === 0;
  validity.valid = validity.valid && validity.buildIdentified && validity.fixtureOwned && validity.cleanupComplete && errors.length === 0;
  const safeResults = Object.fromEntries(Object.entries(results ?? {}).map(([mode, result]) => [mode,
    validity.valid ? result : { ...result, summary: null, fileBytes: null, bytesPerRow: null },
  ]));
  return {
    schema: SCHEMA,
    generatedAt,
    authoritative: false,
    authorityLimit: "Local bounded synthetic measurement only; build hashes identify bytes but do not attest source-to-build equivalence or production performance.",
    build,
    fixture,
    errors,
    validity,
    tool: "scripts/benchmark-indexer.mjs",
    target,
    config,
    dataset,
    environment,
    results: safeResults,
    cleanup,
    warnings,
    notes,
  };
}

export function usage() {
  return [
    "Usage: node scripts/benchmark-indexer.mjs [--rows=N] [--reps=N] [--seed=N] [--help]",
    "",
    `  --rows=N   rows per rep, 1..${MAX_ROWS} (default ${DEFAULT_ROWS})`,
    `  --reps=N   repetitions per mode, 1..${MAX_REPS} (default ${DEFAULT_REPS})`,
    `  --seed=N   32-bit PRNG seed (default ${DEFAULT_SEED})`,
    "",
    `Benchmarks the built SigilIndexer.storeAction on memory vs disk; writes ${REPORT_PATH}.`,
    `Requires Node ${REQUIRED_NODE_MAJOR}+ (engines.node); older runtimes are rejected before any database work.`,
  ].join("\n");
}

// ── environment / I/O (impure) ──────────────────────────────────────────────────

function collectEnvironment() {
  const cpuList = cpus();
  return {
    node: {
      version: process.version,
      versions: {
        node: process.versions.node,
        v8: process.versions.v8,
        modules: process.versions.modules,
      },
      execPath: process.execPath,
    },
    os: {
      type: osType(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpus: cpuList.length,
      cpuModel: cpuList[0]?.model ?? "unknown",
      totalMemBytes: totalmem(),
    },
    sqlite: sqliteVersion(),
  };
}

/** SQLite library version, read from a throwaway in-memory database (offline, no files). */
function sqliteVersion() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("SELECT sqlite_version() AS v").get();
    db.close();
    return { module: "node:sqlite", version: String(row.v) };
  } catch (err) {
    return { module: "node:sqlite", version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function verifyWholeTable(indexer, rows) {
  const actual = indexer.db.prepare(`SELECT chain_id, tx_hash, log_index, block_number,
    block_hash, agent_id, target, selector, value, rationale_hash, ts FROM actions`).all();
  const normalize = (r) => JSON.stringify([r.chain_id, r.tx_hash, r.log_index, r.block_number,
    r.block_hash, r.agent_id, r.target, r.selector, r.value, r.rationale_hash, r.ts]);
  const expected = rows.map((r) => normalize({ chain_id: r.chainId, tx_hash: r.txHash,
    log_index: r.logIndex, block_number: Number(r.blockNumber), block_hash: r.blockHash,
    agent_id: r.agentId, target: r.target, selector: r.selector, value: String(r.value),
    rationale_hash: r.rationaleHash, ts: r.timestamp })).sort();
  const contents = actual.map(normalize).sort();
  return { actual: actual.length, expected: rows.length,
    ok: JSON.stringify(contents) === JSON.stringify(expected),
    scope: "Independent SQL multiset comparison of every action column, without agent or chain filters" };
}

export function collectBuildIdentity(root = ROOT) {
  const files = {};
  const visit = (path) => {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`build identity refuses symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile()) {
      files[path] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  };
  for (const path of ["package.json", "package-lock.json", "scripts/benchmark-indexer.mjs",
    "packages/indexer/package.json", "packages/indexer/tsconfig.json", "packages/indexer/src", "packages/indexer/dist",
    "packages/core/package.json", "packages/core/src", "packages/core/dist"]) visit(path);
  let git;
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    git = { commit: execFileSync("git", ["rev-parse", "HEAD"], options).trim(),
      dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options).trim().length > 0 };
  } catch { git = { commit: null, dirty: null }; }
  return { algorithm: "sha256", files, git,
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    scope: "Measured workspace source/dist, harness, manifests and lockfile identity; not source-to-build attestation or dependency-byte certification" };
}

export function verifyAgentRows(indexer, rows) {
  const normalize = (row) => JSON.stringify([
    row.chainId, row.txHash, row.logIndex, row.blockHash, row.agentId, row.target,
    row.selector, String(row.value), row.rationaleHash, row.ts, Number(row.blockNumber),
  ]);
  let actualCount = 0;
  let ok = true;
  for (const agentId of new Set(rows.map((row) => row.agentId))) {
    const expected = rows.filter((row) => row.agentId === agentId)
      .map((row) => normalize({ ...row, ts: row.timestamp })).sort();
    const actual = indexer.actionsForAgent(agentId, CHAIN_ID).map(normalize).sort();
    actualCount += actual.length;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) ok = false;
  }
  return { actual: actualCount, expected: rows.length, ok,
    scope: "All fields for generated agents; unknown-agent rows are not covered." };
}

/** Runs one repetition; injected indexers permit offline failure regressions. */
export function runRep(SigilIndexer, silentLogger, mode, rows, rep, tempDir, ownedPaths = new Set()) {
  assertRuntimeFloor(process.versions.node);
  validateWorkload({ rows: rows?.length, reps: rep, seed: 0 });
  if (!MODES.includes(mode)) throw new Error("unsupported storage mode");
  const dbPath = mode === "memory" ? ":memory:" : join(tempDir, `${FILE_PREFIX}${mode}-rep${rep}.sqlite`);
  const record = { rep, mode, dbPath, completed: false, verified: {}, errors: [] };
  let indexer;
  let stage = "reserve";
  try {
    if (mode === "disk") {
      for (const path of tempArtifacts(dbPath)) {
        try { lstatSync(path); throw new Error(`fixture already exists: ${path}`); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      writeFileSync(dbPath, "", { flag: "wx" });
      for (const path of tempArtifacts(dbPath)) ownedPaths.add(path);
    }
    stage = "construct";
    indexer = new SigilIndexer(dbPath, CHAIN_ID, { logger: silentLogger() });
    stage = "freshness";
    record.verified.fresh = verifyWholeTable(indexer, []);
    if (!record.verified.fresh.ok) throw new Error("fixture is not empty before writes");
    const before = process.memoryUsage();
    stage = "write";
    const started = performance.now();
    for (const row of rows) indexer.storeAction(row, row.blockHash, row.chainId);
    record.elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    record.rowsPerSecond = rowsPerSecond(rows.length, record.elapsedMs);
    record.memory = {
      rssBeforeBytes: before.rss, rssAfterBytes: after.rss, rssDeltaBytes: after.rss - before.rss,
      heapUsedBeforeBytes: before.heapUsed, heapUsedAfterBytes: after.heapUsed,
      heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
      externalDeltaBytes: after.external - before.external,
    };
    stage = "readback";
    record.verified.wholeTable = verifyWholeTable(indexer, rows);
    record.verified.allAgentRows = verifyAgentRows(indexer, rows);
    const expected = shapeOf(rows).largestTarget;
    const stored = indexer.actionsForTarget(expected.target, CHAIN_ID).length;
    const spend = indexer.spendByAgent(rows[0].agentId, CHAIN_ID);
    const expectedSpend = rows.filter((r) => r.agentId === rows[0].agentId).reduce((acc, r) => acc + r.value, 0n);
    record.verified.targetRows = { actual: stored, expected: expected.count, ok: stored === expected.count };
    record.verified.agentSpendWei = { actual: String(spend), expected: String(expectedSpend), ok: spend === expectedSpend };
    record.completed = true;
  } catch (error) {
    record.errors.push({ stage, message: error instanceof Error ? error.message : String(error) });
  } finally {
    try { indexer?.close(); }
    catch (error) {
      record.completed = false;
      record.errors.push({ stage: "close", message: error instanceof Error ? error.message : String(error) });
    }
  }
  try { record.fileBytes = mode === "disk" ? statSync(dbPath).size : 0; }
  catch (error) {
    record.completed = false;
    record.errors.push({ stage: "file-size", message: String(error) });
  }
  return record;
}

// ── main ───────────────────────────────────────────────────────────────────────

export async function runBenchmark({ rows, reps, seed, now = () => new Date(), log = console.log } = {}, dependencies = {}) {
  // Enforce the Node floor before ANY other work: no dist lookup, no dynamic import, no
  // mkdir, no SQLite handle. On an unsupported runtime this throws and nothing is written.
  const runtime = assertRuntimeFloor(process.versions.node);
  validateWorkload({ rows, reps, seed });
  if (!workerData?.benchmarkWorker && Object.keys(dependencies).every((key) => key === "outDir")) {
    const generatedAt = now().toISOString();
    return new Promise((resolveRun, rejectRun) => {
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
        workerData: { benchmarkWorker: true, rows, reps, seed, generatedAt, outDir: dependencies.outDir },
      });
      let result;
      worker.on("message", (message) => { result = message; });
      worker.on("error", rejectRun);
      worker.on("exit", (code) => {
        if (code !== 0 || !result) return rejectRun(new Error(`benchmark worker exited without a report (${code})`));
        if (result.error) {
          const error = new Error(result.error);
          error.report = result.report;
          error.reportWriteFailed = result.reportWriteFailed;
          rejectRun(error);
          return;
        }
        try { assertValidReport(result.report); }
        catch (error) { rejectRun(error); return; }
        log(`wrote ${result.report.fixture.reportPath}`);
        resolveRun(result.report);
      });
    });
  }

  const outDir = dependencies.outDir ?? OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const runDir = mkdtempSync(join(outDir, "benchmark-run-"));
  const tempDir = join(runDir, "fixtures");
  const reportPath = join(runDir, "benchmark.json");
  const datasetRows = makeSyntheticRows(rows, seed);
  const dataset = { ...shapeOf(datasetRows), sha256: createHash("sha256")
    .update(JSON.stringify(datasetRows, (_, value) => typeof value === "bigint" ? String(value) : value)).digest("hex") };
  const warnings = [];
  const errors = [];
  const createdFiles = new Set();
  const results = Object.fromEntries(MODES.map((mode) => [mode, { reps: [], summary: null }]));
  let cleanup;
  let build;
  try {
    mkdirSync(tempDir);
    build = (dependencies.collectIdentity ?? collectBuildIdentity)();
    const { SigilIndexer, silentLogger } = dependencies.load ? await dependencies.load() : {
      ...(await import(pathToFileURL(INDEXER_ENTRY).href)), ...(await import("@sigilkit/core")),
    };
    for (const mode of MODES) {
      const repRecords = results[mode].reps;
      for (let rep = 1; rep <= reps; rep++) {
        const record = runRep(SigilIndexer, silentLogger, mode, datasetRows, rep, tempDir, createdFiles);
        repRecords.push(record);
        if (!record.completed) break;
      }
      if (repRecords.length === reps && repRecords.every((r) => r.completed)) {
        results[mode].summary = summarizeReps(repRecords, rows);
        if (mode === "disk") {
          results[mode].fileBytes = { median: Math.round(median(repRecords.map((r) => r.fileBytes))) };
          results[mode].bytesPerRow = { median: round(median(repRecords.map((r) => r.fileBytes / rows)), 1) };
        }
      }
    }
    const after = (dependencies.collectIdentity ?? collectBuildIdentity)();
    build = { ...build, stable: build.digest === after.digest, afterDigest: after.digest };
  } catch (error) {
    errors.push({ stage: "execution", message: error instanceof Error ? error.message : String(error) });
  } finally {
    cleanup = cleanupArtifacts(createdFiles, { tempDir, tempDirPreExisted: false, ...dependencies.cleanupOptions });
  }

  if (cleanup.refused.length > 0) {
    warnings.push(`cleanup refused for ${cleanup.refused.length} file(s): ${cleanup.refused[0].reason}`);
  }

  const report = buildReport({
    generatedAt: workerData?.benchmarkWorker ? workerData.generatedAt : now().toISOString(),
    errors,
    fixture: { runDir, tempDir, reportPath, exclusive: true },
    build: { ...build, injected: Object.keys(dependencies).some((key) => key !== "outDir") },
    target: {
      module: "packages/indexer/dist/index.js",
      class: "SigilIndexer",
      method: "storeAction",
      source: "built dist artifact (never src/)",
      options: "{ logger: silentLogger() } — class defaults, no PRAGMA tuning",
      timedRegion: "the storeAction loop only; read-back verification runs after the clock stops",
      writeMix: "unique natural keys — pure INSERT, no upsert conflict branch",
    },
    config: {
      rows,
      reps,
      seed,
      modes: MODES,
      chainId: CHAIN_ID,
      caps: { maxRows: MAX_ROWS, maxReps: MAX_REPS },
      defaults: { rows: DEFAULT_ROWS, reps: DEFAULT_REPS, seed: DEFAULT_SEED },
    },
    dataset,
    environment: { ...collectEnvironment(), runtime },
    results,
    cleanup,
    warnings,
    notes: [
      "Offline and reproducible: synthetic ActionLogged records from a seeded mulberry32 PRNG, no RPC, no fixtures, no network.",
      "No optimized or hypothetical path is measured: no WAL/synchronous pragma, no batched transaction, no statement cache, no in-memory-only shortcut for the disk mode.",
      `Runtime floor enforced before any database work: Node ${REQUIRED_NODE_MAJOR}+ (engines.node); the run aborts and writes no report otherwise.`,
      "Elapsed time is wall-clock around the storeAction loop; rows/sec is rows/elapsed; medians are taken across reps (3 by default).",
      "Disk fixtures are exclusively reserved in a unique run directory; owned SQLite paths are cleaned after close, with failures retained in cleanup diagnostics.",
      "Memory figures are process.memoryUsage() deltas across the timed loop, so they include GC noise; treat them as indicative, not as a peak measurement.",
    ],
  });

  let reportWriteFailed = false;
  try { writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    reportWriteFailed = true;
    errors.push({ stage: "report-write", message: error instanceof Error ? error.message : String(error) });
  }

  if (workerData?.benchmarkWorker) {
    parentPort.postMessage({ report, reportWriteFailed, error: reportWriteFailed ? "report write failed" : null });
    return report;
  }

  log(`wrote ${reportPath}`);
  assertValidReport(report);
  for (const mode of MODES) {
    const s = results[mode].summary;
    log(
      `${mode.padEnd(6)} rows=${rows} reps=${reps} elapsedMedian=${s.elapsedMs.median}ms rowsPerSecMedian=${s.rowsPerSecond.median}` +
        (mode === "disk" ? ` fileMedian=${results.disk.fileBytes.median}B` : ""),
    );
  }
  log(`cleanup: removed ${cleanup.removedFiles.length}/${cleanup.createdFiles.length} created files; leftovers=${cleanup.leftoverFiles.length}`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  await runBenchmark(args);
}

const isMain = isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err.report) console.error(JSON.stringify(err.report, null, 2));
    process.exitCode = 1;
  });
}

// Worker bootstrap: a fresh worker has a fresh ESM module cache, so the dist artifact
// imported here is re-read from disk — the hashed build identity is the executed code.
if (!isMainThread && workerData?.benchmarkWorker) {
  runBenchmark(
    { rows: workerData.rows, reps: workerData.reps, seed: workerData.seed, now: () => new Date(workerData.generatedAt) },
    { outDir: workerData.outDir },
  ).catch((error) => {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error), report: error.report ?? null });
  });
}
