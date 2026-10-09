---
name: september-2026-payroll-deduction-trims-are-intended
description: "The three September 2026 figures charged below the Deductions module's proposal are the owner's own trims — never \"corrected\" by a later session."
metadata:
  node_type: memory
  type: project
  originSessionId: 5566e73c-38c0-4e93-b3c8-7857c2ef20ff
  modified: 2026-10-09T11:20:38.053Z
---

On the September 2026 run (`6b941989-9f31-49f1-830b-31edc0e8f374`), three Part 2 figures sit
**below** what the Deductions module proposes, and the owner confirmed on 2026-10-09 that all three
are deliberate: *"the trims on Ghada, Esraa and Aisha are intended."*

| Employee | Column | Module proposes | The run charges |
| --- | --- | --- | --- |
| Ghada Mohamed Abdelwahab Ismaiel | Unpaid Vacation | 966.66 (2 days) | 483.33 (1 day) |
| Esraa fotooh Mosaad Al-Shandalati | Unpaid Vacation | 516.67 (1 day) | 258.33 (½ day) |
| Aisha Ehab Mamdouh Hussein | CRM | 1,450.00 | 1,250.00 |

941.67 EGP in total, and **not a defect**. None of the three blocks the Part 2 confirm, which is the
drift check behaving correctly: for the first two the module has not moved at all, so the figure
reads as somebody's decision rather than a stale copy; the third reads as an override beside the
module's 1,450.00. See [[sos-monthly-closing-is-the-only-sales-truth]] for the sibling rule that a
surface must not re-derive a figure it was given.

**Why:** a sweep comparing every draft row against the module's approved totals finds exactly these
three (plus Ahmed Mohamed Rabiee Fayk Elkawas, correctly absent — terminated 31 August, not
payroll-eligible). A session that runs that comparison and reads a shortfall as an error would
"repair" the owner's own decision, on a month that is not published yet.

**How to apply:** if a drift report, a gap sweep or a Part 2 review names any of those three rows for
September 2026, say the trim is intended and leave the figure alone. Do not propose a re-confirm to
take the module's figure, and do not raise it again. The same shape in a DIFFERENT month is a fresh
question for him.
