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
  | {
      type: 'updateAnnotation';
      payload: {
        id: string;
        patch: Partial<Omit<AnnotationRecord, 'id' | 'createdAt' | 'updatedAt'>>;
      };
    }
  | { type: 'deleteAnnotation'; payload: { id: string } }
  | { type: 'exportAnnotations' }
  | { type: 'exportAnnotatedPdf' }
  | { type: 'saveWord'; payload: Omit<WordRecord, 'id' | 'createdAt' | 'updatedAt'> }
  | { type: 'reviewWord'; payload: { id: string; remembered: boolean } }
  | { type: 'saveProgress'; payload: ProgressRecord }
  | { type: 'copyPrompt'; payload: { text: string } }
  | { type: 'translate'; payload: { text: string } };

export class PaperReaderPanel {
  private static currentPanel: PaperReaderPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private storage: ReaderStorage;
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
    this.storage = new ReaderStorage(pdfUri);
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
      case 'updateAnnotation':
        await this.storage.updateAnnotation(message.payload.id, message.payload.patch);
        await this.postState();
        break;
      case 'deleteAnnotation':
        await this.storage.deleteAnnotation(message.payload.id);
        await this.postState();
        break;
      case 'exportAnnotations':
        await this.exportAnnotations();
        break;
      case 'exportAnnotatedPdf':
        await this.exportAnnotatedPdf();
        break;
      case 'saveWord':
        await this.storage.addWord(message.payload);
        await this.postState();
        break;
      case 'reviewWord':
        await this.storage.updateWordReview(message.payload.id, message.payload.remembered);
        await this.postState();
        break;
      case 'saveProgress':
        await this.storage.saveProgress(message.payload);
        break;
      case 'copyPrompt':
        await this.copyPrompt(message.payload.text);
        break;
      case 'translate':
        await this.translate(message.payload.text);
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

  private async translate(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      await this.postTranslationResult('', 'Select or paste text before translating.');
      return;
    }

    try {
      const translatedText = await this.translateWithLibreTranslate(trimmed);
      await this.postTranslationResult(translatedText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.postTranslationResult('', message);
    }
  }

  private async translateWithLibreTranslate(text: string) {
    const config = vscode.workspace.getConfiguration('readingExtension');
    const endpoint = config.get<string>('libreTranslateEndpoint') || 'http://localhost:5000/translate';
    const source = config.get<string>('translationSource') || 'auto';
    const target = config.get<string>('translationTarget') || 'zh';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: text,
          source,
          target,
          format: 'text'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`LibreTranslate returned HTTP ${response.status}.`);
      }

      const data = await response.json() as { translatedText?: string; error?: string };
      if (data.error) {
        throw new Error(data.error);
      }
      if (!data.translatedText) {
        throw new Error('LibreTranslate response did not include translatedText.');
      }

      return data.translatedText;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('LibreTranslate request timed out. Is the local server running?');
      }
      if (error instanceof TypeError) {
        throw new Error('Could not reach LibreTranslate. Start the local server or change readingExtension.libreTranslateEndpoint.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postTranslationResult(translatedText: string, error?: string) {
    await this.panel.webview.postMessage({
      type: 'translationResult',
      payload: {
        translatedText,
        error
      }
    });
  }

  private async exportAnnotations() {
    try {
      const uri = await this.storage.exportAnnotationsMarkdown();
      await this.panel.webview.postMessage({
        type: 'exportResult',
        payload: {
          path: uri.fsPath
        }
      });
      vscode.window.showInformationMessage(`Annotations exported: ${uri.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({
        type: 'exportResult',
        payload: {
          error: message
        }
      });
    }
  }

  private async exportAnnotatedPdf() {
    try {
      const uri = await this.storage.exportAnnotatedPdf();
      await this.panel.webview.postMessage({
        type: 'exportResult',
        payload: {
          path: uri.fsPath
        }
      });
      vscode.window.showInformationMessage(`Annotated PDF exported: ${uri.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({
        type: 'exportResult',
        payload: {
          error: message
        }
      });
    }
  }

  private async getHtml() {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.css')
    );
    const pdfJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.mjs')
    );
    const pdfWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs')
    );
    const pdfWebviewUri = webview.asWebviewUri(this.pdfUri);
    const nonce = getNonce();
    const readerConfig = JSON.stringify({
      pdfUrl: pdfWebviewUri.toString(),
      pdfJsUrl: pdfJsUri.toString(),
      pdfWorkerUrl: pdfWorkerUri.toString()
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Reading Extension</title>
</head>
<body>
  <main class="shell">
    <section class="reader">
      <div class="reader-toolbar">
        <button id="prevPage" title="Previous page">Prev</button>
        <label class="page-jump">
          <span>Page</span>
          <input id="pageInput" type="number" min="1" value="1">
          <span id="pageTotal">/ -</span>
        </label>
        <button id="nextPage" title="Next page">Next</button>
        <button id="zoomOut" title="Zoom out">-</button>
        <span id="zoomValue">100%</span>
        <button id="zoomIn" title="Zoom in">+</button>
        <span id="readerStatus" class="reader-status">Loading PDF...</span>
      </div>
      <div id="pdfViewer" class="pdf-viewer" aria-label="PDF pages"></div>
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
          <button id="translateLocal">Translate locally</button>
          <button id="copyPrompt">Copy ChatGPT prompt</button>
        </div>
        <textarea id="translationOutput" rows="5" placeholder="Local translation will appear here."></textarea>
      </section>
      <section class="tool-block">
        <h2>Annotation</h2>
        <div id="annotationEditStatus" class="edit-status" hidden>Editing annotation</div>
        <label for="annotationColor">Highlight color</label>
        <select id="annotationColor">
          <option value="#ffd654">Yellow</option>
          <option value="#8fd3ff">Blue</option>
          <option value="#a6e99f">Green</option>
          <option value="#ffaaa5">Red</option>
          <option value="#d7b8ff">Purple</option>
        </select>
        <textarea id="noteInput" rows="4" placeholder="Your annotation"></textarea>
        <div class="actions">
          <button id="saveAnnotation">Save annotation</button>
          <button id="cancelAnnotationEdit" class="secondary-button" hidden>Cancel edit</button>
        </div>
      </section>
      <section class="tool-block">
        <h2>Wordbook</h2>
        <input id="wordInput" type="text" placeholder="Word or phrase">
        <input id="translationInput" type="text" placeholder="Translation">
        <textarea id="wordNoteInput" rows="3" placeholder="Definition, memory note, or context"></textarea>
        <button id="saveWord">Save word</button>
      </section>
      <section class="tool-block list-block">
        <h2>Due today</h2>
        <div id="dueWordsList" class="list"></div>
      </section>
      <section class="tool-block list-block">
        <h2>Saved annotations</h2>
        <input id="annotationSearch" type="search" placeholder="Search annotations">
        <select id="annotationColorFilter">
          <option value="">All colors</option>
          <option value="#ffd654">Yellow</option>
          <option value="#8fd3ff">Blue</option>
          <option value="#a6e99f">Green</option>
          <option value="#ffaaa5">Red</option>
          <option value="#d7b8ff">Purple</option>
        </select>
        <div class="actions">
          <button id="exportAnnotations">Export Markdown</button>
          <button id="exportAnnotatedPdf">Export PDF</button>
        </div>
        <div id="annotationExportStatus" class="status-line"></div>
        <div id="annotationsList" class="list"></div>
      </section>
      <section class="tool-block list-block">
        <h2>Wordbook</h2>
        <div id="wordsList" class="list"></div>
      </section>
    </aside>
  </main>
  <script nonce="${nonce}">window.readerConfig = ${readerConfig};</script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
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
