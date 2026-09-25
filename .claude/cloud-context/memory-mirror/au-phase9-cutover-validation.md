---
name: au-phase9-cutover-validation
description: "Verified prod/staging facts for the area-unification Phase-9 cutover (FIX-E public.areas remap + FIX-D occupancy) — read before authoring/applying either"
metadata:
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

**Read-only prod validation done 2026-07-18 (owner approved SELECT-only on prod ozucdzovmcqvepbozvqf).**

**public.areas (prod):** 90 rows — ids 1–80 + 1011 + 1029–1037. Codes are lowercase slugs (`alex_center`, `cairo`); canonical codes (AB1, GZ2…) don't collide. `code` is UNIQUE (`areas_code_key`); `line_id` currently NOT NULL (migration 20260712233618 drops the NOT NULL — must run before FIX-E). **Prod area ids ALIGN with the staging `au.area_migration_map` old_area_ids** (prod was a clone) — so the map transfers, EXCEPT the 4 `ai_`/`pd_` orphans **1029/1030/1033/1037 which are NOT in the map AND unreferenced by any of the 9 FK tables** → safe to just deactivate.

**9 FK tables → public.areas(id)** (from 20260712233618): employees, employee_history, coaching_reports, job_offers, marketing_customers, marketing_pharmacies, marketing_requests, position_vacancies, positions. Only denormalized display name to re-sync = `employees.area_name` (marketing `extracted_area_name`, `residence_area`, `area_of_development`, `job_offers.area_scope` are source/other — leave alone).

**Region/office rows are KEPT (deactivated, not deleted).** Map kind region/office = old ids **1(Cairo),7(Giza),16(Upper Egypt),23(ALEX-BHR),29(Delta1),35(Delta2),42(Egypt),80(Head office)**. Their active-employee occupants were verified to be **exclusively DSM/RSM/NSM/PM/GPM + Head-Office roles** (CEO,HR,Marketing,Admin,R&D,Training,SFE,QPPV…) — legitimately no single 42-area. Leave their area_id pointing at the now-inactive region/office row (zero loss); they drop out of the active field picker, exactly as staging. Staging end-state = 50 area rows / **42 active**, active emps on 42 canonical + a few on inactive head_office/egypt/giza + 23 null.

**APPLIED TO PRODUCTION 2026-07-18** (owner-approved go-live): all 21 au migrations + FIX-E + FIX-D applied via MCP apply_migration in order; dry-run (raise-to-rollback) green first. Final prod state VERIFIED: 42 active areas (48 legacy retired, kept), 97 emps on canonical, 39 managers/HO on kept region/office rows, 3 pre-existing null-area actives, occupancy 99 person/33 vacant, **0 employees stranded on a collapsed legacy area**. Backup in `_au_rollback` schema (drop after stable). Then merged branch → main (production deploy). If rollback needed: restore area_id from `_au_rollback.*`, re-activate legacy areas, or Supabase PITR.

**FIX-E authored:** `supabase/migrations/20260718120000_au_public_areas_cutover_phase9.sql` — a guarded DO block: insert 42 canonical → build old→new remap → HARD GUARD (abort if any referenced id is neither canonical/mapped/region-office) → remap 9 tables → resync employees.area_name → deactivate non-canonical → assert 42 active + no leftover. Sorts AFTER prod head (20260717134435) so it applies last. **Not yet dry-run** (needs owner-approved BEGIN/ROLLBACK on prod at cutover). Migrations are human-gated (not auto-applied on deploy) per [[gcp-cloud-run-migration-2026-07]].

**FIX-D (occupancy) — schema facts:** `employees` has `hire_date`(date)=**master hiring date** ([[au-occupancy-hiring-date-from-master]]), `employment_status`, `hr_id`, `line_id/line_name`, `area_id/area_name`, `position_id/job_title`, `manager_hr_id`, `resignation_date`. `au.seats` cols: seat_id, seat_tier, line_code, region_code, area_code, rsm_group, parent_seat_id, is_other_pseudo_dm, seat_label, is_active, effective_from/to. STILL TO INSPECT before authoring D: au.occupancy_history columns + au.hire_into_seat RPC (employee→seat mapping) + how the seed built the 132 occupancy rows. See [[field-sales-3way-report-spec]], area-unification audit task #80.
