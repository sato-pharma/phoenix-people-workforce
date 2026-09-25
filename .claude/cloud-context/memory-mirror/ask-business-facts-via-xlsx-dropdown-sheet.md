---
name: ask-business-facts-via-xlsx-dropdown-sheet
description: "Owner's standing rule — when in doubt about a business fact anywhere in the repo, send an XLSX with dropdowns for him to fill, never guess and never ask in prose"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 29be11d8-82c5-4358-9875-43313787e696
  modified: 2026-08-04T15:39:37.831Z
---

When you are in doubt about a business fact — which of a set of options each of a list of items
belongs to — build an XLSX with one row per item and a locked data-validation dropdown of the
allowed answers, send it, and read the answers back. He fills it and returns it. Stated 2026-08-03
("lets follow this system everywhere in the repo anything u are in dout of give xlsx with droplists
i populate and give back 2 u") right after this worked for classifying 16 Arabic-named bricks as
Fayoum vs Beni Suef. **Applies repo-wide, not just Source of Sales.**

**Why:** he is the only person who holds these facts, and the alternatives both fail. Guessing puts
a wrong number into a live report — for the GZ6 bricks I could place most from the Arabic names but
genuinely could not place `بليفيا`, and it turned out to be Beni Suef. Asking in prose makes him type
16 answers into chat, which he will not do at 2am. A dropdown sheet is a few clicks and comes back
machine-readable.

**How to apply:**
- One row per item. Columns: index, stable ID, human-readable name, whatever context makes the call
  easy (current value, recent sales), the dropdown, and a free-text Note.
- `cell.dataValidation = { type: "list", allowBlank: false, formulae: ['"A,B"'], showErrorMessage: true }`
  so a typo is rejected by Excel rather than by you later.
- Tint the columns he must fill (amber) so they are obvious; match the Phoenix export style — black band, orange accent, no wrapping, no truncation.
- Arabic names: right-align, `readingOrder: "rtl"`, generous width. They round-trip through ExcelJS
  intact.
- **Reading it back, skip merged footer/spacer rows** — a merged note row reads as a data row with
  the note text repeated in every column. Filter on a plausible ID, not on "cell is non-empty".
- A scratchpad script cannot `import "exceljs"` — ESM resolves from the script's own folder. Use
  `createRequire("file:///F:/Phoenix Workforce/phoenix-workforce/package.json")`.
- Verify the written file by reading it back and asserting the dropdown survived on every row before
  sending it. See AGENTS.md §1 rule 1 (show the proof, never the claim).

Recorded in AGENTS.md section 4 as well, per [[owner-working-profile-audit-2026-08-01]] — standing
preferences belong in AGENTS.md, not only in memory.
