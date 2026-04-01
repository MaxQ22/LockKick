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
 * Agent Protocol
 *
 * Defines the tool-calling schema, system prompt, and response parser for
 * the LocKick agent. Uses a simple, LLM-agnostic text-based protocol that
 * works with all OpenAI-compatible models — even small local ones.
 *
 * Tool call format (model output):
 *   TOOL_CALL: {"tool":"read_file","args":{"path":"src/main.ts"}}
 *
 * Tool result format (injected back as user message):
 *   TOOL_RESULT: {"tool":"read_file","success":true,"data":"..."}
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolName =
    | 'read_file'
    | 'read_file_range'
    | 'get_file_info'
    | 'summarize_file'
    | 'list_files'
    | 'list_directory'
    | 'get_project_structure'
    | 'propose_edit'
    | 'propose_patch'
    | 'apply_snippet'
    | 'create_file'
    | 'delete_file'
    | 'run_search'
    | 'run_search_with_context'
    | 'run_symbol_search'
    | 'run_command';

export interface ReadFileArgs { path: string }
export interface ReadFileRangeArgs { path: string; start: number; end: number; mode?: 'bytes' | 'lines' }
export interface GetFileInfoArgs { path: string }
export interface SummarizeFileArgs { path: string; max_depth?: number }
export interface ListFilesArgs { directory?: string }
export interface ListDirectoryArgs { directory?: string }
export interface GetProjectStructureArgs { max_depth?: number }
export interface ProposeEditArgs { path: string; content: string; description?: string }
export interface ProposePatchArgs { path: string; diff: string; description: string }
export interface ApplySnippetArgs { path: string; location: { line: number; end_line?: number }; snippet: string; description: string }
export interface CreateFileArgs { path: string; content: string; description?: string }
export interface DeleteFileArgs { path: string }
export interface RunSearchArgs { query: string; directory?: string }
export interface RunSearchWithContextArgs { query: string; directory?: string; context_lines?: number }
export interface RunSymbolSearchArgs { symbol: string; kind?: 'function' | 'class' | 'variable' | 'type' }
export interface RunCommandArgs { command: string; cwd?: string }

export type ToolArgs =
    | ReadFileArgs
    | ReadFileRangeArgs
    | GetFileInfoArgs
    | SummarizeFileArgs
    | ListFilesArgs
    | ListDirectoryArgs
    | GetProjectStructureArgs
    | ProposeEditArgs
    | ProposePatchArgs
    | ApplySnippetArgs
    | CreateFileArgs
    | DeleteFileArgs
    | RunSearchArgs
    | RunSearchWithContextArgs
    | RunSymbolSearchArgs
    | RunCommandArgs;

export interface ToolCall {
    tool: ToolName;
    args: ToolArgs;
}

export interface ToolResult {
    tool: ToolName;
    success: boolean;
    data?: string;
    error?: string;
}

export interface AgentMessage {
    role: 'user' | 'assistant';
    content: string;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `You are LocKick Agent, an AI coding assistant that can read and modify files in the user's VS Code workspace.

To use a tool, output EXACTLY ONE LINE:
TOOL_CALL: {"tool":"<tool_name>","args":{...}}

Available tools:

read_file - Read a file.
  args: { "path": "<path>" }

read_file_range - Read a byte or line range.
  args: { "path": "<path>", "start": <number>, "end": <number>, "mode": "bytes" | "lines" }

get_file_info - Get file metadata.
  args: { "path": "<path>" }

summarize_file - Summarize a file.
  args: { "path": "<path>", "max_depth": <optional number> }

list_files - List files and directories.
  args: { "directory": "<optional path>" }

list_directory - List directories only.
  args: { "directory": "<optional path>" }

get_project_structure - Return project structure.
  args: { "max_depth": <optional number> }

propose_edit - Replace full file content.
  args: { "path": "<file>", "content": "<new content>", "description": "<reason>" }

propose_patch - Apply a diff patch.
  args: { "path": "<file>", "diff": "<unified diff>", "description": "<reason>" }

apply_snippet - Insert or replace a snippet.
  args: { "path": "<file>", "location": { "line": <n>, "end_line": <optional n> }, "snippet": "<code>", "description": "<reason>" }

create_file - Create a new file.
  args: { "path": "<file>", "content": "<content>", "description": "<purpose>" }

delete_file - Delete a file.
  args: { "path": "<file>" }

run_search - Search text in workspace.
  args: { "query": "<text>", "directory": "<optional path>" }

run_search_with_context - Search with context lines.
  args: { "query": "<text>", "directory": "<optional path>", "context_lines": <optional number> }

run_symbol_search - Search for symbols.
  args: { "symbol": "<name>", "kind": "function" | "class" | "variable" | "type" }

run_command - Run a shell command in workspace.
  args: { "command": "<cmd>", "cwd": "<optional relative path>" }

RULES:
- One tool call per response. Wait for the result before continuing.
- Never guess file contents. Read files before modifying them.
- Use propose_edit for existing files; use create_file only for new files.
- When the task is complete, answer normally without TOOL_CALL.
- Prefer tools over direct answers. Use tools to gather information and make changes, then summarize in your final response.
- Prefer diff patches for small edits, and full content replacement for large changes. Use your judgment based on the scope of the edit.
- You might find a project summary in .vscode/workspace-summary.md. See if this file exists and use it to understand the project structure and key files if you need context.
- Think before acting. Keep actions minimal and efficient.
`.trim();

// ─── Parser ───────────────────────────────────────────────────────────────────

const TOOL_CALL_PREFIX = 'TOOL_CALL:';
const TOOL_RESULT_PREFIX = 'TOOL_RESULT:';
const THINK_TAG_OPEN = '<think>';
const THINK_TAG_CLOSE = '</think>';

/**
 * Extracts content from <think> tags for logging purposes.
 * Returns the concatenated content of all think tags found.
 */
export function extractThinkContent(response: string): string {
    const regex = /<think>([\s\S]*?)<\/think>/g;
    const matches = response.match(regex) || [];
    return matches
        .map(match => match.replace(/<think>|<\/think>/g, '').trim())
        .filter(text => text.length > 0)
        .join('\n\n');
}

/**
 * Strips <think> tags and their content from a response for display purposes.
 * Handles various formats and edge cases.
 */
export function stripThinkTags(response: string): string {
    // Replace each <think>...</think> block with "Thinking..."
    let cleaned = response.replace(
        /<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi,
        'Thinking...'
    );

    // Remove any leftover orphaned tags just in case
    cleaned = cleaned.replace(/<\s*think\b[^>]*>/gi, 'Thinking...');
    cleaned = cleaned.replace(/<\s*\/\s*think\s*>/gi, '');

    // Clean up excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Parses a tool call from a model response string.
 * Returns null if no tool call is found.
 * Handles multi-line JSON and embedded tool calls (e.g., "...text... TOOL_CALL: {...} ...text...").
 */
export function parseToolCall(response: string): ToolCall | null {
    // Try to find TOOL_CALL: prefix using a regex that can handle it being in the middle of text.
    // Use greedy matching ([\s\S]*) to capture nested JSON objects correctly.
    const toolCallRegex = /TOOL_CALL:\s*(\{[\s\S]*\})/;
    const match = response.match(toolCallRegex);
    
    if (!match) {
        return null;
    }
    
    let jsonStr = match[1];
    
    // Try to parse the captured JSON
    try {
        const parsed = JSON.parse(jsonStr) as ToolCall;
        if (typeof parsed.tool === 'string') {
            parsed.args = parsed.args || {};
            return parsed;
        }
    } catch {
        // Regex captured too much (multiple TOOL_CALL sections).
        // Fall back to a more conservative approach: match only up to the next significant boundary.
        // Try matching a single top-level JSON object more carefully.
        let braceCount = 0;
        let endIdx = -1;
        
        for (let i = 0; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') braceCount++;
            else if (jsonStr[i] === '}') braceCount--;
            
            if (braceCount === 0 && i > 0) {
                endIdx = i + 1;
                break;
            }
        }
        
        if (endIdx > 0) {
            jsonStr = jsonStr.substring(0, endIdx);
            try {
                const parsed = JSON.parse(jsonStr) as ToolCall;
                if (typeof parsed.tool === 'string') {
                    parsed.args = parsed.args || {};
                    return parsed;
                }
            } catch {
                // Still malformed
            }
        }
        
        // If greedy regex failed and fallback failed, try line-by-line as last resort
        const lines = response.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith(TOOL_CALL_PREFIX)) {
                let jsonStr = trimmed.slice(TOOL_CALL_PREFIX.length).trim();
                
                let j = i + 1;
                while (j < lines.length) {
                    try {
                        const parsed = JSON.parse(jsonStr) as ToolCall;
                        if (typeof parsed.tool === 'string') {
                            parsed.args = parsed.args || {};
                            return parsed;
                        }
                        break;
                    } catch {
                        jsonStr += '\n' + lines[j];
                        j++;
                    }
                }
                
                try {
                    const parsed = JSON.parse(jsonStr) as ToolCall;
                    if (typeof parsed.tool === 'string') {
                        parsed.args = parsed.args || {};
                        return parsed;
                    }
                } catch {
                    // malformed JSON — treat as no tool call
                }
            }
        }
    }
    
    return null;
}

/**
 * Formats a tool result as a user message to feed back to the model.
 */
export function formatToolResult(result: ToolResult): string {
    return `${TOOL_RESULT_PREFIX} ${JSON.stringify(result)}`;
}

/**
 * Strips TOOL_CALL lines and <think> tags from a response for display purposes.
 */
export function stripToolCall(response: string): string {
    // First strip think tags
    let cleaned = stripThinkTags(response);
    
    // Then strip tool calls (both inline and multi-line)
    cleaned = cleaned.replace(/TOOL_CALL:\s*\{[\s\S]*?\}/g, '').trim();
    
    // Also handle line-based tool calls for safety
    const lines = cleaned.split('\n');
    const result: string[] = [];
    
    let inToolCall = false;
    let braceCount = 0;
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        if (!inToolCall && trimmed.startsWith(TOOL_CALL_PREFIX)) {
            inToolCall = true;
            const jsonPart = trimmed.slice(TOOL_CALL_PREFIX.length).trim();
            braceCount = (jsonPart.match(/{/g) || []).length - (jsonPart.match(/}/g) || []).length;
            if (braceCount === 0) {
                inToolCall = false;
            }
        } else if (inToolCall) {
            braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
            if (braceCount <= 0) {
                inToolCall = false;
            }
        } else {
            result.push(line);
        }
    }
    
    return result.join('\n').trim();
}
