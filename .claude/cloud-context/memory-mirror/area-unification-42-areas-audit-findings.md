---
name: area-unification-42-areas-audit-findings
description: "Deep read-only audit (2026-07-12) of organogram/employee-master/lifecycle/sales and why the current system resists the 42-area manager-driven model."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

Read-only audit backing [[area-unification-42-areas-design]]. How the system works TODAY and the friction points for the planned model.

**Current model:**
- Org backbone = `departments → lines → areas → teams` (bigint id + text code FKs). `positions`=role catalog; `position_vacancies`=seats + occupancy state (status open/filled/cancelled, filled_by_hr_id). Files: src/lib/reports/organogram-*.ts, vacancies.ts, employee-directory.ts.
- Only reporting edge = `employees.manager_hr_id` (text self-FK, case-sensitive FK but code joins with lower()). **Nothing derives area/region/team from the manager.**
- **Region is NOT a first-class org entity** — free text `employees.region_name` / `position_vacancies.region_name`. A real regions table exists ONLY in sales (`source_of_sales_regions`, code-based, strict 1 region per area, no line dimension).
- **`areas.line_id NOT NULL` + `areas.code` globally UNIQUE → an area belongs to exactly ONE line.** Not a fixed set; imports create areas freely. Disjoint from `source_of_sales_areas` (no FK bridge; org=bigint id, sales=text code).
- **`teams`** keyed by area_id, NO manager column; membership = manual `employees.team_id`. NOT manager-derived.
- Organogram is NOT stored — recomputed client-side each render by climbing manager_hr_id + classifying job-title strings ("dsm"/"nsm"/"rsm"); ~7 stacked heuristics. Region tier ≈ "an RSM-titled person exists". Vacant seats already counted via live-occupancy suppression (aligns with plan).
- Seat continuity: DB trigger reassigns a resigned manager's reports UPWARD and stamps `pending_manager_replacement_for_hr_id`; resolver src/lib/workforce/hierarchy-resolver.ts regroups them under the vacant seat.
- Lifecycle: offer→hire RPC inserts employee (requires manager, but sets region_name=NULL, team_id=NULL); resignation opens a vacancy (trigger-driven, preserves manager+region on the seat). NO transfer/promotion transition (silent field edits via upsertEmployee/bulkUpdateEmployees). `employee_history` is effectively DEAD (live RPCs skip it) and has NO manager/region columns.
- **Sales = TWO disjoint pipelines that never join:** (a) closing-sheet `sales_records` HAS targets + manager_hr_id + line + territory(area NAME text), NO region/area_id; manager-based team rollup ALREADY EXISTS (`buildTeamPerformanceForScope` in employee-portal/service.ts, incl. vacant areas; line/NSM totals). (b) Source-of-Sales = region_code/area_code/brick, NO targets, NO manager, region derived from area 1:1 global. Only shared vocab = line name.

**Already fits the plan (reuse):** manager-driven team rollup (buildTeamPerformanceForScope + buildSalesManagerPerformanceGroups); vacant seats count in structure; vacant areas carry sales+target; sales-without-target works (0%/neutral); an "Others" bucket (O-1/O-2/O-3 per line) already sits in line+company totals but not manager totals; seat continuity.

**Conflicts (must change):** (1) area welded to one line — can't do "same area, region per line"; need line-agnostic 42-area canonical set. (2) region not a manager-driven entity anywhere. (3) two sales pipelines have no join key — need area-name↔area-code↔region crosswalk (line-aware) = THE enabling prerequisite. (4) DM total is sum-of-reps, plan wants sum-of-areas(incl vacant). (5) "Other" pseudo-DM not assembled per-area + line target would leak an unmanaged area's target (must force Other target=0). (6) manager MOVES don't cascade region/team to reports (only departures cascade). (7) employee_history dead + no manager/region. (8) role/level inferred from job-title strings, not structure. (9) a ready-made governorate area canonicalizer `AREA_PREFIX_RULES` in src/lib/imports/employee-normalizers.ts exists but is UNUSED (dead code) — revive for the 42-area collapse.

**Sales/SoS audit (code-verified, re-run after an API-drop crash of the finder):** P0 — no crosswalk joins the two pipelines: `sales_records` has territory(name)+target+manager but NO area/region code; SoS has area_code/region_code but NO target/manager/employee; they meet only by line+product NAME. Building the `territory↔area_code↔per-line region↔manager` join is THE central task. P0 — SoS region is 1:1 GLOBAL (no line dim); attribution stops at region via a fragile region-NAME string match (no area→DM/rep path). P1 — TARGET DOUBLE-COUNT bug: admin `/sales` does naive SUM(target) while portal does MAX-per-territory dedup → same data, different totals/achievement per screen (service.ts:997/317, metrics.ts:213 vs metrics.ts:414-533). P1 — prod had 81 area rows for 40 real areas (import auto-creates dup areas on spelling variants) → clean build must FREEZE 42 codes + import map-or-reject, never create. P1 — blanket authenticated-read RLS still LIVE on 17 sales/reference tables (incl. confidential product prices); fix #1016 merged but NOT applied to prod; SoS closing engine reads exactly these. P2 — fuzzy vowel-strip area matching (looseAreaKey collapses e.g. Tanta→tnt); admin totals recomputed over a 500-row truncated set; Others(O-1/2/3) vs SoS DIRECT/NATIONAL bucket vocabularies don't correspond. "D3 over-deletion" is an org/areas-side incident, no sales-code commit.

**Terminology collision to watch:** in generic Phoenix org, RSM=region (tier ABOVE DSM). In the owner's model, the DM owns a "region" (B-119=District Manager, Alex-BHR region). Confirm whether new model is NSM→DM→rep (region=DM) or keeps an RSM layer in some lines.
