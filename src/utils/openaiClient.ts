/**
 * OpenAI-compatible API client for LM Studio and similar local servers.
 * Uses the built-in Node.js fetch (available in Node 18+ / VS Code 1.85+).
 */
export interface ConnectionConfig {
    serverUrl: string;
    apiKey: string;
    modelName: string;
}

export interface ModelInfo {
    id: string;
    object: string;
    owned_by?: string;
}

export interface TestConnectionResult {
    success: boolean;
    message: string;
    models?: ModelInfo[];
}

export class OpenAIClient {
    private config: ConnectionConfig;

    constructor(config: ConnectionConfig) {
        this.config = config;
    }

    /**
     * Tests the connection by hitting the /models endpoint.
     * Returns a result object with success status, message, and available models.
     */
    async testConnection(): Promise<TestConnectionResult> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const response = await fetch(`${url}/models`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    message: `Server responded with ${response.status}: ${errorText}`
                };
            }

            const data: any = await response.json();
            const models: ModelInfo[] = data.data || [];

            return {
                success: true,
                message: `Connected successfully! Found ${models.length} model(s).`,
                models
            };
        } catch (error: any) {
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    message: `Connection timed out after 8 seconds. Is the server running at ${url}?`
                };
            }
            return {
                success: false,
                message: `Connection failed: ${error.message}`
            };
        }
    }

    /**
     * Sends a chat completion request (non-streaming).
     */
    async chat(messages: { role: string; content: string }[]): Promise<string> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model: this.config.modelName,
                messages,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }

        const data: any = await response.json();
        return data.choices[0].message.content;
    }

    /**
     * Streams a chat completion request.
     * Calls onChunk with each new text delta as it arrives.
     * Returns the full assembled response when done.
     */
    async chatStream(
        messages: { role: string; content: string }[],
        onChunk: (delta: string) => void,
        signal?: AbortSignal
    ): Promise<string> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model: this.config.modelName,
                messages,
                temperature: 0.7,
                stream: true
            }),
            signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error ${response.status}: ${errorText}`);
        }
        if (!response.body) {
            throw new Error('No response body returned from server.');
        }

        const decoder = new TextDecoder('utf-8');
        let fullContent = '';
        let buffer = '';

        for await (const chunk of response.body as any) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) { continue; }
                const dataStr = trimmed.slice(6);
                if (dataStr === '[DONE]') { return fullContent; }
                try {
                    const parsed = JSON.parse(dataStr);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                        onChunk(delta);
                    }
                } catch { /* ignore partial JSON */ }
            }
        }

        return fullContent;
    }
}
