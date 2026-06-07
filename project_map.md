# Project Map

This repository is a VS Code extension prototype for reading papers with translation assistance, annotations, vocabulary capture, and automatic local saves.

## Root Files

- `README.md`: User-facing overview, setup commands, current MVP, and roadmap.
- `package.json`: VS Code extension manifest, contributed command, configuration, scripts, and npm dependencies including pdf.js rendering and PDF export helpers.
- `package-lock.json`: Locked dependency graph for reproducible installs.
- `tsconfig.json`: TypeScript compiler settings. Source files compile from `src/` into `out/`.
- `scripts/test-annotation-exports.mjs`: Node regression test that checks annotation Markdown export and annotated PDF comment export after TypeScript compilation.
- `.gitignore`: Local files excluded from git, including `node_modules/`, compiled output, packaged extensions, and sidecar reading data.
- `.vscodeignore`: Files excluded when packaging the extension.
- `project_map.md`: This file. Keep it updated when files or responsibilities change.

## Source

- `src/extension.ts`: Extension entrypoint. Registers `readingExtension.openReader`, resolves the target PDF, and opens the reader panel.
- `src/paperReaderPanel.ts`: Owns the VS Code Webview panel. It wires PDF, pdf.js, CSS, and JS resource URIs into the Webview, handles messages from the reader UI, calls local LibreTranslate, and delegates persistence to `ReaderStorage`.
- `src/annotationTypes.ts`: Shared annotation TypeScript types used by storage, export helpers, and Webview message payloads.
- `src/annotationExports.ts`: Pure annotation export helpers. It formats annotation Markdown and applies visible highlight/underline marks plus native note comments to PDF bytes.
- `src/readerStorage.ts`: Sidecar JSON persistence layer. It stores colored highlight/underline annotations, calls annotation export helpers, stores vocabulary, vocabulary review state, and reading progress under `.reading-extension/` next to the PDF being read.

## Webview Assets

- `media/reader.js`: Browser-side reader app. It uses pdf.js to lazily render pages near the viewport, captures text selection, tracks current page, draws annotation highlights/underlines/page-note markers, supports annotation search/filter/style/color/edit/delete/jump/export interactions, renders local translation results, shows due vocabulary, and sends save/copy/review events back to the extension host.
- `media/reader.css`: Reader layout, PDF page presentation, text selection layer, highlight overlay, side panel, and responsive rules.

## Build Output

- `out/`: Generated JavaScript and source maps from `npm run compile`. Do not edit these files manually.

## Runtime Data

For a PDF named `paper.pdf`, runtime data is written next to the PDF:

```text
.reading-extension/
  paper.pdf.annotations.json
  paper.pdf.annotations.md
  paper.pdf.annotated.pdf
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

- The reader creates page shells for the whole document, then lazily renders canvas/text content near the viewport with a bounded render queue. Full virtualization can still improve very large documents later.
- Annotations are stored as normalized page rectangles, so highlights survive zoom changes.
- Annotation colors are stored per annotation as hex strings and styles are stored as `highlight` or `underline`; older annotations fall back to yellow highlight.
- Annotated PDF export draws visible highlight rectangles and creates native `/Text` comment annotations for note text.
- Export logic is covered by `npm test`, which verifies Markdown content and native PDF note comments.
- Page-only notes are rendered as clickable markers in the page overlay and exported as native PDF comments.
- Local translation calls happen from the extension host instead of the Webview, which avoids Webview CORS friction.
- The ChatGPT prompt copy path remains available as a no-extra-API-cost fallback.
- Vocabulary review uses a deliberately small interval list for now: due immediately, then 1, 3, 7, 14, and 30 days.
- `project_map.md` should be updated whenever a major file is added, removed, or changes responsibility.
