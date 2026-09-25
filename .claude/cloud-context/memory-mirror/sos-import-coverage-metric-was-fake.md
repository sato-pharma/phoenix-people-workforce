---
name: sos-import-coverage-metric-was-fake
description: "SoS import coverage read 100% by construction and wasn't recorded on the real path. Fixed by computeBrickCoverage + a row-reconciliation gate (PR #1451)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-29T08:22:04.914Z
---

2026-07-29, Phase 1 of the SoS integrity plan. **PR #1451** (branch
`codex/sos-phase1-integrity`, worktree `F:/Phoenix Workforce/_wt-sos-phase1`). Three commits.

## The trap worth remembering

`resolved_pct` in `sos_import_coverage_snapshots` was **100% by construction** and therefore
useless as an alarm:

```ts
resolvedRowsPct = importableRows / totalRows      // import-preview.ts:132
// persistNormalizedBatch (normalizer/service.ts):
total_rows: rows.length,
importable_rows: rows.length,                     // ← identical, always
```

*Importable* = the parser accepted the row. It says nothing about whether the row got a brick.
Every snapshot in prod reads `100.0`, including rows recording `mapped_customers: 0`.

**And it wasn't even running.** `saveCoverageSnapshot` was only wired to
`app/api/sales/monthly-import/validate` + `/commit`. All 18 June batches used
`persistNormalizedBatch` (`template_key='normalizer'`), which never called it — the newest snapshot
in prod predated the June import entirely. Measuring the wrong thing AND not executing.

## What replaced it

`computeBrickCoverage` in `src/lib/sales/import-coverage.ts` — of the rows that NEEDED a brick, how
many got one:
- blank/whitespace `brick_id` counts as **missing** (`import_rows` stores `''`, not `NULL` — the
  shape that made 3,184 June rows look fine)
- **DIRECT leaves the denominator**, never counted as failure (brick-level by design, no customer
  code; counting it would park coverage under any threshold and train everyone to ignore the alarm)
- units reported alongside rows — 50% of rows can be 90% of volume
- recorded on commit; logs `sos_import_low_brick_coverage` below `BRICK_COVERAGE_WARN_PCT` (98)

On June's real numbers this reads **95.1%** and fires.

Plus a **row-reconciliation gate**: chunked inserts throw on error but not on a chunk that succeeds
storing fewer rows than handed. Now counts what landed vs what was sent; on mismatch the batch is
`blocked` + `sos_import_row_reconciliation_failed` logged + commit throws, **before**
`finalizeSosBatchAndAuditSupersede` — after promotion a short import is already live. Rows are left
on disk, not deleted, so it can be diagnosed.

Also fixed `src/lib/crm/sync.ts` reconcile (same unordered-`.range()` class as
[[sos-unordered-pagination-lost-mappings]]) — **that one feeds DELETEs**: a skipped id leaves a
voided visit in the mirror; a repeated id inflates `existingIds.length`, the denominator of the 50%
cap meant to stop a truncated CRM response wiping a window.

## Deferred by the owner

**1.4 — asking PS/Overseas for a client address column.** `0%` of the June import had an address
(all 45,268 rows), which is the ceiling on auto-mapping: 824 unmapped customers had no place name
anywhere in their name. Owner said "skip 1.4 now" on 07-29. Phase 3 (AI-suggest, re-mapping) is
worth roughly a third as much without it.

Remaining plan: Phase 2 = confidence backfill + "worst mappings by revenue" queue + coarseness
report + `.range()` audit. Phase 4 = brick coordinates ([[brick-coordinates-are-geocoded-guesses]]).
See [[sos-owner-standing-rules-from-session-369dd08d]].
