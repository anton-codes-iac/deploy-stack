const vscode = require('vscode');

function activate(context) {
    const install = vscode.commands.registerCommand('grada.installMcpServer', () => {
        const terminal = vscode.window.createTerminal('Grada MCP Install');
        terminal.sendText('npx -y grada-run mcp --install vscode');
        terminal.show();
        vscode.window.showInformationMessage(
            'Grada: installing the MCP server into your user mcp.json — restart Copilot chat when it finishes.'
        );
    });

    const docs = vscode.commands.registerCommand('grada.openDocs', () => {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/grada-run/grada'));
    });

    context.subscriptions.push(install, docs);
}

function deactivate() {}

module.exports = { activate, deactivate };
