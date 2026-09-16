#!/usr/bin/env node
/**
 * sigilkit-mcp — Model Context Protocol server over stdio.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and writes every diagnostic to
 * stderr, so stdout stays a clean protocol channel. The server exits 0 when the client
 * closes the pipe (or on SIGINT/SIGTERM), and never leaves a half-written response.
 *
 *   sigilkit-mcp --help
 *   sigilkit-mcp --log-level debug
 *
 * Agent framework config:
 *   { "command": "npx", "args": ["-y", "@sigilkit/mcp"] }
 */
import { createRequire } from "node:module";
import { runCli, type CliSpec } from "@sigilkit/core/cli";
import { readEnvChoice, loadDotEnv } from "@sigilkit/core/config";
import { LOG_FORMATS, LOG_LEVELS, createLogger } from "@sigilkit/core/logger";
import { serveStdio } from "./server.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const SPEC: CliSpec = {
  name: "sigilkit-mcp",
  version: pkg.version,
  summary:
    "MCP server exposing SigilKit to agent frameworks: zero-gas request validation, scope building, revert decoding and audit queries.",
  usage: ["sigilkit-mcp [--log-level <level>]"],
  flags: [
    {
      name: "--log-level",
      value: "<level>",
      choices: LOG_LEVELS,
      description: "Diagnostics verbosity, written to stderr (env: SIGILKIT_LOG_LEVEL, default info)",
    },
  ],
  examples: ["sigilkit-mcp", "sigilkit-mcp --log-level debug"],
  notes: [
    "TRANSPORT",
    "  Newline-delimited JSON-RPC 2.0 on stdin/stdout. Diagnostics go to stderr only.",
    "",
    "TOOLS",
    "  validate_request  zero-gas policy check against a scope",
    "  build_scope       Merkle root + scope spec for grantSessionKey",
    "  decode_error      named SigilKit revert decoding",
    "  audit_query       read-only queries over an indexer SQLite database",
    "",
    "EXIT CODES",
    "  0  clean shutdown     1  runtime failure     2  usage error",
  ],
};

await runCli(SPEC, process.argv.slice(2), async (args) => {
  // `.env` first, so `cp .env.example .env` works as documented. Real env vars win.
  loadDotEnv();
  const level = args.oneOf("--log-level", LOG_LEVELS) ?? readEnvChoice(process.env, "SIGILKIT_LOG_LEVEL", LOG_LEVELS, "info");
  const logger = createLogger({
    level,
    format: readEnvChoice(process.env, "SIGILKIT_LOG_FORMAT", LOG_FORMATS, "text"),
    scope: "mcp",
    out: (line) => process.stderr.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  });

  const stop = serveStdio(process.stdin, process.stdout, logger);

  // Stay alive until the client goes away. Without this the process would exit the
  // moment `main` returns, before the first request arrives.
  await new Promise<void>((resolve) => {
    let done = false;
    const shutdown = (): void => {
      if (done) return;
      done = true;
      stop();
      resolve();
    };
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  logger.info("shutting down");
  return 0;
});
