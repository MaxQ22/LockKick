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
 * Agent Runner
 *
 * Orchestrates the agentic loop:
 *   1. Send messages to the LLM (non-streaming, so tool-call JSON can be parsed cleanly)
 *   2. Parse any tool call from the response
 *   3. Execute the tool (with user approval where required)
 *   4. Feed the result back to the LLM
 *   5. Repeat until the LLM returns a final answer (no tool call)
 *
 * The runner emits events via callbacks so the UI can update in real time.
 */

import { OpenAIClient, ConnectionConfig } from '../utils/openaiClient.js';
import {
    AgentMessage, ToolCall, ToolResult,
    AGENT_SYSTEM_PROMPT,
    parseToolCall, formatToolResult, stripToolCall,
} from './agentProtocol.js';
import { executeTool, ConfirmFn } from './agentTools.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentRunnerCallbacks {
    /** Called when the agent emits plain text (reasoning or final answer). */
    onAssistantMessage: (text: string) => void;
    /** Called when the agent decides to use a tool. */
    onToolCall: (call: ToolCall) => void;
    /** Called after a tool has been executed. */
    onToolResult: (result: ToolResult) => void;
    /** Called when the full run is complete. */
    onComplete: () => void;
    /** Called on any unrecoverable error. */
    onError: (message: string) => void;
}

export interface AgentRunOptions {
    config: ConnectionConfig;
    userMessage: string;
    history: AgentMessage[];
    callbacks: AgentRunnerCallbacks;
    signal: AbortSignal;
    /** Inline confirmation callback — routes approvals to the chat UI instead of a modal popup. */
    confirm?: ConfirmFn;
    /** Maximum tool-call iterations before forcing a stop (prevents infinite loops). */
    maxIterations?: number;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Runs the full agentic loop for a single user turn.
 * Mutates `history` in-place, appending all messages generated during the run.
 */
export async function runAgent(options: AgentRunOptions): Promise<void> {
    const {
        config, userMessage, history, callbacks, signal,
        maxIterations = DEFAULT_MAX_ITERATIONS,
    } = options;

    const client = new OpenAIClient(config);

    // Build the full history for this run, prepending the system instructions
    const systemMessage: AgentMessage = {
        role: 'user',
        content: '[AGENT SYSTEM INSTRUCTIONS — DO NOT INCLUDE IN YOUR REPLY]\n' + AGENT_SYSTEM_PROMPT,
    };
    const fullHistory: AgentMessage[] = [systemMessage, ...history];

    // Append the new user message
    history.push({ role: 'user', content: userMessage });
    fullHistory.push({ role: 'user', content: userMessage });

    let iterations = 0;

    while (iterations < maxIterations) {
        // ── Check for user-requested stop ──────────────────────────────────
        if (signal.aborted) {
            break; // clean exit; onComplete will still be called below
        }

        iterations++;

        // ── Call the LLM ───────────────────────────────────────────────────
        let response: string;
        try {
            response = await client.chat(fullHistory as any[], signal);
        } catch (e: any) {
            if (signal.aborted || e.name === 'AbortError') {
                break; // user stopped — exit cleanly
            }
            callbacks.onError(`LLM request failed: ${e.message}`);
            return;
        }

        // ── Parse the response ─────────────────────────────────────────────
        const toolCall = parseToolCall(response);

        if (!toolCall) {
            // No tool call → final answer
            history.push({ role: 'assistant', content: response });
            callbacks.onAssistantMessage(response);
            break;
        }

        // ── Show any reasoning text before the tool call ───────────────────
        const reasoning = stripToolCall(response);
        if (reasoning) {
            callbacks.onAssistantMessage(reasoning);
        }

        // ── Notify UI of the tool call ─────────────────────────────────────
        callbacks.onToolCall(toolCall);

        // Record the assistant message (including the TOOL_CALL line) in history
        fullHistory.push({ role: 'assistant', content: response });
        history.push({ role: 'assistant', content: response });

        // ── Execute the tool ───────────────────────────────────────────────
        // Check abort again before executing (tool execution may show a dialog)
        if (signal.aborted) {
            break;
        }

        const result = await executeTool(toolCall, options.confirm);
        callbacks.onToolResult(result);

        // Feed the result back into the conversation
        const resultMessage = formatToolResult(result);
        fullHistory.push({ role: 'user', content: resultMessage });
        history.push({ role: 'user', content: resultMessage });

        // If the user explicitly rejected/cancelled, tell the agent clearly
        // and stop the loop — do NOT let the model retry silently.
        if (!result.success) {
            const isUserRejection =
                result.error?.includes('rejected') ||
                result.error?.includes('cancelled');

            if (isUserRejection) {
                const stopNote: AgentMessage = {
                    role: 'user',
                    content: 'The user rejected or cancelled that operation. Please stop and explain what you were trying to do, then ask how the user would like to proceed.',
                };
                fullHistory.push(stopNote);
                history.push(stopNote);

                // One final LLM call so it can respond gracefully
                try {
                    const finalResponse = await client.chat(fullHistory as any[], signal);
                    if (!signal.aborted) {
                        history.push({ role: 'assistant', content: finalResponse });
                        callbacks.onAssistantMessage(finalResponse);
                    }
                } catch { /* ignore errors in the graceful close */ }
                break; // Do NOT continue the loop
            }
        }
    }

    if (iterations >= maxIterations) {
        callbacks.onError(
            `Agent reached the maximum of ${maxIterations} tool-call iterations. ` +
            'Stopping to prevent a runaway loop.'
        );
    }

    callbacks.onComplete();
}
