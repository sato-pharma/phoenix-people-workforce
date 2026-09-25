---
name: pm-gpm-vacancy-line-scope
description: "Business rule — PM/GPM MUST see the portal Vacancies tab scoped to their own line; do NOT restrict to DSM/NSM only."
metadata: 
  node_type: memory
  type: project
  originSessionId: 50c9ffda-c81f-455f-814f-8b17108e9f9d
---

Product Manager and Group Product Manager roles **must** see the employee-portal
Vacancies tab, **scoped to their own line only** (`isLineScoped` in
`getEmployeePortalVacancies`, `src/lib/employee-portal/service.ts`). This is the
owner's explicit requirement: "I want them to see vacancies related to their scope only."

A parallel session (Claude Sonnet 4.6) twice removed this — branch
`codex/hr-specialist-cleanup-final` / PR #154 → merged to main as `487c7c10`
("restrict vacancy visibility to DSM/NSM only"), arguing "title is display-only."
That broke the desired behavior (PM/GPM saw an empty Vacancies tab, since the nav
still showed it). It was reverted on 2026-06-14 as `eb857485` and deployed to
production (verified live, HTTP 200).

**Why:** PM/GPM legitimately need line-scoped vacancy visibility; the original
`62c913ec` feature (surface Organogram/Vacancies/Probation/Expenses to PM/GPM) is
correct and must stay. This is distinct from the general "[[job-title-not-a-permission-source]]"
rule — here the access is intended, scoped by the employee's `lineId`, not by title text.

**How to apply:** Do NOT re-restrict PM/GPM portal vacancy access to DSM/NSM only.
If a future change touches `getEmployeePortalVacancies`, keep the `isLineScoped`
branch (`isNsm || Product Manager || Group Product Manager`) and the
`row.line_id === currentEmployee.lineId` scoping. Watch for parallel sessions
re-introducing the restriction.

**Full visibility chain (all three must align for PM/GPM):**
1. Data — `getEmployeePortalVacancies` (`service.ts`): `isLineScoped` allows PM/GPM, scoped to `lineId`.
2. Permission — `defaultPermissionMatrix` in `permissions.ts`: PM + GPM both have `vacancies: ["read"]`.
3. **Sidebar flag** — `resolveEmployeePortalNavVisibility` in `src/lib/employee-portal/navigation.ts`:
   `showVacanciesTab` was hard-wired to DM/NSM only, so PM/GPM saw NO Vacancies sidebar link
   even though 1+2 allowed it. Fixed 2026-06-14 to also include `isProductManager || isGroupProductManager`
   (regression test added in `tests/employee-portal-navigation.test.ts`). Same half-wired pattern
   likely affects Probation/Organogram tabs for PM/GPM (`showProbationTab`/`showOrganogramTab` still DM/NSM-gated)
   — surface those too only if the owner asks.
