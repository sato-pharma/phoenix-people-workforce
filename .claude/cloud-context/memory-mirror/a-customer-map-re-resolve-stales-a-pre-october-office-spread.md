---
name: a-customer-map-re-resolve-stales-a-pre-october-office-spread
description: "Re-pointing a month's rows to the active customer map moves the non-Office base the Office spread was weighted from, and for any month before 2026-10 nothing re-runs it — refreshBatchRollups does not reach computeOfficeAllocation and the read-time respread starts at October."
metadata:
  node_type: memory
  type: project
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
  modified: 2026-10-09T17:56:58.908Z
---

A bulk re-resolve of import rows against the active customer→brick map fixes only the **own-sales**
half of an area's achievement. The Office channel carries no geography: `computeOfficeAllocation`
spreads it by each area's share of the line's non-Office **value**, computed once when the Office
book is committed and frozen into the rows. Verified on 2026-10-09 against the source, not inferred:
`computeOfficeAllocation` has exactly two callers — `src/lib/sales/office-upload.ts` (the commit
path, the only one that writes a spread) and `scripts/check-office-golden-rule.ts` (no Supabase
client) — and `refreshBatchRollups` reaches neither. `isOfficeRespreadActive` is a `YYYY-MM` string
compare against `OFFICE_RESPREAD_START_PERIOD = "2026-10"`
(`src/lib/sales/office-distributor.ts:63`), so **September and earlier read their stored Office rows
as stamped**, on his own 2026-10-09 ruling — "leave the Office respread at October".

So after re-pointing September's rows, an area keeps the Office credit its pre-remap share earned.
Sohag 1 CNS was 983,492.96 EGP against a 337,595.66 target (291%) with **591,890 of it Office** —
re-pointing moved 160,437.05 EGP of own sales out and left the Office 60% untouched.

**Why:** the drift is invisible by construction — the published-closing drift check compares today's
shares applied to the line's own stored Office total, so both sides hold identical units per line and
that one scalar always matches. August CNS carried the same shape unnoticed.

**How to apply:** when a remap, brick move or late distributor book changes a month's non-Office
base, say in the same report that the month's Office geography is now stale and give the measured
number from `scripts/check-office-allocation-drift.ts <period>`, run from a tree on `origin/main`
(see [[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]]). Never fix it by
re-committing the Office book — `allocateProduct` drops every product netting ≤ 0 inside the locked
region, so the recompute totals *higher* than the file — and never move
`OFFICE_RESPREAD_START_PERIOD` without his own new word. Related:
[[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]].
