# Project Map

This repository is a VS Code extension prototype for reading papers with translation assistance, annotations, vocabulary capture, and automatic local saves.

## Root Files

- `README.md`: User-facing overview, setup commands, current MVP, and roadmap.
- `package.json`: VS Code extension manifest, contributed command, configuration, scripts, and npm dependencies.
- `package-lock.json`: Locked dependency graph for reproducible installs.
- `tsconfig.json`: TypeScript compiler settings. Source files compile from `src/` into `out/`.
- `.gitignore`: Local files excluded from git, including `node_modules/`, compiled output, packaged extensions, and sidecar reading data.
- `.vscodeignore`: Files excluded when packaging the extension.
- `project_map.md`: This file. Keep it updated when files or responsibilities change.

## Source

- `src/extension.ts`: Extension entrypoint. Registers `readingExtension.openReader`, resolves the target PDF, and opens the reader panel.
- `src/paperReaderPanel.ts`: Owns the VS Code Webview panel. It wires PDF, pdf.js, CSS, and JS resource URIs into the Webview, handles messages from the reader UI, calls local LibreTranslate, and delegates persistence to `ReaderStorage`.
- `src/readerStorage.ts`: Sidecar JSON persistence. It stores annotations, vocabulary, vocabulary review state, and reading progress under `.reading-extension/` next to the PDF being read.

## Webview Assets

- `media/reader.js`: Browser-side reader app. It uses pdf.js to render pages, captures text selection, tracks current page, draws annotation highlights, renders local translation results, shows due vocabulary, and sends save/copy/review events back to the extension host.
- `media/reader.css`: Reader layout, PDF page presentation, text selection layer, highlight overlay, side panel, and responsive rules.

## Build Output

- `out/`: Generated JavaScript and source maps from `npm run compile`. Do not edit these files manually.

## Runtime Data

For a PDF named `paper.pdf`, runtime data is written next to the PDF:

```text
.reading-extension/
  paper.pdf.annotations.json
  paper.pdf.wordbook.json
  paper.pdf.progress.json
```

These sidecar JSON files are intentionally plain text so they can be synchronized with Git, iCloud Drive, Dropbox, Syncthing, or another sync tool.

## Current Architecture

```text
VS Code command
  -> src/extension.ts
  -> src/paperReaderPanel.ts
  -> Webview HTML
  -> media/reader.js + pdfjs-dist
  -> user actions
  -> Webview postMessage
  -> src/paperReaderPanel.ts
  -> local LibreTranslate or src/readerStorage.ts
  -> translation result or .reading-extension/*.json
```

## Development Notes

- The reader currently renders all PDF pages sequentially. This is simple and useful for the MVP; large PDFs may need virtualized page rendering later.
- Annotations are stored as normalized page rectangles, so highlights survive zoom changes.
- Local translation calls happen from the extension host instead of the Webview, which avoids Webview CORS friction.
- The ChatGPT prompt copy path remains available as a no-extra-API-cost fallback.
- Vocabulary review uses a deliberately small interval list for now: due immediately, then 1, 3, 7, 14, and 30 days.
- `project_map.md` should be updated whenever a major file is added, removed, or changes responsibility.
