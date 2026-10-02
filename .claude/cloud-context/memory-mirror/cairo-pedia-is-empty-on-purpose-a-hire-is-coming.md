---
name: cairo-pedia-is-empty-on-purpose-a-hire-is-coming
description: "Seats the owner has ruled NEGLECTED until he hires — the whole Cairo Pedia branch (DM + five reps), and Anti Infective Menoufia 1 with its 94 Phoenix CRM customers; never report either as a gap, a defect or a next step, and never move their customers to a neighbouring rep"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-10-02T09:53:42.358Z
---

**Owner ruling, 2026-09-30, in his own words: *"we will hire soon neglect cairo pedia dm and reps
now"*.** It is known, it is decided, and it is his to close.

The branch is empty top to bottom:

```
SEAT-PED-DM-CA   PEDIA Cairo DM      vacant since 2026-08-20
SEAT-PED-REP-CA1 · CA2 · CA3 · CA4 · CA6    all five vacant
parent                                SEAT-PED-NSM — Ali Mohamed Ali Elsayed (A-12)
```

The DM seat's full occupancy history is three rows and holds no candidate:

| From | To | Who | Event |
| --- | --- | --- | --- |
| 2026-07-13 | 07-19 | — | seed baseline, vacant |
| 2026-07-19 | 08-20 | Ahmed Mohamed Nagy (PD-0006) | hire |
| 2026-08-20 | open | — | **resign**, recorded by b-10 |

PD-0006 reads `employment_status = resigned`, so **the history cannot fill the seat** — restoring him
would assert a resigned person holds a live seat and pull him back into scope, KPIs and approval
chains.

**How to apply:**

- 🔴 **Never raise Cairo Pedia as a finding, a gap, a data-quality issue or a `Next step:`.** A report
  that lists vacant seats, unmanaged areas or unassignable customers must not single it out — it is
  the expected state until he says otherwise.
- 🔴 **Never fill it.** A vacancy is a hire in progress and only the Super Admin's intent fills one;
  `hire_rpc` is the path, never a hand-written `au.occupancy_history` row. See the standing rule that
  an `employees` insert auto-seats a person and restamps nothing —
  [[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]].
- Where something in Cairo must still be attributed to a person — a prospect list, a coverage report
  — route it to the **Pedia NSM, Ali Mohamed Ali Elsayed (A-12)**, and say on the row that the DM seat
  is vacant, so nobody reads him as the district manager.
- When the hire lands, the branch fills through the normal path and this memory retires. Until then
  the silence is the instruction.

## The same ruling, a second seat: Anti Infective Menoufia 1 (2026-10-02)

**His words, asked directly while rolling Phoenix CRM out to Delta (1): *"leave menoufia 1 as it is
until I hire"*.** Raised because the seat's 94 Phoenix CRM customers have nobody to validate or visit
them — so the ruling is specifically that those customers WAIT, rather than being shared out.

```
SEAT-AIF-REP-D12  Menoufia 1 · Delta (1) · anti_infective   vacant since 2026-08-31
  previous        Warda Farhat (B-55), resign — and she reads employment_status = resigned
  parent          SEAT-AIF-DM-D1 — Dina Hamdy Fadel Mohamed Bdair (B-12)
  waiting         94 customers, all status `pending` (the carried-over reference list)
```

🔴 **Never propose splitting those 94 across Gharbia 1, Gharbia 2, Kafr El-Sheikh 1 or Menoufia 2.**
That is the obvious-looking fix and he refused it: a place is validated ONCE and fixed forever
([[territory-is-not-geography]] and the place-move rule), so a neighbour validating them would do
work the new hire inherits as somebody else's captures, and every visit would have to be measured
again when the seat fills. The customers simply sit `pending` until there is a rep.

🔴 **And never read "0 validated customers in Menoufia 1" as an adoption failure** in any CRM
readiness or coverage report — the other four Delta (1) reps are the live ones; this seat is empty on
purpose, exactly like Cairo Pedia above.

Related: [[never-change-the-organogram-skeleton]] · [[au-org-tree-is-sales-only]]
