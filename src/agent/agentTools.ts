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
 * Agent Tools
 *
 * Implements each tool using the VS Code API. Every write or destructive
 * operation requires explicit user confirmation before execution.
 *
 * All file paths are resolved relative to the workspace root and validated
 * to prevent any access outside the workspace boundary.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as util from 'util';
import {
    ToolCall, ToolResult,
    ReadFileArgs, ReadFileRangeArgs, GetFileInfoArgs, SummarizeFileArgs,
    ListFilesArgs, ListDirectoryArgs, GetProjectStructureArgs,
    ProposeEditArgs, ProposePatchArgs, ApplySnippetArgs,
    CreateFileArgs, DeleteFileArgs,
    RunSearchArgs, RunSearchWithContextArgs, RunSymbolSearchArgs,
    RunCommandArgs,
} from './agentProtocol.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Called when a destructive tool needs user confirmation. Resolves to true = accepted. */
export type ConfirmFn = (request: { title: string; body: string }) => Promise<boolean>;

// ─── Public API ───────────────────────────────────────────────────────────────

/** Executes a parsed tool call. Returns a ToolResult to feed back to the model. */
export async function executeTool(call: ToolCall, confirm?: ConfirmFn): Promise<ToolResult> {
    const root = getWorkspaceRoot();
    if (!root) {
        return { tool: call.tool, success: false, error: 'No workspace folder is open.' };
    }

    try {
        switch (call.tool) {
            case 'read_file': return await toolReadFile(root, call.args as ReadFileArgs);
            case 'read_file_range': return await toolReadFileRange(root, call.args as ReadFileRangeArgs);
            case 'get_file_info': return await toolGetFileInfo(root, call.args as GetFileInfoArgs);
            case 'summarize_file': return await toolSummarizeFile(root, call.args as SummarizeFileArgs);
            case 'list_files': return await toolListFiles(root, call.args as ListFilesArgs);
            case 'list_directory': return await toolListDirectory(root, call.args as ListDirectoryArgs);
            case 'get_project_structure': return await toolGetProjectStructure(root, call.args as GetProjectStructureArgs);
            case 'propose_edit': return await toolProposeEdit(root, call.args as ProposeEditArgs, confirm);
            case 'propose_patch': return await toolProposePatch(root, call.args as ProposePatchArgs, confirm);
            case 'apply_snippet': return await toolApplySnippet(root, call.args as ApplySnippetArgs, confirm);
            case 'create_file': return await toolCreateFile(root, call.args as CreateFileArgs, confirm);
            case 'delete_file': return await toolDeleteFile(root, call.args as DeleteFileArgs, confirm);
            case 'run_search': return await toolRunSearch(root, call.args as RunSearchArgs);
            case 'run_search_with_context': return await toolRunSearchWithContext(root, call.args as RunSearchWithContextArgs);
            case 'run_symbol_search': return await toolRunSymbolSearch(root, call.args as RunSymbolSearchArgs);
            case 'run_command': return await toolRunCommand(root, call.args as RunCommandArgs, confirm);
            default:
                return { tool: call.tool, success: false, error: `Unknown tool: ${call.tool}` };
        }
    } catch (e: any) {
        return { tool: call.tool, success: false, error: e.message };
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/**
 * Resolves a path, enforces workspace boundary.
 * Throws if the resolved path escapes the workspace root.
 */
function resolveSafe(root: string, filePath: string): string {
    const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath);

    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Access denied: "${filePath}" is outside the workspace boundary.`);
    }
    return resolved;
}

function uriFor(p: string): vscode.Uri {
    return vscode.Uri.file(p);
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function toolReadFile(root: string, args: ReadFileArgs): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const bytes = await vscode.workspace.fs.readFile(uriFor(absPath));
    const content = Buffer.from(bytes).toString('utf8');

    // Truncate very large files to avoid blowing up the context window
    const MAX_CHARS = 16_000;
    const truncated = content.length > MAX_CHARS
        ? content.slice(0, MAX_CHARS) + `\n\n... [file truncated at ${MAX_CHARS} chars]`
        : content;

    return {
        tool: 'read_file',
        success: true,
        data: truncated,
    };
}

async function toolListFiles(root: string, args: ListFilesArgs): Promise<ToolResult> {
    const dir = args.directory ? resolveSafe(root, args.directory) : root;
    
    // Create a relative pattern to search recursively inside the requested directory
    const pattern = new vscode.RelativePattern(uriFor(dir), '**/*');
    
    // Find all files, excluding node_modules to avoid flooding the context
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');

    const lines = files
        .map(uri => path.relative(root, uri.fsPath).replace(/\\/g, '/'))
        .sort((a, b) => a.localeCompare(b));

    // Truncate to avoid context explosion if there are too many files
    const MAX_FILES = 1000;
    const truncatedLines = lines.slice(0, MAX_FILES);
    let outputData = truncatedLines.join('\n');
    
    if (lines.length > MAX_FILES) {
        outputData += `\n... (${lines.length - MAX_FILES} more files omitted)`;
    }

    return {
        tool: 'list_files',
        success: true,
        data: outputData || '(no files found)',
    };
}

async function toolProposeEdit(root: string, args: ProposeEditArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    // Verify the file exists before diffing
    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        return { tool: 'propose_edit', success: false, error: `File not found: ${args.path}` };
    }

    // Write the proposed content to a temp file for diffing
    const tempUri = uri.with({ path: uri.path + '.lockick-proposed' });
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(args.content));

    const label = args.description ?? `LocKick: Proposed edit to ${path.basename(args.path)}`;
    await vscode.commands.executeCommand('vscode.diff', uri, tempUri, label);

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Edit: ${path.relative(root, absPath)}`,
            body: args.description ?? 'Apply the proposed changes shown in the diff?',
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to edit "${path.relative(root, absPath)}". Apply this change?`,
            { modal: true }, 'Apply', 'Reject'
        );
        accepted = choice === 'Apply';
    }

    // Clean up temp file regardless of decision
    await vscode.workspace.fs.delete(tempUri, { useTrash: false }).then(
        () => { }, () => { } // ignore errors deleting temp file
    );

    closeRecentDiffs(uri);

    if (!accepted) {
        // Revert view to original file content
        await vscode.window.showTextDocument(uri);
        return { tool: 'propose_edit', success: false, error: 'User rejected the proposed edit.' };
    }

    await vscode.workspace.fs.writeFile(uri, encoder.encode(args.content));
    await vscode.window.showTextDocument(uri);
    return { tool: 'propose_edit', success: true, data: `File "${args.path}" updated successfully.` };
}

async function toolCreateFile(root: string, args: CreateFileArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    // Check if it already exists
    let exists = false;
    try {
        await vscode.workspace.fs.stat(uri);
        exists = true;
    } catch { /* does not exist */ }

    if (exists) {
        return {
            tool: 'create_file',
            success: false,
            error: `File already exists: "${args.path}". Use propose_edit instead.`,
        };
    }

    // Create a temporary empty file to diff against
    const emptyUri = uri.with({ path: uri.path + '.lockick-empty' });
    const tempUri = uri.with({ path: uri.path + '.lockick-proposed' });
    const encoder = new TextEncoder();

    await vscode.workspace.fs.writeFile(emptyUri, encoder.encode(''));
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(args.content));

    const label = args.description ?? `LocKick: Create ${path.basename(args.path)}`;
    await vscode.commands.executeCommand('vscode.diff', emptyUri, tempUri, label);

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Create: ${path.relative(root, absPath)}`,
            body: args.description ?? 'Create this new file with the content shown in the diff?',
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to create "${path.relative(root, absPath)}".`,
            { modal: true }, 'Create', 'Cancel'
        );
        accepted = choice === 'Create';
    }

    // Cleanup
    await Promise.all([
        vscode.workspace.fs.delete(emptyUri, { useTrash: false }).then(() => { }, () => { }),
        vscode.workspace.fs.delete(tempUri, { useTrash: false }).then(() => { }, () => { }),
    ]);

    closeRecentDiffs(uri);

    if (!accepted) {
        return { tool: 'create_file', success: false, error: 'User cancelled file creation.' };
    }

    await vscode.workspace.fs.writeFile(uri, encoder.encode(args.content));
    await vscode.window.showTextDocument(uri);

    return { tool: 'create_file', success: true, data: `File "${args.path}" created successfully.` };
}

async function toolDeleteFile(root: string, args: DeleteFileArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    // Verify it exists
    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        return { tool: 'delete_file', success: false, error: `File not found: "${args.path}"` };
    }

    // Create a temporary empty file to diff against (showing deletion)
    const emptyUri = uri.with({ path: uri.path + '.lockick-empty' });
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(emptyUri, encoder.encode(''));

    const label = `LocKick: Delete ${path.basename(args.path)} (Proposed)`;
    await vscode.commands.executeCommand('vscode.diff', uri, emptyUri, label);

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Delete: ${path.relative(root, absPath)}`,
            body: 'Are you sure you want to delete this file? (View the "deletion diff" to confirm contents).',
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to DELETE "${path.relative(root, absPath)}".`,
            { modal: true }, 'Delete', 'Cancel'
        );
        accepted = choice === 'Delete';
    }

    // Cleanup
    await vscode.workspace.fs.delete(emptyUri, { useTrash: false }).then(() => { }, () => { });
    closeRecentDiffs(uri);

    if (!accepted) {
        // "Revert" view by showing the original file again
        await vscode.window.showTextDocument(uri);
        return { tool: 'delete_file', success: false, error: 'User cancelled file deletion.' };
    }

    await vscode.workspace.fs.delete(uri, { useTrash: true });
    return { tool: 'delete_file', success: true, data: `File "${args.path}" moved to trash.` };
}

async function toolRunSearch(root: string, args: RunSearchArgs): Promise<ToolResult> {
    const searchDir = args.directory ? resolveSafe(root, args.directory) : undefined;

    // Build a glob pattern for the search directory
    const includePattern = searchDir
        ? new vscode.RelativePattern(uriFor(searchDir), '**/*')
        : undefined;

    const results = await vscode.workspace.findFiles(
        includePattern ?? '**/*',
        '**/node_modules/**',
        200
    );

    const hits: string[] = [];
    const query = args.query.toLowerCase();

    for (const fileUri of results) {
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(bytes).toString('utf8');
            const relPath = path.relative(root, fileUri.fsPath);

            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(query)) {
                    hits.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                    if (hits.length >= 50) { break; }
                }
            }
        } catch { /* skip unreadable files */ }

        if (hits.length >= 50) { break; }
    }

    if (hits.length === 0) {
        return { tool: 'run_search', success: true, data: `No results found for "${args.query}".` };
    }

    const suffix = hits.length >= 50 ? '\n... (results truncated at 50 matches)' : '';
    return {
        tool: 'run_search',
        success: true,
        data: `Found matches for "${args.query}":\n${hits.join('\n')}${suffix}`,
    };
}

let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('LocKick Agent Term');
    }
    return _outputChannel;
}

async function toolRunCommand(root: string, args: RunCommandArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const cwd = args.cwd ? resolveSafe(root, args.cwd) : root;

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Run Command`,
            body: `Do you want to run exactly this command in the terminal?\n\n> ${args.command}\n\nRunning commands can have unintended side effects.`,
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to run a command:\n\n${args.command}\n\nRun it?`,
            { modal: true }, 'Run', 'Cancel'
        );
        accepted = choice === 'Run';
    }

    if (!accepted) {
        return { tool: 'run_command', success: false, error: 'User cancelled command execution.' };
    }

    const channel = getOutputChannel();
    channel.show(true); // Bring to front but do not steal focus
    channel.appendLine(`\n----------------------------------------`);
    channel.appendLine(`LocKick Agent running in ${cwd}`);
    channel.appendLine(`$ ${args.command}`);
    channel.appendLine(`----------------------------------------\n`);

    return new Promise<ToolResult>((resolve) => {
        let output = '';
        let errorOutput = '';

        const child = cp.spawn(args.command, { cwd, shell: true });

        child.stdout.on('data', (data) => {
            const str = data.toString();
            output += str;
            channel.append(str);
        });

        child.stderr.on('data', (data) => {
            const str = data.toString();
            errorOutput += str;
            channel.append(str);
        });

        child.on('error', (err) => {
            channel.appendLine(`\n[Failed to start process: ${err.message}]`);
            resolve({
                tool: 'run_command',
                success: false,
                error: `Process error: ${err.message}`
            });
        });

        child.on('close', (code) => {
            channel.appendLine(`\n----------------------------------------`);
            channel.appendLine(`Process exited with code ${code}`);

            // Combine stdout and stderr for the LLM
            let fullOutput = output;
            if (errorOutput) {
                fullOutput += `\n[STDERR]\n${errorOutput}`;
            }

            const MAX_CHARS = 16_000;
            const truncated = fullOutput.length > MAX_CHARS
                ? fullOutput.slice(0, MAX_CHARS) + `\n\n... [output truncated at ${MAX_CHARS} chars]`
                : fullOutput;

            if (code === 0) {
                resolve({ 
                    tool: 'run_command', 
                    success: true, 
                    data: truncated || '(Command succeeded with no output)' 
                });
            } else {
                resolve({ 
                    tool: 'run_command', 
                    success: false, 
                    error: `Command failed with code ${code ?? 'unknown'}.\nOutput:\n${truncated}` 
                });
            }
        });
    });
}

/**
 * Attempts to close any diff tabs related to a file we were just previewing.
 * This helps "revert" the UI state after a user confirms or rejects a change.
 */
async function toolReadFileRange(root: string, args: ReadFileRangeArgs): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const bytes = await vscode.workspace.fs.readFile(uriFor(absPath));
    const content = Buffer.from(bytes).toString('utf8');

    const mode = args.mode ?? 'lines';
    let sliced: string;
    let actualStart: number;
    let actualEnd: number;
    let truncated = false;

    if (mode === 'bytes') {
        actualStart = Math.max(0, args.start);
        actualEnd = Math.min(bytes.length, args.end);
        if (actualEnd < args.end) {
            truncated = true;
        }
        sliced = content.slice(actualStart, actualEnd);
    } else {
        // lines mode
        const lines = content.split('\n');
        actualStart = Math.max(0, args.start);
        actualEnd = Math.min(lines.length, args.end);
        if (actualEnd < args.end) {
            truncated = true;
        }
        sliced = lines.slice(actualStart, actualEnd).join('\n');
    }

    return {
        tool: 'read_file_range',
        success: true,
        data: JSON.stringify({
            content: sliced,
            actual_start: actualStart,
            actual_end: actualEnd,
            truncated,
        }),
    };
}

async function toolGetFileInfo(root: string, args: GetFileInfoArgs): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    let exists = false;
    let stat: vscode.FileStat | undefined;
    try {
        stat = await vscode.workspace.fs.stat(uri);
        exists = true;
    } catch {
        /* does not exist */
    }

    if (!exists) {
        return {
            tool: 'get_file_info',
            success: true,
            data: JSON.stringify({
                exists: false,
                size_bytes: null,
                line_count: null,
                language: null,
                last_modified: null,
            }),
        };
    }

    // Get line count
    let lineCount = 0;
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        lineCount = content.split('\n').length;
    } catch {
        lineCount = 0;
    }

    // Detect language from extension
    const ext = path.extname(args.path).toLowerCase();
    const languageMap: { [key: string]: string } = {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.py': 'python',
        '.java': 'java',
        '.cpp': 'cpp',
        '.c': 'c',
        '.cs': 'csharp',
        '.go': 'go',
        '.rs': 'rust',
        '.php': 'php',
        '.rb': 'ruby',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.html': 'html',
        '.css': 'css',
        '.md': 'markdown',
    };
    const language = languageMap[ext] ?? null;

    const lastModified = stat ? new Date(stat.mtime).toISOString() : null;

    return {
        tool: 'get_file_info',
        success: true,
        data: JSON.stringify({
            exists: true,
            size_bytes: stat?.size ?? 0,
            line_count: lineCount,
            language,
            last_modified: lastModified,
        }),
    };
}

async function toolSummarizeFile(root: string, args: SummarizeFileArgs): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const bytes = await vscode.workspace.fs.readFile(uriFor(absPath));
    const content = Buffer.from(bytes).toString('utf8');
    const lines = content.split('\n');

    const imports: string[] = [];
    const classes: { name: string; methods: string[] }[] = [];
    const functions: { name: string; signature: string }[] = [];
    const comments: string[] = [];
    const todos: string[] = [];

    // Simple regex-based parsing (works for most languages)
    const importRegex = /^import\s+.*|^from\s+.*|^require\s*\(|^use\s+/;
    const classRegex = /^class\s+(\w+)|^interface\s+(\w+)|^type\s+(\w+)/;
    const funcRegex = /^(async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=\s*(\(.*?\)\s*=>|async\s*\()|^let\s+(\w+)\s*=|^export\s+(const|function|class|interface)\s+(\w+)/;
    const todoRegex = /(TODO|FIXME|HACK|BUG)\s*:\s*(.*?)$/;
    const commentRegex = /^\s*(\/\/|#|\/\*|--)/;

    let currentClass: { name: string; methods: string[] } | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Check for imports
        if (importRegex.test(line)) {
            imports.push(line.slice(0, 80));
        }

        // Check for classes
        const classMatch = line.match(classRegex);
        if (classMatch) {
            const className = classMatch[1] || classMatch[2] || classMatch[3];
            currentClass = { name: className, methods: [] };
            classes.push(currentClass);
        }

        // Check for functions
        const funcMatch = line.match(funcRegex);
        if (funcMatch) {
            const funcName = funcMatch[2] || funcMatch[3] || funcMatch[5] || funcMatch[7];
            if (funcName) {
                functions.push({ name: funcName, signature: line.slice(0, 100) });
            }
        }

        // Check for TODOs
        const todoMatch = line.match(todoRegex);
        if (todoMatch) {
            todos.push(`Line ${i + 1}: ${todoMatch[1]}: ${todoMatch[2]}`);
        }

        // Check for comments
        if (commentRegex.test(line)) {
            const cleanComment = line.replace(/^(\s*\/\/|#|\/\*|--)\s*/, '');
            if (cleanComment.length > 0) {
                comments.push(cleanComment.slice(0, 100));
            }
        }
    }

    return {
        tool: 'summarize_file',
        success: true,
        data: JSON.stringify({
            imports: imports.slice(0, 10),
            classes: classes.slice(0, 10),
            functions: functions.slice(0, 20),
            top_level_comments: comments.slice(0, 5),
            todos_and_fixmes: todos.slice(0, 10),
        }),
    };
}

async function toolListDirectory(root: string, args: ListDirectoryArgs): Promise<ToolResult> {
    const dir = args.directory ? resolveSafe(root, args.directory) : root;

    let entries: [string, vscode.FileType][] = [];
    try {
        entries = await vscode.workspace.fs.readDirectory(uriFor(dir));
    } catch {
        return {
            tool: 'list_directory',
            success: false,
            error: `Failed to read directory: ${args.directory || '(root)'}`,
        };
    }

    const files: string[] = [];
    const directories: string[] = [];

    for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
            directories.push(name);
        } else if (type === vscode.FileType.File) {
            files.push(name);
        }
    }

    files.sort();
    directories.sort();

    return {
        tool: 'list_directory',
        success: true,
        data: JSON.stringify({
            files,
            directories,
        }),
    };
}

async function toolGetProjectStructure(root: string, args: GetProjectStructureArgs): Promise<ToolResult> {
    const maxDepth = args.max_depth ?? 3;

    interface DirectoryNode {
        name: string;
        type: 'file' | 'directory';
        path?: string;
        children?: DirectoryNode[];
    }

    async function buildTree(dirPath: string, depth: number): Promise<DirectoryNode[]> {
        if (depth > maxDepth) {
            return [];
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uriFor(dirPath));

            const nodes: DirectoryNode[] = [];

            for (const [name, type] of entries) {
                // Skip node_modules and hidden directories
                if (
                    name === 'node_modules' ||
                    name === '.git' ||
                    name === 'dist' ||
                    name === 'build' ||
                    name.startsWith('.')
                ) {
                    continue;
                }

                const itemPath = path.join(dirPath, name);
                const relativePath = path.relative(root, itemPath).replace(/\\/g, '/');

                if (type === vscode.FileType.Directory) {
                    const children = await buildTree(itemPath, depth + 1);
                    nodes.push({
                        name,
                        type: 'directory',
                        path: relativePath,
                        children: children.length > 0 ? children : undefined,
                    });
                } else {
                    nodes.push({
                        name,
                        type: 'file',
                        path: relativePath,
                    });
                }
            }

            return nodes.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        } catch {
            return [];
        }
    }

    const tree = await buildTree(root, 0);

    // Look for key config files
    const configFiles: { [key: string]: string } = {};
    const pattern = new vscode.RelativePattern(uriFor(root), '{package.json,tsconfig.json,pyproject.toml,setup.py,Makefile,CMakeLists.txt,.eslintrc.json,jest.config.js,webpack.config.js}');
    const found = await vscode.workspace.findFiles(pattern);

    for (const file of found) {
        const rel = path.relative(root, file.fsPath).replace(/\\/g, '/');
        const baseName = path.basename(file.fsPath);
        configFiles[baseName] = rel;
    }

    // Find potential entry points
    const entryPoints: string[] = [];
    const mainPattern = new vscode.RelativePattern(uriFor(root), '{main.{ts,js},index.{ts,js},src/index.{ts,js},src/main.{ts,js}}');
    const mainFiles = await vscode.workspace.findFiles(mainPattern);

    for (const file of mainFiles) {
        const rel = path.relative(root, file.fsPath).replace(/\\/g, '/');
        entryPoints.push(rel);
    }

    return {
        tool: 'get_project_structure',
        success: true,
        data: JSON.stringify({
            directory_tree: tree,
            config_files: configFiles,
            entry_points: entryPoints,
        }),
    };
}

async function toolProposePatch(root: string, args: ProposePatchArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    // Verify the file exists
    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        return { tool: 'propose_patch', success: false, error: `File not found: ${args.path}` };
    }

    // Parse the unified diff and apply it to show a preview
    const originalBytes = await vscode.workspace.fs.readFile(uri);
    const originalContent = Buffer.from(originalBytes).toString('utf8');

    // Simple unified diff parser
    const diffLines = args.diff.split('\n');
    let patchedContent = originalContent;
    let lineOffset = 0;

    try {
        for (const diffLine of diffLines) {
            if (diffLine.startsWith('@@')) {
                const match = diffLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                if (match) {
                    lineOffset = parseInt(match[1]) - 1;
                }
            } else if (diffLine.startsWith('-') && !diffLine.startsWith('---')) {
                // Remove line
                const lines = patchedContent.split('\n');
                if (lineOffset < lines.length) {
                    lines.splice(lineOffset, 1);
                    patchedContent = lines.join('\n');
                }
            } else if (diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
                // Add line
                const lines = patchedContent.split('\n');
                lines.splice(lineOffset, 0, diffLine.slice(1));
                patchedContent = lines.join('\n');
                lineOffset++;
            } else if (!diffLine.startsWith('@@') && !diffLine.startsWith('---') && !diffLine.startsWith('+++')) {
                lineOffset++;
            }
        }
    } catch (e: any) {
        return {
            tool: 'propose_patch',
            success: false,
            error: `Failed to parse or apply diff: ${e.message}`,
        };
    }

    // Write the patched content to a temp file for diffing
    const tempUri = uri.with({ path: uri.path + '.lockick-proposed' });
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(patchedContent));

    const label = `LocKick: Patch ${path.basename(args.path)}`;
    await vscode.commands.executeCommand('vscode.diff', uri, tempUri, label);

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Patch: ${path.relative(root, absPath)}`,
            body: args.description ?? 'Apply the proposed patch shown in the diff?',
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to apply a patch to "${path.relative(root, absPath)}". Apply it?`,
            { modal: true }, 'Apply', 'Reject'
        );
        accepted = choice === 'Apply';
    }

    await vscode.workspace.fs.delete(tempUri, { useTrash: false }).then(() => { }, () => { });
    closeRecentDiffs(uri);

    if (!accepted) {
        await vscode.window.showTextDocument(uri);
        return { tool: 'propose_patch', success: false, error: 'User rejected the proposed patch.' };
    }

    await vscode.workspace.fs.writeFile(uri, encoder.encode(patchedContent));
    await vscode.window.showTextDocument(uri);
    return { tool: 'propose_patch', success: true, data: `Patch applied to "${args.path}".` };
}

async function toolApplySnippet(root: string, args: ApplySnippetArgs, confirm?: ConfirmFn): Promise<ToolResult> {
    const absPath = resolveSafe(root, args.path);
    const uri = uriFor(absPath);

    // Verify the file exists
    const bytes = await vscode.workspace.fs.readFile(uri);
    const originalContent = Buffer.from(bytes).toString('utf8');
    const lines = originalContent.split('\n');

    const insertLine = args.location.line;
    const endLine = args.location.end_line;

    // Generate the modified content
    let modifiedContent: string;
    if (endLine !== undefined) {
        // Replace mode
        const before = lines.slice(0, insertLine);
        const after = lines.slice(endLine);
        modifiedContent = [...before, args.snippet, ...after].join('\n');
    } else {
        // Insert mode
        const before = lines.slice(0, insertLine);
        const after = lines.slice(insertLine);
        modifiedContent = [...before, args.snippet, ...after].join('\n');
    }

    // Show diff preview
    const tempUri = uri.with({ path: uri.path + '.lockick-proposed' });
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(modifiedContent));

    const label = `LocKick: Apply Snippet to ${path.basename(args.path)}`;
    await vscode.commands.executeCommand('vscode.diff', uri, tempUri, label);

    let accepted: boolean;
    if (confirm) {
        accepted = await confirm({
            title: `Snippet: ${path.relative(root, absPath)}`,
            body: args.description ?? 'Apply the code snippet?',
        });
    } else {
        const choice = await vscode.window.showWarningMessage(
            `LocKick Agent wants to insert code into "${path.relative(root, absPath)}". Apply it?`,
            { modal: true }, 'Apply', 'Reject'
        );
        accepted = choice === 'Apply';
    }

    await vscode.workspace.fs.delete(tempUri, { useTrash: false }).then(() => { }, () => { });
    closeRecentDiffs(uri);

    if (!accepted) {
        await vscode.window.showTextDocument(uri);
        return { tool: 'apply_snippet', success: false, error: 'User rejected the snippet.' };
    }

    await vscode.workspace.fs.writeFile(uri, encoder.encode(modifiedContent));
    await vscode.window.showTextDocument(uri);
    return { tool: 'apply_snippet', success: true, data: `Snippet applied to "${args.path}".` };
}

async function toolRunSearchWithContext(root: string, args: RunSearchWithContextArgs): Promise<ToolResult> {
    const searchDir = args.directory ? resolveSafe(root, args.directory) : undefined;
    const contextLines = args.context_lines ?? 5;

    const includePattern = searchDir
        ? new vscode.RelativePattern(uriFor(searchDir), '**/*')
        : undefined;

    const results = await vscode.workspace.findFiles(
        includePattern ?? '**/*',
        '**/node_modules/**',
        200
    );

    interface SearchResult {
        file: string;
        line: number;
        match: string;
        before: string[];
        after: string[];
    }

    const hits: SearchResult[] = [];
    const query = args.query.toLowerCase();

    for (const fileUri of results) {
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(bytes).toString('utf8');
            const relPath = path.relative(root, fileUri.fsPath);
            const lines = text.split('\n');

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(query)) {
                    const before = lines
                        .slice(Math.max(0, i - contextLines), i)
                        .map(l => l.trim());
                    const after = lines
                        .slice(i + 1, Math.min(lines.length, i + 1 + contextLines))
                        .map(l => l.trim());

                    hits.push({
                        file: relPath,
                        line: i + 1,
                        match: lines[i].trim(),
                        before,
                        after,
                    });

                    if (hits.length >= 50) {
                        break;
                    }
                }
            }
        } catch {
            /* skip unreadable files */
        }

        if (hits.length >= 50) {
            break;
        }
    }

    if (hits.length === 0) {
        return { tool: 'run_search_with_context', success: true, data: `No results found for "${args.query}".` };
    }

    const suffix = hits.length >= 50 ? '\n... (results truncated at 50 matches)' : '';
    return {
        tool: 'run_search_with_context',
        success: true,
        data: `Found ${hits.length} matches for "${args.query}":\n${JSON.stringify(hits)}\n${suffix}`,
    };
}

async function toolRunSymbolSearch(root: string, args: RunSymbolSearchArgs): Promise<ToolResult> {
    interface SymbolResult {
        file: string;
        line: number;
        symbol_name: string;
        symbol_kind: string;
        signature?: string;
    }

    const hits: SymbolResult[] = [];
    const symbolRegex = new RegExp(`\\b${args.symbol}\\b`, 'i');

    const pattern = new vscode.RelativePattern(uriFor(root), '**/*.{ts,tsx,js,jsx,py,java,go,rs,cs}');
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);

    for (const fileUri of files) {
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(bytes).toString('utf8');
            const lines = content.split('\n');
            const relPath = path.relative(root, fileUri.fsPath);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (symbolRegex.test(line)) {
                    // Determine symbol kind by regex patterns
                    let kind = 'variable';
                    if (/\bfunction\s+\w+/.test(line)) kind = 'function';
                    else if (/\bclass\s+\w+/.test(line)) kind = 'class';
                    else if (/\binterface\s+\w+/.test(line)) kind = 'type';
                    else if (/\btype\s+\w+/.test(line)) kind = 'type';
                    else if (/\bconst\s+\w+\s*=\s*\(.*?\)\s*=>/.test(line)) kind = 'function';

                    // Filter by kind if specified
                    if (args.kind && args.kind !== kind) {
                        continue;
                    }

                    hits.push({
                        file: relPath,
                        line: i + 1,
                        symbol_name: args.symbol,
                        symbol_kind: kind,
                        signature: line.trim().slice(0, 120),
                    });

                    if (hits.length >= 50) {
                        break;
                    }
                }
            }
        } catch {
            /* skip unreadable files */
        }

        if (hits.length >= 50) {
            break;
        }
    }

    if (hits.length === 0) {
        return {
            tool: 'run_symbol_search',
            success: true,
            data: `No symbols matching "${args.symbol}"${args.kind ? ` of kind "${args.kind}"` : ''} found.`,
        };
    }

    return {
        tool: 'run_symbol_search',
        success: true,
        data: `Found ${hits.length} symbols:\n${JSON.stringify(hits, null, 2)}`,
    };
}

function closeRecentDiffs(fileUri: vscode.Uri) {
    const targetPath = fileUri.fsPath;

    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputTextDiff) {
                const isMatch = tab.input.original.fsPath.startsWith(targetPath) ||
                    tab.input.modified.fsPath.startsWith(targetPath);

                if (isMatch) {
                    vscode.window.tabGroups.close(tab).then(() => { }, () => { });
                }
            }
        }
    }
}
