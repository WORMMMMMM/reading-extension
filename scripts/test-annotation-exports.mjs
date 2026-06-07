import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');
const { applyAnnotationsToPdf, formatAnnotationsMarkdown } = require('../out/annotationExports.js');

const timestamp = '2026-01-01T00:00:00.000Z';
const annotations = [
  {
    id: 'highlight-with-note',
    page: 1,
    rects: [{ page: 1, x: 0.1, y: 0.2, width: 0.4, height: 0.05 }],
    color: '#ffd654',
    kind: 'highlight',
    selectedText: 'Transformer models align tokens across long contexts.',
    note: 'Important architecture claim.',
    createdAt: timestamp,
    updatedAt: timestamp
  },
  {
    id: 'underline-only',
    page: 1,
    rects: [{ page: 1, x: 0.15, y: 0.35, width: 0.3, height: 0.04 }],
    color: '#8fd3ff',
    kind: 'underline',
    selectedText: 'Ablation result',
    note: '',
    createdAt: timestamp,
    updatedAt: timestamp
  },
  {
    id: 'page-note',
    page: 1,
    rects: [],
    color: '#b6e388',
    kind: 'highlight',
    selectedText: '',
    note: 'Re-read this page before the group meeting.',
    createdAt: timestamp,
    updatedAt: timestamp
  }
];

const markdown = formatAnnotationsMarkdown('sample.pdf', annotations, new Date(timestamp));
assert.match(markdown, /# Annotations for sample\.pdf/);
assert.match(markdown, /Exported at 2026-01-01T00:00:00\.000Z/);
assert.match(markdown, /Page 1 \(highlight, #ffd654\)/);
assert.match(markdown, /> Transformer models align tokens across long contexts\./);
assert.match(markdown, /Important architecture claim\./);
assert.match(markdown, /Page 1 \(underline, #8fd3ff\)/);
assert.match(markdown, /Re-read this page before the group meeting\./);

const sourcePdf = await PDFDocument.create();
sourcePdf.addPage([400, 300]);
const sourceBytes = await sourcePdf.save();
const exportedBytes = await applyAnnotationsToPdf(sourceBytes, annotations);

assert.ok(exportedBytes.length > sourceBytes.length, 'annotated PDF should include extra drawing/comment data');

const exportedPdf = await PDFDocument.load(exportedBytes);
const [firstPage] = exportedPdf.getPages();
const annots = firstPage.node.Annots();

assert.ok(annots, 'annotated PDF should include native note comments');
assert.equal(annots.size(), 2, 'notes should create one native PDF comment each');

console.log('annotation export regression passed');
