---
name: sos-upload-block-vs-warn-policy
description: "LOCKED owner rule for /sales/upload — exactly which validator findings BLOCK vs WARN"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ed35b8f5-5eb6-4d42-9da0-50c378aeda1e
---

LOCKED owner policy for the monthly Sales upload (`/sales/upload`), shipped PR #370 (`8e9433ae`, merged to main + prod 2026-06-20).

**An upload BLOCKS only when the system can't use the file or importing would corrupt/double-count data. Every pure data-quality issue is an advisory WARNING that never blocks** (shown, but Confirm & upload stays enabled; the operator decides).

BLOCK (error severity / flow gate):
- unmapped rows (product/customer/brick/territory) — `commitMonthlyUpload` exceptions gate, status "blocked"
- duplicate sheet — `period_replace` (promoted warning→error; "delete it first in Uploaded Sheets, then re-upload"; no more silent replace) + DB `duplicate_sales_batch` 409 backstop
- unreadable file / column mismatch — `dark_exceptions`
- nothing recognized / rows don't reconcile — `no_coded_rows`, `all_rows_ignored`, `rows_read_mismatch`
- broken geography (corrupts regional totals) — `brick_to_region_inconsistent`, `blank_geography`
- (long-standing structural stops: coded-sheet, header mismatch, missing/multi period)

WARN only — NEVER block (do not re-promote these to error):
- `duplicate_rows` (duplicate sales LINES — the original complaint), `future_dated_rows`, `blank_invoice_date` (no >50% escalation), returns/negative/zero value, discount range, extreme unit price, low recognition, anomalies vs prior, detector-disagrees, etc.

**Why:** in pharma, partial-pack/fractional and repeated lines are normal data; over-strict blocks stopped legitimate uploads. **How to apply:** severity is set in `src/lib/sales/upload-validation.ts`; commit gates on `!validation.ok` only (the per-finding **acknowledgement** system was removed — warnings need no checkbox). See [[sales-upload-two-pages-weekly-wizard]] and [[sos-perfect-module-plan]]. Fractional-qty check already removed in PR #368.
