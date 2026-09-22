import assert from "node:assert/strict";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  DEFAULT_REPS,
  DEFAULT_ROWS,
  DEFAULT_SEED,
  MAX_REPS,
  MAX_ROWS,
  buildReport,
  assertValidReport,
  runRep,
  runBenchmark,
  verifyAgentRows,
  assertRuntimeFloor,
  checkRuntime,
  cleanupArtifacts,
  makeSyntheticRows,
  median,
  parseArgs,
  round,
  rowsPerSecond,
  shapeOf,
  summarizeReps,
  tempArtifacts,
  usage,
} from "./benchmark-indexer.mjs";

// Lifecycle tests use isolated, test-owned directories and injected indexers.
// No built workspace artifact is required by this helper suite.

test("importing the module exposes the harness without running it", () => {
  // If importing had executed main(), the process would have benchmarked and exited; the
  // exports below would be unreachable. The filesystem is deliberately not asserted on,
  // because the temp directory is shared state on a machine where a run may be in flight.
  assert.equal(typeof cleanupArtifacts, "function");
  assert.match(usage(), /benchmark-indexer\.mjs/);
  assert.match(usage(), /--rows/);
});

test("round keeps numbers numeric and passes non-finite values through", () => {
  assert.equal(round(1.23456, 3), 1.235);
  assert.equal(round(2, 3), 2);
  assert.equal(round(Infinity), Infinity);
  assert.equal(round(0.5, 0), 1);
});

test("median handles odd, even, single and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), 0);
  assert.equal(median([5, 5, 5]), 5);
});

test("rowsPerSecond never returns Infinity for a non-positive elapsed time", () => {
  assert.equal(rowsPerSecond(1000, 500), 2000);
  assert.equal(rowsPerSecond(250, 0), 0);
  assert.equal(rowsPerSecond(250, -1), 0);
});

test("summarizeReps takes the median across reps and reports min/max", () => {
  const rep = (elapsedMs, rssDeltaBytes = 0, heapUsedDeltaBytes = 0) => ({
    elapsedMs,
    rowsPerSecond: rowsPerSecond(100, elapsedMs),
    memory: { rssDeltaBytes, heapUsedDeltaBytes },
  });
  const summary = summarizeReps([rep(100, 10, 1), rep(300, 30, 3), rep(200, 20, 2)], 100);
  assert.equal(summary.reps, 3);
  assert.equal(summary.rowsPerRep, 100);
  assert.equal(summary.elapsedMs.median, 200);
  assert.equal(summary.elapsedMs.min, 100);
  assert.equal(summary.elapsedMs.max, 300);
  assert.equal(summary.rowsPerSecond.median, 500);
  assert.equal(summary.rssDeltaBytes.median, 20);
  assert.equal(summary.heapUsedDeltaBytes.median, 2);
});

test("summarizeReps works with a single rep", () => {
  const summary = summarizeReps(
    [{ elapsedMs: 50, rowsPerSecond: 20, memory: { rssDeltaBytes: -5, heapUsedDeltaBytes: 7 } }],
    1,
  );
  assert.equal(summary.elapsedMs.median, 50);
  assert.equal(summary.rowsPerSecond.median, 20);
  assert.equal(summary.rssDeltaBytes.median, -5);
});

test("makeSyntheticRows is deterministic per seed and varies across seeds", () => {
  const a = makeSyntheticRows(50, 1234);
  const b = makeSyntheticRows(50, 1234);
  const c = makeSyntheticRows(50, 1235);
  assert.equal(a.length, 50);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("makeSyntheticRows produces well-formed ActionLogged records", () => {
  const rows = makeSyntheticRows(16, DEFAULT_SEED);
  for (const row of rows) {
    assert.match(row.agentId, /^0x[0-9a-f]{64}$/);
    assert.match(row.target, /^0x[0-9a-f]{40}$/);
    assert.match(row.selector, /^0x[0-9a-f]{8}$/);
    assert.match(row.rationaleHash, /^0x[0-9a-f]{64}$/);
    assert.match(row.txHash, /^0x[0-9a-f]{64}$/);
    assert.match(row.blockHash, /^0x[0-9a-f]{64}$/);
    assert.equal(typeof row.value, "bigint");
    assert.ok(row.value > 0n);
    assert.equal(row.logIndex, 0);
    assert.equal(typeof row.timestamp, "number");
    assert.equal(typeof row.blockNumber, "bigint");
  }
  // Unique txHash per row → the natural key never collides, so every write is an INSERT.
  assert.equal(shapeOf(rows).keyCollisions, 0);
});

test("makeSyntheticRows honours the row count and the chain id", () => {
  assert.equal(makeSyntheticRows(0, 1).length, 0);
  assert.equal(makeSyntheticRows(1, 1).length, 1);
  assert.equal(makeSyntheticRows(3, 1, 10).every((r) => r.chainId === 10), true);
});

test("shapeOf counts distinct actors and reports the block span", () => {
  const rows = [
    { agentId: "a", target: "t1", selector: "s1", txHash: "x1", value: 10n, blockNumber: 5n },
    { agentId: "a", target: "t1", selector: "s2", txHash: "x2", value: 20n, blockNumber: 7n },
    { agentId: "b", target: "t2", selector: "s1", txHash: "x3", value: 30n, blockNumber: 6n },
  ];
  const shape = shapeOf(rows, 8453);
  assert.equal(shape.rows, 3);
  assert.equal(shape.chainId, 8453);
  assert.equal(shape.uniqueAgents, 2);
  assert.equal(shape.uniqueTargets, 2);
  assert.equal(shape.uniqueSelectors, 2);
  assert.equal(shape.uniqueTxHashes, 3);
  assert.equal(shape.keyCollisions, 0);
  assert.equal(shape.firstBlock, 5);
  assert.equal(shape.lastBlock, 7);
  assert.equal(shape.blockSpan, 2);
  assert.equal(shape.minValueWei, "10");
  assert.equal(shape.maxValueWei, "30");
  assert.equal(shape.totalValueWei, "60");
  assert.deepEqual(shape.largestTarget, { target: "t1", count: 2 });
});

test("shapeOf reports an empty dataset without throwing", () => {
  const shape = shapeOf([]);
  assert.equal(shape.rows, 0);
  assert.equal(shape.blockSpan, 0);
  assert.equal(shape.totalValueWei, "0");
  assert.equal(shape.largestTarget, null);
});

test("shapeOf counts colliding natural keys as collisions", () => {
  const rows = [
    { agentId: "a", target: "t", selector: "s", txHash: "same", value: 1n, blockNumber: 1n },
    { agentId: "a", target: "t", selector: "s", txHash: "same", value: 1n, blockNumber: 1n },
  ];
  assert.equal(shapeOf(rows).keyCollisions, 1);
});

test("checkRuntime compares the node major against the required major", () => {
  assert.equal(checkRuntime("24.13.3").satisfiesRequired, true);
  assert.equal(checkRuntime("v24.0.0").satisfiesRequired, true);
  assert.equal(checkRuntime("25.1.0").satisfiesRequired, true);
  assert.equal(checkRuntime("22.22.2").satisfiesRequired, false);
  assert.equal(checkRuntime("22.22.2").major, 22);
  assert.equal(checkRuntime("nonsense").major, 0);
  assert.equal(checkRuntime("22.22.2", 22).satisfiesRequired, true);
});

test("assertRuntimeFloor rejects Node below the required major", () => {
  // The floor is a hard guard: an unsupported runtime must abort, not emit a report.
  assert.throws(() => assertRuntimeFloor("22.22.2"), /unsupported runtime/);
  assert.throws(() => assertRuntimeFloor("22.22.2"), /Node 22\.22\.2/);
  assert.throws(() => assertRuntimeFloor("22.22.2"), /required Node 24/);
  assert.throws(() => assertRuntimeFloor("nonsense"), /unsupported runtime/);
});

test("assertRuntimeFloor returns the runtime record at or above the floor", () => {
  const ok = assertRuntimeFloor("24.12.0");
  assert.equal(ok.major, 24);
  assert.equal(ok.satisfiesRequired, true);
  assert.equal(assertRuntimeFloor("v24.0.0").major, 24);
  assert.equal(assertRuntimeFloor("25.1.0").satisfiesRequired, true);
});

test("assertRuntimeFloor honours a lowered floor for injected runtimes", () => {
  assert.equal(assertRuntimeFloor("22.22.2", 22).major, 22);
  assert.throws(() => assertRuntimeFloor("22.22.2", 23), /required Node 23/);
});

test("tempArtifacts lists the database plus the exact SQLite sidecar paths", () => {
  assert.deepEqual(tempArtifacts("C:/tmp/bench.sqlite"), [
    "C:/tmp/bench.sqlite",
    "C:/tmp/bench.sqlite-journal",
    "C:/tmp/bench.sqlite-wal",
    "C:/tmp/bench.sqlite-shm",
  ]);
});

test("buildReport preserves diagnostics but rejects caller-supplied authority", () => {
  const report = buildReport({
    generatedAt: "2026-09-17T00:00:00.000Z",
    config: { rows: 10, reps: 1 },
    dataset: { rows: 10 },
    environment: { runtime: { satisfiesRequired: true } },
    results: { memory: { summary: {} }, disk: { summary: {} } },
    cleanup: { removedFiles: [] },
    warnings: [],
    notes: ["n"],
    target: { class: "SigilIndexer" },
    authoritative: true,
  });
  assert.equal(report.generatedAt, "2026-09-17T00:00:00.000Z");
  assert.equal(report.authoritative, false);
  assert.equal(report.validity.valid, false);
  assert.equal(report.results.memory.summary, null);
  assert.throws(() => assertValidReport(report), /validation failed/);
  assert.equal(report.config.rows, 10);
  assert.deepEqual(report.notes, ["n"]);
  assert.ok(report.schema.startsWith("sigilkit.benchmark.indexer/"));
});

function reportFixture() {
  const rep = (mode) => ({ rep: 1, mode, completed: true, elapsedMs: 10, rowsPerSecond: 100,
    verified: { fresh: { ok: true }, wholeTable: { ok: true }, targetRows: { ok: true }, agentSpendWei: { ok: true }, allAgentRows: { ok: true } } });
  return { build: { digest: "a".repeat(64), stable: true }, fixture: { exclusive: true },
    cleanup: { tempDirRemoved: true, refused: [], leftoverFiles: [] },
    config: { rows: 1, reps: 1, seed: 1 }, dataset: { rows: 1, keyCollisions: 0 },
    environment: { runtime: { satisfiesRequired: true } },
    results: Object.fromEntries(["memory", "disk"].map((mode) => [mode, { reps: [rep(mode)], summary: { retained: true } }])) };
}

test("valid bounded diagnostics retain summaries without claiming authority", () => {
  const report = buildReport(reportFixture());
  assert.equal(report.validity.valid, true);
  assert.equal(report.authoritative, false);
  assert.deepEqual(report.results.disk.summary, { retained: true });
  assert.doesNotThrow(() => assertValidReport(report));
});

test("each missing or failed check invalidates the entire report", () => {
  for (const key of ["fresh", "wholeTable", "targetRows", "agentSpendWei", "allAgentRows"]) {
    for (const value of [{ ok: false }, undefined]) {
      const input = reportFixture();
      input.results.disk.reps[0].verified[key] = value;
      const report = buildReport(input);
      assert.equal(report.validity.correctness, false);
      assert.equal(report.results.memory.summary, null);
      assert.equal(report.results.disk.summary, null);
      assert.throws(() => assertValidReport(report), (error) => error.report === report);
    }
  }
});

test("incomplete runs, collisions, unsupported runtime and invalid timing fail closed", () => {
  const mutations = [
    (x) => { x.results.disk.reps = []; },
    (x) => { x.results.memory.reps[0].completed = false; },
    (x) => { x.dataset.keyCollisions = 1; },
    (x) => { x.dataset.rows = 0; },
    (x) => { x.environment.runtime.satisfiesRequired = false; },
    ...[0, -1, NaN, Infinity].map((n) => (x) => { x.results.disk.reps[0].elapsedMs = n; }),
  ];
  for (const mutate of mutations) {
    const input = reportFixture();
    mutate(input);
    const report = buildReport(input);
    assert.equal(report.validity.valid, false);
    assert.throws(() => assertValidReport(report), /validation failed/);
  }
});

test("all-agent verification detects field corruption, missing and duplicate rows", () => {
  const rows = makeSyntheticRows(16, 1);
  const stored = rows.map((r) => ({ ...r, value: String(r.value), ts: r.timestamp, blockNumber: Number(r.blockNumber) }));
  const adapter = (data) => ({ actionsForAgent: (id, chain) => data.filter((r) => r.agentId === id && r.chainId === chain) });
  assert.equal(verifyAgentRows(adapter(stored), rows).ok, true);
  for (const field of ["chainId", "txHash", "logIndex", "blockHash", "agentId", "target", "selector", "value", "rationaleHash", "ts", "blockNumber"]) {
    const corrupt = stored.map((r) => ({ ...r }));
    corrupt[1][field] = typeof corrupt[1][field] === "number" ? -1 : "corrupt";
    assert.equal(verifyAgentRows(adapter(corrupt), rows).ok, false, field);
  }
  assert.equal(verifyAgentRows(adapter(stored.slice(1)), rows).ok, false);
  assert.equal(verifyAgentRows(adapter([...stored, stored[0]]), rows).ok, false);
});

test("injected mismatch repetition closes the indexer and fails report completion", () => {
  const rows = makeSyntheticRows(1, 1);
  let closed = false;
  class MismatchIndexer {
    db = { prepare: () => ({ all: () => [] }) };
    storeAction() {}
    actionsForAgent() { return []; }
    actionsForTarget() { return []; }
    spendByAgent() { return 0n; }
    close() { closed = true; }
  }
  const record = runRep(MismatchIndexer, () => ({}), "memory", rows, 1, "/unused");
  assert.equal(closed, true);
  assert.equal(record.verified.allAgentRows.ok, false);
  const input = reportFixture();
  input.results.memory.reps = [record];
  const report = buildReport(input);
  assert.equal(report.authoritative, false);
  assert.throws(() => assertValidReport(report), /validation failed/);
});

test("exported benchmark rejects invalid bounds before database work", async () => {
  for (const config of [{}, { rows: 0, reps: 1, seed: 1 }, { rows: 1, reps: 4, seed: 1 }, { rows: 1, reps: 1, seed: NaN }]) {
    await assert.rejects(runBenchmark(config), /must be an integer between|unsupported runtime/);
  }
});

function ownedTestDirectory(t) {
  const dir = mkdtempSync(resolve("benchmark-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FixtureIndexer {
  records = [];
  db = { prepare: () => ({ all: () => this.records.map((r) => ({ chain_id: r.chainId,
    tx_hash: r.txHash, log_index: r.logIndex, block_number: Number(r.blockNumber), block_hash: r.blockHash,
    agent_id: r.agentId, target: r.target, selector: r.selector, value: String(r.value), rationale_hash: r.rationaleHash, ts: r.timestamp })) }) };
  storeAction(row) { this.records.push(row); }
  actionsForAgent(id) { return this.records.filter((r) => r.agentId === id).map((r) => ({ ...r, ts: r.timestamp })); }
  actionsForTarget(target) { return this.records.filter((r) => r.target === target); }
  spendByAgent(id) { return this.records.filter((r) => r.agentId === id).reduce((sum, r) => sum + r.value, 0n); }
  close() {}
}

function injectedRun(outDir, Indexer = FixtureIndexer, extra = {}) {
  return runBenchmark({ rows: 2, reps: 1, seed: 7, log: () => {} }, {
    outDir, collectIdentity: () => ({ digest: "a".repeat(64) }),
    load: async () => ({ SigilIndexer: Indexer, silentLogger: () => ({}) }), ...extra,
  });
}

test("concurrent runs isolate fixtures and preserve existing operator files", async (t) => {
  const dir = ownedTestDirectory(t);
  const sentinel = join(dir, "bench-indexer-disk-rep1.sqlite");
  writeFileSync(sentinel, "operator-owned");
  const reports = await Promise.all([injectedRun(dir), injectedRun(dir)]);
  assert.notEqual(reports[0].fixture.runDir, reports[1].fixture.runDir);
  assert.equal(readFileSync(sentinel, "utf8"), "operator-owned");
  for (const report of reports) {
    assert.equal(report.validity.valid, true);
    assert.equal(report.authoritative, false);
    assert.equal(report.build.injected, true);
    assert.equal(existsSync(report.fixture.tempDir), false);
    assert.equal(JSON.parse(readFileSync(report.fixture.reportPath)).validity.valid, true);
  }
});

test("preexisting database or sidecar is refused and never registered for deletion", (t) => {
  const dir = ownedTestDirectory(t);
  const db = join(dir, "bench-indexer-disk-rep1.sqlite");
  for (const path of tempArtifacts(db)) {
    writeFileSync(path, "operator-owned");
    const owned = new Set();
    const record = runRep(FixtureIndexer, () => ({}), "disk", makeSyntheticRows(1, 1), 1, dir, owned);
    assert.equal(record.completed, false);
    assert.match(record.errors[0].message, /already exists/);
    assert.equal(owned.size, 0);
    assert.equal(readFileSync(path, "utf8"), "operator-owned");
    rmSync(path);
  }
});

test("construction, write, readback and close failures retain reports and clean owned fixtures", async (t) => {
  for (const stage of ["construct", "write", "readback", "close"]) {
    const dir = ownedTestDirectory(t);
    let closes = 0;
    class Broken extends FixtureIndexer {
      constructor(path) {
        super();
        if (stage === "construct") {
          if (path !== ":memory:") writeFileSync(`${path}-journal`, "owned sidecar");
          throw new Error("injected construct");
        }
      }
      storeAction(row) { if (stage === "write") throw new Error("injected write"); super.storeAction(row); }
      actionsForAgent(id) { if (stage === "readback") throw new Error("injected readback"); return super.actionsForAgent(id); }
      close() { closes++; if (stage === "close") throw new Error("injected close"); }
    }
    await assert.rejects(injectedRun(dir, Broken), (error) => {
      const report = error.report;
      assert.equal(report.validity.valid, false);
      assert.equal(report.results.disk.summary, null);
      assert.equal(report.results.disk.reps[0].errors[0].stage, stage);
      assert.equal(existsSync(report.fixture.tempDir), false);
      assert.equal(JSON.parse(readFileSync(report.fixture.reportPath)).validity.valid, false);
      return true;
    });
    assert.equal(closes, stage === "construct" ? 0 : 2);
  }
});

test("unknown-agent or other-chain rows fail independent whole-table verification", async (t) => {
  for (const mutation of ["unknown-agent", "other-chain"]) {
    class ExtraRow extends FixtureIndexer {
      storeAction(row) {
        super.storeAction(row);
        super.storeAction({ ...row, agentId: "unknown", chainId: mutation === "other-chain" ? 1 : row.chainId });
      }
    }
    await assert.rejects(injectedRun(ownedTestDirectory(t), ExtraRow), (error) => {
      assert.equal(error.report.results.disk.reps[0].verified.wholeTable.ok, false);
      assert.equal(error.report.results.disk.summary, null);
      return true;
    });
  }
});

test("cleanup refusal and changing build identity fail closed with saved diagnostics", async (t) => {
  const dir = ownedTestDirectory(t);
  await assert.rejects(injectedRun(dir, FixtureIndexer, { cleanupOptions: {
    rm: () => { throw new Error("injected refusal"); },
  } }), (error) => {
    assert.equal(error.report.validity.cleanupComplete, false);
    assert.ok(error.report.cleanup.leftoverFiles.length > 0);
    assert.equal(existsSync(error.report.fixture.reportPath), true);
    return true;
  });
  let calls = 0;
  await assert.rejects(injectedRun(dir, FixtureIndexer, { collectIdentity: () => ({ digest: (++calls === 1 ? "a" : "b").repeat(64) }) }),
    (error) => error.report.validity.buildIdentified === false);
});

test("failed benchmark completion yields nonzero child exit and an invalid saved report", (t) => {
  const dir = ownedTestDirectory(t);
  const source = `import {runBenchmark} from ${JSON.stringify(new URL("./benchmark-indexer.mjs", import.meta.url).href)};
    class Broken { constructor() { throw new Error('injected mismatch'); } }
    runBenchmark({rows:1,reps:1,seed:1,log:()=>{}}, {outDir:${JSON.stringify(dir)},
      collectIdentity:()=>({digest:'a'.repeat(64)}), load:async()=>({SigilIndexer:Broken,silentLogger:()=>({})})})
      .catch(()=>{process.exitCode=1});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0], "benchmark.json")));
  assert.equal(report.validity.valid, false);
  assert.equal(report.authoritative, false);
  assert.equal(report.results.disk.summary, null);
});

test("worker-isolated real runs validate the saved report end to end", { skip: !existsSync(resolve("packages/indexer/dist/index.js")) ? "requires the built indexer artifact" : false }, (t) => {
  const dir = ownedTestDirectory(t);
  const source = `import {runBenchmark} from ${JSON.stringify(new URL("./benchmark-indexer.mjs", import.meta.url).href)};
    runBenchmark({rows:2,reps:1,seed:7,log:()=>{}}, {outDir:${JSON.stringify(dir)}})
      .then(()=>{process.exitCode=0}).catch((error)=>{console.error(error.message);process.exitCode=1});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0], "benchmark.json")));
  assert.equal(report.validity.valid, true);
  assert.equal(report.authoritative, false);
  assert.equal(report.build.injected, false);
  assert.equal(report.build.stable, true);
  assert.notEqual(report.results.disk.summary, null);
  assert.equal(report.results.disk.reps[0].verified.wholeTable.ok, true);
  assert.equal(existsSync(report.fixture.tempDir), false);
});

// ── cleanup (injected filesystem — no real files are touched) ───────────────────

const TEMP = "/tmp/bench";

/** Minimal in-memory stand-in for the fs calls cleanupArtifacts makes. */
function fakeFs({ files = [], failOn = null } = {}) {
  const fileSet = new Set(files);
  const dirSet = new Set([TEMP]); // the directory always exists once mkdir has run
  const calls = [];
  const rm = (path, opts) => {
    calls.push(path);
    if (failOn && failOn.test(path)) throw new Error("SAFE_DELETE_BULK_REJECTED");
    if (fileSet.delete(path) || dirSet.delete(path)) return;
    if (opts?.force) return;
    throw new Error(`ENOENT: ${path}`);
  };
  const exists = (path) => fileSet.has(path) || dirSet.has(path);
  const readdir = (path) => [...fileSet].filter((f) => dirname(f) === path).map((f) => basename(f));
  return { rm, rmdir: rm, lstat: () => ({ isSymbolicLink: () => false }), exists, readdir, calls, fileSet };
}

test("cleanupArtifacts deletes the exact created files and removes an empty dir it created", () => {
  const db = `${TEMP}/bench-indexer-disk-rep1.sqlite`;
  const fs = fakeFs({ files: [db] });
  const cleanup = cleanupArtifacts([db], { tempDir: TEMP, tempDirPreExisted: false, ...fs });
  assert.deepEqual(fs.calls, [db, TEMP]);
  assert.deepEqual(cleanup.removedFiles, [db]);
  assert.deepEqual(cleanup.refused, []);
  assert.equal(cleanup.tempDirRemoved, true);
  assert.deepEqual(cleanup.leftoverFiles, []);
});

test("cleanupArtifacts keeps a temp directory that already existed", () => {
  const db = `${TEMP}/bench-indexer-disk-rep1.sqlite`;
  const fs = fakeFs({ files: [db] });
  const cleanup = cleanupArtifacts([db], { tempDir: TEMP, tempDirPreExisted: true, ...fs });
  assert.equal(cleanup.tempDirRemoved, false);
  assert.deepEqual(fs.calls, [db]);
});

test("cleanupArtifacts refuses to delete anything outside the temp directory", () => {
  const inside = `${TEMP}/bench-indexer-disk-rep1.sqlite`;
  const outside = "/etc/passwd";
  const fs = fakeFs({ files: [inside, outside] });
  const cleanup = cleanupArtifacts([inside, outside], { tempDir: TEMP, tempDirPreExisted: true, ...fs });
  assert.equal(fs.calls.includes(outside), false);
  assert.deepEqual(cleanup.removedFiles, [inside]);
  assert.equal(cleanup.refused.length, 1);
  assert.equal(cleanup.refused[0].path, outside);
  assert.match(cleanup.refused[0].reason, /outside the benchmark temp directory/);
});

test("cleanupArtifacts records a refused deletion instead of throwing", () => {
  const db = `${TEMP}/bench-indexer-disk-rep1.sqlite`;
  const fs = fakeFs({ files: [db], failOn: /rep1/ });
  const cleanup = cleanupArtifacts([db], { tempDir: TEMP, tempDirPreExisted: false, ...fs });
  assert.deepEqual(cleanup.removedFiles, []);
  assert.equal(cleanup.refused.length, 1);
  assert.match(cleanup.refused[0].reason, /SAFE_DELETE_BULK_REJECTED/);
  assert.deepEqual(cleanup.leftoverFiles, ["bench-indexer-disk-rep1.sqlite"]);
  assert.equal(cleanup.tempDirRemoved, false);
});

// ── argument cap ────────────────────────────────────────────────────────────────

test("parseArgs applies the bounded defaults", () => {
  assert.deepEqual(parseArgs([]), {
    rows: DEFAULT_ROWS,
    reps: DEFAULT_REPS,
    seed: DEFAULT_SEED,
    help: false,
  });
  assert.equal(DEFAULT_ROWS, MAX_ROWS);
  assert.ok(DEFAULT_ROWS <= 1000);
});

test("parseArgs accepts in-range values in any order", () => {
  assert.deepEqual(parseArgs(["--reps=2", "--rows=250", "--seed=7"]), {
    rows: 250,
    reps: 2,
    seed: 7,
    help: false,
  });
  assert.equal(parseArgs([`--rows=${MAX_ROWS}`]).rows, MAX_ROWS);
  assert.equal(parseArgs([`--reps=${MAX_REPS}`]).reps, MAX_REPS);
  assert.equal(parseArgs(["--seed=0"]).seed, 0);
});

test("parseArgs recognises --help without demanding values", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs rejects rows above the cap", () => {
  assert.throws(() => parseArgs([`--rows=${MAX_ROWS + 1}`]), /--rows must be between 1 and 1000 \(got 1001\)/);
  assert.throws(() => parseArgs(["--rows=100000"]), /deliberately bounded/);
});

test("parseArgs rejects rows below the floor", () => {
  assert.throws(() => parseArgs(["--rows=0"]), /--rows must be between 1 and 1000 \(got 0\)/);
  assert.throws(() => parseArgs(["--rows=-5"]), /--rows must be between 1 and 1000 \(got -5\)/);
});

test("parseArgs rejects reps above the cap", () => {
  assert.throws(() => parseArgs([`--reps=${MAX_REPS + 1}`]), /--reps must be between 1 and 3 \(got 4\)/);
});

test("parseArgs rejects non-integer and out-of-range seeds", () => {
  assert.throws(() => parseArgs(["--seed=abc"]), /--seed must be an integer/);
  assert.throws(() => parseArgs(["--seed=-1"]), /--seed must be between 0 and 4294967295/);
  assert.throws(() => parseArgs(["--seed=4294967296"]), /--seed must be between 0 and 4294967295/);
});

test("parseArgs rejects malformed and unknown arguments instead of ignoring them", () => {
  assert.throws(() => parseArgs(["--rows"]), /unknown argument "--rows"/);
  assert.throws(() => parseArgs(["rows=10"]), /unknown argument "rows=10"/);
  assert.throws(() => parseArgs(["--verbose=true"]), /unknown option "--verbose"/);
  assert.throws(() => parseArgs(["--rows=1.5"]), /--rows must be an integer, got "1\.5"/);
});
