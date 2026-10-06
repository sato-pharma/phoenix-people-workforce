---
name: the-staging-mask-renamed-people-per-row-not-per-person
description: "staging's mask rewrote denormalized `<x>_name` columns PER ROW, so one hr_id carried up to 11 different synthetic names — B-94 was 7 people in ats_candidates while employees said Farida Lotfy. An exposure audit passes it (every name IS synthetic); only a consistency check catches it, and it is invisible until you read two screens about one person"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T05:20:11.389Z
---

Found 6 Oct 2026 while building the Recruitment film for the *Inside Phoenix* series, on staging
`cifwmndunmlxjhyjugxa`. Related: [[the-staging-mask-skipped-app-auth-users]], which is the
EXPOSURE half of the same mask; this is the CONSISTENCY half.

**The shape:** a denormalized `<x>_name` column beside an `<x>_hr_id`. The mask keyed the
synthetic name on the ROW, not on the person, so the same `hr_id` came out as a different human
on every row. `B-94` is **Farida Lotfy** in `employees` and was **seven different names** in
`ats_candidates`; `A-12` was **eleven**.

Swept all **60** `<x>_name` / `<x>_hr_id` pairs in `public` (base tables only). Five disagreed:

| Table · column | Rows | Worst names for one person |
| --- | --- | --- |
| `ireports360_visits.agent_name` | **121,943** | 3 |
| `ireports360_visits.double_name` | 13,393 | 1 |
| `employee_plan_items.double_visit_medical_rep_name` | 330 | 2 |
| `ats_candidates.manager_notified_name` | 24 | **11** |
| `position_vacancies.manager_name` | 4 | 1 |

Fixed with `update <t> set <name> = e.full_name from employees e where e.hr_id = t.<id> and
<name> is distinct from e.full_name`; re-measured after — all 60 agree. A mismatch count above
zero with "worst = 1" is still a defect: the name is internally consistent but disagrees with
`employees`, so it contradicts the next screen.

**Why:** an exposure audit asks *"is this a real name?"* and every one of these is correctly
synthetic, so all five passed it. Consistency is a **second axis**, and it is invisible until you
read two screens about the same person — rare in ordinary work, universal when filming or
demoing, where it reads as the system contradicting itself.

**How to apply:** after ANY staging refresh from production, run both checks, not just the
exposure one. The sweep is cheap — enumerate the pairs from `information_schema`, then probe each
with `query_to_xml` inside a lateral.

🔴 **`query_to_xml(q, nulls, tableforest, ns)` with `tableforest = true` emits `<row>`, so the
xpath is `/row/<col>/text()`.** Getting that root wrong returns NULL for every probe, and a
`where mismatches > 0` filter then swallows all 60 and prints an empty result — a silent zero
wearing the shape of a clean bill of health. It happened on the first run of this very sweep.
Disbelieve an all-clear from a dynamic probe until one row you verified by hand shows up in it.
