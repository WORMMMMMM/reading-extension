import * as path from 'path';
import * as vscode from 'vscode';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFPage, PDFString, rgb } from 'pdf-lib';

export interface AnnotationRecord {
  id: string;
  page?: number;
  rects?: AnnotationRect[];
  color?: string;
  selectedText: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WordRecord {
  id: string;
  word: string;
  translation?: string;
  sentence?: string;
  note?: string;
  page?: number;
  review?: WordReview;
  createdAt: string;
  updatedAt: string;
}

export interface WordReview {
  level: number;
  nextReviewAt: string;
  lastReviewedAt?: string;
}

export interface ProgressRecord {
  page?: number;
  updatedAt: string;
}

export class ReaderStorage {
  private readonly storageDir: vscode.Uri;
  private readonly baseName: string;

  constructor(private readonly pdfUri: vscode.Uri) {
    this.baseName = path.basename(pdfUri.fsPath);
    this.storageDir = vscode.Uri.file(path.join(path.dirname(pdfUri.fsPath), '.reading-extension'));
  }

  async ensureStorageDir() {
    await vscode.workspace.fs.createDirectory(this.storageDir);
  }

  async readAnnotations(): Promise<AnnotationRecord[]> {
    return this.readJson<AnnotationRecord[]>(this.fileUri('annotations'), []);
  }

  async readWords(): Promise<WordRecord[]> {
    return this.readJson<WordRecord[]>(this.fileUri('wordbook'), []);
  }

  async readProgress(): Promise<ProgressRecord> {
    return this.readJson<ProgressRecord>(this.fileUri('progress'), {
      updatedAt: new Date(0).toISOString()
    });
  }

  async addAnnotation(input: Omit<AnnotationRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = new Date().toISOString();
    const annotations = await this.readAnnotations();
    annotations.unshift({
      ...input,
      color: input.color ?? '#ffd654',
      id: cryptoRandomId(),
      createdAt: now,
      updatedAt: now
    });
    await this.writeJson(this.fileUri('annotations'), annotations);
  }

  async updateAnnotation(
    id: string,
    patch: Partial<Omit<AnnotationRecord, 'id' | 'createdAt' | 'updatedAt'>>
  ) {
    const annotations = await this.readAnnotations();
    const annotation = annotations.find(item => item.id === id);
    if (!annotation) {
      return;
    }

    Object.assign(annotation, patch, {
      updatedAt: new Date().toISOString()
    });
    await this.writeJson(this.fileUri('annotations'), annotations);
  }

  async deleteAnnotation(id: string) {
    const annotations = await this.readAnnotations();
    await this.writeJson(
      this.fileUri('annotations'),
      annotations.filter(item => item.id !== id)
    );
  }

  async exportAnnotationsMarkdown() {
    const annotations = await this.readAnnotations();
    const markdown = this.formatAnnotationsMarkdown(annotations);
    const uri = this.fileUri('annotations.md');
    await this.writeText(uri, markdown);
    return uri;
  }

  async exportAnnotatedPdf() {
    const [pdfBytes, annotations] = await Promise.all([
      vscode.workspace.fs.readFile(this.pdfUri),
      this.readAnnotations()
    ]);
    const pdf = await PDFDocument.load(pdfBytes);
    const pages = pdf.getPages();

    for (const annotation of annotations) {
      const color = hexToRgb(annotation.color ?? '#ffd654');
      for (const rect of annotation.rects ?? []) {
        const page = pages[rect.page - 1];
        if (!page) {
          continue;
        }

        const { width, height } = page.getSize();
        page.drawRectangle({
          x: rect.x * width,
          y: (1 - rect.y - rect.height) * height,
          width: rect.width * width,
          height: rect.height * height,
          color: rgb(color.r, color.g, color.b),
          opacity: 0.35,
          borderOpacity: 0
        });
      }

      if (annotation.note) {
        this.addNativeTextAnnotation(pdf, pages, annotation, color);
      }
    }

    const exportedBytes = await pdf.save();
    const uri = this.fileUri('annotated.pdf');
    await this.ensureStorageDir();
    await vscode.workspace.fs.writeFile(uri, exportedBytes);
    return uri;
  }

  async addWord(input: Omit<WordRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = new Date().toISOString();
    const words = await this.readWords();
    words.unshift({
      ...input,
      id: cryptoRandomId(),
      review: input.review ?? {
        level: 0,
        nextReviewAt: startOfTodayIso()
      },
      createdAt: now,
      updatedAt: now
    });
    await this.writeJson(this.fileUri('wordbook'), words);
  }

  async updateWordReview(id: string, remembered: boolean) {
    const words = await this.readWords();
    const word = words.find(item => item.id === id);
    if (!word) {
      return;
    }

    const currentLevel = word.review?.level ?? 0;
    const nextLevel = remembered ? Math.min(currentLevel + 1, reviewIntervalsDays.length - 1) : 0;
    const now = new Date();

    word.review = {
      level: nextLevel,
      lastReviewedAt: now.toISOString(),
      nextReviewAt: addDaysIso(now, remembered ? reviewIntervalsDays[nextLevel] : 1)
    };
    word.updatedAt = now.toISOString();

    await this.writeJson(this.fileUri('wordbook'), words);
  }

  async saveProgress(progress: ProgressRecord) {
    await this.writeJson(this.fileUri('progress'), {
      ...progress,
      updatedAt: new Date().toISOString()
    });
  }

  private fileUri(kind: 'annotations' | 'annotations.md' | 'annotated.pdf' | 'wordbook' | 'progress') {
    const extension = kind === 'annotations.md' ? 'md' : kind === 'annotated.pdf' ? 'pdf' : 'json';
    const stem = kind === 'annotations.md' ? 'annotations' : kind === 'annotated.pdf' ? 'annotated' : kind;
    return vscode.Uri.joinPath(this.storageDir, `${this.baseName}.${stem}.${extension}`);
  }

  private async readJson<T>(uri: vscode.Uri, fallback: T): Promise<T> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(uri: vscode.Uri, value: unknown) {
    await this.ensureStorageDir();
    const bytes = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
  }

  private async writeText(uri: vscode.Uri, value: string) {
    await this.ensureStorageDir();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(value, 'utf8'));
  }

  private formatAnnotationsMarkdown(annotations: AnnotationRecord[]) {
    const lines = [
      `# Annotations for ${this.baseName}`,
      '',
      `Exported at ${new Date().toISOString()}`,
      ''
    ];

    if (!annotations.length) {
      lines.push('No annotations saved yet.', '');
      return lines.join('\n');
    }

    for (const annotation of annotations) {
      lines.push(`## ${annotation.page ? `Page ${annotation.page}` : 'Annotation'} (${annotation.color ?? '#ffd654'})`);
      lines.push('');
      if (annotation.selectedText) {
        lines.push('> ' + annotation.selectedText.replace(/\n/g, '\n> '));
        lines.push('');
      }
      if (annotation.note) {
        lines.push(annotation.note);
        lines.push('');
      }
      lines.push(`- Created: ${annotation.createdAt}`);
      lines.push(`- Updated: ${annotation.updatedAt}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private addNativeTextAnnotation(
    pdf: PDFDocument,
    pages: PDFPage[],
    annotation: AnnotationRecord,
    color: { r: number; g: number; b: number }
  ) {
    const firstRect = annotation.rects?.[0];
    const pageIndex = firstRect ? firstRect.page - 1 : (annotation.page ?? 1) - 1;
    const page = pages[pageIndex];
    if (!page) {
      return;
    }

    const { width, height } = page.getSize();
    const iconSize = 18;
    const x = firstRect ? firstRect.x * width : width - 42;
    const y = firstRect ? (1 - firstRect.y) * height + 4 : height - 42;
    const iconRect = [
      clampNumber(x, 0, width - iconSize),
      clampNumber(y, 0, height - iconSize),
      clampNumber(x + iconSize, iconSize, width),
      clampNumber(y + iconSize, iconSize, height)
    ];
    const contents = [
      annotation.note,
      annotation.selectedText ? `\n\nSelected text:\n${annotation.selectedText}` : ''
    ].join('');
    const annot = pdf.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Text'),
      Rect: iconRect,
      Contents: PDFHexString.fromText(contents),
      T: PDFHexString.fromText('Reading Extension'),
      Name: PDFName.of('Comment'),
      C: [color.r, color.g, color.b],
      M: PDFString.fromDate(new Date(annotation.updatedAt || annotation.createdAt)),
      Open: false,
      F: 4
    });
    const annotRef = pdf.context.register(annot);
    const annots = page.node.Annots() ?? pdf.context.obj([]) as PDFArray;

    if (!page.node.Annots()) {
      page.node.set(PDFName.of('Annots'), annots);
    }

    annots.push(annotRef);
  }
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const reviewIntervalsDays = [0, 1, 3, 7, 14, 30];

function startOfTodayIso() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next.toISOString();
}

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return { r: 1, g: 0.84, b: 0.33 };
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
