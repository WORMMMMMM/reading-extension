export interface AnnotationRecord {
  id: string;
  page?: number;
  rects?: AnnotationRect[];
  highlighterPosition?: PdfHighlighterPosition;
  color?: string;
  kind?: AnnotationKind;
  tags?: string[];
  contextBefore?: string;
  contextAfter?: string;
  selectedText: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type AnnotationKind = 'highlight' | 'underline';

export interface AnnotationRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfHighlighterPosition {
  boundingRect: PdfHighlighterScaledRect;
  rects: PdfHighlighterScaledRect[];
  usePdfCoordinates?: boolean;
}

export interface PdfHighlighterScaledRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  pageNumber: number;
}
