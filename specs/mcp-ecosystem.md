# Specification: Native MCP Server & Agent Ecosystem

## 1. Overview
This sprint embeds a Model Context Protocol (MCP) server directly into the CLI via a new `grada mcp` command, exposing Day-0 scaffolding and Day-2 observability tools to AI coding assistants. It also creates marketplace-ready plugin manifests for Cursor, Claude, Windsurf, Zed, OpenAI, and Copilot, and fixes programmatic API error boundaries discovered via telemetry.

## 2. Boundaries & Constraints
- **TRANSPORT:** The `grada mcp` command must implement the standard MCP STDIO transport layer.
- **NO PROMPTS:** All wrapped CLI logic must implicitly bypass prompts.
- **ISOLATION:** Do not refactor existing core command logic in `src/commands/`. Use wrappers.
- **NO PROCESS.EXIT:** The MCP server must survive programmatic errors (e.g., `AWS_CLI_MISSING`, `TERRAFORM_NOT_INITIALIZED`).

## 3. Implementation Targets

### A. Programmatic API & Telemetry Hardening
- **The Bug:** Telemetry reveals that when `runAdd`, `runDomain`, etc. are called programmatically, the telemetry event registers as `module_import` and internal utility failures (like `system.js` dependency checks) trigger a fatal `process.exit(1)`, crashing the calling script.
- **The Fix:** 
  1. Ensure `utils/telemetry.js` correctly infers the active command name even when `is_cli_entry` is false.
  2. Implement an execution boundary wrapper (e.g., inside the new `mcp.js` tool handlers) that safely catches internal `failCommand` or `process.exit` calls thrown by the legacy programmatic functions, converting them into structured `{ isError: true, content: [...] }` MCP JSON-RPC responses rather than crashing the server.

### B. The MCP Server (`src/commands/mcp.js`)
Implement the `mcp` command starting the STDIO server. Add `@modelcontextprotocol/sdk` and `zod`. Register:
- **`analyze_stack`**: Tells the LLM what framework/targets are configured.
- **`add_primitive`**: Wraps programmatic `grada add`.
- **`stack_status`**: Wraps programmatic `grada status`.
- **`fetch_logs`**: Wraps programmatic `grada logs`.
- **`audit_secrets`**: Wraps programmatic `grada secrets audit`.

### C. Universal Marketplace Integrations
Generate the following files/logic for maximum ecosystem discovery:
- **Claude Code:** `.claude-plugin/plugin.json` and `skills/grada-aws-infrastructure/SKILL.md`.
- **Cursor:** `.cursor/rules/grada-infrastructure.mdc`.
- **Windsurf:** `.windsurfrules`.
- **Copilot:** `.github/copilot-instructions.md`.
- **OpenAPI:** `.ai/openapi.json` (OpenAPI 3.1.0 schema documenting the 5 tools).
- **Auto-Installer:** Add `grada mcp --install <editor>` flag to inject the MCP config directly into the user's IDE config (`windsurf`, `zed`, `cursor`, `vscode`, `claude-desktop`, `gemini-cli`).

## 4. Acceptance Criteria
1. Running `grada mcp` responds to standard JSON-RPC payloads over `stdin`.
2. The MCP server does *not* crash if a tool triggers an internal `AWS_CLI_MISSING` or capability error.
3. The 6 IDE/Agent marketplace manifest files exist and are valid.
4. `grada mcp --install windsurf` correctly modifies the local file system config.