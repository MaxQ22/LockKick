import * as vscode from 'vscode';
import { OpenAIClient, ConnectionConfig, TestConnectionResult } from '../utils/openaiClient.js';

type ViewMode = 'chat' | 'settings';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'lockick.chatView';

    private _view?: vscode.WebviewView;
    private _currentMode: ViewMode = 'settings'; // Start on settings for first-time setup

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtml();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'saveSettings': {
                    await this._saveSettings(message.data);
                    break;
                }
                case 'testConnection': {
                    await this._testConnection(message.data);
                    break;
                }
                case 'loadSettings': {
                    this._sendCurrentSettings();
                    break;
                }
                case 'switchMode': {
                    this._currentMode = message.mode;
                    break;
                }
            }
        });
    }

    /**
     * Save connection settings to VS Code's configuration (persists across sessions).
     */
    private async _saveSettings(data: ConnectionConfig) {
        const config = vscode.workspace.getConfiguration('lockick');
        await config.update('serverUrl', data.serverUrl, vscode.ConfigurationTarget.Global);
        await config.update('apiKey', data.apiKey, vscode.ConfigurationTarget.Global);
        await config.update('modelName', data.modelName, vscode.ConfigurationTarget.Global);

        this._view?.webview.postMessage({
            command: 'settingsSaved',
            message: 'Settings saved successfully.'
        });
    }

    /**
     * Test the connection with the provided settings (does NOT save first).
     */
    private async _testConnection(data: ConnectionConfig) {
        this._view?.webview.postMessage({ command: 'testConnectionStart' });

        const client = new OpenAIClient(data);
        const result: TestConnectionResult = await client.testConnection();

        this._view?.webview.postMessage({
            command: 'testConnectionResult',
            result
        });
    }

    /**
     * Send the current persisted settings to the webview.
     */
    private _sendCurrentSettings() {
        const config = vscode.workspace.getConfiguration('lockick');
        this._view?.webview.postMessage({
            command: 'currentSettings',
            data: {
                serverUrl: config.get<string>('serverUrl') || 'http://localhost:1234/v1',
                apiKey: config.get<string>('apiKey') || 'lm-studio',
                modelName: config.get<string>('modelName') || 'default'
            }
        });
    }

    private _getHtml(): string {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LocKick</title>
    <style>
        /* ── Reset & Base ── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            padding: 0;
            overflow-x: hidden;
        }

        /* ── Navigation Tabs ── */
        .nav {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
            background: var(--vscode-sideBarSectionHeader-background, transparent);
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .nav-btn {
            flex: 1;
            padding: 10px 0;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            font-size: 12px;
            font-weight: 500;
            letter-spacing: 0.3px;
            text-transform: uppercase;
            cursor: pointer;
            opacity: 0.55;
            transition: opacity 0.2s, border-color 0.2s;
            border-bottom: 2px solid transparent;
        }
        .nav-btn:hover { opacity: 0.85; }
        .nav-btn.active {
            opacity: 1;
            border-bottom-color: var(--vscode-focusBorder, #007acc);
        }

        /* ── Panels ── */
        .panel { display: none; padding: 16px 14px; }
        .panel.active { display: block; }

        /* ── Settings Form ── */
        .form-group {
            margin-bottom: 16px;
        }
        .form-group label {
            display: block;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground, rgba(255,255,255,0.6));
            margin-bottom: 6px;
        }
        .form-group input {
            width: 100%;
            padding: 8px 10px;
            border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
            border-radius: 4px;
            background: var(--vscode-input-background, rgba(255,255,255,0.06));
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            font-size: var(--vscode-font-size, 13px);
            outline: none;
            transition: border-color 0.15s;
        }
        .form-group input:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .form-group .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, rgba(255,255,255,0.45));
            margin-top: 4px;
        }

        /* ── Buttons ── */
        .btn-row {
            display: flex;
            gap: 8px;
            margin-top: 20px;
        }
        .btn {
            flex: 1;
            padding: 9px 14px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.15s, transform 0.1s;
        }
        .btn:active { transform: scale(0.97); }
        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none;
        }

        .btn-primary {
            background: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #fff);
        }
        .btn-primary:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground, #005a9e);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        }
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.14));
        }

        /* ── Status Banner ── */
        .status {
            margin-top: 16px;
            padding: 10px 12px;
            border-radius: 4px;
            font-size: 12px;
            line-height: 1.5;
            display: none;
            animation: fadeIn 0.2s ease;
        }
        .status.show { display: block; }
        .status.success {
            background: rgba(40, 167, 69, 0.12);
            border: 1px solid rgba(40, 167, 69, 0.3);
            color: #4ec96d;
        }
        .status.error {
            background: rgba(220, 53, 69, 0.12);
            border: 1px solid rgba(220, 53, 69, 0.3);
            color: #f47983;
        }
        .status.info {
            background: rgba(0, 122, 204, 0.12);
            border: 1px solid rgba(0, 122, 204, 0.3);
            color: var(--vscode-focusBorder, #007acc);
        }
        .status .models-list {
            margin-top: 8px;
            padding-left: 16px;
        }
        .status .models-list li {
            margin-bottom: 2px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            opacity: 0.85;
        }

        /* ── Spinner ── */
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.2);
            border-top-color: var(--vscode-focusBorder, #007acc);
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            vertical-align: middle;
            margin-right: 6px;
        }

        /* ── Chat placeholder ── */
        .chat-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 300px;
            text-align: center;
            opacity: 0.5;
        }
        .chat-placeholder svg {
            width: 48px;
            height: 48px;
            margin-bottom: 12px;
            opacity: 0.4;
        }
        .chat-placeholder p {
            font-size: 12px;
            max-width: 200px;
            line-height: 1.5;
        }

        /* ── Animations ── */
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body>
    <!-- Navigation -->
    <div class="nav">
        <button class="nav-btn" data-target="chat" id="nav-chat">💬 Chat</button>
        <button class="nav-btn active" data-target="settings" id="nav-settings">⚙ Settings</button>
    </div>

    <!-- Chat Panel -->
    <div class="panel" id="panel-chat">
        <div class="chat-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <p>Chat coming soon.<br/>Configure your connection in <strong>Settings</strong> first.</p>
        </div>
    </div>

    <!-- Settings Panel -->
    <div class="panel active" id="panel-settings">
        <div class="form-group">
            <label for="input-url">Server URL</label>
            <input type="text" id="input-url" placeholder="http://localhost:1234/v1" spellcheck="false" />
            <div class="hint">The base URL of your LM Studio or OpenAI-compatible server.</div>
        </div>

        <div class="form-group">
            <label for="input-key">API Key</label>
            <input type="password" id="input-key" placeholder="lm-studio" spellcheck="false" />
            <div class="hint">Usually "lm-studio" for local servers. Click the field to edit.</div>
        </div>

        <div class="form-group">
            <label for="input-model">Model Name</label>
            <input type="text" id="input-model" placeholder="default" spellcheck="false" />
            <div class="hint">Leave as "default" to auto-select the loaded model.</div>
        </div>

        <div class="btn-row">
            <button class="btn btn-secondary" id="btn-test">Test Connection</button>
            <button class="btn btn-primary" id="btn-save">Save</button>
        </div>

        <div class="status" id="status-banner"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // ── Elements ──
        const navBtns   = document.querySelectorAll('.nav-btn');
        const panels    = document.querySelectorAll('.panel');
        const inputUrl  = document.getElementById('input-url');
        const inputKey  = document.getElementById('input-key');
        const inputModel = document.getElementById('input-model');
        const btnTest   = document.getElementById('btn-test');
        const btnSave   = document.getElementById('btn-save');
        const statusEl  = document.getElementById('status-banner');

        // ── Tab Navigation ──
        navBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.target;
                navBtns.forEach(b => b.classList.remove('active'));
                panels.forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('panel-' + target).classList.add('active');
                vscode.postMessage({ command: 'switchMode', mode: target });
            });
        });

        // ── Helpers ──
        function getFormData() {
            return {
                serverUrl: inputUrl.value.trim(),
                apiKey: inputKey.value.trim(),
                modelName: inputModel.value.trim()
            };
        }

        function showStatus(type, html) {
            statusEl.className = 'status show ' + type;
            statusEl.innerHTML = html;
        }

        function hideStatus() {
            statusEl.className = 'status';
            statusEl.innerHTML = '';
        }

        // ── Button Handlers ──
        btnSave.addEventListener('click', () => {
            const data = getFormData();
            if (!data.serverUrl) {
                showStatus('error', '⚠ Server URL is required.');
                return;
            }
            vscode.postMessage({ command: 'saveSettings', data });
        });

        btnTest.addEventListener('click', () => {
            const data = getFormData();
            if (!data.serverUrl) {
                showStatus('error', '⚠ Server URL is required.');
                return;
            }
            btnTest.disabled = true;
            btnTest.textContent = 'Testing...';
            vscode.postMessage({ command: 'testConnection', data });
        });

        // ── Messages from Extension ──
        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'currentSettings':
                    inputUrl.value   = msg.data.serverUrl || '';
                    inputKey.value   = msg.data.apiKey    || '';
                    inputModel.value = msg.data.modelName || '';
                    break;

                case 'settingsSaved':
                    showStatus('success', '✓ ' + msg.message);
                    break;

                case 'testConnectionStart':
                    showStatus('info', '<span class="spinner"></span> Connecting...');
                    break;

                case 'testConnectionResult': {
                    btnTest.disabled = false;
                    btnTest.textContent = 'Test Connection';
                    const r = msg.result;
                    if (r.success) {
                        let html = '✓ ' + r.message;
                        if (r.models && r.models.length > 0) {
                            html += '<ul class="models-list">';
                            r.models.forEach(m => { html += '<li>' + m.id + '</li>'; });
                            html += '</ul>';
                        }
                        showStatus('success', html);
                    } else {
                        showStatus('error', '✗ ' + r.message);
                    }
                    break;
                }
            }
        });

        // ── On Load: request current settings ──
        vscode.postMessage({ command: 'loadSettings' });
    </script>
</body>
</html>`;
    }
}
