---
name: weekly-month-vs-target-access-bound-live-on-prod-2026-08-16
description: "Month vs Target targets are bounded by applyWeeklyAccessScope in month-target-scope.ts — LIVE prod 2026-08-16 (#2177); never remove that call, never restore the current-Cairo-month fallback"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0da5625e-dcac-499c-8ced-ec519381d576
  modified: 2026-08-16T19:09:06.291Z
---

The Weekly Summarized Report's **Tab 6 (Month vs Target)** shipped 2026-08-16 in `#2176` dividing
every manager's sales by the **national** target. `loadWeeklyDashboard` redacts the SALES via
`applyWeeklyAccessScope`, but `phx_monthly_targets` is `SECURITY DEFINER` with **no viewer bound**,
and the route narrowed it only by the URL filters. Fixed the same day in
[#2177](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2177), squash `82f6fa46`,
**live on prod 2026-08-16 22:08 Cairo** (confirmed via `/api/healthz` revision).

Measured on the real production August-2026 grid — a Regional Manager bounded to AB/D1/D2:

| line | national (what shipped) | his own | overstated |
| --- | ---: | ---: | ---: |
| CNS | 170,680 | 83,633.2 | 2.04x |
| Pedia | 32,605.29 | 18,223.425 | 1.79x |

He saw **71 of 71** line×area target rows; he should see **34**. 96 active accounts hold
`weekly_sales:read` on a non-full tier.

**Never undo any of these.**

- `src/lib/sales/weekly/month-target-scope.ts` — `const scoped = applyWeeklyAccessScope(widened, accessScope);`
  is THE bound. It is source-pinned in `tests/sales-head-office-lock.test.ts`, which runs in the
  required `validate` job. Removing it goes red — do not "fix" the pin.
- `regionCode` **must** be populated from the area master before that call.
  `applyWeeklyTerritoryScope` reads `(row.regionCode ?? "")` and `""` matches nothing, so an
  unresolved area fails **closed** and reads as "no target uploaded" rather than as a bug.
- **Medical Rep gets NO tab** (owner, 2026-08-16). `VS_TARGET_ROLES` is an explicit ALLOW-list —
  a new role gets nothing until someone decides. His other five tabs are unchanged.
- **A distributor filter SUPPRESSES the tab**, replaced by one sheet carrying the reason. A target
  belongs to an AREA, not to whoever delivered it. Do not restore the old caption-and-show.
- **Never restore the `?? currentCairoCycleMonth()` fallback.** The month follows the filter; a
  month with no upload shows its real target against zero sales and says so.
- "Filter requested" and "filter resolves to nothing" are DIFFERENT — `PreparedFilter.requested` is
  recorded before resolution. Collapsing them makes `?line=Head Office` widen the tab to every line.
- `droppedByAccessScope` is returned for tests but deliberately **NOT printed on the sheet** — the
  never-silent-drop rule covers mapping faults, not access redaction; printing it leaks how much
  territory the viewer cannot see. `unresolvedAreas` / `unrecognisedLines` DO reach the sheet.

Related: [[unmapped-products-must-never-reach-a-report]] is a different rule — this one is about
targets, not products. See also [[weekly-summarized-report-owner-rules]],
[[reusing-a-squash-merged-branch-makes-a-conflicting-pr]] (hit during this very merge — #2176
squash-merged the same branch mid-session, so #2177 opened CONFLICTING with zero checks).
