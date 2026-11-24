---
name: expense-capture-rules-three-choices-2026-11-23
description: "Owner's three answers (23 Nov 2026) for the outstation capture gaps found by the District Manager expense inspection - uploaded arrival photo, return ticket, odometer"
metadata:
  node_type: memory
  type: project
  originSessionId: c0a87309-b6bc-4f3d-bc23-917253ee831f
  modified: 2026-11-23T07:25:03.521Z
---

On 23 Nov 2026 the owner answered three multiple-choice questions on the capture gaps the District Manager expense inspection found. All three picks were the recommended options:

1. **An uploaded (gallery) arrival photo on a train or bus trip is still allowed**, as he decided on 5 Aug. A claim carrying one never reaches Ready on the Expense Approvals desk; it goes to Your call. There were 21 such claims since July and 7 waiting on the day.
2. **The return ticket is asked for with the departure photo** and read by the same ticket reader as the outbound ticket (7 Nov rule). A train or bus claim with a return amount and no return ticket read goes to Your call, worded with the amount. On the day, 9 of 9 train claims since 7 Nov claimed a return and none carried a return ticket that had been read.
3. **The odometer is read by the system from the car photos** (arrival and departure) through the one AI door, the same way as tickets. An unreadable photo is refused with guidance. Readings are chained against the person's previous car trip. 136 of 207 car claims since July had a typed reading of 0 or blank.

**Why:** the inspection proved money lost to each gap. Examples: Osama claims 259 and 276 chained without going home, and Sally claim 163 shows only 7 km on the odometer after claim 162.

**How to apply:**
- These rules land as new checks on the waiting claims only. A decided claim stays read-only ([[expense-desk-three-choices-kept-as-built-2026-11-23]]).
- They are built in ONE PR on top of PR 699 (the decision desk).
- Gap 5 (a late departure photo) needed nothing: 699 already sends every `outside_trip_window` departure to Your call. That covered 11 of 11 audit cases.
- Claims filed before the odometer rule show no odometer line.
