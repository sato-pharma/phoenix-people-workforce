---
name: untargeted-area-taxonomy-and-closing-region-mismatch
description: "An area with no target is usually CORRECT (Others carry none) — check au.f_line_area_map_asof before calling it a miss; also the closing sheet's region ≠ the seat model's operational region"
metadata: 
  node_type: memory
  type: project
  originSessionId: 12cbb8b7-ccc7-4d6c-851b-309d5beb799c
  modified: 2026-08-02T04:29:35.435Z
---

Auditing Anti-Infective July 2026 (2026-08-02), 17 area×product cells had sales but no
target. Only **one** was a real miss. Never flag an untargeted area without checking
`au.f_line_area_map_asof('<period-end>')` first.

**The taxonomy** (query `area_state` / `other_type` / `rep_seat_id`):

| Category | Signature | Verdict |
| --- | --- | --- |
| Others | `other_type` set, `operational_region_code='OT'`, **no rep seat** | ✅ correct — Others carry no target by design |
| Vacant with a seat | `area_state='vacant_will_hire'`, has rep seat | ⚠️ should carry one — targets ride the SEAT, so a new hire inherits it |
| Occupied | `area_state='occupied'`, has rep seat | ❌ genuine miss |

July example: CA5, D11, D17, D25, GZ7, OT1–OT10 were correct. CA2, GZ2, GZ4 were vacant
but inconsistent (CA1, same state, *does* carry a target). **CA6 alone was occupied with a
rep and no target.** Owner ruled 2026-08-02 to leave all of them blank for now.

🔴 **The region a closing row shows is NOT the seat model's operational region.**
`loadMonthlyClosing` builds rows from `source_of_sales_areas.region_code`; achievement/DM
logic uses `au.f_line_area_map_asof(...).operational_region_code`. CA5 sits under **Cairo**
in the closing sheet but under **OT** in the seat model. That is the owner's own ruling —
an Others area is "calculated with others but laying under cairo" — so do not "fix" it.

**Why it matters for any % you quote:** roll-ups sum sales and targets separately then
divide once, so untargeted sales land in the numerator with nothing beneath them. Cairo
read 33.9% when its staffed, targeted areas were at ~21% — 50.1% of its sales had no
denominator, while 24% of its target sat on a vacant seat (CA1). Always offer the
like-for-like number next to the displayed one.

Related: [[sos-owner-standing-rules-from-session-369dd08d]] ·
[[sos-areas-must-never-be-deleted-au-linkage]] · [[closing-matrix-inclusion-rule]]
