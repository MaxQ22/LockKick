import * as vscode from 'vscode';

export function getSelectedText(): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        return editor.document.getText(editor.selection);
    }
    return '';
}

export function getCurrentFileContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const document = editor.document;
        return `File: ${document.fileName}\nLanguage: ${document.languageId}\nContent:\n${document.getText()}\n`;
    }
    return '';
}
