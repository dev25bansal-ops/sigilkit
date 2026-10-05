export * from "./types.js";
export * from "./signing.js";
export * from "./accounts.js";
export * from "./client.js";
export * from "./eip7702.js";
export * from "./abis.js";
export * from "./errors.js";
export * from "./validation.js";
// P0-3: `logger`, `config` and `cli` are no longer re-exported from this barrel.
// Use the subpaths instead — they are declared in package.json, so nothing is unreachable:
//   logger  ->  @sigilkit/core/logger
//   config  ->  @sigilkit/core/config
//   cli     ->  @sigilkit/core/cli
//
// WHY `config` IS EXCLUDED — the binding form is irrelevant, the top-level static import is not.
// `config.ts` does `import { existsSync } from "node:fs"` and `import { join } from "node:path"`
// at the top level, unconditionally. These are static, side-effecting imports of Node builtins
// reachable from an `export *` barrel: a bundler cannot prove they are unused, so no amount of
// tree-shaking removes them. This — NOT the fact that `config` "uses Node" — is what breaks a
// browser/edge consumer, and it is the whole reason this barrel must stay free of `config`.
//
// On the other two, the reason is different, and it is about the CALL SURFACE, not the import
// graph. Both `logger.ts` and `cli.ts` have a closure with no `node:` specifier at all.
//
//   EVALUATE vs CALL is the distinction, and the two must be measured separately. Every one of
//   `logger`, `cli`, `config` and this barrel EVALUATES cleanly in a realm with no `process`
//   and no `node:` builtins: each `process` dereference sits in a default parameter value or
//   inside a function body, so nothing runs at import time. An import-only portability check
//   therefore passes for all of them and proves nothing. The failures are all at CALL time:
//     · `logger`  — the ONLY one of the three that is safe at BOTH stages. `createLogger({})`,
//                  `.info()`, `.error()`, `silentLogger()` and `redact()` were each measured
//                  with no `process` present and all of them complete normally, because the
//                  default IO sinks resolve the stream through `hostStdout()` / `hostStderr()`,
//                  which return `undefined` when there is no `process` and degrade to a no-op.
//                  Do not assume the other two behave the same way — they do not.
//     · `cli`     — safe to EVALUATE, unsafe to CALL. All three dereferences sit inside
//                  `defaultIo`'s arrow bodies, so evaluation is fine, but `runCli` without an
//                  injected `io` REJECTS with `ReferenceError: process is not defined` — for
//                  `--help` and for a normal run alike. Being a rejection and not a throw, a
//                  caller who does not await it gets an unhandled rejection rather than a
//                  catchable error. Injecting `io` makes it resolve cleanly.
//     · `config`  — safe to EVALUATE, unsafe to CALL. `loadDotEnv()` and `loadServiceConfig()`
//                  throw on their `process.cwd()` / `process.env` DEFAULT PARAMETERS when
//                  called with no argument; passing an explicit value is fine.
//
// So: `config` is excluded for a hard bundling reason (the `node:fs` top-level import), while
// `cli` and `logger` are excluded as entry-point hygiene — API-surface convergence. Dropping
// `cli` from the barrel is NOT a bundling fix, and it never was.
