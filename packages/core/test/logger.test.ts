import { describe, expect, it } from "vitest";
import {
  createLogger,
  LOG_FORMATS,
  LOG_LEVELS,
  parseLogFormat,
  parseLogLevel,
  silentLogger,
  type LogFields,
} from "../src/logger.js";

const FIXED = new Date("2026-09-15T05:36:20.123Z");

/** Collects output into two arrays instead of the console. */
function sink(): { out: string[]; err: string[]; opts: { out: (l: string) => void; err: (l: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, opts: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

function make(level: (typeof LOG_LEVELS)[number], format: "text" | "json" = "text", scope = "indexer") {
  const s = sink();
  const log = createLogger({ level, format, scope, now: () => FIXED, ...s.opts });
  return { log, ...s };
}

describe("level filtering", () => {
  it("drops lines below the configured floor", () => {
    const { log, out } = make("warn");
    log.debug("d");
    log.info("i");
    expect(out).toHaveLength(0);
    log.warn("w");
    expect(out).toHaveLength(1);
  });

  it("emits everything at debug", () => {
    const { log, out } = make("debug");
    log.debug("d");
    log.info("i");
    log.warn("w");
    expect(out).toHaveLength(3);
  });

  it("silences everything, including errors", () => {
    const { log, out, err } = make("silent");
    log.error("boom");
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(0);
  });

  it("routes errors to the error sink only", () => {
    const { log, out, err } = make("debug");
    log.error("boom");
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
  });
});

describe("text format", () => {
  it("renders timestamp, level, scope, message and fields", () => {
    const { log, out } = make("info");
    log.info("stored events", { count: 3, chainId: 8453 });
    expect(out[0]).toBe(`${FIXED.toISOString()}  INFO  indexer  stored events count=3 chainId=8453`);
  });

  it("quotes string fields and skips undefined ones", () => {
    const { log, out } = make("info");
    log.info("x", { a: "plain", b: undefined, c: { nested: true } });
    expect(out[0]).toContain("a=plain");
    expect(out[0]).toContain('c={"nested":true}');
    expect(out[0]).not.toContain("b=");
  });

  it("omits the scope tag when there is no scope", () => {
    const { log, out } = make("info", "text", "");
    log.info("hello");
    expect(out[0]).toBe(`${FIXED.toISOString()}  INFO   hello`);
  });
});

describe("json format", () => {
  it("emits one JSON object per line", () => {
    const { log, out } = make("info", "json");
    log.info("stored", { count: 2 });
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ts: FIXED.toISOString(), level: "info", scope: "indexer", msg: "stored", count: 2 });
  });

  it("serializes bigint fields as strings", () => {
    const { log, out } = make("info", "json");
    log.info("spend", { totalWei: 10n ** 18n });
    expect(JSON.parse(out[0] as string).totalWei).toBe("1000000000000000000");
  });

  it("attaches error details when an error is passed", () => {
    const { log, err } = make("info", "json");
    log.error("failed", { attempt: 2 }, new Error("boom"));
    const parsed = JSON.parse(err[0] as string) as { error: { name: string; message: string } };
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("boom");
  });

  it("serializes a non-Error throwable", () => {
    const { log, err } = make("info", "json");
    log.error("failed", undefined, "plain");
    expect(JSON.parse(err[0] as string).error).toBe("plain");
  });
});

describe("child loggers", () => {
  it("compose scopes and inherit level, format and sinks", () => {
    const { log, out } = make("debug", "text", "indexer");
    log.child("poll").info("tick");
    expect(out[0]).toContain("indexer.poll");
    expect(out[0]).toContain("tick");
  });

  it("use the child scope alone when the parent has none", () => {
    const { log, out } = make("debug", "text", "");
    log.child("mcp").info("up");
    expect(out[0]).toContain("mcp");
  });
});

describe("resilience", () => {
  it("never throws when the sink fails", () => {
    const log = createLogger({
      level: "debug",
      out: () => {
        throw new Error("EPIPE");
      },
      err: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => log.info("x")).not.toThrow();
    expect(() => log.error("x")).not.toThrow();
  });

  it("silentLogger discards everything", () => {
    const log = silentLogger();
    expect(log.level).toBe("silent");
    expect(() => log.error("nothing")).not.toThrow();
  });
});

describe("parsers", () => {
  it("accept the documented values case-insensitively", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogFormat("JSON")).toBe("json");
  });

  it("fall back for undefined, blank or unknown input", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("   ")).toBe("info");
    expect(parseLogLevel("loud")).toBe("info");
    expect(parseLogFormat(undefined)).toBe("text");
    expect(parseLogFormat("xml")).toBe("text");
    expect(parseLogLevel(undefined, "warn")).toBe("warn");
  });

  it("export the supported sets", () => {
    expect(LOG_LEVELS).toContain("silent");
    expect(LOG_FORMATS).toEqual(["text", "json"]);
  });
});

describe("field handling", () => {
  it("accepts arbitrary field bags without mutating them", () => {
    const fields: LogFields = { a: 1 };
    const { log } = make("info");
    log.info("x", fields);
    expect(fields).toEqual({ a: 1 });
  });
});
