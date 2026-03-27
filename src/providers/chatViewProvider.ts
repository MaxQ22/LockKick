/**
 * Chat View Provider
 *
 * The main sidebar panel for LocKick.
 * Handles both Chat Mode (direct LLM conversation) and Agent Mode
 * (agentic tool-calling loop with workspace access).
 */

import * as vscode from 'vscode';
import { OpenAIClient, ConnectionConfig, TestConnectionResult } from '../utils/openaiClient.js';
import { AgentLogProvider }    from './agentLogProvider.js';
import { runAgent }            from '../agent/agentRunner.js';
import { ToolCall, ToolResult } from '../agent/agentProtocol.js';
import { ConfirmFn }            from '../agent/agentTools.js';

type Role = 'user' | 'assistant';
interface ChatMessage { role: Role; content: string; }

// ─── Provider ─────────────────────────────────────────────────────────────────

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'lockick.chatView';

    private _view?: vscode.WebviewView;
    private _chatHistory: ChatMessage[] = [];
    private _agentHistory: ChatMessage[] = [];
    private _pendingConfirm = new Map<string, (accepted: boolean) => void>();
    private _abortController?: AbortController;
    private _agentMode = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _agentLog: AgentLogProvider,
        private readonly _secretStorage: vscode.SecretStorage,
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = buildHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'loadSettings':      await this._sendCurrentSettings(); break;
                case 'saveSettings':      await this._saveSettings(msg.data); break;
                case 'testConnection':    await this._testConnection(msg.data); break;
                case 'sendMessage':       await this._handleSend(msg.text); break;
                case 'stopGeneration':    this._stop(); break;
                case 'clearHistory':      this._clearHistory(); break;
                case 'askAboutSelection': await this._askAboutSelection(); break;
                case 'setAgentMode':      this._setAgentMode(!!msg.enabled); break;
                case 'toggleInlineCompletions': await this._toggleInlineCompletions(!!msg.enabled); break;
                case 'confirmResponse':   this._resolveConfirm(msg.id, !!msg.accepted); break;
            }
        });
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    public async sendAskAboutSelection(): Promise<void> {
        await this._askAboutSelection();
    }

    // ─── Config ──────────────────────────────────────────────────────────────

    private async _getConfig(): Promise<ConnectionConfig> {
        const cfg = vscode.workspace.getConfiguration('lockick');
        let apiKey = await this._secretStorage.get('lockick.apiKey');
        if (!apiKey) {
            apiKey = 'lm-studio';
        }

        return {
            serverUrl: cfg.get<string>('serverUrl') || 'http://localhost:1234/v1',
            apiKey:    apiKey,
            modelName: cfg.get<string>('modelName') || 'default',
        };
    }

    // ─── Settings ────────────────────────────────────────────────────────────

    private async _sendCurrentSettings(): Promise<void> {
        const inlineConfig = vscode.workspace.getConfiguration('lockick').get<boolean>('inlineCompletionsEnabled', false);
        const config = await this._getConfig();
        this._post({ command: 'currentSettings', data: config, inlineCompletionsEnabled: inlineConfig });
    }

    private async _toggleInlineCompletions(enabled: boolean): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('lockick');
        await cfg.update('inlineCompletionsEnabled', enabled, vscode.ConfigurationTarget.Global);
        this._post({ command: 'settingsSaved' });
    }

    private async _saveSettings(data: ConnectionConfig): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('lockick');
        await cfg.update('serverUrl', data.serverUrl, vscode.ConfigurationTarget.Global);
        await cfg.update('modelName', data.modelName, vscode.ConfigurationTarget.Global);
        await this._secretStorage.store('lockick.apiKey', data.apiKey || 'lm-studio');
        this._post({ command: 'settingsSaved' });
    }

    private async _testConnection(data: ConnectionConfig): Promise<void> {
        this._post({ command: 'testConnectionStart' });
        const result: TestConnectionResult = await new OpenAIClient(data).testConnection();
        this._post({ command: 'testConnectionResult', result });
    }

    // ─── Message Routing ─────────────────────────────────────────────────────

    private async _handleSend(userText: string): Promise<void> {
        if (!userText.trim()) { return; }
        if (this._agentMode) {
            await this._runAgentTurn(userText);
        } else {
            await this._runChatTurn(userText);
        }
    }

    private _stop(): void {
        this._abortController?.abort();
    }

    private _setAgentMode(enabled: boolean): void {
        this._agentMode = enabled;
        if (enabled) { this._agentHistory = []; }
    }

    private _makeConfirmFn(): ConfirmFn {
        return (req) => new Promise<boolean>((resolve) => {
            const id = Math.random().toString(36).slice(2, 10);
            this._pendingConfirm.set(id, resolve);
            this._post({ command: 'agentConfirm', id, title: req.title, body: req.body });
        });
    }

    private _resolveConfirm(id: string, accepted: boolean): void {
        const resolve = this._pendingConfirm.get(id);
        if (resolve) { this._pendingConfirm.delete(id); resolve(accepted); }
    }

    private _clearHistory(): void {
        this._chatHistory = [];
        this._agentHistory = [];
        this._post({ command: 'historyCleared' });
    }

    // ─── Chat Mode ───────────────────────────────────────────────────────────

    private async _runChatTurn(userText: string): Promise<void> {
        this._chatHistory.push({ role: 'user', content: userText });
        this._post({ command: 'appendMessage', role: 'user', content: userText });
        this._post({ command: 'streamStart' });

        this._abortController = new AbortController();
        const client = new OpenAIClient(await this._getConfig());
        let assembled = '';

        try {
            assembled = await client.chatStream(
                this._chatHistory as any[],
                (delta) => this._post({ command: 'streamDelta', delta }),
                this._abortController.signal,
            );
            this._chatHistory.push({ role: 'assistant', content: assembled });
            this._post({ command: 'streamEnd' });
        } catch (err: any) {
            if (err.name === 'AbortError') {
                this._chatHistory.push({ role: 'assistant', content: assembled });
                this._post({ command: 'streamAborted' });
            } else {
                this._post({ command: 'streamError', message: err.message });
            }
        }
    }

    // ─── Agent Mode ──────────────────────────────────────────────────────────

    private async _runAgentTurn(userText: string): Promise<void> {
        this._post({ command: 'appendMessage', role: 'user', content: userText });
        this._post({ command: 'agentStart' });
        this._agentLog.logUserTask(userText);

        this._abortController = new AbortController();

        await runAgent({
            config:      await this._getConfig(),
            userMessage: userText,
            history:     this._agentHistory,
            signal:      this._abortController.signal,
            confirm:     this._makeConfirmFn(),
            callbacks: {
                onAssistantMessage: (text) => {
                    this._post({ command: 'agentAssistantMessage', content: text });
                    this._agentLog.logReasoning(text);
                },
                onToolCall: (call: ToolCall) => {
                    this._post({ command: 'agentToolCall', call });
                    this._agentLog.logToolCall(call);
                },
                onToolResult: (result: ToolResult) => {
                    this._post({ command: 'agentToolResult', result });
                    this._agentLog.logToolResult(result);
                },
                onComplete: () => {
                    this._post({ command: 'agentEnd' });
                    this._agentLog.logInfo('Agent task complete.');
                },
                onError: (message) => {
                    this._post({ command: 'agentError', message });
                    this._agentLog.logError(message);
                },
            },
        });
    }

    // ─── Context Helpers ─────────────────────────────────────────────────────

    private async _askAboutSelection(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('LocKick: No active editor.');
            return;
        }

        const selection = editor.document.getText(editor.selection);
        const lang      = editor.document.languageId;
        const filePath  = editor.document.fileName;

        let question: string;
        if (selection) {
            question = 'Please explain the following ' + lang + ' code from `' + filePath + '`:\n```' + lang + '\n' + selection + '\n```';
        } else {
            const preview = editor.document.getText().split('\n').slice(0, 200).join('\n');
            question = 'Please give me an overview of this file (`' + filePath + '`, ' + lang + '):\n```' + lang + '\n' + preview + '\n```';
        }

        this._post({ command: 'switchToChat' });
        await this._handleSend(question);
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    private _post(message: object): void {
        this._view?.webview.postMessage(message);
    }
}

// ─── HTML Builder ─────────────────────────────────────────────────────────────

function buildHtml(): string {
    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8"/>',
        '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>',
        '<title>LocKick</title>',
        '<style>' + getCSS() + '</style>',
        '</head>',
        '<body>',
        getBodyHTML(),
        '<script>' + getJS() + '<\/script>',
        '</body>',
        '</html>',
    ].join('\n');
}

function getCSS(): string {
    return `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
  font-family:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);
  font-size:var(--vscode-font-size,13px);
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
}
/* nav */
.nav{display:flex;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));background:var(--vscode-sideBarSectionHeader-background,transparent)}
.nav-btn{flex:1;padding:9px 0;border:none;background:transparent;color:var(--vscode-foreground);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;cursor:pointer;opacity:.5;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s}
.nav-btn:hover{opacity:.8}
/* nav */
.nav{display:flex;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));background:var(--vscode-sideBarSectionHeader-background,transparent)}
.nav-btn{flex:1;padding:10px 0;border:none;background:transparent;color:var(--vscode-foreground);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;opacity:.5;border-bottom:2px solid transparent;transition:all .2s}
.nav-btn:hover{opacity:1;background:rgba(255,255,255,.04)}
.nav-btn.active{opacity:1;border-bottom-color:var(--vscode-focusBorder,#007acc);background:rgba(255,255,255,.06)}

.panel{display:none;flex:1;flex-direction:column;overflow:hidden}
.panel.active{display:flex}

/* --- chat header --- */
.chat-header{display:flex;align-items:center;padding:14px;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));background:var(--vscode-sideBarSectionHeader-background,transparent)}
.header-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.8;display:flex;align-items:center;gap:10px;width:100%;justify-content:space-between}
.logo-icon{font-size:15px;filter:drop-shadow(0 0 5px rgba(0,122,204,0.4))}

/* --- mode badge --- */
.mode-badge{font-size:9.5px;padding:3px 10px;border-radius:12px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;transition:all .3s ease}
.mode-badge.chat {background:rgba(0,122,204,0.12);color:#007acc;border:1px solid rgba(0,122,204,0.2)}
.mode-badge.agent{background:rgba(229,160,13,0.12);color:#e5a00d;border:1px solid rgba(229,160,13,0.2);box-shadow:0 0 10px rgba(229,160,13,0.1)}

/* --- mode dropdown --- */
.mode-select{
  appearance:none;-webkit-appearance:none;
  border:1px solid var(--vscode-input-border,rgba(255,255,255,.1));
  border-radius:6px;
  background:rgba(255,255,255,.04);
  color:var(--vscode-foreground);
  font-family:inherit;font-size:11px;font-weight:600;
  padding:4px 28px 4px 10px;
  cursor:pointer;outline:none;
  transition:all .2s cubic-bezier(0.4, 0, 0.2, 1);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E");
  background-repeat:no-repeat;
  background-position:right 10px center;
  min-width:90px;
}
.mode-select:hover{border-color:var(--vscode-focusBorder,#007acc);background-color:rgba(255,255,255,.08)}
.mode-select:focus{border-color:var(--vscode-focusBorder,#007acc);box-shadow:0 0 0 2px rgba(0,122,204,0.2)}
.mode-select.agent{
  border-color:rgba(229,160,13,.5);
  background-color:rgba(229,160,13,.08);
  color:#e5a00d;
  box-shadow:0 0 8px rgba(229,160,13,0.1);
  animation:pulse 2.5s ease infinite;
}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.8;transform:scale(0.98)}}
/* --- messages --- */
.messages{flex:1;overflow-y:auto;padding:16px 14px 4px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}
.msg{display:flex;flex-direction:column;gap:6px;animation:fadeUp .25s ease-out}
.msg-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;opacity:.5}
.msg.user .msg-label{color:var(--vscode-focusBorder,#007acc)}
.msg.assistant .msg-label{color:#4ec96d}
.msg.agent-tool .msg-label{color:#e5a00d}
.msg-bubble{padding:12px 14px;border-radius:8px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.msg.user .msg-bubble{background:var(--vscode-input-background,rgba(255,255,255,.04));border:1px solid var(--vscode-input-border,rgba(255,255,255,.08))}
.msg.assistant .msg-bubble{background:transparent;border:none}
.msg.agent-tool .msg-bubble{background:rgba(229,160,13,.04);border:1px solid rgba(229,160,13,.15);font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:11.5px}
.msg-bubble code{background:rgba(255,255,255,.08);border-radius:4px;padding:2px 5px;font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:11.5px}
.msg-bubble pre{background:var(--vscode-textCodeBlock-background,rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px;margin:8px 0;overflow-x:auto}
.msg-bubble pre code{background:none;padding:0;font-size:12px}
/* tool result badge */
.tool-result-badge{display:inline-block;font-size:10px;padding:3px 8px;border-radius:4px;margin-top:8px;font-weight:600;letter-spacing:0.3px}
.tool-result-badge.ok {background:rgba(78,201,109,.12);color:#4ec96d}
.tool-result-badge.err{background:rgba(244,121,131,.12);color:#f47983}
/* thinking dots */
.thinking{display:inline-flex;gap:5px;padding:6px 0}
.thinking span{width:6px;height:6px;border-radius:50%;background:var(--vscode-focusBorder,#007acc);animation:dot 1.2s ease infinite}
.thinking span:nth-child(2){animation-delay:.2s}
.thinking span:nth-child(3){animation-delay:.4s}
@keyframes dot{0%,80%,100%{transform:scale(.6);opacity:.3}40%{transform:scale(1);opacity:1}}
/* cursor */
.cursor{display:inline-block;width:2px;height:14px;background:var(--vscode-focusBorder,#007acc);border-radius:1px;margin-left:2px;vertical-align:middle;animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
/* empty state */
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:.4;padding:48px;animation:fadeIn 0.5s ease}
.empty-state svg{width:64px;height:64px;margin-bottom:20px;opacity:.6;color:var(--vscode-focusBorder)}
.empty-state h3{font-size:15px;margin-bottom:10px;font-weight:600;letter-spacing:0.5px}
.empty-state p{font-size:12px;line-height:1.6;max-width:240px;opacity:0.8}
@keyframes fadeIn{from{opacity:0}to{opacity:.4}}
/* input */
.input-area{flex-shrink:0;padding:12px 14px 16px;border-top:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));display:flex;flex-direction:column;gap:12px;background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
/* toolbar */
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.toolbar-right{display:flex;align-items:center;gap:10px}
.icon-btn{background:none;border:1px solid transparent;border-radius:4px;color:var(--vscode-foreground);opacity:.6;font-size:11px;padding:5px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
.icon-btn:hover{opacity:1;background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.1)}
.icon-btn.active{opacity:1;background:rgba(229,160,13,.15);border-color:rgba(229,160,13,.3);color:#e5a00d}
.icon-btn .icon{font-size:13px}
.input-row{display:flex;gap:10px;align-items:flex-end}
#chat-input{flex:1;resize:none;min-height:40px;max-height:180px;overflow-y:auto;padding:12px;border:1px solid var(--vscode-input-border,rgba(255,255,255,.12));border-radius:8px;background:var(--vscode-input-background,rgba(255,255,255,.04));color:var(--vscode-input-foreground,var(--vscode-foreground));font-family:inherit;font-size:var(--vscode-font-size,13px);line-height:1.5;outline:none;transition:border-color .15s}
#chat-input:focus{border-color:var(--vscode-focusBorder,#007acc)}
#chat-input::placeholder{opacity:.4}
.send-btn{padding:0 20px;height:40px;border:none;border-radius:8px;background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;flex-shrink:0;letter-spacing:0.5px}
.send-btn:hover{opacity:.9;filter:brightness(1.1);transform:translateY(-1px)}
.send-btn:active{transform:scale(.97) translateY(0)}
.send-btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
.send-btn.stop{background:var(--vscode-errorForeground,#c0392b)}
/* --- settings --- */
#panel-settings{overflow-y:auto}
.settings-content{padding:20px 16px}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--vscode-descriptionForeground,rgba(255,255,255,.5));margin-bottom:8px}
.form-group input{width:100%;padding:10px 12px;border-radius:6px;outline:none;border:1px solid var(--vscode-input-border,rgba(255,255,255,.12));background:var(--vscode-input-background,rgba(255,255,255,.04));color:var(--vscode-input-foreground,var(--vscode-foreground));font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:var(--vscode-font-size,13px);transition:border-color .15s}
.form-group input:focus{border-color:var(--vscode-focusBorder,#007acc)}
.form-group .hint{font-size:10.5px;color:var(--vscode-descriptionForeground,rgba(255,255,255,.4));margin-top:8px;line-height:1.5}
.btn-row{display:flex;gap:12px;margin-top:24px}
.btn{flex:1;padding:12px 14px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .1 shapes;letter-spacing:0.3px}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-primary{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff)}
.btn-primary:hover:not(:disabled){opacity:.9;filter:brightness(1.1)}
.btn-secondary{background:var(--vscode-button-secondaryBackground,rgba(255,255,255,.06));color:var(--vscode-foreground);border:1px solid rgba(255,255,255,.1)}
.btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.12)}
.status-box{margin-top:20px;padding:14px;border-radius:8px;font-size:11.5px;line-height:1.6;display:none;animation:fadeUp .25s ease}
.status-box.show{display:block}
.status-box.success{background:rgba(40,167,69,.12);border:1px solid rgba(40,167,69,.25);color:#4ec96d}
.status-box.error{background:rgba(220,53,69,.12);border:1px solid rgba(220,53,69,.25);color:#f47983}
.status-box.info{background:rgba(0,122,204,.12);border:1px solid rgba(0,122,204,.25);color:var(--vscode-focusBorder,#007acc)}
.model-list{margin-top:10px;padding-left:14px;list-style:disc}
.model-list li{margin-bottom:6px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;opacity:.8}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.2);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* --- confirm card --- */
.confirm-card{border:1px solid rgba(229,160,13,.2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;animation:fadeUp .3s ease-out;background:var(--vscode-editor-background);box-shadow:0 8px 24px rgba(0,0,0,0.3);margin:10px 0;border-left:4px solid #e5a00d}
.confirm-title{font-size:13px;font-weight:800;color:#e5a00d;display:flex;align-items:center;gap:10px;text-transform:uppercase;letter-spacing:0.5px}
.confirm-body{font-size:11.5px;opacity:.9;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family,monospace);background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)}
.confirm-actions{display:flex;gap:12px;margin-top:6px}
.confirm-btn{flex:1;padding:12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;border:1px solid transparent;outline:none}
.confirm-btn:active{transform:scale(.97)}
.confirm-btn.accept{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);box-shadow:0 3px 10px rgba(0,122,204,0.3)}
.confirm-btn.accept:hover{opacity:.9;filter:brightness(1.1)}
.confirm-btn.decline{background:transparent;color:var(--vscode-foreground);border-color:rgba(255,255,255,0.15)}
.confirm-btn.decline:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.2)}
.confirm-resolved{font-size:11.5px;padding:8px 14px;border-radius:8px;font-weight:700;display:inline-flex;align-items:center;gap:10px}
.confirm-resolved.accepted{background:rgba(78,201,109,.15);color:#4ec96d;border:1px solid rgba(78,201,109,0.3)}
.confirm-resolved.declined{background:rgba(244,121,131,.15);color:#f47983;border:1px solid rgba(244,121,131,0.3)}
`;
}

function getBodyHTML(): string {
    return `
<div class="chat-header">
  <div class="header-title">
    <span class="logo-icon">&#128640;</span> LocKick
    <span class="mode-badge chat" id="mode-badge">Chat Mode</span>
  </div>
</div>

<div class="nav" id="main-nav">
  <button class="nav-btn active" id="tab-chat">Chat</button>
  <button class="nav-btn" id="tab-settings">Settings</button>
</div>

<!-- Chat Panel -->
<div class="panel active" id="panel-chat">
  <div class="messages" id="messages">
    <div class="empty-state" id="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <h3>LocKick Chat</h3>
      <p>Ask anything. Switch the mode to <strong>Agent</strong> to let the model interact with your workspace.</p>
    </div>
  </div>

  <div class="input-area">
    <div class="toolbar">
      <button class="icon-btn" id="btn-selection" title="Ask about current selection or file">
        <span class="icon">&#8679;</span> Selection
      </button>
      
      <div class="toolbar-right">
        <button class="icon-btn" id="btn-autocomplete" title="Toggle Inline Auto-complete">
          <span class="icon">&#9889;</span> <span>Auto-complete: OFF</span>
        </button>
        <button class="icon-btn" id="btn-clear" title="Clear conversation">
          <span class="icon">&#128465;</span> Clear
        </button>
        <select class="mode-select" id="mode-select" title="Switch between Chat and Agent mode">
          <option value="chat">&#128172; Chat</option>
          <option value="agent">&#9889; Agent</option>
        </select>
      </div>
    </div>
    
    <div class="input-row">
      <textarea id="chat-input" rows="1" placeholder="Type a message..."></textarea>
      <button class="send-btn" id="btn-send">Send</button>
    </div>
  </div>
</div>

<!-- Settings Panel -->
<div class="panel" id="panel-settings">
  <div class="settings-content">
    <div class="form-group">
      <label for="input-url">Server URL</label>
      <input type="text" id="input-url" placeholder="http://localhost:1234/v1" spellcheck="false"/>
      <div class="hint">Base URL of your LM Studio or OpenAI-compatible server.</div>
    </div>
    <div class="form-group">
      <label for="input-key">API Key</label>
      <input type="password" id="input-key" placeholder="lm-studio" spellcheck="false"/>
      <div class="hint">Usually lm-studio for local servers.</div>
    </div>
    <div class="form-group">
      <label for="input-model">Model Name</label>
      <input type="text" id="input-model" placeholder="default" spellcheck="false"/>
      <div class="hint">Leave as default to use the loaded model.</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-test">Test Connection</button>
      <button class="btn btn-primary" id="btn-save">Save Settings</button>
    </div>
    <div class="status-box" id="status-box"></div>
  </div>
</div>
`;
}

function getJS(): string {
    return `
const vscode = acquireVsCodeApi();

// Tab switching
var tabChat     = document.getElementById('tab-chat');
var tabSettings = document.getElementById('tab-settings');
var panelChat   = document.getElementById('panel-chat');
var panelSettings = document.getElementById('panel-settings');

function showPanel(id) {
  panelChat.classList.toggle('active', id === 'chat');
  panelSettings.classList.toggle('active', id === 'settings');
  tabChat.classList.toggle('active', id === 'chat');
  tabSettings.classList.toggle('active', id === 'settings');
}

tabChat.addEventListener('click', () => showPanel('chat'));
tabSettings.addEventListener('click', () => showPanel('settings'));

// Mode dropdown and badge
var modeSelect = document.getElementById('mode-select');
var modeBadge  = document.getElementById('mode-badge');

modeSelect.addEventListener('change', function() {
  var isAgent = modeSelect.value === 'agent';
  modeSelect.className = 'mode-select' + (isAgent ? ' agent' : '');
  
  // Update badge
  modeBadge.className = 'mode-badge' + (isAgent ? ' agent' : ' chat');
  modeBadge.textContent = isAgent ? 'Agent Mode' : 'Chat Mode';
  
  vscode.postMessage({ command: 'setAgentMode', enabled: isAgent });
});

// Chat elements
var messagesEl   = document.getElementById('messages');
var emptyState   = document.getElementById('empty-state');
var chatInput    = document.getElementById('chat-input');
var btnSend      = document.getElementById('btn-send');
var btnClear     = document.getElementById('btn-clear');
var btnSelection = document.getElementById('btn-selection');
var btnAutocomplete = document.getElementById('btn-autocomplete');

var isStreaming        = false;
var streamingBubble    = null;
var accumulatedContent = '';
var isAutocompleteOn   = false;

function updateAutocompleteBtn() {
  btnAutocomplete.className = 'icon-btn' + (isAutocompleteOn ? ' active' : '');
  btnAutocomplete.innerHTML = '<span class="icon">&#9889;</span> <span>Auto-complete: ' + (isAutocompleteOn ? 'ON' : 'OFF') + '</span>';
}

btnAutocomplete.addEventListener('click', function() {
  isAutocompleteOn = !isAutocompleteOn;
  updateAutocompleteBtn();
  vscode.postMessage({ command: 'toggleInlineCompletions', enabled: isAutocompleteOn });
});

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMarkdown(text) {
  var result = '';
  var re = /\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    result += inlineMd(text.slice(last, m.index));
    var lang = m[1] ? ' class="language-' + escapeHtml(m[1]) + '"' : '';
    result += '<pre><code' + lang + '>' + escapeHtml(m[2]) + '</code></pre>';
    last = re.lastIndex;
  }
  result += inlineMd(text.slice(last));
  return result;
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>');
}

function clearEmptyState() {
  if (emptyState && emptyState.parentNode) { emptyState.parentNode.removeChild(emptyState); }
}

function appendMessage(role, content, extraClass) {
  clearEmptyState();
  var el = document.createElement('div');
  el.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
  var labels = { user: 'You', assistant: 'Assistant', 'agent-tool': 'Agent Tool' };
  var label  = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = labels[role] || role;
  var bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = content !== '' ? renderMarkdown(content) : '<div class="thinking"><span></span><span></span><span></span></div>';
  el.appendChild(label);
  el.appendChild(bubble);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function setWorking(active) {
  isStreaming = active;
  if (active) {
    btnSend.textContent = '\\u23F9 Stop';
    btnSend.classList.add('stop');
    chatInput.disabled = true;
  } else {
    btnSend.textContent = 'Send';
    btnSend.classList.remove('stop');
    chatInput.disabled = false;
    chatInput.focus();
  }
}

function sendConfirm(id, accepted) {
  var card = document.getElementById('confirm-' + id);
  if (card) {
    var actionsEl = card.querySelector('.confirm-actions');
    if (actionsEl) {
      // Show loading/resolved state immediately
      var badge = document.createElement('span');
      badge.className = 'confirm-resolved ' + (accepted ? 'accepted' : 'declined');
      badge.innerHTML = accepted ? '&#10003; Accepted' : '&#10007; Declined';
      actionsEl.innerHTML = '';
      actionsEl.appendChild(badge);
    }
  }
  vscode.postMessage({ command: 'confirmResponse', id: id, accepted: accepted });
}

function sendMessage() {
  var text = chatInput.value.trim();
  if (!text || isStreaming) { return; }
  chatInput.value = '';
  adjustHeight();
  vscode.postMessage({ command: 'sendMessage', text: text });
}

btnSend.addEventListener('click', function() {
  if (isStreaming) { vscode.postMessage({ command: 'stopGeneration' }); }
  else             { sendMessage(); }
});
chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener('input', adjustHeight);
function adjustHeight() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}
btnClear.addEventListener('click',     function(){ vscode.postMessage({ command: 'clearHistory' }); });
btnSelection.addEventListener('click', function(){ vscode.postMessage({ command: 'askAboutSelection' }); });

// Settings
var inputUrl   = document.getElementById('input-url');
var inputKey   = document.getElementById('input-key');
var inputModel = document.getElementById('input-model');
var btnTest    = document.getElementById('btn-test');
var btnSaveSet = document.getElementById('btn-save');
var statusBox  = document.getElementById('status-box');
function getFormData(){ return { serverUrl: inputUrl.value.trim(), apiKey: inputKey.value.trim(), modelName: inputModel.value.trim() }; }
function showStatus(type, html){ statusBox.className = 'status-box show ' + type; statusBox.innerHTML = html; }

btnSaveSet.addEventListener('click', function(){
  var d = getFormData();
  if (!d.serverUrl){ showStatus('error','&#9888; Server URL is required.'); return; }
  vscode.postMessage({ command: 'saveSettings', data: d });
});
btnTest.addEventListener('click', function(){
  var d = getFormData();
  if (!d.serverUrl){ showStatus('error','&#9888; Server URL is required.'); return; }
  btnTest.disabled = true;
  btnTest.textContent = 'Testing...';
  vscode.postMessage({ command: 'testConnection', data: d });
});

// Messages from extension
window.addEventListener('message', function(ev) {
  var msg = ev.data;
  switch(msg.command) {
    // settings
    case 'currentSettings':
      inputUrl.value   = msg.data.serverUrl || '';
      inputKey.value   = msg.data.apiKey    || '';
      inputModel.value = msg.data.modelName || '';
      if (typeof msg.inlineCompletionsEnabled === 'boolean') {
        isAutocompleteOn = msg.inlineCompletionsEnabled;
        updateAutocompleteBtn();
      }
      break;
    case 'settingsSaved': showStatus('success','&#10003; Settings saved.'); break;
    case 'testConnectionStart': showStatus('info','<span class="spinner"></span> Connecting&hellip;'); break;
    case 'testConnectionResult':
      btnTest.disabled = false; btnTest.textContent = 'Test Connection';
      if (msg.result.success) {
        var html = '&#10003; ' + escapeHtml(msg.result.message);
        if (msg.result.models && msg.result.models.length) {
          html += '<ul class="model-list">' + msg.result.models.map(function(m){ return '<li>' + escapeHtml(m.id) + '</li>'; }).join('') + '</ul>';
        }
        showStatus('success', html);
      } else { showStatus('error','&#10007; ' + escapeHtml(msg.result.message)); }
      break;

    // chat streaming
    case 'appendMessage': appendMessage(msg.role, msg.content); break;
    case 'streamStart':
      setWorking(true); accumulatedContent = '';
      streamingBubble = appendMessage('assistant', '');
      streamingBubble.innerHTML = '<span class="cursor"></span>';
      break;
    case 'streamDelta':
      accumulatedContent += msg.delta;
      if (streamingBubble) {
        streamingBubble.innerHTML = renderMarkdown(accumulatedContent) + '<span class="cursor"></span>';
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      break;
    case 'streamEnd':
      if (streamingBubble){ streamingBubble.innerHTML = renderMarkdown(accumulatedContent); }
      setWorking(false); streamingBubble = null; break;
    case 'streamAborted':
      if (streamingBubble){ streamingBubble.innerHTML = renderMarkdown(accumulatedContent) + ' <em style="opacity:.5">[stopped]</em>'; }
      setWorking(false); streamingBubble = null; break;
    case 'streamError':
      if (streamingBubble){ streamingBubble.innerHTML = '<span style="color:#f47983">&#9888; ' + escapeHtml(msg.message) + '</span>'; }
      setWorking(false); streamingBubble = null; break;

    // agent
    case 'agentStart': setWorking(true); clearEmptyState(); break;
    case 'agentAssistantMessage':
      appendMessage('assistant', msg.content); break;
    case 'agentToolCall': break;   // hidden — only natural language shown
    case 'agentToolResult': break; // hidden — only natural language shown
    case 'agentConfirm': {
      (function(cId, cTitle, cBody) {
        clearEmptyState();
        var wrap = document.createElement('div');
        wrap.className = 'msg assistant';
        var lbl = document.createElement('div');
        lbl.className = 'msg-label';
        lbl.style.color = '#e5a00d';
        lbl.textContent = 'Agent Request';
        var card = document.createElement('div');
        card.className = 'confirm-card';
        card.id = 'confirm-' + cId;
        var titleEl = document.createElement('div');
        titleEl.className = 'confirm-title';
        titleEl.textContent = '\\u26a1 ' + cTitle;
        var bodyEl = document.createElement('div');
        bodyEl.className = 'confirm-body';
        bodyEl.textContent = cBody;
        var actionsEl = document.createElement('div');
        actionsEl.className = 'confirm-actions';
        var acceptBtn = document.createElement('button');
        acceptBtn.className = 'confirm-btn accept';
        acceptBtn.textContent = '\\u2713 Accept';
        acceptBtn.addEventListener('click', function() { sendConfirm(cId, true); });
        var declineBtn = document.createElement('button');
        declineBtn.className = 'confirm-btn decline';
        declineBtn.textContent = '\\u2717 Decline';
        declineBtn.addEventListener('click', function() { sendConfirm(cId, false); });
        actionsEl.appendChild(acceptBtn);
        actionsEl.appendChild(declineBtn);
        card.appendChild(titleEl);
        card.appendChild(bodyEl);
        card.appendChild(actionsEl);
        wrap.appendChild(lbl);
        wrap.appendChild(card);
        messagesEl.appendChild(wrap);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      })(msg.id, msg.title, msg.body);
      break;
    }
    case 'agentEnd':   setWorking(false); break;
    case 'agentError':
      appendMessage('assistant', '&#9888; ' + msg.message);
      setWorking(false); break;

    // misc
    case 'historyCleared':
      messagesEl.innerHTML = '';
      var es = document.createElement('div');
      es.className = 'empty-state'; es.id = 'empty-state';
      es.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><h3>LocKick Chat</h3><p>Ask anything. Switch the mode to <strong>Agent</strong> to let the model interact with your workspace.</p>';
      messagesEl.appendChild(es);
      break;
    case 'switchToChat': showPanel('chat'); break;
  }
});

vscode.postMessage({ command: 'loadSettings' });
chatInput.focus();
`;
}
