const vscode = acquireVsCodeApi();
const config = window.readerConfig;
const pdfjsLib = await import(config.pdfJsUrl);

pdfjsLib.GlobalWorkerOptions.workerSrc = config.pdfWorkerUrl;

const viewer = document.getElementById('pdfViewer');
const selectedText = document.getElementById('selectedText');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const annotationColor = document.getElementById('annotationColor');
const annotationKind = document.getElementById('annotationKind');
const annotationTags = document.getElementById('annotationTags');
const annotationEditStatus = document.getElementById('annotationEditStatus');
const saveAnnotationButton = document.getElementById('saveAnnotation');
const cancelAnnotationEditButton = document.getElementById('cancelAnnotationEdit');
const noteInput = document.getElementById('noteInput');
const wordInput = document.getElementById('wordInput');
const translationInput = document.getElementById('translationInput');
const translationOutput = document.getElementById('translationOutput');
const wordNoteInput = document.getElementById('wordNoteInput');
const annotationSearch = document.getElementById('annotationSearch');
const annotationTagFilter = document.getElementById('annotationTagFilter');
const annotationColorFilter = document.getElementById('annotationColorFilter');
const annotationKindFilter = document.getElementById('annotationKindFilter');
const annotationSort = document.getElementById('annotationSort');
const annotationExportStatus = document.getElementById('annotationExportStatus');
const annotationListStatus = document.getElementById('annotationListStatus');
const annotationSummary = document.getElementById('annotationSummary');
const annotationsList = document.getElementById('annotationsList');
const dueWordsList = document.getElementById('dueWordsList');
const wordsList = document.getElementById('wordsList');
const readerStatus = document.getElementById('readerStatus');
const zoomValue = document.getElementById('zoomValue');

let pdfDoc;
let scale = 1.25;
let currentPage = 1;
let state = { annotations: [], words: [], progress: {} };
let latestSelectionRects = [];
let latestSelectionContext = {};
let pageObserver;
let renderObserver;
let restoredProgress = false;
let editingAnnotationId;
let activeAnnotationId;
let annotationAutoSaveTimer;
let annotationStatusTimer;
let annotationPreviewEl;
let lastDeletedAnnotation;
let lastAutoSavedAnnotationSnapshot = '';
let renderGeneration = 0;
const renderedPages = new Set();
const renderingPages = new Set();
const queuedPages = new Set();
const renderQueue = [];
const maxConcurrentPageRenders = 2;
let activeRenderCount = 0;

bindUi();
loadPdf();
vscode.postMessage({ type: 'ready' });

function bindUi() {
  document.getElementById('translateLocal').addEventListener('click', () => {
    const text = selectedText.value.trim();
    if (!text) {
      selectedText.focus();
      return;
    }
    translationOutput.value = 'Translating with local LibreTranslate...';
    vscode.postMessage({ type: 'translate', payload: { text } });
  });

  document.getElementById('copyPrompt').addEventListener('click', () => {
    const text = selectedText.value.trim();
    if (!text) {
      selectedText.focus();
      return;
    }
    vscode.postMessage({ type: 'copyPrompt', payload: { text } });
  });

  saveAnnotationButton.addEventListener('click', () => {
    const payload = readAnnotationEditorPayload();
    if (!payload.selectedText && !payload.note) {
      noteInput.focus();
      return;
    }

    if (editingAnnotationId) {
      cancelPendingAnnotationAutoSave();
      vscode.postMessage({
        type: 'updateAnnotation',
        payload: {
          id: editingAnnotationId,
          patch: payload
        }
      });
      clearAnnotationEditor();
      return;
    }

    vscode.postMessage({
      type: 'saveAnnotation',
      payload
    });
    noteInput.value = '';
  });

  cancelAnnotationEditButton.addEventListener('click', clearAnnotationEditor);

  document.getElementById('saveWord').addEventListener('click', () => {
    const word = wordInput.value.trim();
    if (!word) {
      wordInput.focus();
      return;
    }
    vscode.postMessage({
      type: 'saveWord',
      payload: {
        word,
        translation: translationInput.value.trim(),
        sentence: selectedText.value.trim(),
        note: wordNoteInput.value.trim(),
        page: readPage()
      }
    });
    wordInput.value = '';
    translationInput.value = '';
    wordNoteInput.value = '';
  });

  pageInput.addEventListener('change', () => {
    goToPage(readPage() || currentPage);
    scheduleEditedAnnotationAutoSave();
  });

  document.getElementById('prevPage').addEventListener('click', () => {
    goToPage(Math.max(1, currentPage - 1));
  });

  document.getElementById('nextPage').addEventListener('click', () => {
    goToPage(Math.min(pdfDoc?.numPages || currentPage, currentPage + 1));
  });

  document.getElementById('zoomOut').addEventListener('click', () => {
    setScale(Math.max(0.75, scale - 0.15));
  });

  document.getElementById('zoomIn').addEventListener('click', () => {
    setScale(Math.min(2.5, scale + 0.15));
  });

  selectedText.addEventListener('input', () => {
    if (!editingAnnotationId) {
      latestSelectionRects = [];
      latestSelectionContext = {};
    }
    scheduleEditedAnnotationAutoSave();
  });

  noteInput.addEventListener('input', scheduleEditedAnnotationAutoSave);
  annotationTags.addEventListener('input', scheduleEditedAnnotationAutoSave);
  annotationColor.addEventListener('change', scheduleEditedAnnotationAutoSave);
  annotationKind.addEventListener('change', scheduleEditedAnnotationAutoSave);

  document.addEventListener('selectionchange', captureSelection);
  viewer.addEventListener('scroll', hideAnnotationPreview);
  window.addEventListener('resize', hideAnnotationPreview);

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'translationResult') {
      showTranslationResult(message.payload);
      return;
    }
    if (message.type === 'exportResult') {
      showExportResult(message.payload);
      return;
    }
    if (message.type === 'clipboardResult') {
      showClipboardResult(message.payload);
      return;
    }
    if (message.type === 'annotationActionResult') {
      showAnnotationActionResult(message.payload);
      return;
    }
    if (message.type !== 'state') {
      return;
    }

    state = message.payload;
    renderAnnotationsList(state.annotations || []);
    renderDueWords(state.words || []);
    renderWords(state.words || []);
    restoreProgress(state.progress?.page);
    renderAnnotationOverlays();
  });

  dueWordsList.addEventListener('click', event => {
    const button = event.target.closest('button[data-review]');
    if (!button) {
      return;
    }
    vscode.postMessage({
      type: 'reviewWord',
      payload: {
        id: button.dataset.wordId,
        remembered: button.dataset.review === 'remembered'
      }
    });
  });

  annotationSearch.addEventListener('input', () => {
    renderAnnotationsList(state.annotations || []);
  });

  annotationTagFilter.addEventListener('input', () => {
    renderAnnotationsList(state.annotations || []);
  });

  annotationColorFilter.addEventListener('change', () => {
    renderAnnotationsList(state.annotations || []);
  });

  annotationKindFilter.addEventListener('change', () => {
    renderAnnotationsList(state.annotations || []);
  });

  annotationSort.addEventListener('change', () => {
    renderAnnotationsList(state.annotations || []);
  });

  annotationExportStatus.addEventListener('click', event => {
    const button = event.target.closest('button[data-status-action]');
    if (button?.dataset.statusAction === 'undoDelete') {
      undoDeleteAnnotation();
    }
  });

  document.getElementById('exportAnnotations').addEventListener('click', () => {
    annotationExportStatus.textContent = 'Exporting annotation Markdown...';
    vscode.postMessage({ type: 'exportAnnotations' });
  });

  document.getElementById('exportAnnotatedPdf').addEventListener('click', () => {
    annotationExportStatus.textContent = 'Exporting annotated PDF...';
    vscode.postMessage({ type: 'exportAnnotatedPdf' });
  });

  annotationsList.addEventListener('click', event => {
    const button = event.target.closest('button[data-annotation-action]');
    const item = event.target.closest('[data-annotation-id]');
    if (!item) {
      return;
    }

    const annotation = findAnnotation(item.dataset.annotationId);
    if (!annotation) {
      return;
    }

    if (button?.dataset.annotationAction === 'edit') {
      editAnnotation(annotation);
      return;
    }
    if (button?.dataset.annotationAction === 'delete') {
      deleteAnnotation(annotation);
      return;
    }
    if (button?.dataset.annotationAction === 'copyMarkdown') {
      copyAnnotationMarkdown(annotation);
      return;
    }

    focusAnnotation(annotation);
  });
}

async function loadPdf() {
  try {
    readerStatus.textContent = 'Loading PDF...';
    const loadingTask = pdfjsLib.getDocument({
      url: config.pdfUrl,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true
    });
    pdfDoc = await loadingTask.promise;
    pageTotal.textContent = `/ ${pdfDoc.numPages}`;
    currentPage = clampPage(currentPage);
    pageInput.max = String(pdfDoc.numPages);
    await renderPdf();
    goToPage(currentPage, { smooth: false });
    readerStatus.textContent = 'Ready';
  } catch (error) {
    console.error('PDF URL load failed, retrying with fetched bytes.', error);
    await loadPdfFromBytes(error);
  }
}

async function loadPdfFromBytes(originalError) {
  try {
    readerStatus.textContent = 'Retrying PDF load...';
    const response = await fetch(config.pdfUrl);
    if (!response.ok) {
      throw new Error(`PDF fetch returned HTTP ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfDoc = await loadingTask.promise;
    pageTotal.textContent = `/ ${pdfDoc.numPages}`;
    currentPage = clampPage(currentPage);
    pageInput.max = String(pdfDoc.numPages);
    await renderPdf();
    goToPage(currentPage, { smooth: false });
    readerStatus.textContent = 'Ready';
  } catch (error) {
    console.error('PDF byte fallback failed.', error);
    readerStatus.textContent = `Could not load PDF: ${formatErrorMessage(error || originalError)}`;
  }
}

async function renderPdf() {
  disconnectObserver();
  disconnectRenderObserver();
  renderGeneration += 1;
  renderedPages.clear();
  renderingPages.clear();
  queuedPages.clear();
  renderQueue.length = 0;
  viewer.innerHTML = '';
  zoomValue.textContent = `${Math.round((scale / 1.25) * 100)}%`;

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    readerStatus.textContent = `Preparing page ${pageNumber} / ${pdfDoc.numPages}`;
    await createPageShell(pageNumber);
  }

  renderAnnotationOverlays();
  observePageRendering();
  observePages();
  renderVisiblePages();
}

async function createPageShell(pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const pageEl = document.createElement('article');
  const canvas = document.createElement('canvas');
  const textLayer = document.createElement('div');
  const annotationLayer = document.createElement('div');

  pageEl.className = 'pdf-page pending-page';
  pageEl.dataset.page = String(pageNumber);
  pageEl.style.width = `${viewport.width}px`;
  pageEl.style.height = `${viewport.height}px`;

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  textLayer.className = 'text-layer';
  annotationLayer.className = 'annotation-layer';

  pageEl.append(canvas, textLayer, annotationLayer);
  viewer.appendChild(pageEl);
}

function renderPageContent(pageEl, generation = renderGeneration, priority = false) {
  const pageNumber = Number(pageEl.dataset.page);
  if (
    !pageNumber ||
    renderedPages.has(pageNumber) ||
    renderingPages.has(pageNumber) ||
    queuedPages.has(pageNumber)
  ) {
    return;
  }

  queuedPages.add(pageNumber);
  const item = { pageEl, pageNumber, generation };
  if (priority) {
    renderQueue.unshift(item);
  } else {
    renderQueue.push(item);
  }
  processRenderQueue();
}

function processRenderQueue() {
  while (activeRenderCount < maxConcurrentPageRenders && renderQueue.length) {
    const item = renderQueue.shift();
    queuedPages.delete(item.pageNumber);
    activeRenderCount += 1;
    renderPageContentNow(item.pageEl, item.generation).finally(() => {
      activeRenderCount -= 1;
      processRenderQueue();
    });
  }
}

async function renderPageContentNow(pageEl, generation) {
  const pageNumber = Number(pageEl.dataset.page);
  if (!pageNumber || renderedPages.has(pageNumber) || renderingPages.has(pageNumber)) {
    return;
  }

  renderingPages.add(pageNumber);
  pageEl.classList.remove('pending-page');
  pageEl.classList.add('rendering');
  readerStatus.textContent = `Rendering page ${pageNumber} / ${pdfDoc.numPages}`;

  try {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = pageEl.querySelector('canvas');
    const textLayer = pageEl.querySelector('.text-layer');

    if (generation !== renderGeneration || !canvas || !textLayer) {
      return;
    }

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    textLayer.innerHTML = '';

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport
    }).promise;

    if (generation !== renderGeneration) {
      return;
    }

    await renderTextLayer(page, viewport, textLayer);
    renderedPages.add(pageNumber);
    pageEl.classList.remove('rendering');
    pageEl.classList.add('rendered');
    readerStatus.textContent = `Ready · rendered ${renderedPages.size} / ${pdfDoc.numPages}`;
  } catch (error) {
    console.error(error);
    readerStatus.textContent = `Could not render page ${pageNumber}`;
  } finally {
    renderingPages.delete(pageNumber);
  }
}

async function renderTextLayer(page, viewport, textLayer) {
  const textContent = await page.getTextContent();
  const styles = textContent.styles || {};

  for (const item of textContent.items) {
    if (!item.str) {
      continue;
    }

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const style = styles[item.fontName] || {};
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.fontFamily = style.fontFamily || 'sans-serif';
    span.style.transform = `matrix(${tx.map(value => Number(value).toFixed(4)).join(',')})`;
    span.style.width = `${Math.max(1, item.width * scale)}px`;
    span.style.height = `${Math.max(1, item.height * scale)}px`;
    textLayer.appendChild(span);
  }
}

function captureSelection() {
  const selection = window.getSelection();
  const text = selection?.toString().trim() || '';
  if (!selection || !selection.anchorNode || !text || !viewer.contains(selection.anchorNode)) {
    return;
  }

  selectedText.value = text;
  latestSelectionRects = getSelectionRects(selection);
  latestSelectionContext = getSelectionContext(text, latestSelectionRects[0]?.page);
  const firstPage = latestSelectionRects[0]?.page;
  if (firstPage) {
    setCurrentPage(firstPage);
  }
}

function getSelectionRects(selection) {
  const rects = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    for (const rect of range.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }

      const pageEl = elementFromRect(rect)?.closest?.('.pdf-page');
      if (!pageEl) {
        continue;
      }

      const pageRect = pageEl.getBoundingClientRect();
      rects.push({
        page: Number(pageEl.dataset.page),
        x: round((rect.left - pageRect.left) / pageRect.width),
        y: round((rect.top - pageRect.top) / pageRect.height),
        width: round(rect.width / pageRect.width),
        height: round(rect.height / pageRect.height)
      });
    }
  }
  return rects;
}

function getSelectionContext(selectedValue, pageNumber) {
  if (!pageNumber) {
    return {};
  }

  const pageEl = document.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
  const spans = [...(pageEl?.querySelectorAll('.text-layer span') || [])];
  const pageText = normalizeContextText(spans.map(span => span.textContent || '').join(' '));
  const selected = normalizeContextText(selectedValue);

  if (!pageText || !selected) {
    return {};
  }

  const index = pageText.toLowerCase().indexOf(selected.toLowerCase());
  if (index < 0) {
    return {};
  }

  const contextSize = 140;
  const before = pageText.slice(Math.max(0, index - contextSize), index).trim();
  const after = pageText.slice(index + selected.length, index + selected.length + contextSize).trim();
  return { before, after };
}

function normalizeContextText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function elementFromRect(rect) {
  return document.elementFromPoint(rect.left + Math.min(4, rect.width / 2), rect.top + Math.min(4, rect.height / 2));
}

function renderAnnotationOverlays() {
  hideAnnotationPreview();
  document.querySelectorAll('.annotation-layer').forEach(layer => {
    layer.innerHTML = '';
  });

  for (const annotation of state.annotations || []) {
    if (isPageNoteAnnotation(annotation)) {
      renderPageNoteMarker(annotation);
    }

    for (const rect of annotation.rects || []) {
      const pageEl = document.querySelector(`.pdf-page[data-page="${rect.page}"]`);
      const layer = pageEl?.querySelector('.annotation-layer');
      if (!pageEl || !layer) {
        continue;
      }

      const mark = document.createElement('div');
      const kind = annotation.kind || 'highlight';
      mark.className = `highlight ${kind === 'underline' ? 'underline-mark' : 'highlight-mark'}${annotation.id === activeAnnotationId ? ' active-highlight' : ''}`;
      mark.dataset.annotationId = annotation.id;
      mark.tabIndex = 0;
      mark.setAttribute('role', 'button');
      mark.setAttribute('aria-label', `Annotation on page ${rect.page}`);
      mark.title = annotation.note || annotation.selectedText || 'Annotation';
      if (kind === 'underline') {
        mark.style.color = annotation.color || '#ffd654';
        mark.style.background = 'transparent';
      } else {
        mark.style.background = colorWithAlpha(annotation.color || '#ffd654', 0.42);
      }
      mark.style.left = `${rect.x * 100}%`;
      mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
      mark.addEventListener('click', event => {
        event.stopPropagation();
        focusAnnotation(annotation, { scroll: false });
      });
      bindAnnotationPreview(mark, annotation);
      layer.appendChild(mark);
    }
  }
}

function renderPageNoteMarker(annotation) {
  const page = annotation.page || 1;
  const pageEl = document.querySelector(`.pdf-page[data-page="${page}"]`);
  const layer = pageEl?.querySelector('.annotation-layer');
  if (!pageEl || !layer) {
    return;
  }

  const pageNotes = (state.annotations || []).filter(item => isPageNoteAnnotation(item) && (item.page || 1) === page);
  const index = Math.max(0, pageNotes.findIndex(item => item.id === annotation.id));
  const marker = document.createElement('button');
  marker.className = `page-note-marker${annotation.id === activeAnnotationId ? ' active-note-marker' : ''}`;
  marker.dataset.annotationId = annotation.id;
  marker.type = 'button';
  marker.title = annotation.note || 'Page note';
  marker.textContent = 'N';
  marker.style.background = annotation.color || '#ffd654';
  marker.style.top = `${Math.min(88, 5 + index * 6)}%`;
  marker.addEventListener('click', event => {
    event.stopPropagation();
    focusAnnotation(annotation, { scroll: false });
  });
  bindAnnotationPreview(marker, annotation);
  layer.appendChild(marker);
}

function bindAnnotationPreview(anchor, annotation) {
  anchor.addEventListener('mouseenter', () => showAnnotationPreview(anchor, annotation));
  anchor.addEventListener('mouseleave', hideAnnotationPreview);
  anchor.addEventListener('focus', () => showAnnotationPreview(anchor, annotation));
  anchor.addEventListener('blur', hideAnnotationPreview);
}

function showAnnotationPreview(anchor, annotation) {
  if (!annotationPreviewEl) {
    annotationPreviewEl = document.createElement('aside');
    annotationPreviewEl.className = 'annotation-preview';
    document.body.appendChild(annotationPreviewEl);
  }

  annotationPreviewEl.innerHTML = renderAnnotationPreview(annotation);
  annotationPreviewEl.hidden = false;
  positionAnnotationPreview(anchor, annotationPreviewEl);
}

function hideAnnotationPreview() {
  if (annotationPreviewEl) {
    annotationPreviewEl.hidden = true;
  }
}

function positionAnnotationPreview(anchor, previewEl) {
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 10;
  const previewWidth = Math.min(340, Math.max(240, window.innerWidth - margin * 2));
  previewEl.style.width = `${previewWidth}px`;

  const topCandidate = anchorRect.bottom + margin;
  const measuredHeight = previewEl.offsetHeight || 160;
  const top = topCandidate + measuredHeight > window.innerHeight - margin
    ? Math.max(margin, anchorRect.top - measuredHeight - margin)
    : topCandidate;
  const left = Math.min(
    Math.max(margin, anchorRect.left),
    Math.max(margin, window.innerWidth - previewWidth - margin)
  );

  previewEl.style.top = `${top}px`;
  previewEl.style.left = `${left}px`;
}

function renderAnnotationPreview(annotation) {
  const title = `${annotation.page ? `Page ${annotation.page}` : 'Annotation'} · ${annotation.kind || 'highlight'}`;
  const primary = annotation.selectedText || annotation.note || 'Page note';
  const note = annotation.note && annotation.note !== primary ? `<p>${escapeHtml(annotation.note)}</p>` : '';

  return `
    <strong><span class="color-dot" style="background:${escapeHtml(annotation.color || '#ffd654')}"></span>${escapeHtml(title)}</strong>
    <p>${escapeHtml(primary)}</p>
    ${renderAnnotationContext(annotation)}
    ${note}
    ${renderTagChips(annotation.tags)}
  `;
}

function isPageNoteAnnotation(annotation) {
  return Boolean(annotation.note && annotation.page && !(annotation.rects || []).length);
}

function observePages() {
  pageObserver = new IntersectionObserver(entries => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    const page = Number(visible?.target?.dataset?.page);
    if (page) {
      setCurrentPage(page);
    }
  }, {
    root: viewer,
    threshold: [0.25, 0.5, 0.75]
  });

  document.querySelectorAll('.pdf-page').forEach(page => pageObserver.observe(page));
}

function observePageRendering() {
  renderObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        renderPageContent(entry.target);
      }
    }
  }, {
    root: viewer,
    rootMargin: '1200px 0px',
    threshold: 0.01
  });

  document.querySelectorAll('.pdf-page').forEach(page => renderObserver.observe(page));
}

function disconnectObserver() {
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = undefined;
  }
}

function disconnectRenderObserver() {
  if (renderObserver) {
    renderObserver.disconnect();
    renderObserver = undefined;
  }
}

function renderVisiblePages() {
  const viewerRect = viewer.getBoundingClientRect();
  document.querySelectorAll('.pdf-page').forEach(pageEl => {
    const rect = pageEl.getBoundingClientRect();
    const nearViewport = rect.bottom >= viewerRect.top - 1200 && rect.top <= viewerRect.bottom + 1200;
    if (nearViewport) {
      renderPageContent(pageEl);
    }
  });
}

function setScale(nextScale) {
  const page = currentPage;
  scale = nextScale;
  renderPdf().then(() => goToPage(page, { smooth: false }));
}

function goToPage(page, options = {}) {
  const nextPage = clampPage(page);
  const pageEl = document.querySelector(`.pdf-page[data-page="${nextPage}"]`);
  if (pageEl) {
    renderPageContent(pageEl, renderGeneration, true);
    pageEl.scrollIntoView({
      block: 'start',
      behavior: options.smooth === false ? 'auto' : 'smooth'
    });
  }
  setCurrentPage(nextPage);
}

function setCurrentPage(page) {
  if (!page || page === currentPage) {
    pageInput.value = String(currentPage);
    return;
  }
  currentPage = page;
  pageInput.value = String(currentPage);
  vscode.postMessage({
    type: 'saveProgress',
    payload: {
      page: currentPage,
      updatedAt: new Date().toISOString()
    }
  });
}

function restoreProgress(page) {
  if (!page || restoredProgress) {
    return;
  }

  restoredProgress = true;
  currentPage = clampPage(page);
  pageInput.value = String(currentPage);

  if (pdfDoc) {
    goToPage(currentPage, { smooth: false });
  }
}

function clampPage(page) {
  const max = pdfDoc?.numPages || page || 1;
  return Math.min(Math.max(1, Number(page) || 1), max);
}

function readPage() {
  return clampPage(Number(pageInput.value) || currentPage);
}

function renderAnnotationsList(items) {
  const filteredItems = filterAnnotations(items);
  const sortedItems = sortAnnotationsForDisplay(filteredItems);
  const visibleItems = sortedItems.slice(0, 50);
  annotationsList.innerHTML = '';
  annotationListStatus.textContent = formatAnnotationListStatus(
    visibleItems.length,
    sortedItems.length,
    items.length
  );
  renderAnnotationSummary(sortedItems);
  if (!sortedItems.length) {
    annotationsList.appendChild(emptyItem(items.length ? 'No matching annotations.' : 'No annotations saved yet.'));
    return;
  }

  for (const item of visibleItems) {
    const node = document.createElement('article');
    node.className = `item annotation-item${item.id === activeAnnotationId ? ' active-item' : ''}`;
    node.dataset.annotationId = item.id;
    node.innerHTML = `
      <strong><span class="color-dot" style="background:${escapeHtml(item.color || '#ffd654')}"></span>${escapeHtml(item.page ? `Page ${item.page}` : 'Annotation')} · ${escapeHtml(item.kind || 'highlight')}</strong>
      <p>${escapeHtml(item.selectedText || item.note || '')}</p>
      ${renderAnnotationContext(item)}
      ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}
      ${renderTagChips(item.tags)}
      <div class="annotation-actions">
        <button data-annotation-action="jump">Jump</button>
        <button data-annotation-action="edit">Edit</button>
        <button data-annotation-action="copyMarkdown">Copy MD</button>
        <button data-annotation-action="delete">Delete</button>
      </div>
    `;
    annotationsList.appendChild(node);
  }
}

function filterAnnotations(items) {
  const query = annotationSearch.value.trim().toLowerCase();
  const tagQuery = normalizeTags(annotationTagFilter.value);
  const color = annotationColorFilter.value;
  const kind = annotationKindFilter.value;

  return items.filter(item => {
    const tags = normalizeTags(item.tags || []);
    const matchesColor = !color || (item.color || '#ffd654') === color;
    if (!matchesColor) {
      return false;
    }
    if (kind && (item.kind || 'highlight') !== kind) {
      return false;
    }
    if (tagQuery.length && !tagQuery.every(tag => tags.includes(tag))) {
      return false;
    }
    if (!query) {
      return true;
    }

    const haystack = [
      item.selectedText,
      item.contextBefore,
      item.contextAfter,
      item.note,
      tags.join(' '),
      item.page ? `page ${item.page}` : ''
    ].join('\n').toLowerCase();
    return haystack.includes(query);
  });
}

function renderAnnotationSummary(items) {
  if (!items.length) {
    annotationSummary.innerHTML = '';
    return;
  }

  const styleCounts = countBy(items, item => item.kind || 'highlight');
  const colorCounts = countBy(items, item => colorName(item.color || '#ffd654'));
  const tagCounts = countTags(items);
  const chips = [
    ...summaryEntries(styleCounts, 'style'),
    ...summaryEntries(colorCounts, 'color'),
    ...summaryEntries(tagCounts, 'tag').slice(0, 6)
  ];

  annotationSummary.innerHTML = chips.map(chip => `
    <span class="summary-chip ${chip.type === 'tag' ? 'summary-tag' : ''}">
      ${escapeHtml(chip.label)} <strong>${chip.count}</strong>
    </span>
  `).join('');
}

function summaryEntries(counts, type) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ type, label, count }));
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function countTags(items) {
  return items.reduce((counts, item) => {
    for (const tag of normalizeTags(item.tags || [])) {
      counts[`#${tag}`] = (counts[`#${tag}`] || 0) + 1;
    }
    return counts;
  }, {});
}

function colorName(color) {
  const names = {
    '#ffd654': 'yellow',
    '#8fd3ff': 'blue',
    '#a6e99f': 'green',
    '#ffaaa5': 'red',
    '#d7b8ff': 'purple'
  };
  return names[color] || color;
}

function sortAnnotationsForDisplay(items) {
  const sortMode = annotationSort.value;
  return [...items].sort((a, b) => {
    if (sortMode === 'created') {
      return dateValue(b.createdAt) - dateValue(a.createdAt);
    }
    if (sortMode === 'updated') {
      return dateValue(b.updatedAt) - dateValue(a.updatedAt);
    }
    return compareAnnotationPosition(a, b);
  });
}

function compareAnnotationPosition(a, b) {
  const aPosition = getAnnotationPosition(a);
  const bPosition = getAnnotationPosition(b);

  if (aPosition.page !== bPosition.page) {
    return aPosition.page - bPosition.page;
  }
  if (aPosition.y !== bPosition.y) {
    return aPosition.y - bPosition.y;
  }
  if (aPosition.x !== bPosition.x) {
    return aPosition.x - bPosition.x;
  }
  return dateValue(a.createdAt) - dateValue(b.createdAt);
}

function getAnnotationPosition(annotation) {
  const firstRect = annotation.rects?.[0];
  return {
    page: firstRect?.page ?? annotation.page ?? Number.MAX_SAFE_INTEGER,
    y: firstRect?.y ?? Number.MAX_SAFE_INTEGER,
    x: firstRect?.x ?? Number.MAX_SAFE_INTEGER
  };
}

function formatAnnotationListStatus(shownCount, filteredCount, totalCount) {
  if (!totalCount) {
    return '0 annotations';
  }
  if (filteredCount !== totalCount) {
    return `${shownCount} shown, ${filteredCount} matching of ${totalCount} annotations`;
  }
  if (shownCount !== filteredCount) {
    return `${shownCount} shown of ${totalCount} annotations`;
  }
  if (totalCount === 1) {
    return '1 annotation';
  }
  if (filteredCount === totalCount) {
    return `${totalCount} annotation${totalCount === 1 ? '' : 's'}`;
  }
  return `${filteredCount} of ${totalCount} annotations`;
}

function focusAnnotation(annotation, options = {}) {
  activeAnnotationId = annotation.id;
  renderAnnotationsList(state.annotations || []);
  renderAnnotationOverlays();

  if (options.scroll === false) {
    return;
  }

  const firstRect = annotation.rects?.[0];
  if (firstRect) {
    goToPage(firstRect.page);
    requestAnimationFrame(() => scrollToRect(firstRect));
    return;
  }

  if (annotation.page) {
    goToPage(annotation.page);
    if (isPageNoteAnnotation(annotation)) {
      requestAnimationFrame(() => scrollToNoteMarker(annotation));
    }
  }
}

function editAnnotation(annotation) {
  cancelPendingAnnotationAutoSave();
  editingAnnotationId = annotation.id;
  activeAnnotationId = annotation.id;
  selectedText.value = annotation.selectedText || '';
  noteInput.value = annotation.note || '';
  annotationTags.value = (annotation.tags || []).join(', ');
  annotationColor.value = annotation.color || '#ffd654';
  annotationKind.value = annotation.kind || 'highlight';
  latestSelectionRects = annotation.rects || [];
  latestSelectionContext = {
    before: annotation.contextBefore || '',
    after: annotation.contextAfter || ''
  };
  if (annotation.page) {
    pageInput.value = String(annotation.page);
  }
  lastAutoSavedAnnotationSnapshot = snapshotAnnotationPayload(readAnnotationEditorPayload());
  setAnnotationEditStatus('Editing annotation · autosaves changes');
  cancelAnnotationEditButton.hidden = false;
  saveAnnotationButton.textContent = 'Update now';
  renderAnnotationsList(state.annotations || []);
  renderAnnotationOverlays();
  noteInput.focus();
}

function deleteAnnotation(annotation) {
  const label = annotation.selectedText || annotation.note || `Page ${annotation.page || ''}`;
  if (!confirm(`Delete this annotation?\n\n${label.slice(0, 160)}`)) {
    return;
  }

  if (editingAnnotationId === annotation.id) {
    clearAnnotationEditor();
  }
  lastDeletedAnnotation = annotation;
  vscode.postMessage({
    type: 'deleteAnnotation',
    payload: {
      id: annotation.id
    }
  });
  showUndoDeleteStatus(annotation);
}

function copyAnnotationMarkdown(annotation) {
  annotationExportStatus.textContent = 'Copying annotation Markdown...';
  vscode.postMessage({
    type: 'copyAnnotationMarkdown',
    payload: {
      id: annotation.id
    }
  });
}

function undoDeleteAnnotation() {
  if (!lastDeletedAnnotation) {
    return;
  }

  vscode.postMessage({
    type: 'restoreAnnotation',
    payload: lastDeletedAnnotation
  });
  lastDeletedAnnotation = undefined;
  annotationExportStatus.textContent = 'Restoring annotation...';
}

function showUndoDeleteStatus(annotation) {
  const label = annotation.selectedText || annotation.note || `Page ${annotation.page || ''}`;
  annotationExportStatus.innerHTML = `
    <span>Deleted: ${escapeHtml(label.slice(0, 80))}</span>
    <button class="inline-status-button" data-status-action="undoDelete">Undo</button>
  `;
}

function clearAnnotationEditor() {
  cancelPendingAnnotationAutoSave();
  editingAnnotationId = undefined;
  annotationEditStatus.hidden = true;
  cancelAnnotationEditButton.hidden = true;
  saveAnnotationButton.textContent = 'Save annotation';
  noteInput.value = '';
  annotationTags.value = '';
  latestSelectionContext = {};
  lastAutoSavedAnnotationSnapshot = '';
}

function readAnnotationEditorPayload() {
  return {
    page: readPage(),
    rects: latestSelectionRects,
    color: annotationColor.value,
    kind: annotationKind.value,
    tags: normalizeTags(annotationTags.value),
    contextBefore: latestSelectionContext.before || '',
    contextAfter: latestSelectionContext.after || '',
    selectedText: selectedText.value.trim(),
    note: noteInput.value.trim()
  };
}

function scheduleEditedAnnotationAutoSave() {
  if (!editingAnnotationId) {
    return;
  }

  const payload = readAnnotationEditorPayload();
  const snapshot = snapshotAnnotationPayload(payload);
  if (snapshot === lastAutoSavedAnnotationSnapshot) {
    return;
  }

  if (!payload.selectedText && !payload.note) {
    setAnnotationEditStatus('Editing annotation · add text or a note to autosave');
    return;
  }

  setAnnotationEditStatus('Editing annotation · autosaving...');
  clearTimeout(annotationAutoSaveTimer);
  annotationAutoSaveTimer = setTimeout(() => {
    autoSaveEditedAnnotation();
  }, 700);
}

function autoSaveEditedAnnotation() {
  if (!editingAnnotationId) {
    return;
  }

  const payload = readAnnotationEditorPayload();
  const snapshot = snapshotAnnotationPayload(payload);
  if (snapshot === lastAutoSavedAnnotationSnapshot || (!payload.selectedText && !payload.note)) {
    return;
  }

  lastAutoSavedAnnotationSnapshot = snapshot;
  vscode.postMessage({
    type: 'updateAnnotation',
    payload: {
      id: editingAnnotationId,
      patch: payload
    }
  });
  showTemporaryAnnotationStatus('Editing annotation · saved automatically');
}

function cancelPendingAnnotationAutoSave() {
  clearTimeout(annotationAutoSaveTimer);
  clearTimeout(annotationStatusTimer);
}

function showTemporaryAnnotationStatus(text) {
  setAnnotationEditStatus(text);
  clearTimeout(annotationStatusTimer);
  annotationStatusTimer = setTimeout(() => {
    if (editingAnnotationId) {
      setAnnotationEditStatus('Editing annotation · autosaves changes');
    }
  }, 1800);
}

function setAnnotationEditStatus(text) {
  annotationEditStatus.textContent = text;
  annotationEditStatus.hidden = false;
}

function snapshotAnnotationPayload(payload) {
  return JSON.stringify({
    page: payload.page,
    rects: payload.rects || [],
    color: payload.color,
    kind: payload.kind,
    tags: payload.tags || [],
    contextBefore: payload.contextBefore,
    contextAfter: payload.contextAfter,
    selectedText: payload.selectedText,
    note: payload.note
  });
}

function scrollToRect(rect) {
  const pageEl = document.querySelector(`.pdf-page[data-page="${rect.page}"]`);
  if (!pageEl) {
    return;
  }

  const top = pageEl.offsetTop + rect.y * pageEl.offsetHeight - 80;
  viewer.scrollTo({
    top: Math.max(0, top),
    behavior: 'smooth'
  });
}

function scrollToNoteMarker(annotation) {
  const pageEl = document.querySelector(`.pdf-page[data-page="${annotation.page || 1}"]`);
  const marker = pageEl?.querySelector(`.page-note-marker[data-annotation-id="${annotation.id}"]`);
  if (!pageEl || !marker) {
    return;
  }

  viewer.scrollTo({
    top: Math.max(0, pageEl.offsetTop + marker.offsetTop - 80),
    behavior: 'smooth'
  });
}

function findAnnotation(id) {
  return (state.annotations || []).find(item => item.id === id);
}

function renderDueWords(items) {
  const dueItems = items.filter(isDueForReview);
  dueWordsList.innerHTML = '';
  if (!dueItems.length) {
    dueWordsList.appendChild(emptyItem('No words due today.'));
    return;
  }

  for (const item of dueItems.slice(0, 8)) {
    const node = document.createElement('article');
    node.className = 'item review-item';
    node.innerHTML = `
      <strong>${escapeHtml(item.word)}${item.translation ? ` - ${escapeHtml(item.translation)}` : ''}</strong>
      <p>${escapeHtml(item.sentence || item.note || '')}</p>
      <div class="review-actions">
        <button data-review="again" data-word-id="${escapeHtml(item.id)}">Again</button>
        <button data-review="remembered" data-word-id="${escapeHtml(item.id)}">Remembered</button>
      </div>
    `;
    dueWordsList.appendChild(node);
  }
}

function renderWords(items) {
  wordsList.innerHTML = '';
  if (!items.length) {
    wordsList.appendChild(emptyItem('No words saved yet.'));
    return;
  }

  for (const item of items.slice(0, 20)) {
    const review = item.review || {};
    const node = document.createElement('article');
    node.className = 'item';
    node.innerHTML = `
      <strong>${escapeHtml(item.word)}${item.translation ? ` - ${escapeHtml(item.translation)}` : ''}</strong>
      <p>${escapeHtml(item.note || item.sentence || '')}</p>
      <p>${escapeHtml(formatReviewStatus(review))}</p>
    `;
    wordsList.appendChild(node);
  }
}

function showTranslationResult(payload) {
  if (payload.error) {
    translationOutput.value = `Local translation failed: ${payload.error}`;
    return;
  }
  translationOutput.value = payload.translatedText || '';
  if (!translationInput.value.trim() && payload.translatedText) {
    translationInput.value = payload.translatedText;
  }
}

function showExportResult(payload) {
  if (payload.error) {
    annotationExportStatus.textContent = `Export failed: ${payload.error}`;
    return;
  }

  annotationExportStatus.textContent = `Exported: ${payload.path}`;
}

function showClipboardResult(payload) {
  if (payload.error) {
    annotationExportStatus.textContent = `Copy failed: ${payload.error}`;
    return;
  }

  annotationExportStatus.textContent = payload.message || 'Copied.';
}

function showAnnotationActionResult(payload) {
  if (payload.error) {
    annotationExportStatus.textContent = payload.error;
    return;
  }

  annotationExportStatus.textContent = payload.message || 'Done.';
}

function isDueForReview(item) {
  const nextReviewAt = item.review?.nextReviewAt;
  if (!nextReviewAt) {
    return true;
  }
  return new Date(nextReviewAt).getTime() <= Date.now();
}

function dateValue(value) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatReviewStatus(review) {
  if (!review.nextReviewAt) {
    return 'Review: due now';
  }

  const date = new Date(review.nextReviewAt);
  const label = Number.isNaN(date.getTime()) ? review.nextReviewAt : date.toLocaleDateString();
  return `Review level ${review.level || 0}, next: ${label}`;
}

function renderTagChips(tags) {
  const normalizedTags = normalizeTags(tags || []);
  if (!normalizedTags.length) {
    return '';
  }

  return `
    <div class="annotation-tags">
      ${normalizedTags.map(tag => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join('')}
    </div>
  `;
}

function renderAnnotationContext(annotation) {
  const before = normalizeContextText(annotation.contextBefore || '');
  const after = normalizeContextText(annotation.contextAfter || '');
  if (!before && !after) {
    return '';
  }

  return `
    <p class="annotation-context">
      ${before ? `<span>${escapeHtml(shortenContext(before, 'start'))}</span>` : ''}
      <mark>${escapeHtml(shortenContext(annotation.selectedText || 'selection', 'middle'))}</mark>
      ${after ? `<span>${escapeHtml(shortenContext(after, 'end'))}</span>` : ''}
    </p>
  `;
}

function shortenContext(value, mode) {
  const normalized = normalizeContextText(value);
  const limit = mode === 'middle' ? 90 : 120;
  if (normalized.length <= limit) {
    return normalized;
  }
  if (mode === 'start') {
    return `...${normalized.slice(-limit)}`;
  }
  if (mode === 'end') {
    return `${normalized.slice(0, limit)}...`;
  }
  return `${normalized.slice(0, limit)}...`;
}

function normalizeTags(value) {
  const rawTags = Array.isArray(value) ? value : String(value).split(/[,\s#]+/);
  const tags = rawTags
    .map(tag => String(tag).trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)];
}

function emptyItem(text) {
  const node = document.createElement('div');
  node.className = 'item';
  node.innerHTML = `<p>${escapeHtml(text)}</p>`;
  return node;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatErrorMessage(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function colorWithAlpha(hex, alpha) {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return hex;
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
