import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/chatViewProvider.js';

export function activate(context: vscode.ExtensionContext) {
    console.log('LocKick is now active.');

    const chatProvider = new ChatViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider
        ),
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
