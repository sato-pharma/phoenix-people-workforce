---
name: reps-who-never-appear-in-any-salary-record
description: "OWNER SAID SKIP SOAD (2026-09-04) — do not re-raise her unpaid June/July without him raising it first. The underlying facts stand: only 2 Medical Reps have never been paid at all (Soad Atef, and Abdelrahman Alaa who was hired and terminated the same day); the other 16 with no salary_records row are August-or-later hires not yet due, so the raw count is meaningless until it is split by hire date"
metadata:
  node_type: memory
  type: project
  originSessionId: de3d5355-ce2f-47ce-91e5-037397fd3f85
  modified: 2026-08-23T20:29:22.040Z
---

Swept 2026-08-23. **13 employees with `job_title = 'Medical Representative'` have zero rows in
`salary_records`, any month, any year** (9 active, 3 resigned, 1 terminated). Salary batches exist
through **July only** (July = `approved`, May/June = `locked`); **August has not been run**. So the
count alone means nothing — it must be split by hire date.

**9 of the 13 are NOT a problem** — hired 2026-08-01 or later, so their first payroll simply has not
run: `PD-0009`, `PD-0008`, `AI-0005` (all 08-01), `CN-0006`, `AI-0006` (08-02), `PD-0007` (08-08),
`AI-0009` (08-20), `PD-0011` (08-24), `AI-0010` (09-01). Do not raise these as missing pay.

## 🔴 The one that matters: Soad Atef (`AI-0003`)

| Field | Value |
| --- | --- |
| `hire_date` | 2026-06-20 (record created **2026-06-19** — the creation date, not a real start) |
| CRM slot | 1391, label `Soad.Atef ( Cairo East 1 / A )` |
| Visits | **1,163**, first **2026-01-01**, last **2026-07-28** |
| `last_working_date` | 2026-08-09 |
| Salary records | **ZERO** |
| Deductions pending | **13,572.59 EGP** (July 9,580.65 + August 3,991.94) |

**June and July payroll both ran and both closed. She is in neither.** Her only payroll trace is a
July `automated_payroll_draft_rows` row, `on_hold = true` with **`hold_reason` NULL** — put on hold
2026-08-08, two days before her last working day, with no reason recorded anywhere.

**So the settlement question that ran all session is malformed: you cannot deduct 13,572.59 EGP from
a salary that was never paid.** Either she was paid outside the system (then the deduction needs a
different collection route) or she is owed money (then the company is the debtor, not her). Settle
which it is BEFORE approving or waiving those two candidates. See
[[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]].

**Do NOT yet claim "unpaid since January."** Her visits start 01 Jan but her record starts 20 June.
Slot 1391 carries a **single label across its whole history**, which per
[[crm-resigned-slot-reused-for-new-hire]] can mean either that the slot was genuinely always hers OR
that a relabel rewrote the lot — the same mechanism that handed Omar Tamer's 202 visits to Mohamed
Yasser. The defensible claim is the narrow one: **two closed months, June and July, unpaid.** The
Jan–May question needs the owner.

## ✅ Two ACTIVE reps had NO hire date — FIXED 2026-08-23, before the August run

**BOTH were hired 2026-08-17.** Owner-confirmed, emphatically, after a first write got one wrong.

| HR ID | Name | `hire_date` | Slot | Visits before hire | Genuinely theirs |
| --- | --- | --- | --- | --- | --- |
| `AI-0012` | Hanan Safwat | **2026-08-17** | 1550 | **25** (from 08-11) | 48 |
| `AI-0011` | Mohamed Khaled | **2026-08-17** | 1523 | 0 | 147 |

Both were active with visits through 2026-08-23 while **August payroll had not yet run**. Payroll
prorates a partial first month from `hire_date`; with NULL there is nothing to prorate from.

## 🔴 The trap that caused the wrong write: FIRST VISIT IS NOT EVIDENCE OF HIRE DATE

The first write set Hanan to **2026-08-11** and justified it as *"lands exactly on her first recorded
visit — independent corroboration, not a guess."* **That reasoning is circular and wrong here.** A
CRM slot's history is relabelled onto whoever holds the account now, so "her" earliest visit is
routinely a predecessor's work. Hanan's slot **1550** is the very one this repo recorded on
2026-08-21 as having *"no employee row at all — 62 campaign visits, `agent_hr_id` NULL on every
one"*; those rows now resolve to her. **25 of her 73 visits predate her own hire.**

This is the SAME mechanism as [[crm-resigned-slot-reused-for-new-hire]] (Omar Tamer's 202 visits
credited to Mohamed Yasser) and Soad Atef's visits reaching back to 01 January under a record created
in June. It had already appeared three times in that one session before this write went out anyway.

**How to apply: never date an employment fact from CRM activity.** The mirror's earliest row is the
SLOT's history, not the person's. Ask the owner, or use an HR artefact (offer, contract, resignation
record). If a first-visit date is all you have, say it is unverified — do not call it corroboration.
Mohamed Khaled is the counter-example that shows the check is worthless either way: his earliest
visit also equals his hire date, but only because his slot happened to be clean.

After the write, **no active employee anywhere is missing a hire date.** The only three NULLs left
company-wide are 2 `system_placeholder` rows (`c-o1` Unknown Manager, `O-3` Others/Unassigned) and
one historical `B-HIST-MG` Mahmoud Gamal — none of them real people awaiting pay.

(`AI-0011` is the same Mohamed Khaled whose CRM slot 1523 was un-hidden in PR #2262 — see
[[crm-resigned-slot-reused-for-new-hire]]. He was invisible in the CRM AND had no hire date; both are
now fixed.)

**Also open:** `AI-0004` Abdelrahman Alaa — hired 2026-07-07, **terminated**, **0 visits**, never
paid. July payroll ran after his hire date, so either he never actually started or a partial July
payment was missed. Cheap to resolve, unresolved as of this writing.

**Why:** payroll absence is invisible from every screen that starts from a salary row — a person with
no row simply is not in the report. The only way to see them is to start from `employees` and check
for the ABSENCE of a payroll row, which nothing in the app does.

**How to apply:** run the anti-join below before closing any month, and split the result by hire date
against the batches that actually exist — never report the raw count.
`select e.hr_id, e.full_name, e.employment_status, e.hire_date from employees e where e.job_title='Medical Representative' and not exists (select 1 from salary_records s where replace(upper(s.hr_id),'-','')=replace(upper(e.hr_id),'-',''));`
Related: [[one-part-employees-have-no-part-2-for-deductions-to-land-in]],
[[never-auto-publish-deductions-owner-confirms-first]].

## 2026-09-04 — re-measured: the count grew, the risk shrank, and only the split tells them apart

| | swept 2026-08-23 | live 2026-09-04 |
| --- | --- | --- |
| Medical Reps with no `salary_records` row, ever | 13 | **18** |
| — hired **before** 2026-08-01 (worked, never paid) | 4 | **2** |
| — hired 2026-08-01 or later (not yet due) | 9 | **16** |
| all Medical Reps | — | 126 |

**The headline count moved the wrong way from the risk.** It rose 13 → 18 purely because hiring
continued; the population that actually matters *halved*. Quoting 18 to the owner would describe a
worsening problem where the real one is two people:

| | hire date | status | last working day | salary rows |
| --- | --- | --- | --- | --- |
| **AI-0003 Soad Atef** | 2026-06-20 | resigned | 2026-08-09 | **0** |
| **AI-0004 Abdelrahman Alaa** | 2026-07-07 | terminated | 2026-07-07 | **0** |

Abdelrahman Alaa's hire date and last working date are **the same day**, so a zero there is not
obviously wrong. **Soad Atef is the live one and is unchanged since 2026-08-23** — June and July
are both closed batches, she is in neither, and she still carries the deductions.

**August payroll has still NOT been run.** The newest `salary_batches` row is **2026-07**
(`approved`, 105 records, created 2026-08-10 Cairo). Anyone reasoning that "August has since run,
so the actives were paid" — as this session first did — is guessing. The actives fell out of the
count because their *hire dates* moved them, not because they were paid.

**How to re-measure without repeating the mistake:** count with `lower()` on both sides of the
`hr_id` join (ids are mixed case), then **split by `hire_date` against the first of the month that
has actually been batched**. The unsplit count answers no question worth asking.

## 2026-09-04 — OWNER DECISION: skip Soad

Offered to check Soad Atef's June-July entitlement against her deductions and prepare the figure
before August payroll closed. The owner answered **"NO SKIP SOAD"**.

**So do not prepare, price, or escalate her back pay, and do not raise her in a payroll review.**
He is running payroll himself and this is his call, made with the facts in front of him.

The measurement above is still accurate and is kept as a record — the point of this section is that
being accurate is not a reason to re-open it. **If Soad comes up again it will be because he raises
her.** Same shape as [[ireports360-sync-notify-disabled-on-staging]]: a closed decision that reads
like an open risk to anyone who only reads the evidence.
