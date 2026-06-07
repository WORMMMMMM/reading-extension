const vscode = acquireVsCodeApi();
const config = window.readerConfig;
const pdfjsLib = await import(config.pdfJsUrl);

pdfjsLib.GlobalWorkerOptions.workerSrc = config.pdfWorkerUrl;

const viewer = document.getElementById('pdfViewer');
const selectedText = document.getElementById('selectedText');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const annotationColor = document.getElementById('annotationColor');
const annotationEditStatus = document.getElementById('annotationEditStatus');
const saveAnnotationButton = document.getElementById('saveAnnotation');
const cancelAnnotationEditButton = document.getElementById('cancelAnnotationEdit');
const noteInput = document.getElementById('noteInput');
const wordInput = document.getElementById('wordInput');
const translationInput = document.getElementById('translationInput');
const translationOutput = document.getElementById('translationOutput');
const wordNoteInput = document.getElementById('wordNoteInput');
const annotationSearch = document.getElementById('annotationSearch');
const annotationColorFilter = document.getElementById('annotationColorFilter');
const annotationExportStatus = document.getElementById('annotationExportStatus');
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
let pageObserver;
let restoredProgress = false;
let editingAnnotationId;
let activeAnnotationId;

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
    const text = selectedText.value.trim();
    const note = noteInput.value.trim();
    if (!text && !note) {
      noteInput.focus();
      return;
    }

    const payload = {
      page: readPage(),
      rects: latestSelectionRects,
      color: annotationColor.value,
      selectedText: text,
      note
    };

    if (editingAnnotationId) {
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
    latestSelectionRects = [];
  });

  document.addEventListener('selectionchange', captureSelection);

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

  annotationColorFilter.addEventListener('change', () => {
    renderAnnotationsList(state.annotations || []);
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

    focusAnnotation(annotation);
  });
}

async function loadPdf() {
  try {
    readerStatus.textContent = 'Loading PDF...';
    const loadingTask = pdfjsLib.getDocument(config.pdfUrl);
    pdfDoc = await loadingTask.promise;
    pageTotal.textContent = `/ ${pdfDoc.numPages}`;
    currentPage = clampPage(currentPage);
    pageInput.max = String(pdfDoc.numPages);
    await renderPdf();
    goToPage(currentPage, { smooth: false });
    readerStatus.textContent = 'Ready';
  } catch (error) {
    console.error(error);
    readerStatus.textContent = 'Could not load PDF';
  }
}

async function renderPdf() {
  disconnectObserver();
  viewer.innerHTML = '';
  zoomValue.textContent = `${Math.round((scale / 1.25) * 100)}%`;

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    readerStatus.textContent = `Rendering page ${pageNumber} / ${pdfDoc.numPages}`;
    await renderPage(pageNumber);
  }

  renderAnnotationOverlays();
  observePages();
}

async function renderPage(pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const pageEl = document.createElement('article');
  const canvas = document.createElement('canvas');
  const textLayer = document.createElement('div');
  const annotationLayer = document.createElement('div');

  pageEl.className = 'pdf-page';
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

  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport
  }).promise;

  await renderTextLayer(page, viewport, textLayer);
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

function elementFromRect(rect) {
  return document.elementFromPoint(rect.left + Math.min(4, rect.width / 2), rect.top + Math.min(4, rect.height / 2));
}

function renderAnnotationOverlays() {
  document.querySelectorAll('.annotation-layer').forEach(layer => {
    layer.innerHTML = '';
  });

  for (const annotation of state.annotations || []) {
    for (const rect of annotation.rects || []) {
      const pageEl = document.querySelector(`.pdf-page[data-page="${rect.page}"]`);
      const layer = pageEl?.querySelector('.annotation-layer');
      if (!pageEl || !layer) {
        continue;
      }

      const mark = document.createElement('div');
      mark.className = `highlight${annotation.id === activeAnnotationId ? ' active-highlight' : ''}`;
      mark.dataset.annotationId = annotation.id;
      mark.title = annotation.note || annotation.selectedText || 'Annotation';
      mark.style.background = colorWithAlpha(annotation.color || '#ffd654', 0.42);
      mark.style.left = `${rect.x * 100}%`;
      mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
      mark.addEventListener('click', event => {
        event.stopPropagation();
        focusAnnotation(annotation, { scroll: false });
      });
      layer.appendChild(mark);
    }
  }
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

function disconnectObserver() {
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = undefined;
  }
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
  annotationsList.innerHTML = '';
  if (!filteredItems.length) {
    annotationsList.appendChild(emptyItem('No annotations saved yet.'));
    return;
  }

  for (const item of filteredItems.slice(0, 50)) {
    const node = document.createElement('article');
    node.className = `item annotation-item${item.id === activeAnnotationId ? ' active-item' : ''}`;
    node.dataset.annotationId = item.id;
    node.innerHTML = `
      <strong><span class="color-dot" style="background:${escapeHtml(item.color || '#ffd654')}"></span>${escapeHtml(item.page ? `Page ${item.page}` : 'Annotation')}</strong>
      <p>${escapeHtml(item.selectedText || item.note || '')}</p>
      ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}
      <div class="annotation-actions">
        <button data-annotation-action="jump">Jump</button>
        <button data-annotation-action="edit">Edit</button>
        <button data-annotation-action="delete">Delete</button>
      </div>
    `;
    annotationsList.appendChild(node);
  }
}

function filterAnnotations(items) {
  const query = annotationSearch.value.trim().toLowerCase();
  const color = annotationColorFilter.value;

  return items.filter(item => {
    const matchesColor = !color || (item.color || '#ffd654') === color;
    if (!matchesColor) {
      return false;
    }
    if (!query) {
      return true;
    }

    const haystack = [
      item.selectedText,
      item.note,
      item.page ? `page ${item.page}` : ''
    ].join('\n').toLowerCase();
    return haystack.includes(query);
  });
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
  }
}

function editAnnotation(annotation) {
  editingAnnotationId = annotation.id;
  activeAnnotationId = annotation.id;
  selectedText.value = annotation.selectedText || '';
  noteInput.value = annotation.note || '';
  annotationColor.value = annotation.color || '#ffd654';
  latestSelectionRects = annotation.rects || [];
  if (annotation.page) {
    pageInput.value = String(annotation.page);
  }
  annotationEditStatus.hidden = false;
  cancelAnnotationEditButton.hidden = false;
  saveAnnotationButton.textContent = 'Update annotation';
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
  vscode.postMessage({
    type: 'deleteAnnotation',
    payload: {
      id: annotation.id
    }
  });
}

function clearAnnotationEditor() {
  editingAnnotationId = undefined;
  annotationEditStatus.hidden = true;
  cancelAnnotationEditButton.hidden = true;
  saveAnnotationButton.textContent = 'Save annotation';
  noteInput.value = '';
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

function isDueForReview(item) {
  const nextReviewAt = item.review?.nextReviewAt;
  if (!nextReviewAt) {
    return true;
  }
  return new Date(nextReviewAt).getTime() <= Date.now();
}

function formatReviewStatus(review) {
  if (!review.nextReviewAt) {
    return 'Review: due now';
  }

  const date = new Date(review.nextReviewAt);
  const label = Number.isNaN(date.getTime()) ? review.nextReviewAt : date.toLocaleDateString();
  return `Review level ${review.level || 0}, next: ${label}`;
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
