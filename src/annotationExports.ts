import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFPage, PDFString, rgb } from 'pdf-lib';
import { AnnotationRecord } from './annotationTypes';

export function formatAnnotationsMarkdown(
  baseName: string,
  annotations: AnnotationRecord[],
  exportedAt = new Date()
) {
  const lines = [
    `# Annotations for ${baseName}`,
    '',
    `Exported at ${exportedAt.toISOString()}`,
    ''
  ];

  if (!annotations.length) {
    lines.push('No annotations saved yet.', '');
    return lines.join('\n');
  }

  for (const annotation of annotations) {
    lines.push(
      `## ${annotation.page ? `Page ${annotation.page}` : 'Annotation'} (${annotation.kind ?? 'highlight'}, ${annotation.color ?? '#ffd654'})`
    );
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

export async function applyAnnotationsToPdf(
  pdfBytes: Uint8Array,
  annotations: AnnotationRecord[]
): Promise<Uint8Array> {
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
      const x = rect.x * width;
      const y = (1 - rect.y - rect.height) * height;
      const rectWidth = rect.width * width;
      const rectHeight = rect.height * height;

      if ((annotation.kind ?? 'highlight') === 'underline') {
        page.drawRectangle({
          x,
          y: y + Math.max(1, rectHeight * 0.08),
          width: rectWidth,
          height: Math.max(1.25, rectHeight * 0.08),
          color: rgb(color.r, color.g, color.b),
          opacity: 0.9,
          borderOpacity: 0
        });
      } else {
        page.drawRectangle({
          x,
          y,
          width: rectWidth,
          height: rectHeight,
          color: rgb(color.r, color.g, color.b),
          opacity: 0.35,
          borderOpacity: 0
        });
      }
    }

    if (annotation.note) {
      addNativeTextAnnotation(pdf, pages, annotation, color);
    }
  }

  return pdf.save();
}

function addNativeTextAnnotation(
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
  const modifiedAt = parseDateOrNow(annotation.updatedAt || annotation.createdAt);
  const annot = pdf.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: iconRect,
    Contents: PDFHexString.fromText(contents),
    T: PDFHexString.fromText('Reading Extension'),
    Name: PDFName.of('Comment'),
    C: [color.r, color.g, color.b],
    M: PDFString.fromDate(modifiedAt),
    Open: false,
    F: 4
  });
  const annotRef = pdf.context.register(annot);
  const annots = page.node.Annots() ?? (pdf.context.obj([]) as PDFArray);

  if (!page.node.Annots()) {
    page.node.set(PDFName.of('Annots'), annots);
  }

  annots.push(annotRef);
}

function parseDateOrNow(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
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
