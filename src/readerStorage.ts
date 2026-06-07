import * as path from 'path';
import * as vscode from 'vscode';

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

  private fileUri(kind: 'annotations' | 'wordbook' | 'progress') {
    return vscode.Uri.joinPath(this.storageDir, `${this.baseName}.${kind}.json`);
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
