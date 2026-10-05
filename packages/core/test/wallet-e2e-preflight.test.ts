/**
 * AC-06: the real-MetaMask preflight must reject every CDP target outside the
 * explicit fixture contract — remote hosts, missing ports, and unlisted debug
 * ports all abort before any browser attach.
 */
import { describe, expect, it } from "vitest";
import { assertSafeCdpTarget, parseCdpUrl } from "./wallet-e2e/real-metamask-preflight.js";

describe("real-metamask CDP preflight (AC-06)", () => {
  it("accepts the documented loopback fixture (http://127.0.0.1:9222)", () => {
    expect(assertSafeCdpTarget("http://127.0.0.1:9222")).toEqual({ host: "127.0.0.1", port: 9222 });
  });

  it("rejects a remote host before anything can attach", () => {
    expect(() => assertSafeCdpTarget("http://192.168.1.10:9222")).toThrow(/not loopback/);
  });

  it("rejects a URL without an explicit port", () => {
    expect(() => parseCdpUrl("http://127.0.0.1")).toThrow(/explicit port/);
  });

  it("rejects non-http schemes", () => {
    expect(() => parseCdpUrl("ws://127.0.0.1:9222")).toThrow(/http:\/\//);
  });

  it("rejects a loopback host on a port outside the fixture allowlist", () => {
    expect(() => assertSafeCdpTarget("http://127.0.0.1:9333")).toThrow(/fixture allowlist/);
  });

  it("accepts remote hosts only when the caller explicitly opts in", () => {
    expect(() => assertSafeCdpTarget("http://10.0.0.2:9222")).toThrow(/not loopback/);
    expect(assertSafeCdpTarget("http://10.0.0.2:9222", { allowRemote: true })).toEqual({
      host: "10.0.0.2",
      port: 9222,
    });
  });

  it("accepts caller-supplied extra ports and keeps them out of the default error", () => {
    expect(assertSafeCdpTarget("http://127.0.0.1:9333", { extraPorts: [9333] }).port).toBe(9333);
    expect(() => assertSafeCdpTarget("http://127.0.0.1:9333")).toThrow(/\[9222\]/);
  });
});