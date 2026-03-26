/**
 * Agent Log Provider
 *
 * A dedicated VS Code WebviewViewProvider that renders the LocKick Agent Log —
 * a real-time, formatted activity log of everything the agent does.
 *
 * Registered as a panel in the bottom panel area (like the Problems or Output tabs).
 */

import * as vscode from 'vscode';
import { ToolCall, ToolResult } from '../agent/agentProtocol.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogEntryKind =
    | 'user-task'
    | 'reasoning'
    | 'tool-call'
    | 'tool-result-ok'
    | 'tool-result-err'
    | 'final-answer'
    | 'error'
    | 'info';

export interface LogEntry {
    kind: LogEntryKind;
    timestamp: Date;
    title: string;
    body?: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AgentLogProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'lockick.agentLog';

    private _view?: vscode.WebviewView;
    private _log: LogEntry[] = [];

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = buildLogHtml();

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'clearLog') {
                this._log = [];
                this._post({ command: 'cleared' });
            }
        });

        // Replay existing log entries when the panel is first opened
        for (const entry of this._log) {
            this._postEntry(entry);
        }
    }

    // ─── Public Logging API ─────────────────────────────────────────────────

    public logUserTask(task: string): void {
        this._addEntry({ kind: 'user-task', title: 'Task', body: task });
    }

    public logReasoning(text: string): void {
        if (text.trim()) {
            this._addEntry({ kind: 'reasoning', title: 'Agent Reasoning', body: text });
        }
    }

    public logToolCall(call: ToolCall): void {
        const argsStr = JSON.stringify(call.args, null, 2);
        this._addEntry({ kind: 'tool-call', title: call.tool, body: argsStr });
    }

    public logToolResult(result: ToolResult): void {
        const kind  = result.success ? 'tool-result-ok' : 'tool-result-err';
        const body  = result.data ?? result.error ?? '';
        const title = result.success ? ' Result' : ' Failed';
        this._addEntry({ kind, title: result.tool + title, body });
    }

    public logFinalAnswer(text: string): void {
        this._addEntry({ kind: 'final-answer', title: 'Final Answer', body: text });
    }

    public logError(message: string): void {
        this._addEntry({ kind: 'error', title: 'Error', body: message });
    }

    public logInfo(message: string): void {
        this._addEntry({ kind: 'info', title: message });
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    private _addEntry(fields: Omit<LogEntry, 'timestamp'>): void {
        const entry: LogEntry = { ...fields, timestamp: new Date() };
        this._log.push(entry);
        this._postEntry(entry);
    }

    private _postEntry(entry: LogEntry): void {
        this._post({ command: 'addEntry', entry: this._serialize(entry) });
    }

    private _serialize(entry: LogEntry): object {
        return {
            ...entry,
            timestamp: entry.timestamp.toLocaleTimeString(),
        };
    }

    private _post(message: object): void {
        this._view?.webview.postMessage(message);
    }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildLogHtml(): string {
    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8"/>',
        '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>',
        '<title>LocKick Agent Log</title>',
        '<style>' + getLogCSS() + '</style>',
        '</head>',
        '<body>',
        getLogBodyHTML(),
        '<script>' + getLogJS() + '<\/script>',
        '</body>',
        '</html>',
    ].join('\n');
}

function getLogCSS(): string {
    return `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;display:flex;flex-direction:column}
body{
  font-family:var(--vscode-font-family,'Segoe UI',sans-serif);
  font-size:12px;color:var(--vscode-foreground);
  background:var(--vscode-panel-background,var(--vscode-editor-background));
}
.toolbar{
  display:flex;justify-content:space-between;align-items:center;
  padding:6px 12px;flex-shrink:0;
  border-bottom:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));
}
.toolbar-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;opacity:.6}
.clear-btn{
  background:none;border:none;cursor:pointer;font-size:11px;padding:3px 8px;border-radius:3px;
  color:var(--vscode-foreground);opacity:.5;transition:opacity .15s,background .15s;
}
.clear-btn:hover{opacity:.9;background:rgba(255,255,255,.08)}
.log{flex:1;overflow-y:auto;padding:8px 0}
.log::-webkit-scrollbar{width:4px}
.log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:2px}
.entry{
  padding:8px 12px;border-left:3px solid transparent;
  animation:fadeIn .2s ease;margin-bottom:2px;
}
.entry-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.entry-icon{font-size:13px;line-height:1;flex-shrink:0}
.entry-title{font-weight:600;font-size:11.5px;flex:1}
.entry-time{font-size:10px;opacity:.4;flex-shrink:0}
.entry-body{
  font-family:var(--vscode-editor-font-family,'Consolas',monospace);
  font-size:11px;white-space:pre-wrap;word-break:break-word;
  opacity:.8;padding-left:21px;line-height:1.5;
  max-height:300px;overflow-y:auto;
}
.entry.user-task    {border-color:var(--vscode-focusBorder,#007acc);background:rgba(0,122,204,.06)}
.entry.reasoning    {border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.02)}
.entry.tool-call    {border-color:#e5a00d;background:rgba(229,160,13,.06)}
.entry.tool-result-ok {border-color:#4ec96d;background:rgba(78,201,109,.06)}
.entry.tool-result-err{border-color:#f47983;background:rgba(244,121,131,.06)}
.entry.final-answer {border-color:#4ec96d;background:rgba(78,201,109,.04)}
.entry.error        {border-color:#f47983;background:rgba(244,121,131,.08)}
.entry.info         {border-color:rgba(255,255,255,.15)}
.empty{display:flex;align-items:center;justify-content:center;height:100%;opacity:.35;font-size:12px}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
`;
}

function getLogBodyHTML(): string {
    return `
<div class="toolbar">
  <span class="toolbar-title">&#128196; Agent Log</span>
  <button class="clear-btn" id="btn-clear">Clear</button>
</div>
<div class="log" id="log">
  <div class="empty" id="empty">No agent activity yet.</div>
</div>
`;
}

function getLogJS(): string {
    return `
const vscode = acquireVsCodeApi();
const log    = document.getElementById('log');
const empty  = document.getElementById('empty');
const btnClear = document.getElementById('btn-clear');

const ICONS = {
  'user-task':      '&#127919;',
  'reasoning':      '&#129504;',
  'tool-call':      '&#128295;',
  'tool-result-ok': '&#10003;',
  'tool-result-err':'&#10007;',
  'final-answer':   '&#127881;',
  'error':          '&#9888;',
  'info':           '&#8505;',
};

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addEntry(entry) {
  if (empty) { empty.style.display = 'none'; }

  var el = document.createElement('div');
  el.className = 'entry ' + entry.kind;

  var header = '<div class="entry-header">'
    + '<span class="entry-icon">' + (ICONS[entry.kind] || '') + '</span>'
    + '<span class="entry-title">' + escapeHtml(entry.title) + '</span>'
    + '<span class="entry-time">' + escapeHtml(entry.timestamp) + '</span>'
    + '</div>';

  var body = entry.body
    ? '<div class="entry-body">' + escapeHtml(entry.body) + '</div>'
    : '';

  el.innerHTML = header + body;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

btnClear.addEventListener('click', function() { vscode.postMessage({ command: 'clearLog' }); });

window.addEventListener('message', function(ev) {
  var msg = ev.data;
  if (msg.command === 'addEntry') { addEntry(msg.entry); }
  if (msg.command === 'cleared')  {
    log.innerHTML = '';
    if (empty) { empty.style.display = ''; log.appendChild(empty); }
  }
});
`;
}
