use zed_extension_api::{self as zed, ContextServerId, Project, Result};

struct GradaExtension;

impl zed::Extension for GradaExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<zed::Command> {
        // grada-run ships its MCP server over npm; npx fetches and caches
        // it on first use. Requires Node.js >= 18 with npx on PATH.
        Ok(zed::Command {
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "grada-run".to_string(), "mcp".to_string()],
            env: vec![],
        })
    }
}

zed::register_extension!(GradaExtension);
