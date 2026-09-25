---
name: crm-null-plan-hrid-means-leaver-not-defect
description: "A NULL agent_hr_id on ireports360_plan_entries almost always means a RESIGNED rep whose employees.crm_id was cleared on exit — expected, not a sync defect. Audit 2026-08-21 found 8 of 9 were exactly that."
metadata:
  type: project
---

Audited 2026-08-21 on production: the August 2026 plan had **854 rows across 9 agents with a NULL
`agent_hr_id`**. That looks like a broken sync. It is not.

**8 of the 9 were genuine August leavers** — all Medical Representatives, all `employment_status =
'resigned'`, all with `employees.crm_id` NULL because the resignation flow clears it so the slot can
be inherited. The plan sync resolves hr_id from `employees.crm_id`, so once that link is cleared the
plan rows can no longer resolve. Their *visits* still carry the hr_id because those synced while the
link existed — which is why the visits side looks fine and the plan side looks broken.

Every one was verified consistent: last visit on or before `last_working_date`, zero work-after-exit.
So there was NO second reused-slot bug in this set.

| crm | hr_id | last working date |
| --- | --- | --- |
| 1459 | B-152 | 2026-08-15 |
| 1488 | B-167 | 2026-08-10 |
| 1543 | CN-0005 | 2026-08-08 |
| 1453 | B-144 | 2026-08-09 |
| 1132 | B-3 | 2026-08-09 |
| 1263 | B-52 | 2026-08-09 |
| 1503 | B-179 | 2026-08-09 |
| 1411 | B-112 | 2026-08-05 |

**Why:** this also settles a wrong reading made the same day. Excluding these 8 from the Rep Doctor
Lists board is CORRECT — they are leavers. An earlier SQL cross-check that included them produced
66% adherence and the claim that the board's 69% was "flattered". That was wrong: **69% is the right
number** and 66% was the artefact of including leavers.

**How to apply:** before treating NULL plan `agent_hr_id` as a sync bug, join the crm_id to a visit
row's `agent_hr_id` and check `employment_status` / `last_working_date`. Only investigate the ones
that resolve to nobody at all — those are the real unmapped agents. Scope the check on VISITS, not
plans; a rep with visits and no plan is invisible to a plan-scoped audit (that is how crm 1551 was
nearly missed).

Related: [[crm-resigned-slot-reused-for-new-hire]] ·
[[employees-crm-id-null-does-not-mean-no-crm-activity]]

## Outcome 2026-08-21 — the two real unmapped agents

Widening the scan from plans to VISITS found a 10th agent a plan-scoped audit missed:

- **crm 1551 "Omayma.Wael ( Dokki / A )" = AI-0009 Omayma Wael, ACTIVE.** Owner confirmed the
  identity; `employees.crm_id` set to `'1551'` and her 6 existing visits back-stamped to `AI-0009`
  (label-scoped on the vendor name; the slot carries exactly one name so it was unambiguous).
  `agent_hr_id` is STORED on `ireports360_visits`, NOT resolved live by the `_effective` view — so
  setting `employees.crm_id` alone fixes only FUTURE syncs. Existing rows need the back-stamp too.
  Verified after: 0 nulls left on the slot, 6 rows attributed, exactly 1 owner of 1551.
- **crm 1550 "Hanan.Safwat ( Bani Sweif / A )" — STILL UNRESOLVED.** 62 visits (all campaign) and
  63 plan rows, 11–19 Aug, and **no employee named Hanan or Safwat exists anywhere in `employees`**.
  Someone is doing real fieldwork with no Phoenix employee record. Slots 1550/1551 were created in
  the same batch, so she is most likely a new hire whose HR paperwork was never entered. Needs the
  owner — do NOT invent an employee record.

Two other active reps have **no CRM slot at all** (nothing to link; their CRM accounts were never
created): AI-0010 Omar Tamer and PD-0011 Mohamed Eldomiaty. AI-0009/0010/0011 are one hiring batch
with AI-0011 (Mohamed Khaled) — **that whole intake was never wired to the CRM properly**, which is
the pattern worth catching earlier next time.

## CLOSED 2026-08-21 — 1550 resolved too

The owner created **AI-0012 Hanan Safwat** (Medical Representative, active) at 10:21 Cairo with
`crm_id = '1550'` already set. Creating the record does NOT reach back: her 62 visits and 63 plan
rows still carried a NULL `agent_hr_id`, so both were back-stamped to `AI-0012` (guarded so the
write only fired while AI-0012 was the sole active owner of the slot).

**Final state of the August audit:**
- unmapped CRM agents in August: **0**
- visits unattributed for the new reps (1550, 1551): **0**
- plan rows still NULL: **791 across 8 agents** — the leavers, and CORRECT to leave that way

**Trap worth keeping:** a single statement whose sibling `SELECT` reads a table its own CTE just
updated sees the PRE-update snapshot. A verification query bundled into the same statement as the
write reports stale numbers and looks like the write failed. Verify in a SEPARATE statement.
