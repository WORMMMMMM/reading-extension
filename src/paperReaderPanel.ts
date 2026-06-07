import * as path from 'path';
import * as vscode from 'vscode';
import {
  AnnotationRecord,
  ProgressRecord,
  ReaderStorage,
  WordRecord
} from './readerStorage';

type ReaderMessage =
  | { type: 'ready' }
  | { type: 'saveAnnotation'; payload: Omit<AnnotationRecord, 'id' | 'createdAt' | 'updatedAt'> }
  | { type: 'saveWord'; payload: Omit<WordRecord, 'id' | 'createdAt' | 'updatedAt'> }
  | { type: 'saveProgress'; payload: ProgressRecord }
  | { type: 'copyPrompt'; payload: { text: string } };

export class PaperReaderPanel {
  private static currentPanel: PaperReaderPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly storage: ReaderStorage;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, pdfUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (PaperReaderPanel.currentPanel) {
      PaperReaderPanel.currentPanel.panel.reveal(column);
      PaperReaderPanel.currentPanel.update(pdfUri);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'readingExtension.reader',
      `Reader: ${path.basename(pdfUri.fsPath)}`,
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          extensionUri,
          vscode.Uri.file(path.dirname(pdfUri.fsPath))
        ]
      }
    );

    PaperReaderPanel.currentPanel = new PaperReaderPanel(panel, extensionUri, pdfUri);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private pdfUri: vscode.Uri
  ) {
    this.panel = panel;
    this.storage = new ReaderStorage(pdfUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: ReaderMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.update(pdfUri);
  }

  private async update(pdfUri: vscode.Uri) {
    this.pdfUri = pdfUri;
    this.panel.title = `Reader: ${path.basename(pdfUri.fsPath)}`;
    await this.storage.ensureStorageDir();
    this.panel.webview.html = await this.getHtml();
  }

  private async handleMessage(message: ReaderMessage) {
    switch (message.type) {
      case 'ready':
        await this.postState();
        break;
      case 'saveAnnotation':
        await this.storage.addAnnotation(message.payload);
        await this.postState();
        break;
      case 'saveWord':
        await this.storage.addWord(message.payload);
        await this.postState();
        break;
      case 'saveProgress':
        await this.storage.saveProgress(message.payload);
        break;
      case 'copyPrompt':
        await this.copyPrompt(message.payload.text);
        break;
    }
  }

  private async postState() {
    const [annotations, words, progress] = await Promise.all([
      this.storage.readAnnotations(),
      this.storage.readWords(),
      this.storage.readProgress()
    ]);

    await this.panel.webview.postMessage({
      type: 'state',
      payload: {
        annotations,
        words,
        progress,
        paperName: path.basename(this.pdfUri.fsPath)
      }
    });
  }

  private async copyPrompt(text: string) {
    const template = vscode.workspace
      .getConfiguration('readingExtension')
      .get<string>('chatGptPromptTemplate');
    const prompt = (template || '请翻译并解释下面这段论文内容：\n\n{text}').replace('{text}', text);
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Translation prompt copied for ChatGPT.');
  }

  private async getHtml() {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.css')
    );
    const pdfWebviewUri = webview.asWebviewUri(this.pdfUri);
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Reading Extension</title>
</head>
<body>
  <main class="shell">
    <section class="reader">
      <iframe title="PDF preview" src="${pdfWebviewUri}"></iframe>
    </section>
    <aside class="side-panel">
      <header>
        <p class="eyebrow">Reading Extension</p>
        <h1>${escapeHtml(path.basename(this.pdfUri.fsPath))}</h1>
      </header>
      <section class="tool-block">
        <label for="selectedText">Selected text</label>
        <textarea id="selectedText" rows="6" placeholder="Paste selected paper text here for translation, annotation, or vocabulary capture."></textarea>
        <div class="actions">
          <button id="copyPrompt">Copy ChatGPT prompt</button>
        </div>
      </section>
      <section class="tool-block">
        <h2>Annotation</h2>
        <input id="pageInput" type="number" min="1" placeholder="Page">
        <textarea id="noteInput" rows="4" placeholder="Your annotation"></textarea>
        <button id="saveAnnotation">Save annotation</button>
      </section>
      <section class="tool-block">
        <h2>Wordbook</h2>
        <input id="wordInput" type="text" placeholder="Word or phrase">
        <input id="translationInput" type="text" placeholder="Translation">
        <textarea id="wordNoteInput" rows="3" placeholder="Definition, memory note, or context"></textarea>
        <button id="saveWord">Save word</button>
      </section>
      <section class="tool-block list-block">
        <h2>Saved annotations</h2>
        <div id="annotationsList" class="list"></div>
      </section>
      <section class="tool-block list-block">
        <h2>Wordbook</h2>
        <div id="wordsList" class="list"></div>
      </section>
    </aside>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose() {
    PaperReaderPanel.currentPanel = undefined;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

