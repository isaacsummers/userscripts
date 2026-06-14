# userscripts

A collection of browser userscripts (Tampermonkey / Greasemonkey).

## Scripts

### `copy-page-text.user.js` — Clean Page Text Copier

Injects a draggable **📋 Copy All Text** button into every page. On click, it:

- Expands all collapsed/hidden content (Bootstrap collapses, `<details>`, `aria-hidden` panels)
- Walks the entire DOM and extracts all visible text nodes
- Deduplicates consecutive identical lines
- Copies the result to the clipboard

Supports drag-to-reposition and touch. Works on any `*://*/*` URL.

**Install:** Open the raw `.user.js` file in your browser while Tampermonkey is active — it will prompt to install.

---

### `capture-teams-transcript.user.js` — Teams Transcript Capture

Captures full Microsoft Teams meeting transcripts from the SharePoint recap view. Handles virtualized lists by scrolling through the DOM (or extracting via React fiber internals) to collect all transcript entries.

Features:
- Injected **📋 Capture Transcript** button on SharePoint / Teams recap pages
- Merges consecutive same-speaker turns for clean LLM-ready output
- Exports transcript as plain-text Markdown file or copies to clipboard
- Extracts meeting title, date, and description from page metadata
- Cancel support during long captures

**Matches:** `*.sharepoint.com/*`, `teams.microsoft.com/*`, `*.teams.microsoft.com/*`

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox/Safari).
2. Click the Tampermonkey icon → **Create a new script** (or drag the `.user.js` file onto the dashboard).
3. Paste/save — Tampermonkey will auto-detect the `@match` rules.

## License

MIT
