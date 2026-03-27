import * as vscode from 'vscode';
import { OpenAIClient, ConnectionConfig } from '../utils/openaiClient.js';

export class LocKickInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debounceTimer: NodeJS.Timeout | undefined;

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        
        const config = vscode.workspace.getConfiguration('lockick');
        const isEnabled = config.get<boolean>('inlineCompletionsEnabled', false);
        
        if (!isEnabled || token.isCancellationRequested) {
            return undefined;
        }

        // Add a slight debounce to avoid spamming the local model on every keystroke
        return new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }

            this.debounceTimer = setTimeout(async () => {
                if (token.isCancellationRequested) {
                    resolve(undefined);
                    return;
                }

                resolve(await this.fetchCompletion(document, position, config, token));
            }, 300); // 300ms debounce
        });
    }

    private async fetchCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
        workspaceConfig: vscode.WorkspaceConfiguration,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        
        const prefixLines = 30; // Amount of context above cursor
        const suffixLines = 10; // Amount of context below cursor

        const startLine = Math.max(0, position.line - prefixLines);
        const endLine = Math.min(document.lineCount - 1, position.line + suffixLines);

        const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
        const suffixRange = new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).text.length);

        const prefix = document.getText(prefixRange);
        const suffix = document.getText(suffixRange);

        const prompt = `File: ${document.fileName}\nLanguage: ${document.languageId}\n\nCode before cursor:\n\`\`\`${document.languageId}\n${prefix}\n\`\`\`\n\nCode after cursor:\n\`\`\`${document.languageId}\n${suffix}\n\`\`\`\n\nProvide ONLY the exact code to be inserted at the cursor position. Do not provide explanations or repeat code.`;

        const connectionConfig: ConnectionConfig = {
            serverUrl: workspaceConfig.get<string>('serverUrl') || 'http://localhost:1234/v1',
            apiKey: workspaceConfig.get<string>('apiKey') || 'lm-studio',
            modelName: workspaceConfig.get<string>('modelName') || 'default',
        };

        const maxTokens = workspaceConfig.get<number>('completionMaxTokens', 64);
        const client = new OpenAIClient(connectionConfig);

        try {
            const abortController = new AbortController();
            token.onCancellationRequested(() => abortController.abort());

            let completionText = await client.getCompletion(prompt, maxTokens, abortController.signal);
            
            // Clean up typical model markdown wrappers if they exist
            completionText = completionText.replace(/^```[a-z]*\r?\n/, '');
            completionText = completionText.replace(/\r?\n```$/, '');

            if (!completionText) {
                return undefined;
            }

            const item = new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position));
            return [item];

        } catch (error: any) {
            console.warn('LocKick Inline Completion Error:', error.message);
            return undefined;
        }
    }
}
