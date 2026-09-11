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
path; these tools are the propose-and-verify layer. Wire it into any MCP client:

    {
      "mcpServers": {
        "sigilkit": { "command": "node", "args": ["packages/mcp/dist/cli.js"] }
      }
    }
