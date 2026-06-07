# Reading Extension

A VS Code extension prototype for paper reading workflows: translation prompts, annotations, vocabulary notes, and automatic local persistence.

## Current MVP

- Open the current PDF or choose one from disk.
- Render the selected paper with pdf.js inside a VS Code Webview.
- Capture selected PDF text into the translation and annotation panel.
- Translate selected text through a local LibreTranslate server.
- Save colored annotations automatically to a sidecar JSON file.
- Edit, delete, jump to, and reactivate saved annotations.
- Search and filter annotations by text or highlight color.
- Export annotations to Markdown next to the PDF.
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
  paper.pdf.wordbook.json
  paper.pdf.progress.json
```

These files are ordinary JSON, so they can be synchronized with Git, iCloud Drive, Dropbox, Syncthing, or any other file sync tool.

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

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

## Roadmap

- Add a visible LibreTranslate connection check.
- Add DeepL API Free support.
- Improve spaced repetition scheduling and filtering.
- Export annotations into a marked-up PDF.
