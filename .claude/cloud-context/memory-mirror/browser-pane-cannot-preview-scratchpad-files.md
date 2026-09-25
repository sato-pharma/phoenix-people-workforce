---
name: browser-pane-cannot-preview-scratchpad-files
description: "Claude_Browser tools can't actually render/screenshot local file:// paths outside the project folder (e.g. the scratchpad dir) in this environment — don't waste turns retrying."
metadata:
  node_type: memory
  type: reference
  originSessionId: 83931272-497c-4579-a106-0ac0fe1501fb
  modified: 2026-07-20T18:34:10.865Z
---

When building an HTML Artifact (e.g. a design-concept mockup written to the scratchpad dir under `AppData\Local\Temp\claude\...`), `navigate`/`preview_start` on a `file:///...` path outside the repo folder reports success ("files outside the project folder render as static snapshots") and returns a valid tabId, but every follow-up call against that tab — `computer{screenshot}`, `get_page_text`, `read_page` — fails with `"No site is open in this tab. Use navigate first."` Tried across a fresh `tabs_create` + `navigate` and a `preview_start` shortcut, both times, same result. Not a transient fluke.

**Why:** the Browser pane's real rendering/inspection pipeline appears scoped to project-relative paths and http(s) dev servers; an out-of-project `file://` path only gets a placeholder "static snapshot" tab that the inspection tools can't actually reach.

**How to apply:** don't retry navigate/screenshot/get_page_text/read_page loops against a scratchpad-authored HTML file — it will keep failing the same way. Instead: (1) verify by carefully re-reading the written HTML/CSS for structural correctness (tag balance, selector logic) before publishing, since that's the only verification actually available pre-publish; (2) publish via the `Artifact` tool, which renders independently through its own pipeline (this does work and is the real target anyway — the user views the artifact there, not in the Browser pane). If a page genuinely needs pixel-level pre-publish verification, it would need to live inside the project folder (or be served by a real dev server via `preview_start {name}`) rather than the scratchpad. Related: [[local-browser-verify-gotchas]] (a different class of local-preview gotcha — that one covers the actual `npm run dev` server, not Artifact scratch files).
