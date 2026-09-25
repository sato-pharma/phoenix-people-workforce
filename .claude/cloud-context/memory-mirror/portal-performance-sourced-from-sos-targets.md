---
name: portal-performance-sourced-from-sos-targets
description: "All sales performance pages read SoS+targets via the vs-target engine, not sales_records; vacant-DSM reps group as \"no DM\" by design."
metadata: 
  node_type: memory
  type: project
  originSessionId: a4e49f65-2781-407c-ab8f-e27cdb3b5412
  modified: 2026-08-09T16:59:48.337Z
---

Since PR #1962 (merged 2026-08-09, prod `368002b8`), **every sales *performance* surface reads
actuals from Source of Sales + Direct Orders and targets from `au.monthly_targets`**, via the same
`au.f_monthly_achievement` engine `/sales-vs-target` uses — NOT from `sales_records` /
`v_employee_portal_sales`. Adapter: `src/lib/employee-portal/sos-team-performance.ts`; the entrypoints
`getNsmDsmPerformance`, `getDsmTeamPerformance`, `getCompanyMedRepPerformance`,
`getCompanyDsmPerformance`, `getRmRegionalPerformance` all delegate to it. First month is **July 2026**
(`SALES_VS_TARGET_FLOOR`). The old `buildTeamPerformanceForScope` / `buildDsmPerformanceForLineScope`
were deleted.

**Why:** owner asked (2026-08-09) to wire these off sales_records onto SoS + targets with today's-geography
attribution. Reconciles exactly with `/sales-vs-target` and Monthly Closing.

**How to apply / gotchas:**
- Achievement % is **covered-actual ÷ target** (coverage-aware); a rep/product with sales but no target
  shows the sales with 0 target and does NOT inflate %. Headline totals come from the engine's `totalRows`
  (all scoped rows), so the leaderboard foots to LESS than the headline by the unattributed slice
  (Direct Orders across regions + vacant seats — up to ~39% of a line's July actual). This is intentional,
  same as `/sales-vs-target`. As of **PR #1968 (prod `7a315447`, 2026-08-09)** every performance page renders a
  `PerformanceReconciliationNote` showing that unattributed slice so the header foots to the leaderboard VISIBLY
  (header = Σ members + unattributed). Do NOT strip the note as clutter, and "header ≠ rows" is NOT a bug. The
  math is the dependency-free `reconcileUnattributed` in `src/lib/employee-portal/performance-reconciliation.ts`
  (unit-tested in `tests/performance-reconciliation.test.ts`). The RM command center is untouched — it already
  foots to its own rows (excludes the slice from BOTH header and list); its vacant-seat handling is a separate,
  still-open latent bug (region total drops null-DM rows).
- **Seat continuity moved to the DB engine** (occupant as of period end, `au.occupancy_history`). A rep whose
  DM seat is **vacant** now groups as "no DM" (dm_hr_id null), NOT under the old synthetic "Vacant DSM seat"
  label. If an NSM reports "a rep's district shows blank after the DSM resigned", that is BY DESIGN now — do
  not treat it as a regression and do not re-add `resolveSeatGrouping`/`resolveNsmVacantDsmSeat` to the
  performance path. The source-guard test in `tests/workforce-hierarchy-continuity.test.ts` now locks the
  SoS wiring, not the old resolver.
- CEO company total = Σ NSM lines; RM region = subset-sum of its line. Verified live July 2026: company
  10,497,947 sales / 20,842,604 target / 46.9%; CNS line 50.8%, Pedia 39.7%, Anti-infective 29.8%.
- A rep with SoS sales but no target (e.g. `AI-0005` in July) shows "no target"/0% until a target is set —
  data gap, fixed by loading the target, not by code. See [[system-flags-expenses-never-rejects]] mindset.
