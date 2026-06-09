# Reading Extension

A VS Code extension prototype for paper reading workflows: translation prompts, annotations, vocabulary notes, and automatic local persistence.

## Current MVP

- Open the current PDF or choose one from disk.
- Render the selected paper through a React Webview powered by `react-pdf-highlighter-plus`.
- Capture selected PDF text with the library-managed PDF.js text layer.
- Translate selected text through a local LibreTranslate server.
- Save colored highlight and underline annotations automatically to a sidecar JSON file.
- Save surrounding text context for captured PDF selections.
- Reopen text highlights from the PDF or the annotation list.
- Keep page-only notes in the saved list and annotated PDF export.
- Edit, delete, jump to, and reactivate saved annotations.
- Undo the last annotation deletion from the reader status line.
- Autosave edits to existing annotation notes, colors, styles, text, and page metadata.
- Copy a single annotation as Markdown from the annotation list.
- Add tags to annotations, then search and filter them by tag.
- See a live summary of the current annotation view by style, color, and top tags.
- Search, filter, and sort annotations by text, tag, color, style, paper order, creation time, or edit time.
- Export annotations to Markdown next to the PDF, ordered by paper position and including tags/context.
- Export a highlighted PDF copy with native note comments next to the PDF.
- Save vocabulary notes automatically to a sidecar JSON file.
- Review due vocabulary with a simple spaced repetition loop.
- Restore the last-read page automatically.
- Copy a ChatGPT translation/explanation prompt without using paid API calls.

## Data Model

For a paper named `paper.pdf`, the extension writes local data under:

```text
.reading-extension/
  paper.pdf.annotations.json
  paper.pdf.annotations.md
  paper.pdf.annotated.pdf
  paper.pdf.wordbook.json
  paper.pdf.progress.json
```

These files are ordinary JSON, so they can be synchronized with Git, iCloud Drive, Dropbox, Syncthing, or any other file sync tool.

## Development

```bash
npm install
npm run compile
npm test
```

Then press `F5` in VS Code to launch an Extension Development Host.

`npm run compile` builds both the React Webview bundle under `media/` and the extension host under `out/`.

`npm test` compiles the extension and runs regression checks for annotation Markdown export, annotated PDF export, highlighter-position annotation compatibility, and vocabulary review scheduling.

See `project_map.md` for a file-by-file map of the repository.

## Local Translation

The extension can call a local LibreTranslate server without using paid AI APIs. The default endpoint is:

```text
http://localhost:5000/translate
```

You can change it in VS Code settings:

```json
{
  "readingExtension.libreTranslateEndpoint": "http://localhost:5000/translate",
  "readingExtension.translationSource": "auto",
  "readingExtension.translationTarget": "zh"
}
```

## Troubleshooting

If the reader shows `Could not load PDF`, reload the Extension Development Host and run `Reading Extension: Open Paper Reader` again. The reader updates its Webview resource roots whenever the active PDF changes and pre-registers the PDF.js worker handler in the Webview bundle so PDF.js can run in fake-worker mode inside VS Code.

## Roadmap

- Add a visible LibreTranslate connection check.
- Add DeepL API Free support.
- Add optional free-text notes, drawing, and shape tools from `react-pdf-highlighter-plus`.
- Improve exported PDF highlight fidelity for rotated/cropped pages.
- Improve spaced repetition scheduling and filtering.
