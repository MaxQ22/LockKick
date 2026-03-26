import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('LocKick is now active.');

    context.subscriptions.push(
        vscode.commands.registerCommand('lockick.testConnection', () => {
            const config = vscode.workspace.getConfiguration('lockick');
            const url = config.get<string>('serverUrl');
            vscode.window.showInformationMessage(`LocKick: Testing connection to: ${url}`);
        }),
        vscode.commands.registerCommand('lockick.askAboutSelection', () => {
            vscode.window.showInformationMessage('LocKick: Asking about selection...');
        })
    );
}

export function deactivate() {}
