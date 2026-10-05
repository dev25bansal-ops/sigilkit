/**
 * Minimal leveled logger for the SigilKit services (indexer, MCP, demo agent).
 *
 * Deliberately dependency-free and tiny: the toolkit ships to agent operators who run
 * long-lived processes, so what matters is (a) a level floor they can raise in
 * production, (b) machine-readable output when a log collector is watching, (c) never
 * throwing because logging failed, and (d) never writing a secret to a stream that is
 * usually shipped off-box.
 *
 * Configured from the environment:
 *   SIGILKIT_LOG_LEVEL   debug | info | warn | error | silent   (default: info)
 *   SIGILKIT_LOG_FORMAT  text | json                            (default: text)
 *
 * `text`  → `2026-09-15T05:36:20.123Z  INFO   indexer  message  key=value`
 * `json`  → `{"ts":"…","level":"info","scope":"indexer","msg":"…","key":…}`
 *
 * `json` is never coloured — it is machine output, and a log collector does not want escape
 * bytes. `text` colours the level tag only, and only when the destination can render it
 * (UX-02): see the "Colour" block below for the exact conditions, which are deliberately
 * identical to `scripts/verify.mjs` so the CLI gate and the services agree on one terminal.
 * The level is always spelled out as a word, so colour is reinforcement, never information.
 *
 * ## Redaction (SEC-12)
 *
 * Redaction happens once, in `emit`, *before* either formatter runs — so no output
 * format can ever be a bypass. The two failure modes it closes:
 *
 *   1. Credentials. `SIGILKIT_RPC_URL` is frequently an Alchemy/Infura URL whose last
 *      path segment *is* the provider key (Alchemy/Infura convention). `config.ts`
 *      accepts any http(s) URL, and viem transport errors quote the request URL in
 *      `err.message` — which callers log verbatim (`client.ts` `getWindowState`).
 *      Field-name rules alone cannot catch that, because the field is innocuously
 *      named `reason`; hence the value-level scrubber for URLs, bearer/JWT strings
 *      and 32-byte hex blobs.
 *   2. Absolute paths. `err.stack` is the main source (`D:\SigilKit\packages\…`). It is
 *      omitted entirely unless the logger is explicitly configured at `debug`, and even
 *      then it is scrubbed first.
 *
 * Redaction is *additive* configuration only: `redactKeys` can add sensitive field
 * names, and there is deliberately no `redact: false` switch — a global off-ramp is one
 * careless flag away from logging every key in production, and the value-level
 * heuristics would be defeated with it. Callers who need a field to stop being
 * redacted should not be storing a secret under a public-looking name.
 */
import { assertOneOf } from "./validation.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["text", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Parses a level string, falling back to `fallback` for undefined/blank input.
 *
 * A value that is PRESENT but unrecognized is an error, not a fallback: that is the same
 * rule every `SIGILKIT_*` reader in `config.ts` already follows (`readEnvChoice` throws on
 * an unknown value rather than quietly defaulting), and this function used to be the one
 * place that silently swallowed the typo it was supposed to surface. `fallback` applies to
 * "not configured at all", never to "configured wrong".
 *
 * @throws {@link ValidationError} naming `SIGILKIT_LOG_LEVEL` and listing the allowed values.
 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === undefined || value.trim() === "") return fallback;
  return assertOneOf(value.trim().toLowerCase(), "SIGILKIT_LOG_LEVEL", LOG_LEVELS);
}

/**
 * Parses an output format, falling back to `fallback` for undefined/blank input.
 *
 * Same contract as {@link parseLogLevel}: present-but-invalid throws, absent falls back.
 *
 * @throws {@link ValidationError} naming `SIGILKIT_LOG_FORMAT` and listing the allowed values.
 */
export function parseLogFormat(value: string | undefined, fallback: LogFormat = "text"): LogFormat {
  if (value === undefined || value.trim() === "") return fallback;
  return assertOneOf(value.trim().toLowerCase(), "SIGILKIT_LOG_FORMAT", LOG_FORMATS);
}

/** Extra structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/** A logger bound to a scope (usually the component name). */
export interface Logger {
  readonly level: LogLevel;
  readonly scope: string;
  /** `err` is only rendered with a stack when the logger itself runs at `debug`. */
  debug(msg: string, fields?: LogFields, err?: unknown): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
  /** A logger that writes the same stream with a `parent.child` scope. */
  child(scope: string): Logger;
}

/** Extra field-name patterns to redact, e.g. `["licenseKey", /^x-.*-hdr$/]`. */
export type RedactKey = string | RegExp;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  scope?: string;
  /** Sink for non-error lines. Defaults to stdout. */
  out?: (line: string) => void;
  /** Sink for error lines. Defaults to stderr. */
  err?: (line: string) => void;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /**
   * Additional sensitive field names, matched case-insensitively (strings) or as given
   * (regular expressions). This can only *widen* redaction — there is no option to
   * disable or narrow it (SEC-12).
   */
  redactKeys?: readonly RedactKey[];
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/** Substituted for a value withheld by field-name redaction. */
export const REDACTED = "[redacted]";
/** Substituted for a cycle re-entered while serializing. */
const CIRCULAR = "[circular]";
/** Substituted for a value whose getters/enumeration threw (exotic or hostile objects). */
const UNREADABLE = "[unreadable]";
/** Substituted for a value nested deeper than {@link MAX_DEPTH}. */
const TRUNCATED = "[depth-limit]";
/** Substituted for an absolute filesystem path found inside free text. */
const PATH_MASK = "[path]";
/** Inside URLs the URL serializer percent-encodes brackets, so the mask is a bare word. */
const URL_MASK = "redacted";
/** Depth cap: a pathological payload must not blow the stack of the process logging it. */
const MAX_DEPTH = 8;

/**
 * Field names that are treated as secret regardless of their value. Matched
 * case-insensitively against the raw key.
 *
 * `db` and `rpc` are intentionally broad: `dbPath` and `rpcUrl` are exactly the
 * absolute-path and vendor-key carriers SEC-12 is about.
 */
const SENSITIVE_KEY =
  /(privateKey|secret|token|password|passwd|passphrase|mnemonic|authorization|apikey|api_key|credential|db|rpc|cookie|session)/i;

/**
 * Exception for the built-in name rule: an on-chain address is public data, and domain
 * fields like `tokenAddress` would otherwise be caught by the `token` alternative.
 * A secret is never an address, so this cannot be used to smuggle one through.
 * (Caller-supplied `redactKeys` still apply — the exception only relaxes the built-in rule.)
 */
const PUBLIC_SUFFIX = /(address|addr)$/i;

/**
 * Public identifier fields exempt from the 32-byte-hex value heuristic. `agentId` and
 * `rationaleHash` are `bytes32` and are byte-for-byte indistinguishable from a private
 * key, so an explicit allowlist is the only way to keep the heuristic fail-safe without
 * destroying the log's operational value.
 */
const PUBLIC_IDENTIFIERS =
  /^(agentId|rationaleHash|merkleRoot|actionHash|messageHash|txHash|transactionHash|blockHash|logHash|hash|digest|root|commitment|eventId|requestId|sessionKeyId|publicKey|depositKey|address|addr|target|to|from|recipient|sender|owner|manager|signer)$/i;

/** A value that is exactly 32 bytes of hex — a private key unless the field says otherwise. */
const KEY_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;
/** Whole value is an HTTP auth credential. */
const BEARER = /^(bearer|basic|token|apikey)\s+\S+/i;
/** A JWT anywhere in free text. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** A 32-byte hex blob embedded in a longer message (a key pasted into a provider error). */
const EMBEDDED_HEX64 = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
/** A URL-shaped token inside free text, e.g. inside a viem transport error. */
const URL_LIKE_TOKEN = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'\x60<>)\]}]+/g;
const URL_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
/** `C:\Users\…` / `D:\SigilKit\…` — the absolute-path leak in stacks and file errors. */
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'\x60<>|]*/g;
/** `/home/alice/…`, `/Users/alice/…`. */
const HOME_PATH = /\/(?:home|Users)[\\/][^\s"'\x60<>|]*/g;
/** Query/header parameter names whose value is a credential. */
const SENSITIVE_PARAM =
  /^(?:key|api[_-]?key|access[_-]?key|token|access[_-]?token|secret|password|passwd|auth|authorization|jwt|secret[_-]?key|private[_-]?key)$/i;
/**
 * Providers whose URL path ends in the API key (Alchemy `/v2/<key>`, Infura `/v3/<key>`, …).
 *
 * This list is a FAST PATH, not the safety boundary. It used to be the boundary: a URL was
 * only path-masked when its host appeared here, so any RPC provider not on this 12-entry
 * list printed its key verbatim (`https://rpc.example.io/v1/<key>` → unredacted). A redaction
 * scheme that depends on enumerating every provider is not a redaction scheme. The
 * credential-shaped path segment test below is what actually guarantees masking; this regex
 * only lets a known provider be masked even when its key does not look high-entropy.
 */
const RPC_PROVIDER_HOST = /(?:^|\.)(alchemy\.com|infura\.io|quicknode\.com|ankr\.com|llamarpc\.com|drpc\.org|nownodes\.io|chainstack\.com|moralis\.io|blastapi\.io|4everland\.io|securerpc\.com)$/i;
/**
 * A URL path segment that looks like a provider key rather than a route.
 *
 * Provider keys are long, mixed-alphanumeric, and contain at least one digit — which is what
 * separates `v2/a1b2c3d4e5f6…` from an ordinary route segment like `v1` or `status`. Length
 * is deliberately generous (16) because short test/dev keys exist, and mixed-case plus a
 * digit requirement is what keeps ordinary paths from being over-masked. Masking a
 * non-secret segment is a cosmetic loss in a log; printing a key is a credential leak.
 */
const CREDENTIAL_SEGMENT = /^(?=.{16,}$)(?=.*[0-9])[A-Za-z0-9_-]+$/;
/** Field names that imply the value is an RPC endpoint, used as a hint for the path mask. */
const RPC_HINT = /(rpc|provider|endpoint|node|alchemy|infura|quicknode)/i;
/** Keys that must never be copied onto the rebuilt object (prototype-pollution hygiene). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type KeyMatcher = (key: string) => boolean;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles caller-supplied key patterns. `g`/`y` are stripped: `RegExp.test` is
 * stateful with those flags, and a shared matcher must not depend on call order.
 */
function normalizeKeyPatterns(keys: readonly RedactKey[] | undefined): RegExp[] {
  if (keys === undefined) return [];
  const out: RegExp[] = [];
  for (const key of keys) {
    if (typeof key === "string") {
      if (key !== "") out.push(new RegExp(escapeRegExp(key), "i"));
    } else if (key.source !== "") {
      out.push(new RegExp(key.source, key.flags.replace(/[gy]/g, "")));
    }
  }
  return out;
}

function keyMatcher(extra: readonly RegExp[]): KeyMatcher {
  return (key) => {
    for (const pattern of extra) if (pattern.test(key)) return true;
    if (PUBLIC_SUFFIX.test(key)) return false;
    return SENSITIVE_KEY.test(key);
  };
}

/** Index of the first occurrence of any of `chars` at or after `from`, or -1. */
function indexOfAny(value: string, chars: readonly string[], from: number): number {
  let best = -1;
  for (const ch of chars) {
    const at = value.indexOf(ch, from);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/** Drops trailing punctuation that a greedy path match would otherwise swallow. */
function trimTrailing(value: string): string {
  return value.replace(/[.,;:)\]}]+$/, "");
}

/** Replaces an absolute path match, keeping any trailing punctuation outside the mask. */
function maskPath(match: string): string {
  const kept = trimTrailing(match);
  return `${PATH_MASK}${match.slice(kept.length)}`;
}

/**
 * Masks the credential-bearing parts of a URL while keeping the host readable — an
 * operator still needs to see *which* endpoint failed, just not the key in it.
 */
function scrubUrl(raw: string, rpcHint: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not a URL after all — other heuristics still apply
  }
  const provider = rpcHint || RPC_PROVIDER_HOST.test(url.hostname);
  const maskedParams: string[] = [];
  for (const [name] of url.searchParams) {
    if (SENSITIVE_PARAM.test(name)) maskedParams.push(name);
  }
  if (url.username === "" && url.password === "" && maskedParams.length === 0 && !provider) {
    // Still fall through: a credential-shaped final path segment is maskable even on an
    // unlisted host. Returning here (as this did before the CREDENTIAL_SEGMENT check existed)
    // was what let `https://rpc.example.io/v1/<key>` print verbatim — the only thing that
    // separated a known provider from an unknown one was that allowlist.
    const earlyCut = raw.search(/[?#]/);
    const earlyHead = earlyCut === -1 ? raw : raw.slice(0, earlyCut);
    const earlySlash = earlyHead.lastIndexOf("/");
    const earlySegment = earlySlash === -1 ? "" : earlyHead.slice(earlySlash + 1);
    if (!CREDENTIAL_SEGMENT.test(earlySegment)) return raw;
  }

  let out = raw;
  // userinfo: scheme://user:pass@host → scheme://[redacted]@host
  const schemeEnd = out.indexOf("://");
  if (schemeEnd !== -1) {
    const authorityStart = schemeEnd + 3;
    const authorityEnd = indexOfAny(out, ["/", "?", "#"], authorityStart);
    const authority = out.slice(authorityStart, authorityEnd === -1 ? out.length : authorityEnd);
    const at = authority.lastIndexOf("@");
    if (at !== -1) out = out.slice(0, authorityStart) + REDACTED + out.slice(authorityStart + at);
  }
  // query parameters: ?apiKey=… → ?apiKey=redacted
  for (const name of maskedParams) {
    out = out.replace(new RegExp(`([?&])${escapeRegExp(name)}=[^&#]*`, "g"), `$1${name}=${URL_MASK}`);
  }
  // provider path key: the last non-empty segment is the key (Alchemy/Infura convention).
  // A known provider, an `rpc`-named field, OR a credential-shaped final segment all trigger
  // masking. An unknown host whose last segment does not look like a key keeps its path
  // readable, so ordinary routes (`/v1/status`) survive while an unlisted provider's key
  // does not. Previously the whole block sat behind `if (provider)`, which meant an unknown
  // host was never even examined.
  {
    const cut = out.search(/[?#]/);
    const head = cut === -1 ? out : out.slice(0, cut);
    const tail = cut === -1 ? "" : out.slice(cut);
    const lastSlash = head.lastIndexOf("/");
    const lastSegment = lastSlash === -1 ? "" : head.slice(lastSlash + 1);
    const maskable = provider || CREDENTIAL_SEGMENT.test(lastSegment);
    if (lastSlash !== -1 && head.length > lastSlash + 1 && maskable) {
      out = `${head.slice(0, lastSlash + 1)}${URL_MASK}${tail}`;
    }
  }
  return out;
}

/**
 * True when a string carries content the free-text scrubs must act on, whatever the field
 * name is.
 *
 * This is what separates "an allowlisted identifier holding an identifier" from "an
 * allowlisted field name carrying a credential". A bytes32 hash or a bare address matches
 * none of these, so an allowlisted field holding one is still returned verbatim — the
 * property the allowlist exists for. A `hash` field holding `Bearer sk-…` or an absolute
 * path matches, and must be scrubbed even though its NAME says the value is public.
 */
const NEEDS_TEXT_SCRUB =
  /[A-Za-z]:[\\/]|\\|\/(?:home|Users|root)\/|\/\/|eyJ|[\w-]+\.[\w-]+\.[\w-]+|bearer\s|0x[0-9a-fA-F]{40,}/i;

/**
 * Masks credentials, provider keys and absolute paths inside a free-text string.
 *
 * @param allowlistedField when the field NAME is an allowlisted public identifier. Only the
 *   value-SHAPE heuristics are suppressed in that case (`KEY_SHAPE` would redact a bytes32
 *   hash, which is exactly the identifier the allowlist is meant to preserve). The free-text
 *   scrubs — Bearer tokens, JWTs, URLs with embedded keys, absolute paths — still run,
 *   because a credential does not stop being one because it was logged under `hash`.
 */
function scrubString(value: string, rpcHint: boolean, allowlistedField = false): string {
  // A 32-byte hex identifier is the case the allowlist protects: shape heuristics would
  // redact it as a private key, which is a false positive on the single most common value
  // these fields hold. Anything that still needs text scrubbing goes through below.
  if (!allowlistedField && KEY_SHAPE.test(value)) return REDACTED;
  if (BEARER.test(value)) return REDACTED;
  if (URL_PREFIX.test(value)) return scrubUrl(value, rpcHint);
  let out = value;
  out = out.replace(JWT, URL_MASK);
  out = out.replace(URL_LIKE_TOKEN, (match) => scrubUrl(match, rpcHint));
  if (!allowlistedField) out = out.replace(EMBEDDED_HEX64, REDACTED);
  out = out.replace(WINDOWS_PATH, maskPath);
  out = out.replace(HOME_PATH, maskPath);
  return out;
}

/** Non-object values that need normalizing before `JSON.stringify`. */
function redactPrimitive(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return "[symbol]";
  return value;
}

/** `{name, message}` (+ `stack` in debug mode) with the message scrubbed. */
function redactError(err: Error, includeStack: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: scrubString(err.name, false),
    message: scrubString(err.message, false),
  };
  if (includeStack && typeof err.stack === "string") out.stack = scrubString(err.stack, false);
  return out;
}

/**
 * Recursively rebuilds a value with everything sensitive masked.
 *
 * The input is never mutated: the field bag a caller passed in is read-only, and the
 * output is a fresh tree of plain objects/arrays — which also drops `toJSON` hooks that
 * could otherwise re-inject an unmasked secret at serialization time.
 */
function redactObject(value: object, isSensitive: KeyMatcher, seen: WeakSet<object>, depth: number, withStack: boolean): unknown {
  if (seen.has(value)) return CIRCULAR;
  if (depth > MAX_DEPTH) return TRUNCATED;
  seen.add(value);
  try {
    if (value instanceof Error) return redactError(value, withStack);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => redactField("", item, isSensitive, seen, depth, withStack));
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return UNREADABLE; // Proxy trap or exotic object: never let it cost the whole line
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = redactField(key, entry, isSensitive, seen, depth, withStack);
    }
    return out;
  } finally {
    // Remove on exit rather than keeping for the whole call, so a value referenced twice
    // in sibling positions is still serialized twice (only true cycles become CIRCULAR).
    seen.delete(value);
  }
}

function redactField(
  key: string,
  value: unknown,
  isSensitive: KeyMatcher,
  seen: WeakSet<object>,
  depth: number,
  withStack: boolean,
): unknown {
  // 1. Field name — the primary control, and it is unconditional: a value under a
  //    sensitive name is replaced, never passed through on the chance that it "looks
  //    harmless". A mnemonic or a password is ordinary text, so shape heuristics would
  //    happily echo it. URLs are the one exception: `rpcUrl` stays debuggable because
  //    the host is what an operator needs, while the key inside it is masked.
  if (key !== "" && isSensitive(key)) {
    if (typeof value === "string" && URL_PREFIX.test(value)) return scrubUrl(value, RPC_HINT.test(key));
    return REDACTED;
  }
  if (typeof value === "string") {
    // 2. Allowlisted public identifiers bypass the SHAPE heuristic — a bytes32 hash and a
    //    private key are the same bytes, so only the field name can tell them apart.
    //    They do NOT bypass free-text scrubbing. Returning early did exactly that, and
    //    `scrubString` is what strips Bearer tokens, JWTs, provider keys and absolute
    //    paths, so a credential logged under `hash` / `digest` / `root` (26 allowlisted
    //    names) came out verbatim while the identical value under `note` was redacted.
    //    Only the value-shape heuristics are skipped; the text scrubs still run.
    const allowlisted = PUBLIC_IDENTIFIERS.test(key);
    if (allowlisted && !NEEDS_TEXT_SCRUB.test(value)) return value;
    // 3. Value shape and free text — catches `note: "0x…"` and viem error messages.
    return scrubString(value, RPC_HINT.test(key), allowlisted);
  }
  if (value === null || typeof value !== "object") return redactPrimitive(value);
  return redactObject(value, isSensitive, seen, depth + 1, withStack);
}

/** Redacts one value (field bag, throwable, or nested structure) for output. */
export function redact(value: unknown, options: { redactKeys?: readonly RedactKey[]; withStack?: boolean } = {}): unknown {
  const isSensitive = keyMatcher(normalizeKeyPatterns(options.redactKeys));
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? scrubString(value, false) : redactPrimitive(value);
  }
  return redactObject(value, isSensitive, new WeakSet<object>(), 0, options.withStack === true);
}

/* -------------------------------------------------------------------------- */
/* Colour (UX-02)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether ANSI escapes may be emitted in `text` output.
 *
 * Mirrors the decision in `scripts/verify.mjs` **exactly** — the two read the same
 * environment on the same terminal, and a report that coloured its PASS rows while a logger
 * line beside it did not would be a bug in one of them. Change one, change the other, and
 * change the order of the checks to match.
 *
 * Off when any of these holds:
 *   • `NO_COLOR` present at *any* value — https://no-color.org defines exactly that, and it
 *     is tested first so it also wins over `FORCE_COLOR`.
 *   • `TERM=dumb` — a terminal too weak for escapes.
 *   • `CI` set — GitHub Actions and friends render job logs with their own escape handling;
 *     an ESC byte their viewer drops is worse than no colour at all. This matters even when
 *     the runner is a pseudo-terminal, which is why `isTTY` alone is not sufficient. Read as
 *     a flag, so a local `CI=false` is still "not CI".
 *   • the sink is not a TTY — but only for the *default* sinks. A caller that injects its own
 *     `out`/`err` owns its own formatting, so {@link textColorsEnabled} is the check that
 *     applies here, and it is the conservative one.
 *
 * `FORCE_COLOR=1` is the escape hatch, chiefly for tests that run with piped stdio and still
 * need to assert that colour is emitted when it should be.
 *
 * **Colour is never load-bearing here.** The level is always spelled out as its word
 * (`INFO`, `WARN`, …) and only reinforced by colour, so a log line stays fully readable with
 * colour off, in a redirect, and to a screen reader.
 */
function textColorsEnabled(): boolean {
  const env = typeof process === "undefined" ? undefined : process.env;
  if (env === undefined) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  if (envFlag(env, "CI")) return false;
  if (envFlag(env, "FORCE_COLOR")) return true;
  // Same trap as the env guard above, one level down: `env !== undefined` proves
  // `process.env` is reachable, NOT that `process.stdout` is. A runtime that polyfills
  // `process.env` but has no stdout would throw here, so the stream is probed separately.
  return hostStdout()?.isTTY === true;
}

/** Reads an environment variable as a flag: present and not explicitly off. */
function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** SGR codes, by level. Kept to the level tag only — the message is never recoloured. */
const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "dim",
  info: "dim",
  warn: "bold yellow",
  error: "bold red",
  silent: "",
};

const SGR: Record<string, number> = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };

/** `warn` → yellow, `error` → red; `info`/`debug` stay dim; `silent` is never emitted. */
function levelStyle(level: LogLevel): string {
  return LEVEL_STYLE[level];
}

/**
 * Wraps `text` in the named SGR attributes and a reset, or returns it untouched when colour
 * is off. Never the sole carrier of meaning — see {@link textColorsEnabled}.
 */
function paint(style: string, text: string): string {
  if (style === "" || !textColorsEnabled()) return text;
  const names = style.split(" ").filter((name) => SGR[name] !== undefined);
  if (names.length === 0) return text;
  const open = names.map((name) => `\u001b[${SGR[name]}m`).join("");
  return `${open}${text}\u001b[0m`;
}

/* -------------------------------------------------------------------------- */
/* Process-global access (P0-3)                                             */
/* -------------------------------------------------------------------------- */

/**
 * The host's stdout, or `undefined` when there is none.
 *
 * A default sink cannot be built from `process.stdout.write` directly: in a browser, a
 * worker, or any bundled edge runtime there is no `process` at all, and merely *evaluating*
 * `process.stdout` throws — before the logger ever gets a chance to swallow the error it
 * was designed to swallow. So the default sinks below resolve the stream through this
 * helper and degrade to a no-op.
 *
 * The `typeof process === "undefined"` test is the same one `textColorsEnabled` already
 * uses for `process.env`; that existing guard is left untouched as the reference form.
 * `process.env` is NOT a sufficient proxy for a stream: it can be polyfilled (or injected)
 * while `process.stdout` is still absent, so the two are probed independently.
 *
 * The return type declares `isTTY` because `textColorsEnabled` reads it off this same
 * helper. A structural type listing only `write` would compile at both sink call sites
 * and then fail at the colour site with TS2339 — the type has to cover EVERY use, not
 * just the ones present when it was written. It is optional because the property is
 * absent on a non-TTY stream even though Node's own types declare it unconditionally.
 */
function hostStdout(): { write: (chunk: string) => unknown; isTTY?: boolean } | undefined {
  if (typeof process === "undefined") return undefined;
  return process.stdout;
}

/**
 * As {@link hostStdout}, for stderr.
 *
 * Declares the same shape as its sibling, including `isTTY`, even though only stdout is
 * probed. Narrowing it would make the two helpers differ in a way no call site depends on;
 * the wider type is the one that cannot hide a future access.
 */
function hostStderr(): { write: (chunk: string) => unknown; isTTY?: boolean } | undefined {
  if (typeof process === "undefined") return undefined;
  return process.stderr;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** JSON-encodes one already-redacted value, degrading to a placeholder instead of throwing. */
function encodeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '"[unserializable]"';
  }
}

/** Renders an error concisely as `Name: message` (stack deliberately omitted by default). */
function conciseError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object") {
    const { name, message } = err as { name?: unknown; message?: unknown };
    if (typeof message === "string") return typeof name === "string" && name !== "" ? `${name}: ${message}` : message;
  }
  return encodeValue(err);
}

function formatText(ts: string, level: LogLevel, scope: string, msg: string, fields?: LogFields, err?: unknown): string {
  const levelTag = level.toUpperCase().padEnd(5);
  const scopeTag = scope ? ` ${scope}` : "";
  const extras = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}=${typeof v === "string" ? v : encodeValue(v)}`)
        .join("")
    : "";
  const errorTag = err !== undefined ? ` error=${conciseError(err)}` : "";
  return `${ts}  ${paint(levelStyle(level), levelTag)}${scopeTag}  ${msg}${extras}${errorTag}`;
}

function formatJson(ts: string, level: LogLevel, scope: string, msg: string, fields?: LogFields, err?: unknown): string {
  const payload: Record<string, unknown> = { ts, level, scope, msg };
  if (fields) for (const [k, v] of Object.entries(fields)) payload[k] = v;
  if (err !== undefined) payload.error = err;
  try {
    return JSON.stringify(payload);
  } catch {
    // Redaction already yields JSON-safe values, so this is belt-and-braces: a
    // must-not-throw guarantee for the one line that is trying to report a problem.
    const safe: Record<string, unknown> = { ts, level, scope, msg };
    if (fields) for (const [k, v] of Object.entries(fields)) safe[k] = encodeValue(v);
    if (err !== undefined) safe.error = conciseError(err);
    return JSON.stringify(safe);
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Creates a logger. Output never throws: a broken sink is swallowed rather than
 * taking down the process that was only trying to report something.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "text";
  const scope = options.scope ?? "";
  const out = options.out ?? ((line: string) => hostStdout()?.write(line + "\n"));
  const errSink = options.err ?? ((line: string) => hostStderr()?.write(line + "\n"));
  const clock = options.now ?? (() => new Date());
  // Normalized once here so `child()` can hand the same policy down without a flag.
  const redactKeys = normalizeKeyPatterns(options.redactKeys);
  const isSensitive = keyMatcher(redactKeys);
  // Stacks carry absolute paths, so they are opt-in: only a logger explicitly running at
  // `debug` emits them, and even then the text is scrubbed first.
  const withStack = level === "debug";

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields, err?: unknown): void => {
    if (RANK[lvl] < RANK[level]) return;
    try {
      const ts = clock().toISOString();
      // Redact once, here: both formatters consume the same already-safe values, so no
      // output path can skip it. `msg` is scrubbed too (a caller can interpolate an
      // error message into it); `scope` is developer-controlled and left as-is.
      const safeFields: LogFields | undefined = fields
        ? (redactObject({ ...fields }, isSensitive, new WeakSet<object>(), 0, withStack) as LogFields)
        : undefined;
      const safeErr = err === undefined ? undefined : redact(err, { redactKeys, withStack });
      const safeMsg = scrubString(msg, false);
      const line =
        format === "json" ? formatJson(ts, lvl, scope, safeMsg, safeFields, safeErr) : formatText(ts, lvl, scope, safeMsg, safeFields, safeErr);
      if (lvl === "error") errSink(line);
      else out(line);
    } catch {
      /* logging must never be the reason a process dies */
    }
  };

  return {
    level,
    scope,
    debug: (msg, fields, err) => emit("debug", msg, fields, err),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields, err) => emit("error", msg, fields, err),
    child: (childScope) =>
      createLogger({
        level,
        format,
        scope: scope ? `${scope}.${childScope}` : childScope,
        out,
        err: errSink,
        now: clock,
        // Must be inherited: rebuilding options without it would silently drop the
        // caller's redaction policy for the whole child subtree.
        redactKeys,
      }),
  };
}

/** A logger that discards everything — useful as a default in library code. */
export function silentLogger(): Logger {
  return createLogger({ level: "silent" });
}
