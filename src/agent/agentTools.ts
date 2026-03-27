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
import {
    ToolCall, ToolResult,
    ReadFileArgs, ListFilesArgs, ProposeEditArgs,
    CreateFileArgs, DeleteFileArgs, RunSearchArgs,
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
            case 'list_files': return await toolListFiles(root, call.args as ListFilesArgs);
            case 'propose_edit': return await toolProposeEdit(root, call.args as ProposeEditArgs, confirm);
            case 'create_file': return await toolCreateFile(root, call.args as CreateFileArgs, confirm);
            case 'delete_file': return await toolDeleteFile(root, call.args as DeleteFileArgs, confirm);
            case 'run_search': return await toolRunSearch(root, call.args as RunSearchArgs);
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
    const entries = await vscode.workspace.fs.readDirectory(uriFor(dir));

    const lines = entries
        .sort((a, b) => {
            // directories first, then alphabetical
            if (a[1] !== b[1]) { return a[1] === vscode.FileType.Directory ? -1 : 1; }
            return a[0].localeCompare(b[0]);
        })
        .map(([name, type]) => {
            const rel = path.relative(root, path.join(dir, name));
            return type === vscode.FileType.Directory ? `${rel}/` : rel;
        });

    return {
        tool: 'list_files',
        success: true,
        data: lines.join('\n') || '(empty directory)',
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

/**
 * Attempts to close any diff tabs related to a file we were just previewing.
 * This helps "revert" the UI state after a user confirms or rejects a change.
 */
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
