const vscode = acquireVsCodeApi();
const config = window.readerConfig;
const pdfjsLib = await import(config.pdfJsUrl);

pdfjsLib.GlobalWorkerOptions.workerSrc = config.pdfWorkerUrl;

const viewer = document.getElementById('pdfViewer');
const selectedText = document.getElementById('selectedText');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const noteInput = document.getElementById('noteInput');
const wordInput = document.getElementById('wordInput');
const translationInput = document.getElementById('translationInput');
const wordNoteInput = document.getElementById('wordNoteInput');
const annotationsList = document.getElementById('annotationsList');
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

bindUi();
loadPdf();
vscode.postMessage({ type: 'ready' });

function bindUi() {
  document.getElementById('copyPrompt').addEventListener('click', () => {
    const text = selectedText.value.trim();
    if (!text) {
      selectedText.focus();
      return;
    }
    vscode.postMessage({ type: 'copyPrompt', payload: { text } });
  });

  document.getElementById('saveAnnotation').addEventListener('click', () => {
    const text = selectedText.value.trim();
    const note = noteInput.value.trim();
    if (!text && !note) {
      noteInput.focus();
      return;
    }
    vscode.postMessage({
      type: 'saveAnnotation',
      payload: {
        page: readPage(),
        rects: latestSelectionRects,
        selectedText: text,
        note
      }
    });
    noteInput.value = '';
  });

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
    if (message.type !== 'state') {
      return;
    }

    state = message.payload;
    renderAnnotationsList(state.annotations || []);
    renderWords(state.words || []);
    restoreProgress(state.progress?.page);
    renderAnnotationOverlays();
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
      mark.className = 'highlight';
      mark.title = annotation.note || annotation.selectedText || 'Annotation';
      mark.style.left = `${rect.x * 100}%`;
      mark.style.top = `${rect.y * 100}%`;
      mark.style.width = `${rect.width * 100}%`;
      mark.style.height = `${rect.height * 100}%`;
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
  annotationsList.innerHTML = '';
  if (!items.length) {
    annotationsList.appendChild(emptyItem('No annotations saved yet.'));
    return;
  }

  for (const item of items.slice(0, 20)) {
    const node = document.createElement('article');
    node.className = 'item';
    node.innerHTML = `
      <strong>${escapeHtml(item.page ? `Page ${item.page}` : 'Annotation')}</strong>
      <p>${escapeHtml(item.selectedText || item.note || '')}</p>
      ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}
    `;
    annotationsList.appendChild(node);
  }
}

function renderWords(items) {
  wordsList.innerHTML = '';
  if (!items.length) {
    wordsList.appendChild(emptyItem('No words saved yet.'));
    return;
  }

  for (const item of items.slice(0, 20)) {
    const node = document.createElement('article');
    node.className = 'item';
    node.innerHTML = `
      <strong>${escapeHtml(item.word)}${item.translation ? ` - ${escapeHtml(item.translation)}` : ''}</strong>
      <p>${escapeHtml(item.note || item.sentence || '')}</p>
    `;
    wordsList.appendChild(node);
  }
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
