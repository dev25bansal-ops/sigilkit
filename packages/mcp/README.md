# @sigilkit/mcp

MCP (Model Context Protocol) server exposing SigilKit to agent frameworks over
stdio. The compromised-agent threat model maps directly onto it: the model can
*ask* through these tools, but the wallet path bounds what it can *do*.

| Tool | Purpose |
|------|---------|
| `validate_request` | Zero-gas policy check of an ActionRequest against a scope (same logic as the SDK/contract). |
| `build_scope` | Builds a grant spec + v2 Merkle root over a target list for `grantSessionKey`. |
| `decode_error` | Named decoding of SigilKit revert data. |
| `audit_query` | Read-only queries over the `@sigilkit/indexer` SQLite database (spend/actions/summary). |

No key material ever passes through the server — signing stays with the SDK/wallet
path; these tools are the propose-and-verify layer.

## Install and wire it up

> **Not yet published.** The `@sigilkit` scope on npm is owned by an unrelated project, so
> `npm install @sigilkit/mcp` does not exist yet (404) and `@sigilkit/core` would resolve to
> someone else's package. Run it from a clone in the meantime.

```bash
git clone https://github.com/sigilkit/sigilkit.git && cd sigilkit && npm run setup
node packages/mcp/dist/cli.js --help
```

```json
{
  "mcpServers": {
    "sigilkit": { "command": "node", "args": ["packages/mcp/dist/cli.js"] }
  }
}
```

After publication, that becomes `npx -y @sigilkit/mcp`.

## Behaviour worth knowing

- **stdout is the protocol channel.** All diagnostics go to stderr, so a wrapper that
  prints to stdout will corrupt the stream.
- **Tool arguments are validated.** A bad argument returns `isError: true` with a message
  naming the field — `targets[0].selector: expected 4 bytes of hex` — rather than a stack
  trace from inside a helper.
- **`audit_query` is strictly read-only.** The database is opened with SQLite's `readOnly`
  flag: no directory, table, index, or row is ever created or modified. A missing file
  returns a "database not found" result instead of writing one.
- **Exit codes** follow the project convention: `0` clean shutdown, `1` runtime failure,
  `2` usage error. The server exits when the client closes the pipe.

Options: `--log-level debug|info|warn|error|silent` (also `SIGILKIT_LOG_LEVEL`).
See [CONFIGURATION.md](../../docs/CONFIGURATION.md) for the environment table.

> **Pre-audit software.** The contracts have not been externally audited. See
> [SECURITY.md](../../SECURITY.md).

MIT.
