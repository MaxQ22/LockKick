import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('LocKick is now active.');

    let disposable = vscode.commands.registerCommand('lockick.testConnection', () => {
        const config = vscode.workspace.getConfiguration('lockick');
        const url = config.get<string>('serverUrl');
        vscode.window.showInformationMessage(`Testing connection to: ${url}`);
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
