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
    | 'list_files'
    | 'propose_edit'
    | 'create_file'
    | 'delete_file'
    | 'run_search';

export interface ReadFileArgs    { path: string }
export interface ListFilesArgs   { directory?: string }
export interface ProposeEditArgs { path: string; content: string; description?: string }
export interface CreateFileArgs  { path: string; content: string; description?: string }
export interface DeleteFileArgs  { path: string }
export interface RunSearchArgs   { query: string; directory?: string }

export type ToolArgs =
    | ReadFileArgs
    | ListFilesArgs
    | ProposeEditArgs
    | CreateFileArgs
    | DeleteFileArgs
    | RunSearchArgs;

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

You have access to the following tools. To use a tool, output EXACTLY ONE LINE in this format:
TOOL_CALL: {"tool":"<tool_name>","args":{...}}

Available tools:

read_file     - Read the content of a file.
  args: { "path": "<relative or absolute path>" }

list_files    - List files and directories.
  args: { "directory": "<optional relative path, defaults to workspace root>" }

propose_edit  - Propose an edit to an existing file. The user will see a diff and can approve or reject.
  args: { "path": "<file path>", "content": "<complete new file content>", "description": "<what changed and why>" }

create_file   - Create a new file. The user must confirm.
  args: { "path": "<file path>", "content": "<file content>", "description": "<what this file is for>" }

delete_file   - Delete a file. The user must confirm.
  args: { "path": "<file path>" }

run_search    - Search for text across the workspace.
  args: { "query": "<search term>", "directory": "<optional directory>" }

RULES:
- Issue only ONE tool call per response. Wait for the result before proceeding.
- Never guess file contents — read the file first if you need to know what is in it.
- Always prefer propose_edit over create_file for files that already exist.
- When a task is complete, respond normally without any TOOL_CALL line.
- Be efficient: plan before acting, and explain what you are doing.`.trim();

// ─── Parser ───────────────────────────────────────────────────────────────────

const TOOL_CALL_PREFIX = 'TOOL_CALL:';
const TOOL_RESULT_PREFIX = 'TOOL_RESULT:';

/**
 * Parses a tool call from a model response string.
 * Returns null if no tool call is found.
 */
export function parseToolCall(response: string): ToolCall | null {
    const lines = response.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(TOOL_CALL_PREFIX)) {
            const jsonStr = trimmed.slice(TOOL_CALL_PREFIX.length).trim();
            try {
                const parsed = JSON.parse(jsonStr) as ToolCall;
                if (typeof parsed.tool === 'string' && parsed.args !== undefined) {
                    return parsed;
                }
            } catch {
                // malformed JSON — treat as no tool call
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
 * Strips any TOOL_CALL line from a response for display purposes.
 */
export function stripToolCall(response: string): string {
    return response
        .split('\n')
        .filter(line => !line.trim().startsWith(TOOL_CALL_PREFIX))
        .join('\n')
        .trim();
}
