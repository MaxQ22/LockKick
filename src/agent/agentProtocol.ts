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

You MUST use the provided tools for any action involving files, code, or the workspace.  
Never output code, file contents, or analysis directly when a tool is appropriate.

Your core rules:

1. TOOL-FIRST BEHAVIOR
   - If the user asks to read, inspect, search, modify, create, delete, or run anything in the workspace,
     you MUST call the appropriate tool.
   - Do NOT print file contents or code directly unless the user explicitly asks for an explanation
     and no tool interaction is needed.

2. DECISION PROCESS (follow this every turn)
   Step 1: Determine whether the user request involves workspace interaction.
   Step 2: If yes → choose the correct tool and call it immediately.
   Step 3: If no → respond normally with text.
   Step 4: When using a tool, output ONLY the tool call JSON.

3. VALID TOOL USE CASES
   - read_file: whenever you need to see file content.
   - list_files: when you need to explore the workspace.
   - run_search: when looking for references, symbols, or text.
   - propose_edit: when modifying an existing file.
   - create_file: when generating a new file.
   - delete_file: when removing a file.
   - run_command: when executing a shell command.

4. NEVER DO THE FOLLOWING
   - Never rewrite or print an entire file unless the user explicitly asks.
   - Never hallucinate file paths or code.
   - Never describe what you “would” do instead of using a tool.
   - Never mix tool calls with normal text. A tool call must be the ONLY output.

5. WHEN UNSURE
   - If you are uncertain which tool to use, ask the user a clarifying question.
   - If the user request is ambiguous, ask for more details before acting.

6. STYLE
   - Be concise, technical, and action-oriented.
   - Prefer tool usage over long explanations.
   - Always aim to minimize the amount of code you generate manually.

Your highest priority is:  
**Use tools correctly, consistently, and immediately whenever interacting with the workspace.**
**Answer in small steps, tool call by tool call, use propose patch over propose edit when possible, and always try to do small edits at a time**
** Read the workspace file by file and then finish the tetrois game by proposing small edits**

You have access to the following tools. To use a tool, output EXACTLY ONE LINE in this format:
TOOL_CALL: {"tool":"<tool_name>","args":{...}} .Issue only ONE tool call per response. Wait for the result before proceeding.

Available tools:

read_file     - Read the complete content of a file.
  args: { "path": "<relative or absolute path>" }

read_file_range - Read a slice of a file by byte or line range.
  args: { "path": "<file path>", "start": <number>, "end": <number>, "mode": "<'bytes' | 'lines', default: 'lines'>" }

get_file_info - Return metadata about a file without reading its content.
  args: { "path": "<file path>" }

summarize_file - Get a structural summary of a file (imports, classes, functions, comments, TODOs).
  args: { "path": "<file path>", "max_depth": <number, optional> }

list_files    - List all files recursively in the workspace.
  args: { "directory": "<optional relative path, defaults to workspace root>" }

list_directory - Get a shallow listing of files and directories in a directory.
  args: { "directory": "<optional relative path, defaults to workspace root>" }

get_project_structure - Return a high-level project map with directory tree and key config files.
  args: { "max_depth": <number, optional, default: 3> }

propose_edit  - Propose a full-file edit. The user will see a diff and can approve or reject.
  args: { "path": "<file path>", "content": "<complete new file content>", "description": "<what changed and why>" }

propose_patch - Submit a unified diff instead of full-file replacement.
  args: { "path": "<file path>", "diff": "<unified diff format>", "description": "<explanation of changes>" }

apply_snippet - Insert or replace code at a specific location in a file.
  args: { "path": "<file path>", "location": { "line": <number>, "end_line": <number, optional> }, "snippet": "<code to insert>", "description": "<what this does>" }

create_file   - Create a new file. The user must confirm.
  args: { "path": "<file path>", "content": "<file content>", "description": "<what this file is for>" }

delete_file   - Delete a file. The user must confirm.
  args: { "path": "<file path>" }

run_search    - Search for text across the workspace with basic results.
  args: { "query": "<search term>", "directory": "<optional directory>" }

run_search_with_context - Search for text and return surrounding lines for context.
  args: { "query": "<search term>", "directory": "<optional directory>", "context_lines": <number, optional, default: 5> }

run_symbol_search - Search for code symbols (functions, classes, variables, types).
  args: { "symbol": "<symbol name>", "kind": "<'function' | 'class' | 'variable' | 'type', optional>" }

run_command   - Run a shell command restricted to the workspace.
  args: { "command": "<shell command>", "cwd": "<optional RELATIVE path within the workspace>" }

RULES:
- There could be a file .vscode/workspace-summary.md that contains a summary of the project. Always read it if it exists before doing anything else.
- Try to keep the code files short. If you need a lot of code, no file should be larger then 300 lines.
- If you have no idea of the codebase, start by listing files to get an overview.
- Issue only ONE tool call per response. Wait for the result before proceeding.
- Never guess file contents — read the file first if you need to know what is in it.
- Always prefer propose_edit over create_file for files that already exist.
- When a task is complete, respond normally without any TOOL_CALL line.
- Be efficient: plan before acting, and explain what you are doing.`.trim();

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
 */
export function stripThinkTags(response: string): string {
    return response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
