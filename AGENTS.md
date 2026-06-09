# AGENTS.md

This repository is a VS Code extension for a personal paper-reading workflow. Its goal is a stable, convenient reader with automatic local persistence, annotation, translation, and vocabulary capture. Prefer practical reliability over originality.

## Product Goal

- Build a usable VS Code PDF reader for papers and books.
- Keep annotation data, vocabulary, and reading progress in sidecar files next to the PDF so they can sync through Git or any file-sync tool.
- Let the user work beside VS Code AI extensions such as Codex, Claude Code, or ChatGPT extensions.
- Avoid paid AI API dependencies by default. The extension may copy prompts for ChatGPT Plus, but it should not assume Plus includes API quota.

## Architecture Rules

- Do not rebuild a custom PDF renderer unless there is no alternative. PDF rendering, text selection, text layer behavior, scrolling, zooming, and highlight positioning should stay delegated to `react-pdf-highlighter-plus`.
- The extension host owns file access, clipboard access, local translation process calls, and sidecar persistence.
- The Webview owns reader UI, PDF interaction, annotation editing controls, wordbook controls, and `postMessage` events back to the extension host.
- Runtime user data belongs in `.reading-extension/` next to the PDF, not in VS Code global storage.
- Preserve backward compatibility for existing annotation JSON whenever possible.

## Important Files

- `src/extension.ts`: Registers commands and opens the reader.
- `src/paperReaderPanel.ts`: Creates the Webview, injects resources/config, handles Webview messages, calls local translation, and delegates storage.
- `src/readerStorage.ts`: Reads/writes annotations, wordbook, progress, Markdown export, and annotated PDF export.
- `src/annotationTypes.ts`: Shared persisted data types. Update this carefully when changing the annotation schema.
- `src/annotationExports.ts`: Markdown and annotated PDF export logic.
- `src/wordReview.ts`: Vocabulary review scheduling helpers.
- `webview/src/main.tsx`: React reader UI and PDF/highlight integration.
- `webview/src/styles.css`: Reader layout and visual styling.
- `webview/src/vscodeApi.ts`: Webview access to VS Code API and injected config.
- `scripts/argos_translate.py`: Local Argos Translate helper. It reads JSON from stdin and writes JSON to stdout.
- `scripts/test-annotation-exports.mjs`: Regression tests for exports, schema compatibility, and word review.
- `media/reader-app.js` and `media/reader-app.css`: Generated Webview bundle. Do not edit manually; rebuild with `npm run build:webview` or `npm run compile`.
- `project_map.md`: File-by-file repository map. Update it when adding or changing major files.

## Runtime Data Contract

For `paper.pdf`, the extension writes:

```text
.reading-extension/
  paper.pdf.annotations.json
  paper.pdf.annotations.md
  paper.pdf.annotated.pdf
  paper.pdf.wordbook.json
  paper.pdf.progress.json
```

These files are intentionally plain local files. They should remain portable across machines.

## Local Translation

- Default provider: Argos Translate through `.venv-translate/bin/python`.
- Helper: `scripts/argos_translate.py`.
- Current expected offline package: `en -> zh`.
- LibreTranslate remains available as an HTTP fallback through `readingExtension.libreTranslateEndpoint`.
- Argos quality is usable but limited. Keep `Copy ChatGPT prompt` available for higher-quality translation/explanation.
- Do not commit `.venv-translate/`; it is a local runtime dependency.

## Development Commands

Run these before committing code changes:

```bash
npm test
./node_modules/.bin/tsc -p tsconfig.webview.json --noEmit
node --check media/reader-app.js
```

Use:

```bash
npm run compile
```

to rebuild both the Webview bundle under `media/` and the extension host under `out/`.

## Manual Checks

For reader changes, manually verify at least one normal text PDF:

- PDF opens without a blank Webview.
- Page scale is reasonable at initial load.
- Text selection works with real text PDFs.
- Creating, editing, deleting, and undoing annotations autosaves.
- Closing and reopening restores annotations, wordbook entries, and progress.
- `Translate locally` returns a result for English selected text.
- `Copy ChatGPT prompt` still works.

For scanned PDFs, text selection may not work because there is no text layer. Do not treat that as a regression unless OCR has been added.

## Git Hygiene

Do not commit:

- `.vscode/`
- `.venv-translate/`
- `node_modules/`
- `out/`
- user PDFs
- runtime `.reading-extension/` sidecar data
- packaged `*.vsix` files

Generated `media/reader-app.js` and `media/reader-app.css` should be committed when Webview source changes, because the extension loads them at runtime.

## Known Design Priorities

- Stability first.
- Auto-save first.
- Sync-friendly sidecar files first.
- Keep AI integration optional and cheap.
- Avoid large refactors unless they directly improve reader stability or maintainability.
