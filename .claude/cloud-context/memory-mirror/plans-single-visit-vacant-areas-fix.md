---
name: plans-single-visit-vacant-areas-fix
description: "Single Visit's region->area cascade must show ALL areas incl. vacant seats; Double Visit/Coaching only staffed ones. Shipped PR #880."
metadata: 
  node_type: memory
  type: project
  originSessionId: 077fe765-844b-42c1-9ce2-4257a23a90b3
---

Weekly/Monthly Plan module (`src/lib/weekly-planning/service.ts`, `medicalRepOptionsForEmployee`). Owner-confirmed policy: **Single Visit** never auto-assigns a Medical Rep, so its Area dropdown (after Region is picked) must list every area in that region, including ones whose Medical Rep seat is currently vacant. **Double Visit/Coaching** need the opposite — only areas with a real, non-vacant same-line rep, since they auto-assign one. See [[plan-workspace-slot-workweek-linkage]] and [[sales-territory-scope-build]].

**Bug (fixed 2026-07-05, PR #880):** `medicalRepOptionsForEmployee` only sourced areas from active/hired employees, so an area with a vacant seat silently disappeared from the Area list for Single Visit too — even though the `requireAssignedRep=false` flag on the client (`areasForRegion` in `plans-workspace.tsx`) was already correctly wired for Single Visit. The gap was the *data source*, not the filter logic.

**Fix:** fold open Medical Rep `position_vacancies` rows (already loaded for free via `getEmployeeDirectory().lookups.medicalRepVacancies` — no new query needed) into the same options array as a `"Vacant Medical Rep Seat"` placeholder (hrId `vacancy:<code>`). The existing client-side `isVacantMedicalRep` regex (`/\bvacan(t|cy)\b/` on fullName+hrId) then naturally: (a) INCLUDES these for Single Visit's `areasForRegion(..., requireAssignedRep=false)`, (b) EXCLUDES them for Double Visit/Coaching's `requireAssignedRep=true` and for `eligibleRepsForArea`/auto-rep-assign. Respects the existing multi-line PM override (`allowedLineNames`/`overrideLineKeys`, e.g. Ahmed Sharaf B-155, see [[b155-two-line-pm-scope]]).

**Verification method (useful pattern):** rather than guessing, ran read-only SQL against PRODUCTION (`ozucdzovmcqvepbozvqf`) to find a real test employee + real open vacancies matching the user's example (Pedia line, Cairo region: active employee B-164/Nasr City only + 5 open `position_vacancies` — Cairo East 1/2, West, Heliopolis, Downtown+Shoubra — exactly the areas the user named). Confirms local dev pointing at prod (read-only) is usable for realistic data-driven verification without needing to mutate anything.

**Reusable gotcha — dev-auth needs a real hrId for plan-eligible roles:** `GET /api/dev-auth?role=X` with no `hrId` creates a session with no employee record, so `/employee-portals/plans` shows "Planning Unavailable" even for an eligible role. Must pass `&hrId=<real HR_ID>` to get a resolvable employee. Also: the weekly/monthly PLAN SUBMITTER eligibility list (`WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES` in `plan-v1.ts`) is **Product Manager, Group Product Manager, Marketing Manager, Training Manager, National Sales Manager only** — NOT Medical Rep/DSM/RM (those roles' "Field workweek" is a different concept — the workweek *shape* used when an eligible manager's plan references them, not submission eligibility itself). A prior memory conflated these; this one corrects it.
