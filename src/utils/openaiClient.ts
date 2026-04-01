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
    private readonly MAX_RETRIES = 3;
    private readonly INITIAL_RETRY_DELAY_MS = 500;

    constructor(config: ConnectionConfig) {
        this.config = config;
    }

    /**
     * Helper method to fetch with automatic retry logic and exponential backoff.
     * Retries on network errors and specific HTTP status codes.
     */
    private async fetchWithRetry(
        url: string,
        options: RequestInit,
        maxRetries: number = this.MAX_RETRIES
    ): Promise<Response> {
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);
                
                // Retry on 5xx errors and connection timeouts
                if (response.status >= 500 || response.status === 429) {
                    if (attempt < maxRetries) {
                        const delayMs = this.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }
                }
                
                return response;
            } catch (error: any) {
                lastError = error;
                
                // Retry on network errors
                if (attempt < maxRetries) {
                    const delayMs = this.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
            }
        }
        
        // All retries exhausted
        throw lastError || new Error('Failed to fetch after maximum retries');
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

            const response = await this.fetchWithRetry(`${url}/models`, {
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
     * Long requests may take considerable time; defaults to 10 minute timeout.
     * Includes automatic retry logic with exponential backoff.
     */
    async chat(messages: { role: string; content: string }[], signal?: AbortSignal): Promise<string> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        try {
            // Set up timeout for long-running LLM requests (10 minutes)
            const controller = new AbortController();
            const timeoutMs = 10 * 60 * 1000; // 10 minutes
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            // Use timeout controller as the signal, unless user provided one
            const activeSignal = signal || controller.signal;

            const response = await this.fetchWithRetry(`${url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    model: this.config.modelName,
                    messages,
                    temperature: 0.7
                }),
                signal: activeSignal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error ${response.status}: ${errorText}`);
            }

            const data: any = await response.json();
            return data.choices[0].message.content;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error('Request cancelled by user');
            }
            if (error.message?.includes('fetch')) {
                throw new Error(`Network error: Failed to reach ${url}. Is the server running and accessible?`);
            }
            throw error;
        }
    }

    /**
     * Sends a direct completion or short chat request for inline auto-completion.
     * Includes automatic retry logic with exponential backoff.
     */
    async getCompletion(prompt: string, maxTokens: number = 64, signal?: AbortSignal): Promise<string> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        try {
            // Set up timeout (2 minutes for completions, shorter than full chat)
            const controller = new AbortController();
            const timeoutMs = 2 * 60 * 1000; // 2 minutes
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            const activeSignal = signal || controller.signal;

            // Using chat completions endpoint as it's most broadly supported by standard models
            const response = await this.fetchWithRetry(`${url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`
                },
                body: JSON.stringify({
                    model: this.config.modelName,
                    messages: [
                        { role: 'system', content: 'You are an intelligent code completion engine. Your task is to complete the code provided by the user. ONLY output the exact code that should be inserted at the cursor position. Do not enclose it in markdown blocks. Do not explain. Do not repeat code.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    max_tokens: maxTokens,
                    stop: ['\n\n'] // Useful to stop rambling in inline autocomplete
                }),
                signal: activeSignal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error ${response.status}: ${errorText}`);
            }

            const data: any = await response.json();
            return data.choices[0].message.content;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error('Request cancelled by user');
            }
            if (error.message?.includes('fetch')) {
                throw new Error(`Network error: Failed to reach ${url}. Is the server running and accessible?`);
            }
            throw error;
        }
    }

    /**
     * Streams a chat completion request.
     * Calls onChunk with each new text delta as it arrives.
     * Returns the full assembled response when done.
     * Long streaming requests may take considerable time; defaults to 15 minute timeout.
     * Includes automatic retry logic with exponential backoff.
     */
    async chatStream(
        messages: { role: string; content: string }[],
        onChunk: (delta: string) => void,
        signal?: AbortSignal
    ): Promise<string> {
        const url = this.config.serverUrl.replace(/\/+$/, '');

        try {
            // Set up timeout for long-running streaming requests (15 minutes)
            const controller = new AbortController();
            const timeoutMs = 15 * 60 * 1000; // 15 minutes
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            // Use timeout controller as the signal, unless user provided one
            const activeSignal = signal || controller.signal;

            const response = await this.fetchWithRetry(`${url}/chat/completions`, {
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
                signal: activeSignal
            });

            clearTimeout(timeout);

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
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error('Request cancelled by user or exceeded 15-minute timeout');
            }
            if (error.message?.includes('fetch')) {
                throw new Error(`Network error: Failed to reach ${url}. Is the server running and accessible?`);
            }
            throw error;
        }
    }
}
