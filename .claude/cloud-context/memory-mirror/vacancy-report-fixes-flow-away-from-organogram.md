---
name: vacancy-report-fixes-flow-away-from-organogram
description: "Owner rule: Organogram/AU seat model is the fixed source of truth for org-structure+vacancy data — any future reconciliation fix must change the Vacancy Report / position_vacancies side, never Organogram."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f4c685f6-a2b8-4766-8b85-ef694c95c576
  modified: 2026-07-20T21:17:56.007Z
---

**Owner ruling (2026-07-20):** after making the Vacancy Report's tree read directly from the
organogram's AU seat model (`buildOrganogramSeatReport`) and reconciling the flat
`position_vacancies`-sourced list against organogram occupancy — see
[[organogram-vacancy-occupancy-truth]] for the underlying "seats are fixed, occupancy decides"
principle this extends — the owner set an explicit direction rule: **any future fix to a
discrepancy between the two surfaces must be made on the Vacancy Report / `position_vacancies`
side, never by touching the Organogram or the `au` seat model.** Organogram is the fixed source
of truth; it does not get adjusted to reconcile with anything downstream of it.

**Why this matters concretely:** one known gap was flagged in the same session — a structurally
vacant seat in the AU model with no corresponding `position_vacancies` row won't appear as a row
in the flat Vacancy Report table (though it correctly shows as vacant on the organogram chart,
since the chart now reads the AU model directly). Per this rule, closing that gap means
creating/backfilling the missing `position_vacancies` row, or adjusting the Vacancy Report's own
row-derivation logic — never adjusting `au.seats` / `au.occupancy_history` / `au_v_org_tree` /
`buildOrganogramSeatReport` / `getOrganogramReport` to hide, reshape, or otherwise accommodate a
downstream gap.

**How to apply:** before touching any file in the AU seat-model path
(`src/lib/reports/organogram-au-source.ts`, the `au` schema, `au_v_org_tree`, or
`getOrganogramReport` in `src/lib/reports/organogram.ts`) as part of a "fix the discrepancy"
task — stop, that's the wrong direction. The correct target is `src/lib/reports/vacancies.ts`
(`getVacancyReport`, `position_vacancies` reads/writes) or the AU-backed vacancy-report plumbing
added alongside it in `organogram.ts` (`buildAuBackedVacancyReport`,
`reconcileVacancyRowsAgainstOccupancy`, `scopeAuVacancyReportToLines`,
`scopeAuVacancyReportToTeam`). This applies even to legitimate-looking fixes (e.g. a "missing row"
gap) — the fix is to make position_vacancies/Vacancy-Report agree with Organogram, never the
reverse.

See [[organogram-vacancy-occupancy-truth]], [[au-phase9-cutover-validation]].
