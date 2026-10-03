# Grada for VS Code

Provision production-ready AWS infrastructure and operate it from VS Code.

## Commands

- **Grada: Install MCP Server** — runs `npx -y grada-run mcp --install vscode`,
  registering the Grada MCP server (`analyze_stack`, `add_primitive`,
  `stack_status`, `fetch_logs`, `audit_secrets`) in your user `mcp.json`.
  Requires Node.js >= 18.
- **Grada: Open Documentation** — opens the Grada repository.

## Manual MCP config

If you prefer to wire the server yourself, add this to your user or
workspace `mcp.json` (note VS Code's `servers` key):

```json
{
    "servers": {
        "grada": { "command": "npx", "args": ["grada-run", "mcp"] }
    }
}
```
