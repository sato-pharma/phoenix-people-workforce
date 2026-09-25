---
name: employee-import-payroll-ineligible-block-fix
description: "Root cause of the recurring employee-master-import \"cannot be reactivated\" block on active execs — payroll_eligible=false wrongly treated as terminal"
metadata: 
  node_type: memory
  type: project
  originSessionId: 68d2336e-094e-4a97-b24a-bf1c4012e802
  modified: 2026-08-22T22:24:17.604Z
---

The employee **master import** repeatedly (3rd/4th time) skipped valid rows with
"HR_ID … belongs to an inactive, hidden, resigned, or payroll-ineligible employee and
cannot be reactivated by import." for **active** execs: AA (CEO Anwar Gaweesh), AB (Sahar
Khalil R&D Mgr), B-185 (Ahmed El Maraghy), OF-0002 (Adel El Sayed Financial Advisor).

**Root cause:** `isActiveImportEmployee` in `src/lib/imports/employee-import-existing-state.ts`
ANDed `employment_status ∈ {active,on_leave}` **with** `organogram_visible !== false` **and**
`payroll_eligible !== false`. Those two flags are lifecycle-orthogonal (the CEO is
`payroll_eligible=false` but very much active) → they wrongly landed in
`protectedLifecycleHrIds`/`terminalEmployeeHrIds`, blocking updates. Prod blast radius: 6
active wrongly-protected, 51 genuinely terminal (resigned/terminated/historical_payroll_record/system_placeholder).
Second latent bug: confirm route `employeeValues()` hardcoded `organogram_visible:true,
payroll_eligible:true` on every upsert → unblocking alone would push the CEO onto payroll.

**Fix (branch `codex/fix-employee-import-payroll-ineligible-block`, commit 178ccedd, PR #1386 MERGED 2026-07-27 squash 97901c1b — reached prod at the next ~2h batched deploy window *(that pipeline is gone; since 2026-08-01 a merge ships immediately via Railway — [[railway-merge-is-the-production-deploy]])*; worktree _wt-emp-import-fix awaits owner CLEAN):**
extracted status-only predicate into new `src/lib/imports/employee-lifecycle.ts` (unit-tested,
Supabase-free); confirm route now honours explicit file flag / defaults only for new hires /
leaves existing flags untouched. Full harden gate green. Also restores payroll-ineligible execs
as valid managers + seat-holders (latent `manager_hr_id_not_found`/seat bug). Test:
`tests/employee-import-lifecycle.test.ts`.

**Still OPEN (same upload):**
- Rows 51/56 "duplicate_employee_org_seat_existing": different HR_ID on bricks held by active reps
  B-170 (Gharbia 2/Mahalla, area 1104/D15) and B-158 (Gharbia 1/Tanta, area 1103/D14). FIX PR
  #1387 (branch codex/fix-employee-import-seat-relocation, commit 8c83db73, MERGED 2026-07-27 squash 3fd19f8d) makes the
  existing-seat check **relocation-aware**: skips the block when the current DB owner is moved to a
  DIFFERENT seat elsewhere in the SAME upload (they vacate it). CONSERVATIVE — only unblocks on
  positive relocation evidence; if B-170/B-158 are NOT relocated in the file, 51/56 stay blocked =
  real data question (still need .xlsx to confirm). Seat check in `employee-validator.ts` was
  pre-import-snapshot-only.
- **Family C (area↔sales-area + region auto-populate)** IN PROGRESS 07-27. Owner decisions: PERSIST
  `employees.region_code` (migration), apply EVERYWHERE (edit form + import + directory), resolver
  FIRST. Region is fully determined by **(line, area)** via `au_v_line_area_map.operational_region_code`
  → `au_v_regions.region_name`. lines.code == au line_code for the 3 sales lines (anti_infective/
  pedia/cns); head_office not a sales line → region_code NULL. Backfill resolves 76/113 active.
  PR1 resolver `src/lib/employees/region-resolver.ts` = #1389 MERGED (180722a9; keyed on line+area).
  PR2 #1390 MERGED (febfbb7d): migration `20260727153042_employees_region_code` APPLIED to
  staging+prod & verified (region_code live: 76/113 active backfilled, Head-Office NULL, region_name
  untouched). PR4 #1391 MERGED (6820ddd1): import derives region_code + precise region_name.
  PR3 #1393 OPEN: server-side derivation in employee-directory.ts employeePayload + bulkUpdateEmployees
  (new resolveRegionByIds + pure employeeRegionFields) — every edit-form save persists region_code +
  precise region_name (PR3 #1393 MERGED 020dbb5a). PR5 #1394 OPEN (LAST): directory read path exposes
  region_code (select + JoinedEmployeeDbRow + EmployeeDirectoryRecord.regionCode OPTIONAL + 4 row maps)
  + detail panel shows Area ID + Region Code. PR5 #1394 MERGED (47068b7c) — **Family C COMPLETE** (all
  5 PRs merged): region derived from sales area everywhere (import + edit-save + bulk), region_code
  live, identifier surfaced. TRAP HIT: `pnpm run typecheck 2>&1 | Select-Object` FALSE-GREENED (native
  stderr wrap aborts pipe, masks tsc errors) → CI caught 4 TS2741 (regionCode required broke synthetic
  EmployeeDirectoryRow builds) → made regionCode optional. Use `pnpm run typecheck; $LASTEXITCODE` NO 2>&1. Edit-form Region input
  still text (server-overridden for sales) → optional future read-only tweak. Older note below:
  PR3 = server-side region derivation in `employee-directory.ts` `employeePayload`/`upsertEmployee`
  (+ `bulkUpdateEmployees`): resolve area_id→code + line_id→code then crosswalk, persist
  region_code+precise region_name on every edit-form save (CENTRAL high-risk HR write path → role
  tests + browser verify). PR5 = directory UI Area(id+name)+Region(name+code). Paused: browser verify
  constrained (worktree can't cleanly run dev server per [[preview-start-ignores-worktree-cwd]];
  concurrent session owns main checkout). worktree _wt-emp-import-fix awaits owner CLEAN.
  **Region-name policy: use the PRECISE au region name.** KEY ORG FACT: the SAME area maps to
  DIFFERENT regions across lines BY DESIGN — e.g. Anti Infective splits Upper Egypt into "Upper Egypt
  1/2" (Nosaiba is a senior med rep ACTING AS DM, TEMPORARY until her assignment ends), while other
  lines keep UE unified. Do NOT special-case in code — au crosswalk is source of truth; when Nosaiba's
  arrangement ends, au is updated and derivation follows. Relates to [[au-schema-is-the-org-sos-linkage]].

**Prod data fix applied:** B-185 job_title `Admin Manager` → `Finance and Admin Manager`.
