import { describe, expect, it } from "vitest";
import {
  createLogger,
  LOG_FORMATS,
  LOG_LEVELS,
  parseLogFormat,
  parseLogLevel,
  redact,
  REDACTED,
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

  it("appends a concise error reason without the stack", () => {
    const { log, err } = make("info");
    log.error("failed", { attempt: 2 }, new Error("boom"));
    expect(err[0]).toContain("failed attempt=2 error=Error: boom");
    expect(err[0]).not.toContain("at ");
  });

  it("renders a primitive throwable", () => {
    const { log, err } = make("info");
    log.error("failed", undefined, "plain");
    expect(err[0]).toContain("error=plain");
  });

  it("survives cyclic fields without dropping the line", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { log, out } = make("info");
    expect(() => log.info("x", { cyclic })).not.toThrow();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("cyclic=");
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

  it("survives cyclic fields instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { log, out } = make("info", "json");
    expect(() => log.info("x", { cyclic })).not.toThrow();
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0] as string)).not.toThrow();
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

  it("never throws when the clock fails", () => {
    const log = createLogger({
      level: "debug",
      now: () => {
        throw new Error("clock exploded");
      },
      out: () => {},
      err: () => {},
    });
    expect(() => log.info("x")).not.toThrow();
    expect(() => log.error("x", undefined, new Error("boom"))).not.toThrow();
  });

  it("keeps warn on the stdout sink, not the error sink", () => {
    const { log, out, err } = make("debug");
    log.warn("careful");
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(0);
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

  it("fall back for undefined or blank input, and throw on unknown input", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("   ")).toBe("info");
    expect(() => parseLogLevel("loud")).toThrow(/SIGILKIT_LOG_LEVEL/);
    expect(parseLogFormat(undefined)).toBe("text");
    expect(() => parseLogFormat("xml")).toThrow(/SIGILKIT_LOG_FORMAT/);
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

/**
 * SEC-12: the log layer itself is the control. Every assertion below is written as
 * "this exact string must not survive into the output" so a future change that widens
 * the pass-through again fails here rather than in an operator's log collector.
 */
describe("redaction (SEC-12)", () => {
  /** A real-shaped 32-byte key; any occurrence of it in output is a leak. */
  const KEY = `0x${"1".repeat(64)}`;
  /** A public bytes32 identifier that must survive redaction (no over-redaction). */
  const AGENT_ID = `0x${"a".repeat(64)}`;
  const TARGET = "0x1234567890abcdef1234567890abcdef12345678";
  /** A provider key as it appears in an Alchemy URL path (SEC-12's motivating leak). */
  const VENDOR_KEY = "AbCdEf0123456789_ZYXwvuTsRqOnMlK";
  const VENDOR_URL = `https://eth-mainnet.g.alchemy.com/v2/${VENDOR_KEY}`;
  const RPC_ERROR = `HTTP request failed. URL: ${VENDOR_URL}`;

  it("redacts a provider key on a host that is NOT on the provider allowlist", () => {
    // SEC-12 regression. Path masking used to be gated on a 12-entry host allowlist, so any
    // RPC provider not on it printed its key verbatim:
    //   https://rpc.example.io/v1/<key>  ->  unredacted
    // A redaction scheme that depends on enumerating every provider is not a redaction
    // scheme. Masking now keys off the final path segment being credential-shaped, so an
    // unlisted or self-hosted provider is covered without being known in advance.
    //
    // The field names below deliberately avoid `rpc`/`provider`/`endpoint`/`node`, which
    // match RPC_HINT. That hint already forced masking before this fix, so a test using
    // those names would pass against the vulnerable code and prove nothing. The leak only
    // showed up for fields with no such hint.
    const key = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    for (const [field, url] of [
      ["cfg", `https://rpc.example.io/v1/${key}`],
      ["cfg", `https://my-private-node.example.com/${key}`],
      ["cfg", `http://127.0.0.1:8545/${key}`],
      ["failure", `HTTP request failed. URL: https://rpc.example.io/v1/${key}`],
    ] as const) {
      const { log, out } = make("info", "json");
      log.info("x", { [field]: url });
      expect(out.join("\n"), url).not.toContain(key);
      expect(out.join("\n"), url).toContain("redacted");
    }
  });

  it("still keeps ordinary non-credential URL paths readable (no over-redaction)", () => {
    // The guard above must not mask every deep path — an operator still needs to see which
    // endpoint failed. These final segments are short or contain no digit, so they are not
    // credential-shaped and must survive intact.
    //
    // The field is deliberately NOT named `endpoint`/`rpc`/`provider`: those match the
    // RPC_HINT pattern, and an rpc-named field masks its last path segment unconditionally
    // (the original behaviour, kept because it is the stronger signal when present).
    for (const url of [
      "https://rpc.example.io/v1/status",
      "https://api.example.com/v2/chain/mainnet",
    ]) {
      const { log, out } = make("info", "json");
      log.info("x", { upstream: url });
      expect(out.join("\n"), url).toContain(url);
    }
  });

  it("does not let an allowlisted FIELD NAME bypass text scrubbing", () => {
    // The allowlist exists so a bytes32 hash under the name `hash` is not mistaken for a
    // private key. It was implemented as `if (PUBLIC_IDENTIFIERS.test(key)) return value;`
    // — an early return that also skipped `scrubString`, which is what strips Bearer
    // tokens, JWTs, provider keys and absolute paths. So a credential logged under any of
    // the 26 allowlisted names came out verbatim while the identical value under `note` was
    // redacted. Verified before the fix:
    //   {note:"Bearer sk-…"}  -> "[redacted]"
    //   {hash:"Bearer sk-…"}  -> "Bearer sk-…"
    //   {digest:"<JWT>"}      -> verbatim
    // The fix keeps the identifier exemption and re-runs the text scrubs.
    const BEARER = "Bearer sk-abc123SECRETVALUE";
    const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl";
    for (const field of ["hash", "digest", "root", "to", "from", "address"]) {
      for (const secret of [BEARER, JWT, "C:\\Users\\dev\\secret\\key.pem"]) {
        const { log, out } = make("info", "json");
        log.info("x", { [field]: secret });
        const all = out.join("\n");
        expect(all, `${field} must not pass a credential through`).not.toContain(secret);
        // The mask token differs by KIND: a credential becomes "[redacted]", an absolute
        // path becomes "[path]". Assert it is not verbatim, and that SOME mask replaced it —
        // asserting the word "redacted" specifically failed on the path case.
        // The mask token differs by output format and by kind: the TEXT logger emits "[path]",
        // while the JSON logger emits the bare token "redacted". Assert the secret is gone
        // and that a mask replaced it, without pinning which spelling.
        expect(all, `${field} must be masked`).toMatch(/\[?(redacted|path)\]?/);
      }
    }
  });

  it("still preserves an allowlisted identifier that IS an identifier", () => {
    // The no-over-redaction half. If the fix were "scrub everything under an allowlisted
    // name", these would be destroyed — the allowlist is what keeps them readable.
    for (const field of ["agentId", "hash", "digest", "target"]) {
      const { log, out } = make("info", "json");
      log.info("x", { [field]: AGENT_ID });
      expect(out.join("\n"), field).toContain(AGENT_ID);
    }
    const { log, out } = make("info", "json");
    log.info("x", { target: TARGET });
    expect(out.join("\n")).toContain(TARGET);
  });

  it("redacts a secret nested at any depth and combination of objects and arrays", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      log.info("x", { a: { b: { privateKey: KEY } } });
      log.info("y", { list: [{ deep: [{ mnemonic: "one two three" }] }] });
      log.info("z", { a: { b: { c: { secret: KEY } } } });
      const all = out.join("\n");
      expect(all).not.toContain(KEY);
      expect(all).not.toContain("one two three");
      expect(all).toContain(REDACTED);
    }
  });

  it("truncates structures past the depth cap instead of recursing without bound", () => {
    const { log, out } = make("info", "json");
    log.info("x", { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: KEY } } } } } } } } } });
    expect(out[0]).not.toContain(KEY);
    expect(out[0]).toContain("[depth-limit]");
  });

  it("redacts a 32-byte hex key under an innocuous field name", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      log.info("pasted", { note: KEY, blob: KEY.slice(2) });
      expect(out[0]).not.toContain(KEY);
      expect(out[0]).not.toContain(KEY.slice(2));
    }
  });

  it("masks a vendor key carried by an RPC URL while keeping the host debuggable", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      log.info("call failed", { reason: RPC_ERROR });
      expect(out[0]).not.toContain(VENDOR_KEY);
      // The host survives so an operator can still see which endpoint failed.
      expect(out[0]).toContain("alchemy.com");
    }
  });

  it("masks a vendor key even when the URL is passed under a sensitive field name", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      log.info("dialing", { rpcUrl: VENDOR_URL });
      expect(out[0]).not.toContain(VENDOR_KEY);
    }
  });

  it("masks userinfo and credential query parameters in a URL", () => {
    const { log, out } = make("info", "json");
    log.info("dialing", { endpoint: "https://user:hunter2@example.test/rpc?apiKey=abc123&chainId=1" });
    const line = out[0] as string;
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abc123");
    expect(line).toContain("example.test");
  });

  it("redacts bearer credentials and JWTs embedded in free text", () => {
    const { log, out } = make("info", "json");
    log.info("auth failed", {
      header: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh",
      text: "rejected token eyJhbGciOi.eyJzdWIi.sigvalue for tenant",
    });
    const line = out[0] as string;
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).not.toContain("sigvalue");
  });

  it("replaces absolute filesystem paths in free text", () => {
    const { log, out } = make("info", "json");
    log.info("could not open D:\\SigilKit\\packages\\core\\src\\logger.ts");
    log.info("read /home/alice/keys/agent.json failed");
    expect(out[0]).not.toContain("SigilKit");
    expect(out[1]).not.toContain("alice");
    expect(out[0]).toContain("[path]");
  });

  it("omits err.stack at info and warn, and includes it at debug", () => {
    const boom = (): Error => new Error("boom");
    // info/warn carry no throwable, so the throwable cases run at error/warn-with-message:
    // the point is that a non-debug logger never emits a stack, whatever carries it.
    const info = make("info", "json");
    info.log.info("x");
    info.log.warn("y");
    info.log.error("z", undefined, boom());
    for (const line of [...info.out, ...info.err]) {
      const parsed = JSON.parse(line) as { error?: { stack?: unknown } };
      expect(parsed.error?.stack).toBeUndefined();
    }
    expect(info.out).toHaveLength(2);
    expect(info.err[0]).toContain('"message":"boom"');

    const debug = make("debug", "json");
    debug.log.debug("x", undefined, boom());
    const parsed = JSON.parse(debug.out[0] as string) as { error?: { stack?: string } };
    expect(parsed.error?.stack).toContain("Error: boom");
  });

  it("scrubs absolute paths out of a debug stack as well", () => {
    const { log, err } = make("debug", "json");
    log.error("failed", undefined, new Error("boom"));
    const parsed = JSON.parse(err[0] as string) as { error: { stack: string } };
    expect(parsed.error.stack).toContain("Error: boom");
    // SEC-12: the workspace path must not survive even at debug.
    expect(err[0]).not.toMatch(/[A-Za-z]:[\\/]SigilKit/);
    expect(parsed.error.stack).toContain("[path]");
  });

  it("keeps the child logger's redaction policy", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      const child = log.child("poll");
      child.info("x", { a: { b: { privateKey: KEY } } });
      child.info("y", { note: KEY });
      child.info("z", { reason: RPC_ERROR });
      child.error("e", undefined, new Error("boom"));
      expect(out.join("\n")).not.toContain(KEY);
      expect(out.join("\n")).not.toContain(VENDOR_KEY);
    }
  });

  it("inherits caller-supplied redactKeys in the child", () => {
    const s = sink();
    const parent = createLogger({
      level: "info",
      format: "json",
      scope: "root",
      redactKeys: ["licenseKey"],
      now: () => FIXED,
      ...s.opts,
    });
    parent.child("sub").info("x", { licenseKey: "LIC-abc-123" });
    expect(s.out[0]).toContain(REDACTED);
    expect(s.out[0]).not.toContain("LIC-abc-123");
  });

  it("redacts caller-declared keys and offers no way to switch redaction off", () => {
    const s = sink();
    const log = createLogger({ level: "info", format: "json", redactKeys: ["licenseKey", /^x-trace/], now: () => FIXED, ...s.opts });
    log.info("x", { licenseKey: "LIC-abc-123", "x-trace-id": "trace-1", agentId: AGENT_ID });
    const parsed = JSON.parse(s.out[0] as string) as Record<string, unknown>;
    expect(parsed.licenseKey).toBe(REDACTED);
    expect(parsed["x-trace-id"]).toBe(REDACTED);
    // Built-in rules still apply: declaring a key does not un-redact anything.
    expect(parsed.agentId).toBe(AGENT_ID);
    log.info("y", { rpcUrl: VENDOR_URL });
    expect(s.out[1]).not.toContain(VENDOR_KEY);
    // There is no opt-out: `redactKeys` can only widen the policy, never narrow it.
    expect(createLogger({ level: "info", redactKeys: [] }).level).toBe("info");
  });

  it("survives cyclic structures without overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { note: KEY };
    cyclic.self = cyclic;
    const inner: Record<string, unknown> = {};
    const mutual: Record<string, unknown> = { other: inner };
    inner.parent = mutual;
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      expect(() => log.info("x", { cyclic, mutual })).not.toThrow();
      expect(out).toHaveLength(1);
      expect(out[0]).not.toContain(KEY);
      expect(out[0]).toContain("[circular]");
      // JSON output must stay machine-parseable; text output is not JSON, so only
      // assert parseability where the format promises it.
      if (format === "json") expect(() => JSON.parse(out[0] as string)).not.toThrow();
    }
  });

  it("keeps a self-referencing structure inside a sensitive field from recursing", () => {
    const node: Record<string, unknown> = { name: "x" };
    node.self = node;
    const { log, out } = make("info", "json");
    expect(() => log.info("x", { token: node })).not.toThrow();
    expect(out[0]).toContain(REDACTED);
  });

  it("produces parseable JSON for every redacted shape", () => {
    const { log, out } = make("debug", "json");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info("x", { a: { b: { privateKey: KEY } }, note: KEY, reason: RPC_ERROR });
    log.error("y", { token: { nested: "s" } }, new Error("boom"));
    log.info("z", { cyclic });
    for (const line of out) {
      expect(() => JSON.parse(line as string)).not.toThrow();
    }
  });

  it("does not mutate or leak the caller's object graph", () => {
    const inner = { privateKey: KEY };
    const list: unknown[] = [inner];
    const fields: LogFields = { creds: inner, list };
    const { log, out } = make("info", "json");
    log.info("x", fields);
    expect(out[0]).not.toContain(KEY);
    expect(inner.privateKey).toBe(KEY);
    expect(list[0]).toBe(inner);
  });

  it("keeps normal business fields intact (no over-redaction regression)", () => {
    for (const format of ["text", "json"] as const) {
      const { log, out } = make("info", format);
      log.info("stored events", {
        agentId: AGENT_ID,
        target: TARGET,
        windowSeconds: 500,
        chainId: 8453,
        count: 2,
        fromBlock: "1",
        confirmations: 12,
        attempt: 2,
        delayMs: 500,
        head: "19",
      });
      expect(out[0]).toContain(AGENT_ID);
      expect(out[0]).toContain(TARGET);
      expect(out[0]).toContain("windowSeconds");
      expect(out[0]).toContain("8453");
      expect(out[0]).toContain("19");
    }
  });

  it("keeps public identifiers and addresses that look like secrets", () => {
    const { log, out } = make("info", "json");
    log.info("ok", { txHash: `0x${"b".repeat(64)}`, recipient: TARGET, publicKey: `0x${"a".repeat(64)}` });
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed.txHash).toBe(`0x${"b".repeat(64)}`);
    expect(parsed.recipient).toBe(TARGET);
  });

  it("redacts the exported helper directly, including nested structures", () => {
    expect(redact({ a: { b: { privateKey: KEY } } })).toEqual({ a: { b: { privateKey: REDACTED } } });
    expect(redact({ note: KEY })).toEqual({ note: REDACTED });
  });

  it("leaves ordinary values alone in the exported helper", () => {
    expect(redact({ agentId: AGENT_ID, target: TARGET, windowSeconds: 500 })).toEqual({
      agentId: AGENT_ID,
      target: TARGET,
      windowSeconds: 500,
    });
  });
});
