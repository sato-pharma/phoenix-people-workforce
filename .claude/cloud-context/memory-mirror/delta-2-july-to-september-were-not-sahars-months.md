---
name: delta-2-july-to-september-were-not-sahars-months
description: "The sales engine names a seat's CURRENT holder on past months, so Pedia Delta (2) July to September read as Sahar El Gallad though she was hired on 2026-10-24; never quote that as who ran those months."
metadata:
  node_type: memory
  type: project
  originSessionId: d774fadb-3d42-491b-8fa8-40933eb66b18
  modified: 2026-11-01T18:39:46.213Z
---

`au.f_monthly_achievement` returned Sahar El Gallad as the manager of Pedia Delta (2) for 2026-07, 08 and 09, but the seat's own history says otherwise: Ahmed Mohamed Ahmed Mohamed Heikal until 2026-08-01, vacant to 08-08, Ahmed Elsayed Ahmed Ibrahim to 10-01, vacant to 10-09, Sahar seated from 10-09 and hired 2026-10-24 (owner confirmed 24 October, 2026-11-01; `employees.hire_date` already holds it). The two dates differing is normal, not a defect: seating runs ahead of hiring, and 41 of 49 open hire rows differ, so never hand-edit the seat row to match. Read 2026-11-01. The engine's naming predates the Sharkia change.

**Why:** a manager's name on a past month from this engine is not evidence they ran that month, and calling it "her pay figure" was wrong.

**How to apply:** before quoting who ran a past month, read `au.occupancy_history`. The wording that said otherwise was corrected on commit 82ecc01ef in PR 6759 (owner, 2026-11-01: "add the Sahar wording to 6759"); until that PR merges it is still wrong on `main`. No figure changes. Related: [[sos-monthly-closing-is-the-only-sales-truth]].
