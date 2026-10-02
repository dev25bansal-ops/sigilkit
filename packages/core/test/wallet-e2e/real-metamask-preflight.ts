/**
 * Preflight guard for the REAL MetaMask integration (AC-06).
 *
 * real-metamask.ts drives the user's actual Chrome over CDP. This module is the
 * single gate every CDP attach must pass: loopback endpoints only, and a debug
 * port from the explicit fixture list — so an automation typo can never attach
 * to someone else's browser. Pure functions (env read by the caller), so the
 * unit tests exercise every branch without process state.
 */

export interface CdpTarget {
  host: string;
  port: number;
}

export interface PreflightOptions {
  /** Allow non-loopback hosts (the caller may set this from an env override). */
  allowRemote?: boolean;
  /** Ports accepted beyond the default fixture list (caller-supplied overrides). */
  extraPorts?: number[];
}

/** Chrome's documented remote-debugging default. */
const FIXTURE_PORTS: ReadonlySet<number> = new Set([9222]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseCdpUrl(url: string): CdpTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid CDP URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`CDP URL must be http://, got ${parsed.protocol}//`);
  }
  if (!parsed.port) {
    throw new Error("CDP URL must carry an explicit port (e.g. http://127.0.0.1:9222)");
  }
  return { host: parsed.hostname, port: Number(parsed.port) };
}

export function assertSafeCdpTarget(url: string, opts: PreflightOptions = {}): CdpTarget {
  const target = parseCdpUrl(url);
  if (!LOOPBACK_HOSTS.has(target.host) && opts.allowRemote !== true) {
    throw new Error(
      `CDP endpoint ${JSON.stringify(target.host)} is not loopback. real-metamask.ts drives a ` +
        `real wallet and will only attach to this machine unless the caller explicitly ` +
        `passes allowRemote. Refusing.`,
    );
  }
  const allowedPorts = new Set<number>([...FIXTURE_PORTS, ...(opts.extraPorts ?? [])]);
  if (!allowedPorts.has(target.port)) {
    throw new Error(
      `CDP port ${target.port} is not in the fixture allowlist ${JSON.stringify([...allowedPorts])}. ` +
        `Start Chrome with --remote-debugging-port=9222, or pass the port explicitly via extraPorts. Refusing.`,
    );
  }
  return target;
}