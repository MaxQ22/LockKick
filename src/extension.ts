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
            // Handled inside the webview settings panel
            vscode.commands.executeCommand('lockick.chatView.focus');
        }),
        vscode.commands.registerCommand('lockick.askAboutSelection', () => {
            chatProvider.sendAskAboutSelection();
        })
    );
}

export function deactivate() {}
