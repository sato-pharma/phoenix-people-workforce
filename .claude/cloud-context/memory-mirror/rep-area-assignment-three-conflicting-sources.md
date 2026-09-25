---
name: rep-area-assignment-three-conflicting-sources
description: "Three independent rep→area sources (employees.area_id, au.seats.area_code, sales_records.territory) disagree for 7 active reps; Gharbia pair FIXED in prod 2026-07-28, 5 still unresolved"
metadata: 
  node_type: memory
  type: project
  originSessionId: 63b03dd4-cf84-4102-9c2f-a6e966d0cb39
  modified: 2026-07-28T03:25:50.584Z
---

The Double Visit / Coaching auto-fill in weekly-monthly plans resolves the partner rep by
**matching `employees.area_name` text + line**, then taking the single match
(`autoRepForArea`/`eligibleRepsForArea` in `src/components/employee-portal/plans-workspace.tsx`,
mirrored server-side by `autoMedicalRepForArea` in `src/lib/weekly-planning/service.ts`).
It never cross-checks any other source. So a wrong `employees.area_id` silently produces a
wrong auto-populated rep — this is exactly how the 2026-07-28 bug report surfaced
(Rasha Sabry / A-8 picking a Gharbia area and getting the wrong rep).

**Non-obvious core fact: THREE independent systems each carry the rep→area assignment, and they
disagree for 7 active reps.** Do not assume any one is authoritative:

1. `public.employees.area_id` / `area_name` — from the **2026-05-02 `admin-HR` master import**.
   `audit_logs` records these as entity_type `user` and does **NOT** capture `area_id` values,
   so there is no audit trail for area changes. Denormalized `area_name` must be updated
   alongside `area_id`.
2. `au.seats.area_code` via `au.occupancy_history` — seeded **2026-07-18** (`seed_xlsx`,
   `event_type='seed_baseline'`) from the area-unification master. See [[au-schema-is-the-org-sos-linkage]].
3. `public.sales_records.territory` — actual monthly sales uploads (had Jan–Jun 2026 at time of writing).

The 7 mismatches (query: join `au.occupancy_history`+`au.seats` on open span vs
`employees.area_id`→`areas.code`) formed 3 swap pairs + 1 singleton. **ALL 7 RESOLVED IN FAVOUR
OF `au`; all 7 FIXED in PROD 2026-07-28** — company-wide mismatch count is now 0.

⚠️ **`sales_records.territory` is NOT a valid arbiter — do not use it to adjudicate area identity.**
Its labels use a different naming convention per line. Proof: the line-1 (Anti Infective) Dakahlia
reps are all consistently off by one — B-40 (emp+au = Dakahlia 1) has sales "Dakahlia 2",
B-108 (Dakahlia 2) has "Dakahlia 3", B-96 (Dakahlia 3) has "Dakahlia 4" — while line-2 and line-3
Dakahlia reps show no offset. An earlier pass in this session wrongly concluded "au is the outlier"
from these labels; GPS check-in geography overturned it.

✅ **The working arbiter is `ireports360_checkins`** — it has `lat`/`lon` AND a full `address` for
essentially every row, current to today. Method that settled all 5 disputed cases: extract the
district from the address (3rd-from-last comma segment), then compare the disputed rep's district
histogram against **control reps in the same area family whose assignment all sources already agree
on**. Footprints are near-disjoint per area, so this is unambiguous. Example results: B-146's core
districts (Zeitoun, Hada'iq El Qobbah, Daher, El Weili) are shared only with B-85, a *Cairo East 1*
rep → B-146 is Cairo East 1 (au right, employees wrong). B-137 was 92% in October/Sheikh Zayed vs
8% Haram → October-Zayed. B-115 matched the Dakahlia 2 controls (Mit Ghamr/Senbellawein/Aga);
B-43 matched Dakahlia 3 (Dekernes/Menyet El Nasr/El Manzala).

Corrections applied to `employees` (all within-region, `region_name`/`region_code` untouched);
rollback = restore the left column:

| HR_ID | was (WRONG) | now (au + GPS confirmed) |
| --- | --- | --- |
| B-158 Hassan | 1103 Gharbia 1 (Tanta) | **1104 Gharbia 2 (Mahalla)** D15 |
| B-170 Khaled | 1104 Gharbia 2 (Mahalla) | **1103 Gharbia 1 (Tanta)** D14 |
| B-115 Mohamed Nasr | 1109 Dakahlia 3 | **1108 Dakahlia 2** D22 |
| B-43 Mahmoud AlSlamony | 1108 Dakahlia 2 | **1109 Dakahlia 3** D23 |
| B-146 Ali Shehata | 1097 Cairo East 2 | **1096 Cairo East 1** CA3 |
| CN-0004 Engy Said | 1096 Cairo East 1 | **1097 Cairo East 2** CA4 |
| B-137 Samir Saad | 1116 Haram - Faisal | **1119 October -Zayed** GZ7 |

CN-0004 has 613 visits but **0 check-ins**, so she had no GPS evidence — resolved by elimination
(B-146 confirmed CA3, and those two are the only CNS Cairo East reps).

**Root cause established:** the 2026-05-02 `admin-HR` employee master import contains
adjacent-area transcription errors (swapped neighbouring rows). The `au` seed is correct. The au
rows are single `seed_baseline` entries whose `effective_from` == the rep's `hire_date` with no
transfer events, which ruled out the "au reflects a newer July arrangement" hypothesis.

**Dead ends — don't retry these verification paths:** `geo_bricks` has no rows for these reps;
`ireports360_visits_effective.customer_name` is empty string; `source_of_sales_customer_map.customer_name`
is NULL (keyed by `customer_code`), so CRM-visit→area joins on customer name return zero rows.

**Why:** there is no reconciliation between the three sources. `pnpm run db:au:reconcile-area-state`
(see [[au-area-state-follows-seat-occupancy]]) checks `area_state` vs occupancy — **not**
employee→area assignment — so this drift class is invisible. A reconciliation report was proposed
but NOT built.

**How to apply:** before trusting `employees.area_name` for anything territory-critical, cross-check
`au.seats.area_code` and `sales_records.territory`. `areas` has duplicate names across the legacy
and unified generations (e.g. 3× "Heliopolis"); the current unified rows are `is_active=true`
with `line_id IS NULL` and `code` = the SoS area code (D14/D15/CA3/GZ7…). Updating
`employees.area_id` fires `phx_employee_terminal_vacancy_guard` but it is a **no-op for active
employees** (body only acts on resigned/terminated/inactive).

**Approved plans freeze area text + rep hr_id at save time and are never re-synced**, so correcting
`employees` does not heal existing plan rows. Fixed by hand in PROD 2026-07-28 (audit_logs
`7023d6fd`, `d3e7b02c`, `c4b3f08e` under entity_type `weekly_plan` / `employee_area_assignment`):
Rasha's Jul 28/29 rows re-paired, and two resigned reps cleared from Nahed Hattab's plan
(B-178 Alex West, B-162 Alex Center — both Anti Infective seats genuinely vacant per au
`SEAT-AIF-REP-AB3`/`AB2` + open `position_vacancies` VAC-B178-6FR/VAC-B162-OHN; NULL rep is the
app's supported state for a vacant area, so clear rather than substitute a wrong-line rep).

Still OPEN after all this: nothing re-validates an assigned rep when they later resign, and older
plan rows still name resigned reps / use legacy area labels ("Faisal & October",
"Cairo East 1,2 - Abbasia & Kobbah (East-2)", "Tanta" vs "Gharbia 1 (Tanta)"). Left as historical
record deliberately. Related: [[weekly-plan-duplicate-period-submission-fix]],
[[organogram-vacancy-occupancy-truth]].
