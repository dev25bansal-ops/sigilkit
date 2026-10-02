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

## Programmatic use

The server is a plain module, so it can be embedded or driven from a test without a
subprocess. Like every `@sigilkit/*` package, build the workspace once
(`npm install && npm run build` at the repo root) before importing it — the import fails
with `ERR_MODULE_NOT_FOUND` until `@sigilkit/core` has a `dist/`, which is an environment
problem rather than a problem with the example.

```ts
import { handleMessage, TOOLS, type ToolDef, type LeafKind } from "@sigilkit/mcp/server";

// `handleMessage` takes one JSON-RPC 2.0 message and resolves to the response object,
// or to null for a notification (which by definition gets no reply).
const init = await handleMessage({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "my-agent", version: "1.0.0" } },
});
console.log(init?.result);   // { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sigilkit-mcp", version } }

const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
console.log(list?.result.tools.map((t: ToolDef) => t.name));  // the four tool names

// A tool that throws does NOT break the session: the error comes back as a normal
// result with `isError: true`, so a model can read it and retry.
const bad = await handleMessage({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "validate_request", arguments: { request: { agentId: "0xnope" } } },
});
console.log(bad?.result.isError);   // true — not a JSON-RPC error
```

`TOOLS`, `ToolDef` and `LeafKind` are all exported, so an embedder can wrap, filter or
re-register the tool surface — `LeafKind` in particular is part of the `build_scope`
*response*: its `leafKinds` array is positionally aligned with the `targets` you sent, so
you can tell which whitelist entries are argument-bound (`pinned`) versus open to any
calldata for that selector (`wildcard`).

### Talking to it over stdio by hand

Each line on stdin is one complete JSON-RPC message; each line on stdout is one response.
This is the quickest way to confirm the wiring before pointing an agent framework at it:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node packages/mcp/dist/cli.js 2>/dev/null
```

Note the `2>/dev/null`: **stdout is the protocol channel**, so any diagnostic that leaks
into it corrupts the stream for the client.

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
