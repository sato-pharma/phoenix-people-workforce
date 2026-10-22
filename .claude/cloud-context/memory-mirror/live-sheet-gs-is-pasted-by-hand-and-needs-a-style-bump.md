---
name: live-sheet-gs-is-pasted-by-hand-and-needs-a-style-bump
description: "STALE first half: since 2026-09-05 apps-script-push.yml writes docs/*-live-sheet.gs into each project on merge (HEAD), and PR #6244 also moves the web app — no hand paste. Still true: a look-only change needs STYLE_VERSION bumped or it never repaints."
metadata: 
  node_type: memory
  type: project
  originSessionId: 502a9581-d66b-4ff7-8b0d-4a3b31af8358
  modified: 2026-08-06T10:50:02.130Z
---

`docs/direct-orders-live-sheet.gs` (and its marketing twin) is the **source of record, not a
deployment**. Nothing ships it: no `clasp`, nothing in `.github/workflows/`, nothing in `scripts/`.
The live sheet runs its own copy inside the owner's Apps Script project.

**So "merged" never means "live" for these files.** The owner must open the sheet →
Extensions → Apps Script → select all → paste → Save. Say that explicitly every time, or the
work looks delivered and nothing has changed. This cost a full round trip on 2026-08-06 when he
asked "is what I need done or not?" and the honest answer was no.

**The second trap, which cost two more round trips.** Styling lives in `buildOrdersFrame`, and that
only runs when `headerMatches` is false — i.e. when the COLUMN SET changes. Two consequences:

- A new block of columns added outside Phoenix's own header is **never painted** on an existing
  sheet (no header change → no rebuild). It shipped invisible once exactly this way.
- A **look-only** change repaints nothing, ever. Pasting the new script appears to do nothing.

Fix that is now in the file and must be kept: `var STYLE_VERSION` stamped into
`PropertiesService.getDocumentProperties()`, folded into the rebuild decision as
`var rebuild = restyled || !headerMatches(...)`. **Bump `STYLE_VERSION` on every visual change.**

Also: `headerMatches` must compare `header.length` columns, never `sheet.getLastColumn()` — the
team's editable block sits to the right of Phoenix's table, so `getLastColumn()` made an empty
block suppress the rebuild forever and a populated one force a full repaint every minute.

Related: [[ask-business-facts-via-xlsx-dropdown-sheet]] · [[prove-it-fails-verify-which-assertion-fired]]
