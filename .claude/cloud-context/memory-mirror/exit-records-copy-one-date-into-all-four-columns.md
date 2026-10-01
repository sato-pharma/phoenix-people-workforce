---
name: exit-records-copy-one-date-into-all-four-columns
description: "employee_resignations stores one entered date in submitted_date, resignation_date, last_working_date AND effective_date — 50 of 54 records — so last_working_date is a nominal date nobody observed, yet it gates CRM attribution and pay."
metadata: 
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-10-01T00:00:00.000Z
---

**`last_working_date` is not an observed fact in this system. It is a copy.** Measured in production
2026-08-28: of **54** rows in `employee_resignations`, **50** have `submitted_date`,
`resignation_date`, `last_working_date` and `effective_date` **all four identical**. The exit form
takes one date and writes it to every column, so nothing records the day the person actually stopped
working — and none of the 54 leaves it null, which makes the field look authoritative when it is not.

**That matters because two systems trust it.** `buildCrmIdentityMaps` bounds every CRM attribution by
`employees.hire_date` → `employees.last_working_date` (`src/lib/crm/identity.ts:69-76, 187-192`), and
payroll prices the month from the same window. A date entered as a plan rather than an observation
therefore silently strips real calls and underpays real days.

**Two real cases, both found and fixed 2026-08-28:**

- **Mohamed Yasser (`AI-0006`)** — hire, resignation, last-working and effective dates **all
  2026-08-02**, the same day he was hired. iReports360 shows him working 02, 03 and 04 August
  (**19 real calls**), a campaign day on the 5th and annual leave (`-4`) on the 6th. Corrected to
  **2026-08-06**. The exit record was created 2026-08-11, nine days after the date it asserts.
- **Eman Essam Arafa Attia Mohamed (`B-176`)** — all four **2026-07-12**, but the record was created
  2026-07-06, **six days before** that date: a resignation submitted in advance with a planned last
  day. She then worked one more, a substantive product call on **2026-07-13** whose visit id sits
  well past that day's block, so it is not a re-save of the 12th (see
  [[ireports360-reissues-a-new-plan-entry-id-when-a-rep-re-saves-a-day]]). Corrected to **2026-07-13**.

After both corrections, **zero** leavers have real calls past their recorded last working date —
verified two ways, joining on `agent_hr_id` and again on `agent_name = crm_username` so that already
blocked rows were visible too. The only post-exit row left anywhere on these two is the 2026-08-27
public-holiday marker, which records no work and is what #2539 silences.

**The CRM gives a FLOOR, never the date.** It proves the person was employed on the day they logged
work; it cannot prove they left the next day. Both corrections are the last date with positive
evidence, so each is right-or-early and never late. If HR paperwork says later, HR wins.

**Why the wrong date had not already stripped Mohamed's 19 calls.** `isAttributableOn` still
attributes a post-exit row when the record carries **that employee's own CRM label**
(`src/lib/crm/identity.ts`) — a deliberate escape hatch, because the risk being guarded is a
reused slot, not an own-label one. So the damage was latent: the calls stayed credited only until the
CRM admin next renames that slot. Do not read "the calls are credited" as "the dates are fine."

**Slot 1399 was a handover by RENAME, not by clone** — relabelled from `Nada.Mohammed ( Tanta / E )`
to `Mohamed.Yasser ( Tanta / A )`, the corrupting shape from the slot-1391 incident, not the safe one
in [[crm-resigned-slot-reused-for-new-hire]]. It resolves correctly today only because a manual
override (crm_id 1399 → `B-97`, written 2026-08-28 09:13 by the Super Admin) is **employment-scoped**:
inside Nada's window it claims her 1,229 rows, outside it the name match hands the 24 August rows to
Mohamed. Nada's own last real call is exactly her last working date — her record is clean.

Related: [[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]] ·
[[reps-who-never-appear-in-any-salary-record]] ·
[[pre-hire-blocks-will-alarm-when-a-reconcile-reaches-january]]
