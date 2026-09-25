---
name: direct-is-not-cumulative-but-is-de-cumulated-anyway
description: "Direct weekly sheets are per-week not cumulative — fixed 2026-08-15 with a per-distributor `cumulative` flag honoured on BOTH de-cumulation paths"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b612b65-4e36-471e-997c-1c2d24313b24
  modified: 2026-08-15T12:29:27.241Z
---

Weekly Sales de-cumulates each sheet against the prior one (real week = this sheet minus last). That
is right for six distributors and **wrong for Direct**, which is invoice-keyed: each Direct sheet
carries only that week's own orders.

**Proven from stored rows, not inferred from the negatives.** Across the Direct 2026-05 cycle's weeks
2 and 3, of 26 distinct branch×product cells only **7 appear in both** — 10 vanish, 9 are new. A
running total cannot lose cells. The only two negative week-over-week steps in the whole module were
both Direct: 2026-05 W3 → −65,198.50 and 2026-07 W2 → −418,067.75.

**Fixed in #2157 and LIVE ON PRODUCTION since 2026-08-15 15:29 Cairo (squash `26e35801`, confirmed
by `/api/healthz` revision) — do NOT undo.** Read-time correction only; no stored row moved. Added
`cumulative` to `WEEKLY_DISTRIBUTORS` in `distributors.ts`, read ONLY through
`weeklyDistributorIsCumulative()` — it defaults to **true**, including for an unknown or null code,
so the old behaviour stays the safe fallback and only Direct opts out.

**THERE ARE TWO DE-CUMULATION PATHS — fixing one is a silent half-fix:**

1. `decumulateRows()` ([decumulate.ts]) — the **dashboard**. `loadWeeklyDashboard` de-cumulates
   before anything else ([service.ts:1131]), so this was never just a preview bug.
2. `computeThisWeekOnly()` ([service.ts:87]) — the **upload preview**, which subtracts the prior
   batch's stored `total_sales_value` header instead of row cells. Miss this one and Direct still
   shows a negative "this week only" on the validation screen.

Both new test assertions were break-tested: marking Direct cumulative fails with an actual of exactly
`-65198.5`, and removing the service guard fails its own source assertion.

**How to apply:** never add a de-cumulation call without routing it through
`weeklyDistributorIsCumulative()`, and never "fix" a negative week by disabling de-cumulation
globally — test 8 exists to catch exactly that
([[weekly-batch-header-drifts-from-its-own-rows]], [[weekly-module-audit-2026-08-15]]).
