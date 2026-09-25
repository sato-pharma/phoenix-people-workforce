---
name: au-seat-drift-view-is-the-org-truth-check
description: "Read au_v_employee_seat_drift before reasoning about the hierarchy — employees.manager_hr_id was silently wrong for 6 rows, and an ACTING DM is titled \"Medical Representative\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e2a5a44-09c1-4b95-8b3b-ec6446552f83
  modified: 2026-08-09T09:43:19.145Z
---

On **2026-08-09** I built a whole scope model, and asked the owner a business question by XLSX, from
`employees.manager_hr_id`. The organogram is the declared source of truth, and a view already exists
to catch exactly that gap: **`public.au_v_employee_seat_drift`**. It was reporting **6 rows with
`manager_drifted = true`** the entire time — six Anti-Infective employees whose seat said `AI-0008`
(the AI NSM) while `employees` said `AA` (the CEO).

Everything I had said about that hierarchy was wrong: the CEO manages nobody in the organogram,
"district AA" was an artefact, and **B-1 Nosiba is the ACTING DM for Upper Egypt 1**, not an
unassigned rep. Repair (6 rows updated, drift → 0):

```sql
update public.employees e set manager_hr_id = d.seat_manager_hr_id
from public.au_v_employee_seat_drift d
where d.hr_id = e.hr_id and d.manager_drifted and d.seat_manager_hr_id is not null;
```

**The trap that follows the repair:** an **ACTING_DM can still carry the job title "Medical
Representative"** (`au.seats.seat_tier = 'ACTING_DM'`, one such seat exists). Any code inferring
"district = whoever manages someone titled a medical rep" then classifies that acting DM's *manager*
— the NSM — as a district, and the NSM's board collapses to himself. Correct data triggered a bug
that wrong data had been masking. Fixed in #1932 by resolving an NSM by line **before** any
district test.

**Why:** the denormalized column and the seat model disagree silently; nothing errors, and the wrong
answer looks like a confident answer.

**How to apply:** before reasoning about who reports to whom, run
`select count(*) from public.au_v_employee_seat_drift where manager_drifted`. Seat occupancy lives in
`au.occupancy_history` (`occupant_hr_id`, open row = `effective_to is null`), **not** on `au.seats`
(no `holder_hr_id`, no `seat_code` — the column is `seat_id`). A vacant seat is an open row with
`node_type = 'vacant_placeholder'` and a NULL occupant, so a `NOT EXISTS` check reports it as
*occupied* — join and test the occupant instead. Related:
[[au-area-state-follows-seat-occupancy]], [[au-seat-occupant-period-aware-resolvers]].
