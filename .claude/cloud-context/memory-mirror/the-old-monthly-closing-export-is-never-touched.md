---
name: the-old-monthly-closing-export-is-never-touched
description: "Owner rule 2026-08-31 - the original Monthly Closing export and its workbook are frozen; every new closing feature ships BESIDE it, never inside it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-09-18T15:04:31.207Z
---

**The original Monthly Closing export is frozen. Never change it.** Owner rule, 2026-08-31, in his
own words: *"I want the monthly closing sheet which you are building now. Let's put a rule to not
touch it. The old monthly closing sheet don't mess it. Anything we will do will be aside it."*

That covers **all** of it: `app/api/sales/monthly-closing/export/route.ts`, the workbook it builds,
its sheet set, its layout, and the solid black **Export XLSX** button on the closing screen. No
restyle, no "small improvement", no refactor that changes a byte of what it emits — not even a fix
that looks obviously right.

**Why:** it is the auditor's file. People already read it, forward it and reconcile against it, and
its shape is what they have learned. A second format is additive; a changed first format silently
invalidates every copy already in circulation and every habit built on it. He has now said the same
thing twice in two days — first *"I don't want this sheet to replace the current monthly closing, I
want it another export button beside it"* (2026-08-30), then this. Treat any impulse to improve the
original as the thing the rule exists to stop.

**How to apply:** new closing capability goes in the **premium** export beside it —
`src/lib/sales/closing-engine-fill.ts` (`fillClosingEngine`, 1,893 lines),
`app/api/sales/monthly-closing/premium-export/route.ts`, and the outlined **Export Premium XLSX**
button. Two buttons, both live, the reader picks. If a change genuinely cannot be made without
touching the original, stop and ask him first; do not decide it is small enough.

> **Path corrected 2026-09-05.** This line named `src/lib/sales/premium-closing-export.ts`, which
> **does not exist and appears never to have.** The builder is `closing-engine-fill.ts` — a name that
> matches the rule's own wording, since the premium export *fills* the `.xlsm` engine rather than
> rebuilding it ([[premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it]]). The danger was
> specific: a session following this rule looks for the premium module, finds nothing, concludes the
> "beside it" option does not exist, and is pushed toward the original — **the exact edit the golden
> rule forbids.** Verified from the route's own imports, not by guessing at a filename.

**2026-09-18, one owner-approved exception:** SoS re-measure #20 flagged that the Total sheet's area
rows are before the store split while the Closing Matrix is after it. After answering both ways six
minutes apart across three sessions, he settled it at 18:04 Cairo on one clear English and Arabic
question: **"Yes, change it"**. That approves this one change inside the old export and nothing
wider. The record is in `sos-owner-rulings-2026-09-18.md` in the SoS audit vault. Every other change still needs his
approval first.

The one thing that legitimately spans both: `tests/sos-ui-truth.test.ts` pins that **whatever posts
an export request carries the on-screen filter**, and both buttons share `runExport` so neither can
drift. Keeping that shared is not "touching" the old export — it is what stops the old one silently
diverging from the screen.

Related: [[premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it]] ·
[[an-export-must-match-the-screen-never-different-data]] ·
[[weekly-summarized-report-owner-rules]]
