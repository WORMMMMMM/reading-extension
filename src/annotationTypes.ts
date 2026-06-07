export interface AnnotationRecord {
  id: string;
  page?: number;
  rects?: AnnotationRect[];
  color?: string;
  kind?: AnnotationKind;
  tags?: string[];
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
