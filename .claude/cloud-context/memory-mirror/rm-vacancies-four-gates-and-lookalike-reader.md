---
name: rm-vacancies-four-gates-and-lookalike-reader
description: "RM Vacancies needed 4 separate gates; a look-alike function (fetchOpenVacancySummaryForScope) already had an RM branch and made the page reader look done when it wasn't"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3edad962-84d8-49b6-8b66-d46fc9fd9a67
  modified: 2026-07-31T18:42:09.261Z
---

Owner-approved 2026-07-30: **Regional Manager gets portal Vacancies, region-scoped.** Built in
worktree `_wt-portal-nav-tidy`, branch `codex/portal-nav-tidy`.

✅ **SHIPPED — verified on `origin/main` 2026-07-31.** All three checkable gates are live:
`vacancies: ["read","export"]` in `permissions.ts`, `showVacanciesTab` in
`employee-portal/navigation.ts`, and `"Regional Manager"` in the Vacancies Report roles list in
`system-navigation.ts`. **The earlier "UNCOMMITTED / work lives in `_wt-portal-nav-tidy`" status
was stale** — that worktree was clean and had been recycled onto `codex/password-setup-work-email`;
it was removed 2026-07-31. The `codex/portal-nav-tidy` branch still exists **locally only**
(2 commits, never pushed, now behind main) — it is superseded, but nothing was lost by removing the
worktree, because removing a worktree never deletes its branch.

**Four gates had to agree** (same trap shape as [[weekly-plan-four-gates-rm-dsm]]):
1. `defaultPermissionMatrix` — RM had **no `vacancies` key** at all → `canAccess` refused. Added
   `vacancies: ["read","export"]`.
2. Sidebar flag `showVacanciesTab` (`src/lib/employee-portal/navigation.ts`) — RM missing.
3. Command-palette roles list (`src/config/system-navigation.ts`) — RM missing there for BOTH
   Vacancies and Organogram (Organogram drift was pre-existing: RM had the sidebar tab already).
4. The page reader `getEmployeePortalVacancies` — early return `if (!isDsm && !isLineScoped &&
   !isCompanyScoped) return null` dropped RM before any scoping.

**THE TRAP that cost the most time:** `src/lib/employee-portal/service.ts` has TWO vacancy readers
that look alike. `fetchOpenVacancySummaryForScope` (~line 2969, feeds the Command Center open-seat
count) **already had a full RM region branch** — `regionsWithinManagerHierarchy` + `line_id` +
`normalizeRegionLabel`. I found that branch, assumed it was the page's reader, and reported "the
data layer is RM-ready, only the permission is missing." Wrong: the page uses
`getEmployeePortalVacancies` (~line 5042), which had no RM support. Granting gates 1–3 alone
produced a **visible tab that dead-ends on "Vacancies Unavailable"** — caught only by live
role-by-role browser checks, not by any test.

**Both empty states on the vacancies page share the title "Vacancies Unavailable"** but have
different messages ("Vacancies are available for…" = permission blocked; "This page is available
for…" = reader returned null). Grepping the TITLE cannot tell the two apart — always grep the
message when diagnosing.

**dev-auth gotcha:** `/api/dev-auth?role=X` sets `hrId=null` by default, which collapses scope so
`canAccess` returns false for EVERYTHING — a District Manager (who definitely holds the grant) also
showed "blocked". Always pass `&hrId=<real HR_ID>` when testing a permission, or you will diagnose
a permission bug that isn't there.

**Verified live** (local dev server on the worktree, production Supabase): RM PD-0001 (Hany Saad,
line_id 2, 3 DSMs covering ALEX-BHR / Delta (1) / Delta (2)) sees exactly **6 of the line's 18**
open seats — only ALEX-BHR + Delta (2); Cairo/Giza/Upper Egypt correctly excluded. Medical Rep
still permission-blocked. Fails closed when the region set is empty.

**How to apply:** before declaring a role's data layer "already ready", confirm the function you
read is the one the PAGE calls — grep the page's import, don't pattern-match on a similar body.
See [[dm-sales-scope-drops-out-of-region-areas]] for the seat-vs-region-label rule this scoping obeys.
