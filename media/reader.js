(function () {
  const vscode = acquireVsCodeApi();

  const selectedText = document.getElementById('selectedText');
  const pageInput = document.getElementById('pageInput');
  const noteInput = document.getElementById('noteInput');
  const wordInput = document.getElementById('wordInput');
  const translationInput = document.getElementById('translationInput');
  const wordNoteInput = document.getElementById('wordNoteInput');
  const annotationsList = document.getElementById('annotationsList');
  const wordsList = document.getElementById('wordsList');

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
    vscode.postMessage({
      type: 'saveProgress',
      payload: {
        page: readPage(),
        updatedAt: new Date().toISOString()
      }
    });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type !== 'state') {
      return;
    }

    renderAnnotations(message.payload.annotations || []);
    renderWords(message.payload.words || []);
    if (message.payload.progress?.page) {
      pageInput.value = String(message.payload.progress.page);
    }
  });

  vscode.postMessage({ type: 'ready' });

  function readPage() {
    const value = Number(pageInput.value);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  function renderAnnotations(items) {
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();

