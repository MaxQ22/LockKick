import fetch from 'node-fetch';
import * as vscode from 'vscode';

export class OpenAIClient {
    private url: string;
    private apiKey: string;
    private model: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('lockick');
        this.url = config.get<string>('serverUrl') || 'http://localhost:1234/v1';
        this.apiKey = config.get<string>('apiKey') || 'lm-studio';
        this.model = config.get<string>('modelName') || 'default';
    }

    async chat(messages: { role: string; content: string }[]): Promise<string> {
        try {
            const response = await fetch(`${this.url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: messages,
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API Error: ${response.status} - ${errorText}`);
            }

            const data: any = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error('LocKick OpenAI Client Error:', error);
            throw error;
        }
    }

    // Placeholder for streaming support
    async chatStream(messages: { role: string; content: string }[], callback: (content: string) => void): Promise<void> {
         // To be implemented in later Phase 1 steps
    }
}
