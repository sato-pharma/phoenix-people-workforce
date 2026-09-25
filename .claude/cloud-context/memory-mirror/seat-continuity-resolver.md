---
name: seat-continuity-resolver
description: "Canonical helper for vacant-seat-aware workforce hierarchy + department-safe line scope"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3c6c9b6e-ddda-45a2-b4a9-d36fe935379b
---

`src/lib/workforce/hierarchy-resolver.ts` is the single source of truth for
seat-continuity-aware hierarchy. When a manager resigns, the DB trigger
`phx_release_terminal_manager_ownership` reassigns reports UPWARD
(`manager_hr_id` -> next manager) and stamps
`pending_manager_replacement_for_hr_id` with the departed manager's HR_ID.

Rule: reporting/grouping views must group reports under the VACANT SEAT, not the
upward-reassigned manager. `resolveSeatGrouping` has TWO-TIER precedence:
(1) `pending_manager_replacement_for_hr_id` marker; (2) FALLBACK — if the marker
was lost, an orphaned rep (manager == NSM) is grouped under the single open DSM
`position_vacancies` seat for that NSM+line via `selectVacantManagerSeat`. If 0 or
>1 open DSM seats exist it refuses to guess (no area-hierarchy: the `areas` table
has no parent/district field, and MR territory area != DSM district area). Use
`sameWorkforceDepartment` / `lineScopeIncludesEmployee` for department-safe LINE
scope (LINE-scoped roles see same line AND same department only).

Critical live-data finding (2026-05-29): the marker was NULL on the affected reps
(e.g. B-164 under NSM A-12, Pedia), so a pending-only fix did NOT activate — hence
the vacancy fallback. The fix reuses the open vacancies the directory already
loads (`directory.lookups.workforceVacancies`), no extra query. Organogram already
merged `position_vacancies`; performance + vacation did not.
See [[supabase-dual-project-schema]].
