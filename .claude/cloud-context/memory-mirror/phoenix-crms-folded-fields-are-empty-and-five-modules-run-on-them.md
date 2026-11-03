---
name: phoenix-crms-folded-fields-are-empty-and-five-modules-run-on-them
description: "Phoenix CRM's REQUIRED fields are 100% filled and its FOLDED optional ones are near-nil — next_step 1 of 332 visits, objection 2, samples 19, stock 77 — so commitments.ts, call-prep.ts, missing-stock.ts, samples-report.ts and \"What the field heard\" are all running on empty data; never read one of their empty boards as a bug in the board"
metadata:
  node_type: memory
  type: project
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-11-03T04:40:25.008Z
---

Measured on production 2026-10-05 over every day Phoenix CRM has been live (3–5 Oct, 332 rep-saved
doctor/hospital visits):

| Field | On the form | Filled |
| --- | --- | --- |
| comment | **required** | 332 (100%) |
| products | **required** | 332 (100%) |
| product_availability (stock check) | folded, optional | 77 (23%) |
| samples_given | folded, optional | 19 (6%) |
| objection | folded, optional | **2 (0.6%)** |
| next_step | folded, optional | **1 (0.3%)** |

Everything required is at 100%; everything folded is at 23% or below. The comments themselves are
real — median 75 characters, 301 of 332 in Arabic — so the reps are willing to tell the system
things; they just never open a folded step. `samples_given` is literally `{}` on 313 of 332 and
`product_availability` on 255 of 332.

**So five modules and two reports are running on near-empty input and are NOT broken:**
`commitments.ts` (1 row), `call-prep.ts`'s last objection (2 rows), `missing-stock.ts` (77),
`samples-report.ts` (19), and "What the field heard"'s objections (~0). An empty board there is the
form's fold, never a defect in the loader — do not "fix" the loader, and do not widen a query
looking for rows that were never typed.

**Corrected 2026-11-03: the fold is history.** `.claude/rules/phoenix-crm-visits.md` says objection and next step have been open and optional since 6 Oct 2026 (his word). Read that file, not this paragraph, for the form today; the figures above are the 3 to 5 Oct measure only.

**The fold itself was the owner's own ruling** (2026-10-02, `phoenix-crm` module memory: *"ADD VISIT
KEEPS EVERY POINT, AND ITS THREE OPTIONAL STEPS START FOLDED"* — "I don't need too many steps and too
many clicks by the reps"), so unfolding one needs his word first. The trade it bought is real and
measured: the visit form is fast, and the two fields that make a CRM a CRM are empty.

Account, with the registration-tax figures and the rest of the first field audit:
`docs/phoenix-crm-field-audit-2026-10-05.md`. Related: [[phoenix-crm-has-no-fraud-in-it-and-its-only-strong-flags-are-coarse-location]].
