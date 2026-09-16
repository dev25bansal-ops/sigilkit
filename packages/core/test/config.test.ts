import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_DB_PATH,
  indexerChainId,
  loadDotEnv,
  loadServiceConfig,
  loggerFor,
  readEnvAddress,
  readEnvBigInt,
  readEnvBool,
  readEnvChoice,
  readEnvInt,
  readEnvPrivateKey,
  readEnvString,
  readEnvUrl,
  requireEnv,
  resetDotEnvForTests,
  type EnvSource,
} from "../src/config.js";
import { ValidationError } from "../src/validation.js";

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const KEY = ("0x" + "11".repeat(32)) as `0x${string}`;

describe("readEnvString", () => {
  it("returns the value, treats blank as unset, and falls back", () => {
    const env: EnvSource = { A: "x", B: "   " };
    expect(readEnvString(env, "A")).toBe("x");
    expect(readEnvString(env, "B", "fallback")).toBe("fallback");
    expect(readEnvString(env, "MISSING", "fallback")).toBe("fallback");
    expect(readEnvString(env, "MISSING")).toBeUndefined();
  });
});

describe("readEnvInt", () => {
  it("parses and validates bounds", () => {
    expect(readEnvInt({ N: "12" }, "N", { fallback: 1, min: 0 })).toBe(12);
    expect(readEnvInt({}, "N", { fallback: 5 })).toBe(5);
    expect(() => readEnvInt({ N: "abc" }, "N", { fallback: 1 })).toThrow(ValidationError);
    expect(() => readEnvInt({ N: "0" }, "N", { fallback: 1, min: 1 })).toThrow(/below the minimum/);
  });
});

describe("readEnvBool", () => {
  it("accepts the documented spellings", () => {
    for (const t of ["1", "true", "TRUE", "yes", "on"]) {
      expect(readEnvBool({ B: t }, "B", false)).toBe(true);
    }
    for (const f of ["0", "false", "no", "off"]) {
      expect(readEnvBool({ B: f }, "B", true)).toBe(false);
    }
  });

  it("falls back when unset and rejects nonsense", () => {
    expect(readEnvBool({}, "B", true)).toBe(true);
    expect(() => readEnvBool({ B: "maybe" }, "B", false)).toThrow(/expected a boolean/);
  });
});

describe("typed readers", () => {
  it("validates urls, addresses, keys and amounts", () => {
    expect(readEnvUrl({ U: "http://127.0.0.1:8545" }, "U")).toBe("http://127.0.0.1:8545");
    expect(() => readEnvUrl({ U: "not-a-url" }, "U")).toThrow(/absolute URL/);
    expect(readEnvAddress({ A: ALICE }, "A")).toBe(ALICE);
    expect(() => readEnvAddress({ A: "0x1234" }, "A")).toThrow(/20-byte hex address/);
    expect(readEnvPrivateKey({ K: KEY }, "K")).toBe(KEY);
    expect(() => readEnvPrivateKey({ K: "0x" + "00".repeat(32) }, "K")).toThrow(/all-zero/);
    expect(readEnvBigInt({ W: "1000" }, "W", 0n)).toBe(1000n);
    expect(() => readEnvBigInt({ W: "-1" }, "W", 0n)).toThrow(ValidationError);
  });

  it("requireEnv explains what to do when the variable is absent", () => {
    expect(requireEnv({ X: "set" }, "X")).toBe("set");
    expect(() => requireEnv({}, "X", "export X=…")).toThrow(/is required but not set/);
    expect(() => requireEnv({}, "X", "export X=…")).toThrow(/export X=/);
  });
});

describe("loadServiceConfig", () => {
  it("returns working defaults for an empty environment", () => {
    const c = loadServiceConfig({});
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(c.chainId).toBe(ANVIL_CHAIN_ID);
    expect(c.dbPath).toBe(DEFAULT_DB_PATH);
    expect(c.confirmations).toBe(12);
    expect(c.maxBlockRange).toBe(2000);
    expect(c.logLevel).toBe("info");
    expect(c.logFormat).toBe("text");
  });

  it("reads every supported override", () => {
    const c = loadServiceConfig({
      SIGILKIT_RPC_URL: "https://node.example",
      SIGILKIT_CHAIN_ID: "8453",
      SIGILKIT_DB_PATH: "/var/lib/sigilkit/audit.db",
      SIGILKIT_CONFIRMATIONS: "24",
      SIGILKIT_MAX_BLOCK_RANGE: "500",
      SIGILKIT_LOG_LEVEL: "debug",
      SIGILKIT_LOG_FORMAT: "json",
    });
    expect(c).toEqual({
      rpcUrl: "https://node.example",
      chainId: 8453,
      dbPath: "/var/lib/sigilkit/audit.db",
      confirmations: 24,
      maxBlockRange: 500,
      logLevel: "debug",
      logFormat: "json",
    });
  });

  it("rejects a present-but-invalid value instead of silently defaulting", () => {
    expect(() => loadServiceConfig({ SIGILKIT_CHAIN_ID: "base" })).toThrow(/SIGILKIT_CHAIN_ID/);
    expect(() => loadServiceConfig({ SIGILKIT_RPC_URL: "localhost:8545" })).toThrow(/SIGILKIT_RPC_URL/);
  });

  it("rejects a bad log level or format rather than silently defaulting", () => {
    expect(() => loadServiceConfig({ SIGILKIT_LOG_LEVEL: "loud" })).toThrow(/SIGILKIT_LOG_LEVEL/);
    expect(() => loadServiceConfig({ SIGILKIT_LOG_FORMAT: "xml" })).toThrow(/SIGILKIT_LOG_FORMAT/);
  });

  it("accepts log settings case-insensitively", () => {
    expect(loadServiceConfig({ SIGILKIT_LOG_LEVEL: "DEBUG", SIGILKIT_LOG_FORMAT: "JSON" })).toMatchObject({
      logLevel: "debug",
      logFormat: "json",
    });
  });

  it("still falls back when the log variables are absent or blank", () => {
    expect(loadServiceConfig({ SIGILKIT_LOG_LEVEL: "   " }).logLevel).toBe("info");
    expect(loadServiceConfig({}).logFormat).toBe("text");
  });
});

describe("loadDotEnv", () => {
  const touched: string[] = [];
  const dirs: string[] = [];

  /** Creates a temp dir holding the given files, cleaned up by afterAll. */
  function tempDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "sigilkit-env-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  /** Sets a variable for the duration of one test and records it for cleanup. */
  function setEnv(name: string, value: string): void {
    touched.push(name);
    process.env[name] = value;
  }

  afterAll(() => {
    for (const name of touched) delete process.env[name];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when there is no .env", () => {
    resetDotEnvForTests();
    expect(loadDotEnv(tempDir({}))).toEqual([]);
  });

  it("loads .env then .env.local, and never overrides the real environment", () => {
    setEnv("SIGILKIT_TEST_PRESET", "from-real-env");
    const dir = tempDir({
      ".env": "SIGILKIT_TEST_FROM_ENV=file-value\n",
      ".env.local": "SIGILKIT_TEST_PRESET=from-file\nSIGILKIT_TEST_LOCAL=local-value\n",
    });

    resetDotEnvForTests();
    expect(loadDotEnv(dir)).toEqual([".env", ".env.local"]);

    expect(process.env.SIGILKIT_TEST_FROM_ENV).toBe("file-value");
    expect(process.env.SIGILKIT_TEST_LOCAL).toBe("local-value");
    // The whole point of the convention: a real env var (CI, docker, shell) always wins.
    expect(process.env.SIGILKIT_TEST_PRESET).toBe("from-real-env");

    delete process.env.SIGILKIT_TEST_FROM_ENV;
    delete process.env.SIGILKIT_TEST_LOCAL;
  });

  it("only loads once per process", () => {
    const dir = tempDir({ ".env": "SIGILKIT_TEST_ONCE=1\n" });
    resetDotEnvForTests();
    expect(loadDotEnv(dir)).toEqual([".env"]);
    expect(loadDotEnv(dir)).toEqual([]);
    delete process.env.SIGILKIT_TEST_ONCE;
  });

  it("tolerates .env.local on its own", () => {
    const dir = tempDir({ ".env.local": "SIGILKIT_TEST_LOCAL_ONLY=yes\n" });
    resetDotEnvForTests();
    expect(loadDotEnv(dir)).toEqual([".env.local"]);
    expect(process.env.SIGILKIT_TEST_LOCAL_ONLY).toBe("yes");
    delete process.env.SIGILKIT_TEST_LOCAL_ONLY;
  });
});

describe("readEnvChoice", () => {
  it("returns the fallback when unset and matches case-insensitively", () => {
    expect(readEnvChoice({}, "MODE", ["fast", "slow"] as const, "fast")).toBe("fast");
    expect(readEnvChoice({ MODE: "SLOW" }, "MODE", ["fast", "slow"] as const, "fast")).toBe("slow");
  });

  it("lists the allowed values when the input is unrecognized", () => {
    expect(() => readEnvChoice({ MODE: "medium" }, "MODE", ["fast", "slow"] as const, "fast")).toThrow(
      /fast \| slow/,
    );
  });
});

describe("indexerChainId", () => {
  it("prefers the indexer-specific variable, then the shared one, then the fallback", () => {
    expect(indexerChainId({ SIGILKIT_INDEXER_CHAIN_ID: "10", SIGILKIT_CHAIN_ID: "8453" }, 1)).toBe(10);
    expect(indexerChainId({ SIGILKIT_CHAIN_ID: "8453" }, 1)).toBe(8453);
    expect(indexerChainId({}, 31337)).toBe(31337);
    expect(() => indexerChainId({ SIGILKIT_INDEXER_CHAIN_ID: "abc" }, 1)).toThrow(/SIGILKIT_INDEXER_CHAIN_ID/);
  });
});

describe("loggerFor", () => {
  it("builds a logger carrying the configured level and scope", () => {
    const log = loggerFor({ logLevel: "warn", logFormat: "json" }, "indexer");
    expect(log.level).toBe("warn");
    expect(log.scope).toBe("indexer");
  });
});
