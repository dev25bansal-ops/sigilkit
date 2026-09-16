/**
 * Transport-level tests for `serveStdio`.
 *
 * The tool surface is covered in `validation.test.ts`; this file covers the stdio plumbing
 * added when the server was hardened: parse/validate rejections, EPIPE-safe writes, the
 * close notification, and the disposer. These are the paths a broken client actually hits.
 */
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "@sigilkit/core/logger";
import { serveStdio } from "../src/server.js";

/** A writable that records everything written to it. */
function collector(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join("").split("\n").filter((l) => l.length > 0) };
}

/** An input stream that emits the given lines then ends. */
function feed(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

/** A logger whose output is captured instead of written to the console. */
function capture() {
  const lines: string[] = [];
  const log = createLogger({
    level: "debug",
    scope: "test",
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { log, lines };
}

/** Polls until `predicate` holds, or fails after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met within timeout");
}

describe("serveStdio", () => {
  it("answers a request and announces startup", async () => {
    const out = collector();
    const { log, lines } = capture();
    const stop = serveStdio(feed(['{"jsonrpc":"2.0","id":1,"method":"ping"}']), out.stream, log);

    await waitFor(() => out.lines().length >= 1);
    expect(JSON.parse(out.lines()[0] as string)).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
    expect(lines.some((l) => l.includes("listening on stdio"))).toBe(true);
    stop();
  });

  it("reports a parse error without dying", async () => {
    const out = collector();
    const stop = serveStdio(feed(["{not json"]), out.stream, capture().log);

    await waitFor(() => out.lines().length >= 1);
    expect(JSON.parse(out.lines()[0] as string).error.code).toBe(-32700);
    stop();
  });

  it("rejects a well-formed JSON value that is not an object", async () => {
    const out = collector();
    const stop = serveStdio(feed(["[1,2,3]", '"a string"', "42"]), out.stream, capture().log);

    await waitFor(() => out.lines().length >= 3);
    for (const line of out.lines()) {
      expect(JSON.parse(line).error.code).toBe(-32600);
    }
    stop();
  });

  it("ignores blank lines", async () => {
    const out = collector();
    const stop = serveStdio(feed(["", "   ", '\t']), out.stream, capture().log);

    // Nothing to answer; the interface closes when the input ends.
    await new Promise((r) => setTimeout(r, 50));
    expect(out.lines()).toEqual([]);
    stop();
  });

  it("does not crash when the client has gone away mid-write", async () => {
    const { log, lines } = capture();
    const broken = {
      write() {
        throw new Error("EPIPE");
      },
    } as unknown as NodeJS.WritableStream;

    const stop = serveStdio(feed(['{"jsonrpc":"2.0","id":1,"method":"ping"}']), broken, log);

    await waitFor(() => lines.some((l) => l.includes("client may have disconnected")));
    expect(lines.some((l) => l.includes("EPIPE"))).toBe(true);
    stop();
  });

  it("notes when stdin closes", async () => {
    const { log, lines } = capture();
    const stop = serveStdio(feed([]), collector().stream, log);

    await waitFor(() => lines.some((l) => l.includes("stdin closed")));
    stop();
  });

  it("returns a disposer that can be called more than once", () => {
    const stop = serveStdio(feed([]), collector().stream, capture().log);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  it("handles a notification without writing a response", async () => {
    const out = collector();
    const stop = serveStdio(feed(['{"jsonrpc":"2.0","method":"notifications/initialized"}']), out.stream, capture().log);

    await new Promise((r) => setTimeout(r, 50));
    expect(out.lines()).toEqual([]);
    stop();
  });
});
