---
name: a-date-inside-a-note-is-not-the-notes-subject
description: a record flagged as documenting a superseded decision was in fact recording its REVERSAL — digest the prose against the migration before calling it stale
metadata:
  node_type: memory
  type: project
  originSessionId: 0a3a0a02-b55f-42bb-8f6f-7c578d5fd602
  modified: 2026-10-13T02:29:37.350Z
---

`docs/security/migration-ledger-reconciliation-2026-10-08.md` left one open item for the owner: the
`notes` on `au.line_area_map` for `pedia`/`OT6` (Luxor) "still document the superseded 2026-09-11
shared-rep-seat arrangement", flagged as a one-row documentation write only he could authorise. He
sent it to be fixed on 13 Oct 2026. Read live first: **there was nothing to fix.** The notes are
byte-identical to the text `20261002184148_luxor_separate_from_qena2_no_rep_seat` writes —
`md5(notes)` = `bf6f192ed0baf57e79ed6182cf9b0768`, 387 characters on both sides — and they say the
union **was reverted**. `rep_seat_id` is `NULL`. No production write was made.

It also closes that page's unexplained finding: the direct write that nulled the seat wrote **these
notes too**, both halves of the file's target state with no ledger row — which is why the file's
guarded `update` matched zero rows and why the notes digest read "unchanged" after the 2026-10-08
apply. It was already the right digest.

**Why:** the flag was raised by reading the date "2026-09-11" inside the text without the clause
around it. A sentence recording that a decision was reverted *names the thing it reverted* — that is
what makes it useful — so a date in a note is evidence of nothing on its own.

**How to apply:** before calling a live record stale, `md5()` its text against whatever the
repository says it should be, and read the whole clause. The repo already applies this to function
bodies ([[verify-the-emitted-artifact-never-the-source]]); prose gets the same treatment. The flag
is struck through on the 2026-10-08 page with the withdrawal beside it, so a future session does not
chase it again.
