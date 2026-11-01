---
name: delta-2-july-to-september-were-not-sahars-months
description: "The sales engine names a seat's CURRENT holder on past months, so Pedia Delta (2) July to September read as Sahar El Gallad though she joined in October; wording in the owner-rules account and sales-only-seats.ts still says otherwise and needs correcting."
metadata:
  node_type: memory
  type: project
  originSessionId: d774fadb-3d42-491b-8fa8-40933eb66b18
  modified: 2026-11-01T18:36:24.584Z
---

`au.f_monthly_achievement` returned Sahar El Gallad as the manager of Pedia Delta (2) for 2026-07, 08 and 09, but the seat's own history says otherwise: Ahmed Mohamed Ahmed Mohamed Heikal until 2026-08-01, vacant to 08-08, Ahmed Elsayed Ahmed Ibrahim to 10-01, vacant to 10-09, Sahar seated from 10-09 and hired 2026-10-24 (owner confirmed 24 October, 2026-11-01; `employees.hire_date` already holds it). The two dates differing is normal, not a defect: seating runs ahead of hiring, and 41 of 49 open hire rows differ, so never hand-edit the seat row to match. Read 2026-11-01. The engine's naming predates the Sharkia change.

**Why:** a manager's name on a past month from this engine is not evidence they ran that month, and calling it "her pay figure" was wrong.

**How to apply:** owner, 2026-11-01: "correct the Sahar wording in the next sales PR". So whichever session opens the next sales PR adds this to it, without asking and without a PR of its own, then deletes this paragraph's to-do. Correct two places that say Sahar answers for those months: `docs/agents-owner-rules.md` ("Pedia Sharkia 1 and 2", "Consequences worth knowing") and the comment on `AREAS_KEPT_FOR_EARLIER_MONTHS` in `src/lib/org/sales-only-seats.ts`. Say the seat keeps those areas for those months. Before quoting who ran a past month, read `au.occupancy_history`. No figure changes. Related: [[sos-monthly-closing-is-the-only-sales-truth]].
