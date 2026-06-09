import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { formatAnnotationMarkdownSnippet } from './annotationExports';
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
  | { type: 'restoreAnnotation'; payload: AnnotationRecord }
  | { type: 'copyAnnotationMarkdown'; payload: { id: string } }
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
        localResourceRoots: getLocalResourceRoots(extensionUri, pdfUri)
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
    this.panel.webview.options = {
      ...this.panel.webview.options,
      localResourceRoots: getLocalResourceRoots(this.extensionUri, pdfUri)
    };
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
      case 'restoreAnnotation':
        await this.storage.restoreAnnotation(message.payload);
        await this.postState();
        await this.postAnnotationActionResult('Annotation restored.');
        break;
      case 'copyAnnotationMarkdown':
        await this.copyAnnotationMarkdown(message.payload.id);
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
      const translatedText = await this.translateWithLocalProvider(trimmed);
      await this.postTranslationResult(translatedText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.postTranslationResult('', message);
    }
  }

  private async translateWithLocalProvider(text: string) {
    const config = vscode.workspace.getConfiguration('readingExtension');
    const provider = config.get<string>('translationProvider') || 'argos';

    if (provider === 'argos') {
      try {
        return await this.translateWithArgos(text);
      } catch (error) {
        if (config.get<boolean>('translationFallbackToLibreTranslate') === false) {
          throw error;
        }
      }
    }

    return this.translateWithLibreTranslate(text);
  }

  private async translateWithArgos(text: string) {
    const config = vscode.workspace.getConfiguration('readingExtension');
    const configuredPython = config.get<string>('argosPythonPath')?.trim();
    const pythonPath = configuredPython || path.join(this.extensionUri.fsPath, '.venv-translate', 'bin', 'python');
    const scriptPath = path.join(this.extensionUri.fsPath, 'scripts', 'argos_translate.py');
    const source = normalizeArgosLanguage(config.get<string>('translationSource') || 'auto', 'en');
    const target = normalizeArgosLanguage(config.get<string>('translationTarget') || 'zh', 'zh');

    if (!fs.existsSync(pythonPath)) {
      throw new Error(`Argos Python not found at ${pythonPath}.`);
    }
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Argos helper script not found at ${scriptPath}.`);
    }

    const payload = JSON.stringify({ text, source, target });
    const result = await runProcess(pythonPath, [scriptPath], payload, 45000);
    const jsonLine = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .reverse()
      .find(line => line.startsWith('{') && line.endsWith('}'));
    const parsed = JSON.parse(jsonLine || '{}') as { translatedText?: string; error?: string };
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    if (!parsed.translatedText) {
      throw new Error(result.stderr || 'Argos Translate did not return translatedText.');
    }

    return parsed.translatedText;
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

  private async copyAnnotationMarkdown(id: string) {
    try {
      const annotations = await this.storage.readAnnotations();
      const annotation = annotations.find(item => item.id === id);
      if (!annotation) {
        throw new Error('Annotation not found.');
      }

      await vscode.env.clipboard.writeText(formatAnnotationMarkdownSnippet(annotation));
      await this.panel.webview.postMessage({
        type: 'clipboardResult',
        payload: {
          message: 'Annotation Markdown copied.'
        }
      });
      vscode.window.showInformationMessage('Annotation Markdown copied.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({
        type: 'clipboardResult',
        payload: {
          error: message
        }
      });
    }
  }

  private async postAnnotationActionResult(message: string, error?: string) {
    await this.panel.webview.postMessage({
      type: 'annotationActionResult',
      payload: {
        message,
        error
      }
    });
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
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader-app.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'reader-app.css')
    );
    const pdfWebviewUri = webview.asWebviewUri(this.pdfUri);
    const nonce = getNonce();
    const readerConfig = JSON.stringify({
      pdfUrl: pdfWebviewUri.toString(),
      paperName: path.basename(this.pdfUri.fsPath)
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Reading Extension</title>
</head>
<body>
  <main id="startupStatus" class="startup-state">
    <h1>Starting reader...</h1>
    <p>Loading the Webview script.</p>
  </main>
  <div id="root"></div>
  <script nonce="${nonce}">
    const showStartupError = error => {
      const status = document.getElementById('startupStatus');
      if (status) {
        status.className = 'startup-state startup-error';
        status.innerHTML = '<h1>Reader failed to start</h1><pre></pre>';
        status.querySelector('pre').textContent = error;
      }
    };
    window.process = window.process || { env: {} };
    window.process.env = {
      ...window.process.env,
      NODE_ENV: 'production',
      DRAGGABLE_DEBUG: ''
    };
    window.readerConfig = ${readerConfig};
    window.addEventListener('error', event => {
      showStartupError(event.message || String(event.error || 'Unknown Webview error'));
    });
    window.addEventListener('unhandledrejection', event => {
      showStartupError(event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unhandled promise rejection'));
    });
  </script>
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

function getLocalResourceRoots(extensionUri: vscode.Uri, pdfUri: vscode.Uri) {
  return [
    extensionUri,
    vscode.Uri.file(path.dirname(pdfUri.fsPath))
  ];
}

function normalizeArgosLanguage(value: string, fallback: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'auto') {
    return fallback;
  }
  if (normalized === 'zh-cn' || normalized === 'zh_hans' || normalized === 'zh-hans') {
    return 'zh';
  }
  if (normalized === 'zh-tw' || normalized === 'zh_hant' || normalized === 'zh-hant') {
    return 'zt';
  }
  return normalized;
}

function runProcess(command: string, args: string[], stdin: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd: path.dirname(command),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Local translation timed out.'));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `Local translation exited with code ${code}.`));
    });

    child.stdin.end(stdin);
  });
}
