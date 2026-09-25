---
name: organogram-has-two-data-paths-suppress-only-hits-vacancies
description: "The org-chart PAGE uses the AU seat model (no suppression); suppressFilledVacancyRows/Fix-1 only affects the Vacancies report + CEO seat count."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0aa539e7-1a4c-4b0e-bc7d-ae3b0a6dbee4
  modified: 2026-08-15T23:26:53.009Z
---

The organogram has **two independent data paths**, and `suppressFilledVacancyRows` /
`applyOrganogramMirrorSafety` only touches ONE of them:

- **Org-chart PAGE** (`/workspace/organogram`, `/employee-portals/organogram`):
  `getOrganogramReport` → `buildOrganogramSeatReport()` reads the **AU seat model**
  (`public.au_v_org_tree`) → `org-chart.tsx` calls `buildOrganogramLanes`. This path
  **never calls `applyOrganogramMirrorSafety`/`suppressFilledVacancyRows`.** In
  `au_v_org_tree`, manager (DM/NSM) seats carry `area_name = NULL` (area is in the
  `seat_id` suffix like `SEAT-AIF-DM-CA`), and each area has exactly one DM seat — so
  there are no duplicate phantom DM rows to suppress at the source.
- **Vacancies report + CEO-landing open-seat count**: built from `position_vacancies`
  (+ `employees`) → `applyOrganogramMirrorSafety` → `suppressFilledVacancyRows`.
  `position_vacancies` has NO `line_name`/`area_name`/`position_title` columns — line/area
  come by joining on `line_id`/`area_id`; the title is `job_title`. This is the path where
  stale filled-DSM vacancy rows inflate the seat count.

Consequence: a change to `suppressFilledVacancyRows` (e.g. #2166 phantom-seat Fix 1)
does **NOT** change what the org-chart page renders — only the Vacancies report and the
CEO-landing open-seat count. Confirmed live 2026-08-16: exactly 3 stale DSM rows in prod
(`175`/`251` Cairo→AI-0001, `276` Giza→AI-0007, all naming an old NSM while the area is
held by a DSM now under AI-0008) are suppressed by Fix 1, netting 2 phantom DSM boxes
removed; genuine open DSM vac `308` (Upper Egypt) still renders. See
[[organogram-phantom-seat-fix-2166-live-on-prod-2026-08-16]].
