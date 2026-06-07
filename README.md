# Reading Extension

A VS Code extension prototype for paper reading workflows: translation prompts, annotations, vocabulary notes, and automatic local persistence.

## Current MVP

- Open the current PDF or choose one from disk.
- Show a reader panel with the selected paper.
- Save annotations automatically to a sidecar JSON file.
- Save vocabulary notes automatically to a sidecar JSON file.
- Copy a ChatGPT translation/explanation prompt without using paid API calls.

## Data Model

For a paper named `paper.pdf`, the extension writes local data under:

```text
.reading-extension/
  paper.pdf.annotations.json
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

## Roadmap

- Replace the PDF iframe prototype with a full pdf.js reader.
- Add text selection directly from PDF pages.
- Add LibreTranslate localhost support.
- Add DeepL API Free support.
- Add spaced repetition for saved vocabulary.
- Export annotations into a marked-up PDF.

