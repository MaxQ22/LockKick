/**
 * LocKick Extension Entry Point
 *
 * Registers all WebView providers and commands.
 */

import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/chatViewProvider.js';
import { AgentLogProvider } from './providers/agentLogProvider.js';
import { LocKickInlineCompletionProvider } from './providers/inlineCompletionProvider.js';

export function activate(context: vscode.ExtensionContext): void {
    const agentLog  = new AgentLogProvider();
    const chatPanel = new ChatViewProvider(context.extensionUri, agentLog, context.secrets);
    const inlineProvider = new LocKickInlineCompletionProvider(context.secrets);

    context.subscriptions.push(
        // ── Providers ────────────────────────────────────────────────────────
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' }, 
            inlineProvider
        ),
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatPanel,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            AgentLogProvider.viewType,
            agentLog,
        ),

        // ── Commands ─────────────────────────────────────────────────────────
        vscode.commands.registerCommand('lockick.askAboutSelection', () => {
            chatPanel.sendAskAboutSelection();
        }),

        vscode.commands.registerCommand('lockick.testConnection', () => {
            vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
        }),

        vscode.commands.registerCommand('lockick.openAgentLog', () => {
            vscode.commands.executeCommand(`${AgentLogProvider.viewType}.focus`);
        }),
    );
}

export function deactivate(): void {}
