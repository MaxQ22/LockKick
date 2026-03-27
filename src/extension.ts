/*
 * Copyright (C) 2026 Max Fend
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

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
    const agentLog = new AgentLogProvider();
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

export function deactivate(): void { }
