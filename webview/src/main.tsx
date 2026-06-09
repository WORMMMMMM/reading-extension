import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.min.mjs';
import {
  AreaHighlight,
  PdfHighlighter,
  PdfLoader,
  TextHighlight,
  useHighlightContainerContext,
  type Highlight,
  type PdfHighlighterUtils,
  type PdfScaleValue,
  type PdfSelection,
  type ScaledPosition
} from 'react-pdf-highlighter-plus';
import 'pdfjs-dist/web/pdf_viewer.css';
import 'react-pdf-highlighter-plus/style/style.css';
import './styles.css';
import { readerConfig, vscode } from './vscodeApi';
import type { AnnotationKind, AnnotationRecord, AnnotationRect, ReaderStatePayload, WordRecord } from './types';

type PdfjsGlobal = typeof globalThis & {
  pdfjsWorker?: { WorkerMessageHandler: unknown };
};

(globalThis as PdfjsGlobal).pdfjsWorker = { WorkerMessageHandler };

type ReaderHighlight = Highlight & {
  annotation?: AnnotationRecord;
};

type IncomingMessage =
  | { type: 'state'; payload: ReaderStatePayload }
  | { type: 'translationResult'; payload: { translatedText?: string; error?: string } }
  | { type: 'exportResult'; payload: { path?: string; error?: string } }
  | { type: 'clipboardResult'; payload: { message?: string; error?: string } }
  | { type: 'annotationActionResult'; payload: { message?: string; error?: string } };

const colorOptions = [
  { label: 'Yellow', value: '#ffd654' },
  { label: 'Blue', value: '#8fd3ff' },
  { label: 'Green', value: '#a6e99f' },
  { label: 'Red', value: '#ffaaa5' },
  { label: 'Purple', value: '#d7b8ff' }
];

const defaultState: ReaderStatePayload = {
  annotations: [],
  words: [],
  progress: { updatedAt: new Date(0).toISOString() },
  paperName: readerConfig.paperName
};

function App() {
  const [state, setState] = useState<ReaderStatePayload>(defaultState);
  const [selectedText, setSelectedText] = useState('');
  const [selectionPosition, setSelectionPosition] = useState<ScaledPosition | undefined>();
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [color, setColor] = useState('#ffd654');
  const [kind, setKind] = useState<AnnotationKind>('highlight');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [translationOutput, setTranslationOutput] = useState('');
  const [word, setWord] = useState('');
  const [wordTranslation, setWordTranslation] = useState('');
  const [wordNote, setWordNote] = useState('');
  const [annotationQuery, setAnnotationQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [sortMode, setSortMode] = useState('position');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageTotal, setPageTotal] = useState(0);
  const [zoom, setZoom] = useState<PdfScaleValue>('page-fit');
  const [status, setStatus] = useState('Loading PDF...');
  const [activeId, setActiveId] = useState<string | undefined>();
  const [lastDeleted, setLastDeleted] = useState<AnnotationRecord | undefined>();
  const highlighterRef = useRef<PdfHighlighterUtils | null>(null);
  const editDebounceRef = useRef<number | undefined>(undefined);
  const progressDebounceRef = useRef<number | undefined>(undefined);
  const documentReadyRef = useRef(false);

  useEffect(() => {
    document.body.classList.add('reader-mounted');
    return () => document.body.classList.remove('reader-mounted');
  }, []);

  const handleDocumentReady = useCallback((numPages: number) => {
    setPageTotal(numPages);
    if (!documentReadyRef.current) {
      documentReadyRef.current = true;
      setStatus('PDF loaded.');
    }
  }, []);

  const handleStyleChange = useCallback((annotation: AnnotationRecord, nextColor: string, nextKind: AnnotationKind) => {
    vscode.postMessage({
      type: 'updateAnnotation',
      payload: { id: annotation.id, patch: { color: nextColor, kind: nextKind } }
    });
  }, []);

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
    const listener = (event: MessageEvent<IncomingMessage>) => {
      const message = event.data;
      if (message.type === 'state') {
        setState(message.payload);
        if (message.payload.progress?.page) {
          setCurrentPage(message.payload.progress.page);
        }
      }
      if (message.type === 'translationResult') {
        setTranslationOutput(message.payload.error || message.payload.translatedText || '');
      }
      if (message.type === 'exportResult') {
        setStatus(message.payload.error ? `Export failed: ${message.payload.error}` : `Exported: ${message.payload.path}`);
      }
      if (message.type === 'clipboardResult' || message.type === 'annotationActionResult') {
        setStatus(message.payload.error || message.payload.message || 'Done.');
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  useEffect(() => {
    if (!state.progress?.page || !pageTotal) {
      return;
    }
    const timer = window.setTimeout(() => goToPage(state.progress.page || 1, false), 250);
    return () => window.clearTimeout(timer);
  }, [pageTotal, state.progress?.page]);

  useEffect(() => {
    if (!editingId) {
      return;
    }
    window.clearTimeout(editDebounceRef.current);
    editDebounceRef.current = window.setTimeout(() => {
      const page = selectionPosition?.boundingRect.pageNumber || currentPage;
      vscode.postMessage({
        type: 'updateAnnotation',
        payload: {
          id: editingId,
          patch: {
            page,
            selectedText,
            note,
            tags: normalizeTags(tags),
            color,
            kind,
            highlighterPosition: selectionPosition,
            rects: selectionPosition ? highlighterPositionToRects(selectionPosition) : undefined
          }
        }
      });
      setStatus('Annotation autosaved.');
    }, 550);
    return () => window.clearTimeout(editDebounceRef.current);
  }, [color, currentPage, editingId, kind, note, selectedText, selectionPosition, tags]);

  const highlights = useMemo(
    () => state.annotations.map(annotationToHighlight).filter(Boolean) as ReaderHighlight[],
    [state.annotations]
  );

  const filteredAnnotations = useMemo(() => {
    const query = annotationQuery.trim().toLowerCase();
    const tagNeedles = normalizeTags(tagQuery);
    return [...state.annotations]
      .filter(annotation => {
        const haystack = [
          annotation.selectedText,
          annotation.note,
          annotation.contextBefore,
          annotation.contextAfter,
          ...(annotation.tags || [])
        ].join(' ').toLowerCase();
        if (query && !haystack.includes(query)) {
          return false;
        }
        if (tagNeedles.length && !tagNeedles.every(tag => (annotation.tags || []).includes(tag))) {
          return false;
        }
        if (colorFilter && (annotation.color || '#ffd654') !== colorFilter) {
          return false;
        }
        if (kindFilter && (annotation.kind || 'highlight') !== kindFilter) {
          return false;
        }
        return true;
      })
      .sort((a, b) => compareAnnotations(a, b, sortMode));
  }, [annotationQuery, colorFilter, kindFilter, sortMode, state.annotations, tagQuery]);

  const dueWords = useMemo(() => {
    const now = Date.now();
    return state.words.filter(item => Date.parse(item.review?.nextReviewAt || item.createdAt) <= now);
  }, [state.words]);

  function handleSelection(selection: PdfSelection) {
    const ghost = selection.makeGhostHighlight();
    const text = ghost.content.text || '';
    setSelectedText(text);
    setSelectionPosition(ghost.position);
    setCurrentPage(ghost.position.boundingRect.pageNumber);
    setStatus('Selection captured.');
  }

  function saveAnnotation() {
    const page = selectionPosition?.boundingRect.pageNumber || currentPage;
    const payload = {
      page,
      selectedText,
      note,
      tags: normalizeTags(tags),
      color,
      kind,
      highlighterPosition: selectionPosition,
      rects: selectionPosition ? highlighterPositionToRects(selectionPosition) : undefined
    };
    if (!payload.selectedText.trim() && !payload.note.trim()) {
      setStatus('Add selected text or a note before saving.');
      return;
    }
    if (editingId) {
      vscode.postMessage({ type: 'updateAnnotation', payload: { id: editingId, patch: payload } });
      setStatus('Annotation saved.');
    } else {
      vscode.postMessage({ type: 'saveAnnotation', payload });
      setStatus('Annotation saved automatically.');
    }
    clearAnnotationDraft();
    highlighterRef.current?.removeGhostHighlight();
  }

  function editAnnotation(annotation: AnnotationRecord) {
    setEditingId(annotation.id);
    setActiveId(annotation.id);
    setSelectedText(annotation.selectedText || '');
    setNote(annotation.note || '');
    setTags((annotation.tags || []).join(', '));
    setColor(annotation.color || '#ffd654');
    setKind(annotation.kind || 'highlight');
    setSelectionPosition(annotation.highlighterPosition || rectsToHighlighterPosition(annotation.rects));
    setCurrentPage(annotation.page || annotation.highlighterPosition?.boundingRect.pageNumber || 1);
    focusAnnotation(annotation);
  }

  function deleteAnnotation(annotation: AnnotationRecord) {
    setLastDeleted(annotation);
    vscode.postMessage({ type: 'deleteAnnotation', payload: { id: annotation.id } });
    if (editingId === annotation.id) {
      clearAnnotationDraft();
    }
    setStatus('Annotation deleted. Use undo to restore it.');
  }

  function restoreLastDeleted() {
    if (!lastDeleted) {
      return;
    }
    vscode.postMessage({ type: 'restoreAnnotation', payload: lastDeleted });
    setLastDeleted(undefined);
  }

  function clearAnnotationDraft() {
    window.clearTimeout(editDebounceRef.current);
    setEditingId(undefined);
    setSelectedText('');
    setSelectionPosition(undefined);
    setNote('');
    setTags('');
    setColor('#ffd654');
    setKind('highlight');
    setActiveId(undefined);
  }

  function focusAnnotation(annotation: AnnotationRecord) {
    setActiveId(annotation.id);
    const highlight = annotationToHighlight(annotation);
    if (highlight) {
      highlighterRef.current?.scrollToHighlight(highlight);
      return;
    }
    goToPage(annotation.page || 1);
  }

  function goToPage(page: number, saveProgress = true) {
    const nextPage = Math.min(Math.max(page, 1), pageTotal || page || 1);
    setCurrentPage(nextPage);
    highlighterRef.current?.getViewer()?.scrollPageIntoView({ pageNumber: nextPage });
    if (!saveProgress) {
      return;
    }
    window.clearTimeout(progressDebounceRef.current);
    progressDebounceRef.current = window.setTimeout(() => {
      vscode.postMessage({ type: 'saveProgress', payload: { page: nextPage } });
    }, 350);
  }

  function saveWord() {
    const text = word.trim() || selectedText.trim();
    if (!text) {
      setStatus('Add a word or select text before saving.');
      return;
    }
    vscode.postMessage({
      type: 'saveWord',
      payload: {
        word: text,
        translation: wordTranslation.trim() || translationOutput.trim(),
        sentence: selectedText.trim(),
        note: wordNote.trim(),
        page: currentPage
      }
    });
    setWord('');
    setWordTranslation('');
    setWordNote('');
    setStatus('Word saved.');
  }

  return (
    <main className="shell">
      <section className="reader">
        <div className="reader-toolbar">
          <button title="Previous page" onClick={() => goToPage(currentPage - 1)}>Prev</button>
          <label className="page-jump">
            <span>Page</span>
            <input
              type="number"
              min={1}
              max={pageTotal || undefined}
              value={currentPage}
              onChange={event => setCurrentPage(Number(event.target.value) || 1)}
              onBlur={() => goToPage(currentPage)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  goToPage(currentPage);
                }
              }}
            />
            <span>/ {pageTotal || '-'}</span>
          </label>
          <button title="Next page" onClick={() => goToPage(currentPage + 1)}>Next</button>
          <button title="Zoom out" onClick={() => setZoom(value => clampZoom(typeof value === 'number' ? value - 0.15 : 0.85))}>-</button>
          <span className="zoom-value">{zoomLabel(zoom)}</span>
          <button title="Zoom in" onClick={() => setZoom(value => clampZoom(typeof value === 'number' ? value + 0.15 : 1.15))}>+</button>
          <button title="Fit full page" onClick={() => setZoom('page-fit')}>Fit</button>
          <button title="Fit page width" onClick={() => setZoom('page-width')}>Width</button>
          <span className="reader-status">{status}</span>
        </div>
        <div className="pdf-host">
          <PdfLoader
            document={readerConfig.pdfUrl}
            beforeLoad={progress => <div className="loading">Loading PDF {progress.loaded ? `${Math.round(progress.loaded / 1024)} KB` : ''}</div>}
            errorMessage={error => <div className="loading error">Could not load PDF: {error.message}</div>}
            onError={error => setStatus(`Could not load PDF: ${error.message}`)}
          >
            {pdfDocument => (
              <PdfDocumentView
                activeId={activeId}
                highlights={highlights}
                pdfDocument={pdfDocument}
                zoom={zoom}
                onDelete={deleteAnnotation}
                onDocumentReady={handleDocumentReady}
                onOpen={editAnnotation}
                onSelection={handleSelection}
                onStyleChange={handleStyleChange}
                utilsRef={utils => {
                  highlighterRef.current = utils;
                }}
              />
            )}
          </PdfLoader>
        </div>
      </section>
      <aside className="side-panel">
        <header>
          <p className="eyebrow">Reading Extension</p>
          <h1>{state.paperName || readerConfig.paperName}</h1>
        </header>

        <section className="tool-block">
          <label htmlFor="selectedText">Selected text</label>
          <textarea id="selectedText" rows={6} value={selectedText} onChange={event => setSelectedText(event.target.value)} placeholder="Select paper text or paste text here." />
          <div className="actions">
            <button onClick={() => vscode.postMessage({ type: 'translate', payload: { text: selectedText } })}>Translate locally</button>
            <button onClick={() => vscode.postMessage({ type: 'copyPrompt', payload: { text: selectedText } })}>Copy ChatGPT prompt</button>
          </div>
          <textarea rows={5} value={translationOutput} onChange={event => setTranslationOutput(event.target.value)} placeholder="Local translation will appear here." />
        </section>

        <section className="tool-block">
          <h2>Annotation</h2>
          {editingId ? <div className="edit-status">Editing annotation - autosaves changes</div> : null}
          <label htmlFor="annotationColor">Highlight color</label>
          <select id="annotationColor" value={color} onChange={event => setColor(event.target.value)}>
            {colorOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label htmlFor="annotationKind">Annotation style</label>
          <select id="annotationKind" value={kind} onChange={event => setKind(event.target.value as AnnotationKind)}>
            <option value="highlight">Highlight</option>
            <option value="underline">Underline</option>
          </select>
          <label htmlFor="annotationTags">Tags</label>
          <input id="annotationTags" value={tags} onChange={event => setTags(event.target.value)} placeholder="method, question, todo" />
          <textarea rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="Your annotation" />
          <div className="actions">
            <button onClick={saveAnnotation}>{editingId ? 'Save now' : 'Save annotation'}</button>
            {editingId ? <button className="secondary-button" onClick={clearAnnotationDraft}>Cancel edit</button> : null}
          </div>
        </section>

        <section className="tool-block">
          <h2>Wordbook</h2>
          <input value={word} onChange={event => setWord(event.target.value)} placeholder="Word or phrase" />
          <input value={wordTranslation} onChange={event => setWordTranslation(event.target.value)} placeholder="Translation" />
          <textarea rows={3} value={wordNote} onChange={event => setWordNote(event.target.value)} placeholder="Definition, memory note, or context" />
          <button onClick={saveWord}>Save word</button>
        </section>

        <section className="tool-block list-block">
          <h2>Due today</h2>
          {dueWords.length ? dueWords.map(item => (
            <WordItem key={item.id} word={item} showReview />
          )) : <div className="empty">No words due today.</div>}
        </section>

        <section className="tool-block list-block">
          <h2>Saved annotations</h2>
          <input type="search" value={annotationQuery} onChange={event => setAnnotationQuery(event.target.value)} placeholder="Search annotations" />
          <input type="search" value={tagQuery} onChange={event => setTagQuery(event.target.value)} placeholder="Filter by tag" />
          <select value={colorFilter} onChange={event => setColorFilter(event.target.value)}>
            <option value="">All colors</option>
            {colorOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
            <option value="">All styles</option>
            <option value="highlight">Highlight</option>
            <option value="underline">Underline</option>
          </select>
          <select value={sortMode} onChange={event => setSortMode(event.target.value)}>
            <option value="position">Sort by paper order</option>
            <option value="created">Sort by newest</option>
            <option value="updated">Sort by recently edited</option>
          </select>
          <div className="actions">
            <button onClick={() => vscode.postMessage({ type: 'exportAnnotations' })}>Export Markdown</button>
            <button onClick={() => vscode.postMessage({ type: 'exportAnnotatedPdf' })}>Export PDF</button>
          </div>
          {lastDeleted ? <button className="undo-button" onClick={restoreLastDeleted}>Undo delete</button> : null}
          <div className="status-line">{annotationStatus(filteredAnnotations.length, state.annotations.length)}</div>
          <AnnotationSummary annotations={filteredAnnotations} />
          <div className="list">
            {filteredAnnotations.length ? filteredAnnotations.map(annotation => (
              <AnnotationItem
                key={annotation.id}
                annotation={annotation}
                active={annotation.id === activeId}
                onFocus={() => focusAnnotation(annotation)}
                onEdit={() => editAnnotation(annotation)}
                onCopy={() => vscode.postMessage({ type: 'copyAnnotationMarkdown', payload: { id: annotation.id } })}
                onDelete={() => deleteAnnotation(annotation)}
              />
            )) : <div className="empty">No annotations saved yet.</div>}
          </div>
        </section>

        <section className="tool-block list-block">
          <h2>Wordbook</h2>
          {state.words.length ? state.words.map(item => <WordItem key={item.id} word={item} />) : <div className="empty">No words saved yet.</div>}
        </section>
      </aside>
    </main>
  );
}

function PdfDocumentView({
  activeId,
  highlights,
  pdfDocument,
  zoom,
  onDelete,
  onDocumentReady,
  onOpen,
  onSelection,
  onStyleChange,
  utilsRef
}: {
  activeId?: string;
  highlights: ReaderHighlight[];
  pdfDocument: { numPages: number };
  zoom: PdfScaleValue;
  onDelete(annotation: AnnotationRecord): void;
  onDocumentReady(numPages: number): void;
  onOpen(annotation: AnnotationRecord): void;
  onSelection(selection: PdfSelection): void;
  onStyleChange(annotation: AnnotationRecord, color: string, kind: AnnotationKind): void;
  utilsRef(utils: PdfHighlighterUtils): void;
}) {
  useEffect(() => {
    onDocumentReady(pdfDocument.numPages);
  }, [onDocumentReady, pdfDocument.numPages]);

  return (
    <PdfHighlighter
      pdfDocument={pdfDocument as never}
      highlights={highlights}
      onSelection={onSelection}
      enableAreaSelection={event => event.altKey}
      pdfScaleValue={zoom}
      textSelectionColor="rgba(64, 141, 255, 0.28)"
      utilsRef={utilsRef}
      style={{ height: '100%' }}
    >
      <HighlightContainer
        activeId={activeId}
        onDelete={onDelete}
        onOpen={onOpen}
        onStyleChange={onStyleChange}
      />
    </PdfHighlighter>
  );
}

function HighlightContainer({
  activeId,
  onOpen,
  onStyleChange,
  onDelete
}: {
  activeId?: string;
  onOpen(annotation: AnnotationRecord): void;
  onStyleChange(annotation: AnnotationRecord, color: string, kind: AnnotationKind): void;
  onDelete(annotation: AnnotationRecord): void;
}) {
  const { highlight, isScrolledTo, highlightBindings } = useHighlightContainerContext<ReaderHighlight>();
  const annotation = highlight.annotation;
  const activeClass = annotation?.id === activeId ? ' active-highlight' : '';

  if (!annotation) {
    if (highlight.type === 'area') {
      return (
        <AreaHighlight
          highlight={highlight}
          isScrolledTo={isScrolledTo}
          bounds={highlightBindings.textLayer}
          highlightColor="#ffd654"
        />
      );
    }

    return (
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        highlightColor="#ffd654"
        copyText={highlight.content?.text}
      />
    );
  }

  if (highlight.type === 'area') {
    return (
      <AreaHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        bounds={highlightBindings.textLayer}
        highlightColor={annotation.color || '#ffd654'}
        onDelete={() => onDelete(annotation)}
      />
    );
  }

  return (
    <span className={activeClass}>
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        highlightColor={annotation.color || '#ffd654'}
        highlightStyle={(annotation.kind || 'highlight') === 'underline' ? 'underline' : 'highlight'}
        copyText={annotation.selectedText}
        onClick={() => onOpen(annotation)}
        onDelete={() => onDelete(annotation)}
        onStyleChange={style => {
          onStyleChange(
            annotation,
            style.highlightColor || annotation.color || '#ffd654',
            style.highlightStyle === 'underline' ? 'underline' : 'highlight'
          );
        }}
      />
    </span>
  );
}

function AnnotationItem({
  annotation,
  active,
  onFocus,
  onEdit,
  onCopy,
  onDelete
}: {
  annotation: AnnotationRecord;
  active: boolean;
  onFocus(): void;
  onEdit(): void;
  onCopy(): void;
  onDelete(): void;
}) {
  return (
    <article className={`item annotation-item${active ? ' active-item' : ''}`} onClick={onFocus}>
      <strong>Page {annotation.page || annotation.highlighterPosition?.boundingRect.pageNumber || '-'}</strong>
      <p>{shorten(annotation.selectedText || annotation.note || 'Page note', 220)}</p>
      {annotation.note ? <p className="note">{shorten(annotation.note, 180)}</p> : null}
      {annotation.tags?.length ? <div className="annotation-tags">{annotation.tags.map(tag => <span key={tag}>#{tag}</span>)}</div> : null}
      <div className="annotation-actions">
        <button onClick={stopThen(onFocus)}>Jump</button>
        <button onClick={stopThen(onEdit)}>Edit</button>
        <button onClick={stopThen(onCopy)}>Copy MD</button>
        <button onClick={stopThen(onDelete)}>Delete</button>
      </div>
    </article>
  );
}

function AnnotationSummary({ annotations }: { annotations: AnnotationRecord[] }) {
  if (!annotations.length) {
    return null;
  }
  const highlights = annotations.filter(item => (item.kind || 'highlight') === 'highlight').length;
  const underlines = annotations.filter(item => item.kind === 'underline').length;
  const tagCount = new Map<string, number>();
  annotations.forEach(item => (item.tags || []).forEach(tag => tagCount.set(tag, (tagCount.get(tag) || 0) + 1)));
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <div className="annotation-summary">
      <span>{highlights} highlights</span>
      <span>{underlines} underlines</span>
      {topTags.map(([tag, count]) => <span key={tag}>#{tag} {count}</span>)}
    </div>
  );
}

function WordItem({ word, showReview = false }: { word: WordRecord; showReview?: boolean }) {
  return (
    <article className="item">
      <strong>{word.word}</strong>
      {word.translation ? <p>{word.translation}</p> : null}
      {word.note ? <p className="note">{word.note}</p> : null}
      {showReview ? (
        <div className="annotation-actions">
          <button onClick={() => vscode.postMessage({ type: 'reviewWord', payload: { id: word.id, remembered: true } })}>Remembered</button>
          <button onClick={() => vscode.postMessage({ type: 'reviewWord', payload: { id: word.id, remembered: false } })}>Again</button>
        </div>
      ) : null}
    </article>
  );
}

function annotationToHighlight(annotation: AnnotationRecord): ReaderHighlight | undefined {
  const position = annotation.highlighterPosition || rectsToHighlighterPosition(annotation.rects);
  if (!position) {
    return undefined;
  }
  return {
    id: annotation.id,
    type: annotation.selectedText ? 'text' : 'area',
    content: { text: annotation.selectedText || annotation.note },
    position,
    annotation
  };
}

function highlighterPositionToRects(position: ScaledPosition): AnnotationRect[] {
  const rects = position.rects.length ? position.rects : [position.boundingRect];
  return rects.map(rect => ({
    page: rect.pageNumber,
    x: safeRatio(rect.x1, rect.width),
    y: safeRatio(rect.y1, rect.height),
    width: safeRatio(rect.x2 - rect.x1, rect.width),
    height: safeRatio(rect.y2 - rect.y1, rect.height)
  }));
}

function rectsToHighlighterPosition(rects?: AnnotationRect[]): ScaledPosition | undefined {
  if (!rects?.length) {
    return undefined;
  }
  const scaledRects = rects.map(rect => ({
    x1: rect.x,
    y1: rect.y,
    x2: rect.x + rect.width,
    y2: rect.y + rect.height,
    width: 1,
    height: 1,
    pageNumber: rect.page
  }));
  const firstPage = scaledRects[0].pageNumber;
  const samePageRects = scaledRects.filter(rect => rect.pageNumber === firstPage);
  return {
    boundingRect: {
      x1: Math.min(...samePageRects.map(rect => rect.x1)),
      y1: Math.min(...samePageRects.map(rect => rect.y1)),
      x2: Math.max(...samePageRects.map(rect => rect.x2)),
      y2: Math.max(...samePageRects.map(rect => rect.y2)),
      width: 1,
      height: 1,
      pageNumber: firstPage
    },
    rects: samePageRects
  };
}

function compareAnnotations(a: AnnotationRecord, b: AnnotationRecord, mode: string) {
  if (mode === 'created') {
    return dateValue(b.createdAt) - dateValue(a.createdAt);
  }
  if (mode === 'updated') {
    return dateValue(b.updatedAt) - dateValue(a.updatedAt);
  }
  const aPos = annotationPosition(a);
  const bPos = annotationPosition(b);
  return aPos.page - bPos.page || aPos.y - bPos.y || aPos.x - bPos.x || dateValue(a.createdAt) - dateValue(b.createdAt);
}

function annotationPosition(annotation: AnnotationRecord) {
  const rect = annotation.rects?.[0];
  const highlighterRect = annotation.highlighterPosition?.boundingRect;
  return {
    page: rect?.page || highlighterRect?.pageNumber || annotation.page || Number.MAX_SAFE_INTEGER,
    y: rect?.y ?? (highlighterRect ? safeRatio(highlighterRect.y1, highlighterRect.height) : Number.MAX_SAFE_INTEGER),
    x: rect?.x ?? (highlighterRect ? safeRatio(highlighterRect.x1, highlighterRect.width) : Number.MAX_SAFE_INTEGER)
  };
}

function normalizeTags(value: string | string[]) {
  const raw = Array.isArray(value) ? value : value.split(/[,\s#]+/);
  return [...new Set(raw.map(tag => tag.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
}

function annotationStatus(shown: number, total: number) {
  if (!total) {
    return '0 annotations';
  }
  return shown === total ? `${total} annotation${total === 1 ? '' : 's'}` : `${shown} of ${total} annotations`;
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, 0.5), 2.4);
}

function zoomLabel(value: PdfScaleValue) {
  if (typeof value === 'number') {
    return `${Math.round(value * 100)}%`;
  }
  if (value === 'page-fit') {
    return 'Fit';
  }
  if (value === 'page-width') {
    return 'Width';
  }
  if (value === 'page-actual') {
    return '100%';
  }
  return value;
}

function safeRatio(value: number, total: number) {
  return total ? value / total : 0;
}

function dateValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function shorten(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function stopThen(callback: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation();
    callback();
  };
}

function Bootstrap() {
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      setError(event.message || String(event.error || 'Unknown Webview error'));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      setError(event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unhandled promise rejection'));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  if (error) {
    return (
      <main className="fatal-error">
        <h1>Reader failed to start</h1>
        <pre>{error}</pre>
      </main>
    );
  }

  return <App />;
}

createRoot(document.getElementById('root')!).render(<Bootstrap />);
