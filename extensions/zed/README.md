# Grada Zed Extension (scaffold)

Ships the Grada MCP server (`npx -y grada-run mcp`) to Zed's Agent Panel
as a context server. Requires Node.js >= 18 with `npx` on PATH.

## Verify locally

1. Open Zed → Extensions → **Install Dev Extension**, select
   `extensions/zed/`.
2. Open the Agent Panel → add the `grada` context server.
3. Ask the agent to list the Grada tools (`analyze_stack`,
   `add_primitive`, `stack_status`, `fetch_logs`, `audit_secrets`).

## Submit to the marketplace

1. Push this directory as its own Git repo (`grada-run/grada-zed`;
   Zed extensions are one-repo-per-extension) when opening the
   registry PR — it stays in-tree at `extensions/zed/` until then.
2. Submit it to https://zed.dev/extensions (context-servers filter).
3. Verify it installs from Zed's in-app extension manager.

> Note: Zed plans to deprecate MCP server extensions in favor of the
> official MCP registry (https://registry.modelcontextprotocol.io/).
> Publish there as well as the canonical listing.
