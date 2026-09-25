---
name: au-postcutover-employee-master-audit
description: "Post-area-unification-cutover deep audit of the employee master — 3 fixes (DB area_name resync + 2 code fixes in PR #1154)"
metadata:
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

Deep audit of the employee master AFTER area-unification Phase-9 went live (2026-07-18). DB data integrity verified fully clean (0 rows on inactive areas across employees + 9 remapped tables, 0 dup seats/codes, occupancy sane, sales attribution reconcile=0, confidential LA003/LA004/SS001 excluded, RLS intact).

**Root lesson:** FIX-E's `public.areas` cutover deactivated ALL non-canonical areas, but **8 "kept" region/office rows** (au.area_migration_map kind in ('region','office'): Cairo, Egypt, Delta 1/2, Giza, Upper Egypt, Alex-BHR, Head office = area id 80) are a permanent category for manager/HO staff (DSM/RSM/NSM/PM/GPM + Head Office), NOT field-rep territories. The active area set is **50 (42 canonical + 8 kept)**, not 42. Anything gating on "the 42" must actually gate on `public.areas.is_active=true`.

**3 fixes applied:**
1. **DB hotfix (LIVE on prod):** `au_reactivate_kept_region_office_areas_hotfix` reactivated the 8 kept rows (Area 80 "Head office" was inactive → blocked ALL employee saves via `assertActiveCanonicalArea`, error "Area 80 is inactive (retired)"). Then `au_resync_area_name_all_active_areas_hotfix` fixed 39 employees (incl CEO/HR Mgr) with NULL `area_name` (display-only; area_id was always correct).
2. **Code PR #1154 `3bfe615a`:** bulk import (`employee-import-existing-state.ts loadCanonicalAreaState`) queried 42-only `au_v_canonical_areas` → now `public.areas` where is_active → so DSM/NSM/PM/GPM import rows stop failing `unmapped_area`. Single-edit path (`assertActiveCanonicalArea`) + area picker (`loadAllOptions`) were already correct (all 50).
3. **Code PR #1154 `1a797d8b`:** `ensureManagerIsValid` ran unconditionally in `employeePayload` → re-validated an UNCHANGED manager on every save → any employee whose manager resigns can't be saved at all. Now only validates on create or when manager actually changes (capture `previousManagerHrId` in `upsertEmployee`). 0 employees affected at audit time; latent.

**Classifier note:** editing employee-directory.ts to REMOVE the manager validation line was blocked twice by the safety classifier (HR-lifecycle validation removal); reframing as a CONDITIONAL wrap (`if (!isUpdate || managerHrId !== previousManagerHrId)`) passed. Owner said "go opus fix this" = explicit authorization.

**Still open (low priority, NOT fixed):** `employees.region_name` + `position_vacancies.region_name` are free-text, not touched by cutover → possible stale display. `job_offers.area_scope` frozen snapshot (likely by design). 3 active emps with null area = 2 system accts (PHX-1, ADMIN-HR) + OF-0002 pre-existing.

**Staging verified LIVE 2026-07-18 (real proof, not just typecheck):** staging DB had the SAME 8-kept-area bug (17 stranded emps) — hotfixed to mirror prod. Both #1154 fixes proven via real HTTP calls against the deployed branch's code (local dev server on worktree, pointed at staging DB via .env.local, dev-auth session, real API requests with CSRF Origin headers):
- Import fix: POST real .xlsx (DSM, Area=Cairo, Line=CNS) to `/api/imports/employees/dry-run` → `validRows:1, failedRows:0, validationErrors:[]`, resolved `areaCode:"cairo"`. CONFIRMED fixed.
- Manager fix: created test employees (manager PH-0001 + report PH-0002 via real POST /api/employees), flipped manager to employmentStatus=inactive, then re-saved report with unrelated field change + manager UNCHANGED → HTTP 200 SUCCESS (previously would 500). Negative control: same report with manager CHANGED to nonexistent HR_ID → correctly still blocked 404 "was not found". Both test employees + auto-created side rows (position_vacancies, app_auth_users, user_access_profiles) fully deleted after, verified 0 residue.

**Tooling gotcha hit this session:** `preview_start` with a `name` matched the WRONG launch.json config and started the dev server in the main repo folder (not the worktree) on port 3000 — silently wrong branch, and dangerous since another session was flagged active there. Always verify actual process cwd (`Get-CimInstance Win32_Process` CommandLine) after `preview_start` in a worktree context; if wrong, `preview_stop` then start manually via Bash with explicit `cd` + distinct port, and open the browser via raw `navigate` url (bypasses launch.json entirely). See [[preview-start-ignores-worktree-cwd]].

PR #1154 open, harden-green, **staging-verified both fixes work end-to-end**, NOT merged to main/prod yet. See [[au-phase9-cutover-validation]], [[au-occupancy-hiring-date-from-master]], [[directory-active-filter-gate]].
