import * as vscode from 'vscode';
import { PaperReaderPanel } from './paperReaderPanel';

export function activate(context: vscode.ExtensionContext) {
  const openReader = vscode.commands.registerCommand('readingExtension.openReader', async () => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    let pdfUri: vscode.Uri | undefined;

    if (activeUri?.fsPath.toLowerCase().endsWith('.pdf')) {
      pdfUri = activeUri;
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'PDF files': ['pdf']
        },
        title: 'Choose a paper PDF'
      });
      pdfUri = picked?.[0];
    }

    if (!pdfUri) {
      return;
    }

    PaperReaderPanel.createOrShow(context.extensionUri, pdfUri);
  });

  context.subscriptions.push(openReader);
}

export function deactivate() {
  // No long-lived resources.
}

