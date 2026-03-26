import * as vscode from 'vscode';
import { OpenAIClient, ConnectionConfig, TestConnectionResult } from '../utils/openaiClient.js';

type Role = 'user' | 'assistant';
interface Message { role: Role; content: string; }

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'lockick.chatView';

    private _view?: vscode.WebviewView;
    private _history: Message[] = [];
    private _abortController?: AbortController;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = buildHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'loadSettings':      this._sendCurrentSettings(); break;
                case 'saveSettings':      await this._saveSettings(msg.data); break;
                case 'testConnection':    await this._testConnection(msg.data); break;
                case 'sendMessage':       await this._sendMessage(msg.text); break;
                case 'stopGeneration':    this._stopGeneration(); break;
                case 'clearHistory':      this._clearHistory(); break;
                case 'askAboutSelection': await this._askAboutSelection(); break;
            }
        });
    }

    public async sendAskAboutSelection() {
        await this._askAboutSelection();
    }

    private _getConfig(): ConnectionConfig {
        const cfg = vscode.workspace.getConfiguration('lockick');
        return {
            serverUrl: cfg.get<string>('serverUrl') || 'http://localhost:1234/v1',
            apiKey:    cfg.get<string>('apiKey')    || 'lm-studio',
            modelName: cfg.get<string>('modelName') || 'default',
        };
    }

    private _sendCurrentSettings() {
        this._post({ command: 'currentSettings', data: this._getConfig() });
    }

    private async _saveSettings(data: ConnectionConfig) {
        const cfg = vscode.workspace.getConfiguration('lockick');
        await cfg.update('serverUrl', data.serverUrl, vscode.ConfigurationTarget.Global);
        await cfg.update('apiKey',    data.apiKey,    vscode.ConfigurationTarget.Global);
        await cfg.update('modelName', data.modelName, vscode.ConfigurationTarget.Global);
        this._post({ command: 'settingsSaved' });
    }

    private async _testConnection(data: ConnectionConfig) {
        this._post({ command: 'testConnectionStart' });
        const result: TestConnectionResult = await new OpenAIClient(data).testConnection();
        this._post({ command: 'testConnectionResult', result });
    }

    private async _sendMessage(userText: string) {
        if (!userText.trim()) { return; }
        this._history.push({ role: 'user', content: userText });
        this._post({ command: 'appendMessage', role: 'user', content: userText });
        this._post({ command: 'streamStart' });

        this._abortController = new AbortController();
        const client = new OpenAIClient(this._getConfig());
        let assembled = '';

        try {
            assembled = await client.chatStream(
                this._history,
                (delta) => this._post({ command: 'streamDelta', delta }),
                this._abortController.signal
            );
            this._history.push({ role: 'assistant', content: assembled });
            this._post({ command: 'streamEnd' });
        } catch (err: any) {
            if (err.name === 'AbortError') {
                this._history.push({ role: 'assistant', content: assembled });
                this._post({ command: 'streamAborted' });
            } else {
                this._post({ command: 'streamError', message: err.message });
            }
        }
    }

    private _stopGeneration() { this._abortController?.abort(); }

    private _clearHistory() {
        this._history = [];
        this._post({ command: 'historyCleared' });
    }

    private async _askAboutSelection() {
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
            question = 'I have selected the following ' + lang + ' code from `' + filePath + '`:\n```' + lang + '\n' + selection + '\n```\n\nPlease explain what it does.';
        } else {
            const preview = editor.document.getText().split('\n').slice(0, 200).join('\n');
            question = 'Here is the content of `' + filePath + '` (' + lang + '):\n```' + lang + '\n' + preview + '\n```\n\nPlease give me an overview of this file.';
        }

        this._post({ command: 'switchToChat' });
        await this._sendMessage(question);
    }

    private _post(message: object) {
        this._view?.webview.postMessage(message);
    }
}

// ─── HTML Builder (plain string concat to avoid TS/backtick conflicts) ─────────
function buildHtml(): string {
    const css = getCSS();
    const js  = getJS();
    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8"/>',
        '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>',
        '<title>LocKick</title>',
        '<style>' + css + '</style>',
        '</head>',
        '<body>',
        getBodyHTML(),
        '<script>' + js + '<\/script>',
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
.nav{
  display:flex;flex-shrink:0;
  border-bottom:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));
  background:var(--vscode-sideBarSectionHeader-background,transparent);
}
.nav-btn{
  flex:1;padding:9px 0;border:none;background:transparent;
  color:var(--vscode-foreground);font-size:11px;font-weight:600;
  text-transform:uppercase;letter-spacing:.4px;cursor:pointer;
  opacity:.5;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s;
}
.nav-btn:hover{opacity:.8}
.nav-btn.active{opacity:1;border-bottom-color:var(--vscode-focusBorder,#007acc)}
.panel{display:none;flex:1;overflow:hidden;flex-direction:column}
.panel.active{display:flex}
/* --- Chat --- */
.messages{
  flex:1;overflow-y:auto;padding:12px 12px 4px;
  display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;
}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:2px}
.msg{display:flex;flex-direction:column;gap:4px;animation:fadeUp .2s ease}
.msg-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.45}
.msg.user .msg-label{color:var(--vscode-focusBorder,#007acc)}
.msg.assistant .msg-label{color:var(--vscode-charts-green,#4ec96d)}
.msg-bubble{padding:10px 12px;border-radius:6px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.msg.user .msg-bubble{background:var(--vscode-input-background,rgba(255,255,255,.06));border:1px solid var(--vscode-input-border,rgba(255,255,255,.1))}
.msg.assistant .msg-bubble{background:transparent;border:none}
.msg-bubble code{background:rgba(255,255,255,.08);border-radius:3px;padding:1px 5px;font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:11.5px}
.msg-bubble pre{background:var(--vscode-textCodeBlock-background,rgba(255,255,255,.06));border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:10px 12px;margin:6px 0;overflow-x:auto;white-space:pre}
.msg-bubble pre code{background:none;padding:0;font-size:12px}
.cursor{display:inline-block;width:2px;height:14px;background:var(--vscode-focusBorder,#007acc);border-radius:1px;margin-left:2px;vertical-align:middle;animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:.35;padding:24px}
.empty-state svg{width:48px;height:48px;margin-bottom:14px;opacity:.7}
.empty-state h3{font-size:13px;margin-bottom:6px}
.empty-state p{font-size:11px;line-height:1.6;max-width:200px}
.input-area{flex-shrink:0;padding:10px 12px 12px;border-top:1px solid var(--vscode-panel-border,rgba(255,255,255,.08));display:flex;flex-direction:column;gap:8px}
.input-row{display:flex;gap:6px;align-items:flex-end}
#chat-input{
  flex:1;resize:none;min-height:36px;max-height:120px;overflow-y:auto;
  padding:8px 10px;border:1px solid var(--vscode-input-border,rgba(255,255,255,.12));
  border-radius:6px;background:var(--vscode-input-background,rgba(255,255,255,.06));
  color:var(--vscode-input-foreground,var(--vscode-foreground));
  font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);
  line-height:1.4;outline:none;transition:border-color .15s;
}
#chat-input:focus{border-color:var(--vscode-focusBorder,#007acc)}
#chat-input::placeholder{opacity:.4}
.toolbar{display:flex;gap:6px;justify-content:flex-start;align-items:center}
.icon-btn{background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:4px;color:var(--vscode-foreground);opacity:.5;font-size:12px;transition:opacity .15s,background .15s;line-height:1}
.icon-btn:hover{opacity:.9;background:rgba(255,255,255,.08)}
.send-btn{padding:0 14px;height:36px;border:none;border-radius:6px;background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s;flex-shrink:0;min-width:54px}
.send-btn:hover{opacity:.85}
.send-btn:active{transform:scale(.96)}
.send-btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
.send-btn.stop{background:#c0392b}
/* --- Settings --- */
#panel-settings{overflow-y:auto;padding:16px 14px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground,rgba(255,255,255,.5));margin-bottom:5px}
.form-group input{width:100%;padding:7px 10px;border-radius:4px;outline:none;border:1px solid var(--vscode-input-border,rgba(255,255,255,.12));background:var(--vscode-input-background,rgba(255,255,255,.06));color:var(--vscode-input-foreground,var(--vscode-foreground));font-family:var(--vscode-editor-font-family,'Consolas',monospace);font-size:var(--vscode-font-size,13px);transition:border-color .15s}
.form-group input:focus{border-color:var(--vscode-focusBorder,#007acc)}
.form-group .hint{font-size:10.5px;color:var(--vscode-descriptionForeground,rgba(255,255,255,.4));margin-top:4px}
.btn-row{display:flex;gap:8px;margin-top:18px}
.btn{flex:1;padding:8px 14px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-primary{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff)}
.btn-primary:hover:not(:disabled){opacity:.85}
.btn-secondary{background:var(--vscode-button-secondaryBackground,rgba(255,255,255,.08));color:var(--vscode-foreground)}
.btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.14)}
.status-box{margin-top:14px;padding:10px 12px;border-radius:4px;font-size:11.5px;line-height:1.5;display:none;animation:fadeUp .2s ease}
.status-box.show{display:block}
.status-box.success{background:rgba(40,167,69,.12);border:1px solid rgba(40,167,69,.3);color:#4ec96d}
.status-box.error{background:rgba(220,53,69,.12);border:1px solid rgba(220,53,69,.3);color:#f47983}
.status-box.info{background:rgba(0,122,204,.12);border:1px solid rgba(0,122,204,.3);color:var(--vscode-focusBorder,#007acc)}
.model-list{margin-top:6px;padding-left:14px;list-style:disc}
.model-list li{margin-bottom:2px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;opacity:.85}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.2);border-top-color:var(--vscode-focusBorder,#007acc);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:5px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
`;
}

function getBodyHTML(): string {
    return `
<div class="nav">
  <button class="nav-btn active" data-target="chat">&#128172; Chat</button>
  <button class="nav-btn" data-target="settings">&#9881; Settings</button>
</div>

<div class="panel" id="panel-chat">
  <div class="messages" id="messages">
    <div class="empty-state" id="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <h3>LocKick Chat</h3>
      <p>Ask anything. Your local model is ready.</p>
    </div>
  </div>
  <div class="input-area">
    <div class="toolbar">
      <button class="icon-btn" id="btn-selection" title="Ask about current selection or file">&#8679; Selection</button>
      <button class="icon-btn" id="btn-clear" title="Clear conversation">&#128465; Clear</button>
    </div>
    <div class="input-row">
      <textarea id="chat-input" rows="1" placeholder="Message your model\u2026 (Enter to send)"></textarea>
      <button class="send-btn" id="btn-send">Send</button>
    </div>
  </div>
</div>

<div class="panel" id="panel-settings">
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
    <button class="btn btn-primary" id="btn-save">Save</button>
  </div>
  <div class="status-box" id="status-box"></div>
</div>
`;
}

function getJS(): string {
    return `
const vscode = acquireVsCodeApi();

// ─── Navigation
const navBtns = document.querySelectorAll('.nav-btn');
const panels  = document.querySelectorAll('.panel');
function switchTab(target) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.target === target));
  panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + target));
}
navBtns.forEach(b => b.addEventListener('click', () => switchTab(b.dataset.target)));
switchTab('chat');

// ─── Chat elements
const messagesEl   = document.getElementById('messages');
const emptyState   = document.getElementById('empty-state');
const chatInput    = document.getElementById('chat-input');
const btnSend      = document.getElementById('btn-send');
const btnClear     = document.getElementById('btn-clear');
const btnSelection = document.getElementById('btn-selection');

let isStreaming = false;
let streamingBubble = null;
let accumulatedContent = '';

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMarkdown(text) {
  // fenced code blocks
  var result = '';
  var re = /\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    result += inlineMarkdown(text.slice(last, m.index));
    var lang = m[1] ? ' class="language-' + escapeHtml(m[1]) + '"' : '';
    result += '<pre><code' + lang + '>' + escapeHtml(m[2]) + '</code></pre>';
    last = re.lastIndex;
  }
  result += inlineMarkdown(text.slice(last));
  return result;
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>');
}

function appendMessage(role, content) {
  if (emptyState) { emptyState.style.display = 'none'; }
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  var lbl = document.createElement('div');
  lbl.className = 'msg-label';
  lbl.textContent = role === 'user' ? 'You' : 'Assistant';
  var bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = renderMarkdown(content);
  el.appendChild(lbl);
  el.appendChild(bubble);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function setStreaming(active) {
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

function sendMessage() {
  var text = chatInput.value.trim();
  if (!text || isStreaming) { return; }
  chatInput.value = '';
  adjustHeight();
  vscode.postMessage({ command: 'sendMessage', text: text });
}

btnSend.addEventListener('click', function() {
  if (isStreaming) { vscode.postMessage({ command: 'stopGeneration' }); }
  else { sendMessage(); }
});

chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

chatInput.addEventListener('input', adjustHeight);

function adjustHeight() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

btnClear.addEventListener('click', function() { vscode.postMessage({ command: 'clearHistory' }); });
btnSelection.addEventListener('click', function() { vscode.postMessage({ command: 'askAboutSelection' }); });

// ─── Settings elements
var inputUrl   = document.getElementById('input-url');
var inputKey   = document.getElementById('input-key');
var inputModel = document.getElementById('input-model');
var btnTest    = document.getElementById('btn-test');
var btnSaveSet = document.getElementById('btn-save');
var statusBox  = document.getElementById('status-box');

function getFormData() {
  return { serverUrl: inputUrl.value.trim(), apiKey: inputKey.value.trim(), modelName: inputModel.value.trim() };
}
function showStatus(type, html) {
  statusBox.className = 'status-box show ' + type;
  statusBox.innerHTML = html;
}

btnSaveSet.addEventListener('click', function() {
  var d = getFormData();
  if (!d.serverUrl) { showStatus('error', '&#9888; Server URL is required.'); return; }
  vscode.postMessage({ command: 'saveSettings', data: d });
});

btnTest.addEventListener('click', function() {
  var d = getFormData();
  if (!d.serverUrl) { showStatus('error', '&#9888; Server URL is required.'); return; }
  btnTest.disabled = true;
  btnTest.textContent = 'Testing...';
  vscode.postMessage({ command: 'testConnection', data: d });
});

// ─── Messages from extension
window.addEventListener('message', function(ev) {
  var msg = ev.data;
  switch (msg.command) {
    case 'currentSettings':
      inputUrl.value   = msg.data.serverUrl || '';
      inputKey.value   = msg.data.apiKey    || '';
      inputModel.value = msg.data.modelName || '';
      break;
    case 'settingsSaved':
      showStatus('success', '&#10003; Settings saved.');
      break;
    case 'testConnectionStart':
      showStatus('info', '<span class="spinner"></span> Connecting&hellip;');
      break;
    case 'testConnectionResult':
      btnTest.disabled = false;
      btnTest.textContent = 'Test Connection';
      if (msg.result.success) {
        var html = '&#10003; ' + escapeHtml(msg.result.message);
        if (msg.result.models && msg.result.models.length) {
          html += '<ul class="model-list">' + msg.result.models.map(function(m) { return '<li>' + escapeHtml(m.id) + '</li>'; }).join('') + '</ul>';
        }
        showStatus('success', html);
      } else {
        showStatus('error', '&#10007; ' + escapeHtml(msg.result.message));
      }
      break;
    case 'appendMessage':
      appendMessage(msg.role, msg.content);
      break;
    case 'streamStart':
      setStreaming(true);
      accumulatedContent = '';
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
      if (streamingBubble) { streamingBubble.innerHTML = renderMarkdown(accumulatedContent); }
      setStreaming(false);
      streamingBubble = null;
      break;
    case 'streamAborted':
      if (streamingBubble) {
        streamingBubble.innerHTML = renderMarkdown(accumulatedContent) + ' <em style="opacity:.5">[stopped]</em>';
      }
      setStreaming(false);
      streamingBubble = null;
      break;
    case 'streamError':
      if (streamingBubble) {
        streamingBubble.innerHTML = '<span style="color:#f47983">&#9888; Error: ' + escapeHtml(msg.message) + '</span>';
      }
      setStreaming(false);
      streamingBubble = null;
      break;
    case 'historyCleared':
      messagesEl.innerHTML = '';
      if (emptyState) { emptyState.style.display = ''; messagesEl.appendChild(emptyState); }
      break;
    case 'switchToChat':
      switchTab('chat');
      break;
  }
});

vscode.postMessage({ command: 'loadSettings' });
chatInput.focus();
`;
}
