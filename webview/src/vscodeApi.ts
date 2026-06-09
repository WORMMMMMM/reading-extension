export interface ReaderConfig {
  pdfUrl: string;
  pdfWorkerUrl: string;
  paperName: string;
}

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi;
    readerConfig: ReaderConfig;
  }
}

export const vscode = window.acquireVsCodeApi();
export const readerConfig = window.readerConfig;
