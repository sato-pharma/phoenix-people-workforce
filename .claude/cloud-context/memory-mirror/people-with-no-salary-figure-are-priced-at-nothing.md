---
name: people-with-no-salary-figure-are-priced-at-nothing
description: "People whose base, basic, gross AND net salary are all NULL, so recommend.ts prices them at nothing. The named list keeps changing — RE-MEASURE, never quote it. The AI-0019/CN-0007 gap is CLOSED — both were filled later on 2026-09-04 with the standard rep package (base 17500, net 20000), verified against peers and against the 5-rep September hire cohort. August run clean, no September run yet."
metadata:
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-09-03T00:56:17.526Z
---

## CLOSED later the same day, 2026-09-04 - both rows filled and verified

**Superseding the "still open" block below, which stood for about twenty minutes.** `AI-0019` (Nour
Ahmed) and `CN-0007` (Manar Sadek Abdallah) now both carry the standard Medical Representative
package, entered by someone else between two queries in one session:

| field | both new hires | two peers on the same package | verdict |
| --- | --- | --- | --- |
| base / basic | 17500 / 12250 | 17500 / 12250 | match, and basic is exactly the protected 70% |
| net / fuel / extra COL | 20000 / 500 / 2000 | 20000 / 500 / 2000 | match - take-home identical |
| social_insurance_wage | 16700.00 | 13462.00 | **not an error** - 16700 is shared by ALL 5 reps hired 2026-09-01/02, i.e. the current statutory wage for that cohort |
| medical_insurance | NULL | 0 | normal here - 11 of 69 active reps are NULL |
| line_id / area_id | set (1/1104, 3/1093) | set | only the denormalised `line_name`/`area_name` mirrors are NULL |

Neither statutory figure touches take-home ([[payroll-reads-the-insurance-wage-never-the-status]]), so
the differing wage costs these two nothing. **No September `automated_payroll_runs` row was ever
created while the columns were NULL**, so nobody was priced at zero at any point.

**The transferable lesson is the flip, not the fix.** This file asserted "still open" at 15:0x and was
false by 15:2x, in the same session, with no action by the session that wrote it. Re-read a payroll
row immediately before asserting its state, never from earlier in the same conversation.

## The earlier 2026-09-04 reading - superseded by the block above

`AI-0019` (Nour Ahmed) and `CN-0007` (Manar Sadek Abdallah) both remain `active`,
`payroll_eligible = true`, hired 2026-09-01, with base/basic/gross/net **and** fuel_allowance/
extra_cost_of_living all still NULL. Still **no September `automated_payroll_runs` row** (July
`published`, August `part2` with part2 unconfirmed), so nothing has priced them at zero yet - but the
window the 09-03 note called "fix before September opens" is now four days old.

## Re-measured 2026-09-03 against production

**New live risk, same mechanism, different people: `AI-0019` Nour Ahmed and `CN-0007` Manar Sadek
Abdallah** — both Medical Representative, both hired 2026-09-01, both `active` /
`payroll_eligible = true`, and both have base/basic/gross/net **and** fuel_allowance/
extra_cost_of_living all NULL — a clean incomplete-onboarding row, not the 08-10 wipe signature.
Manar (`CN-0007`) is the same person whose CRM slot (1485) was reassigned from B-171 this session —
her CRM identity is now fixed, her salary is a separate, still-open gap. **No September
`automated_payroll_runs` row exists yet** (only July, published, and August, phase `part2`, part1
confirmed 2026-08-30, part2 not yet confirmed) — so nothing has priced them at zero yet. This is a
"fix before September opens" flag, not an active-drain incident.

**August's open run is clean.** Checked `automated_payroll_draft_rows` for the August run
(`715d41fa-1c0e-4387-ab01-e1eb4824a6cb`) against every all-NULL/zero-base id: `PD-0007`, `PD-0011`
and `AI-0006` all carry `excluded = true` in that run (correctly kept out of the population); `AA`,
`AB`, `B-185`, `OF-0002`, `AI-0019`, `CN-0007`, `AI-0010`, `B-HIST-MG`, `AI-0004` have no row there
at all, meaning they were never drafted into August's population either. Nobody is silently priced
at zero in the run that is actually open right now.

**Group 1 (the 08-10 wipe, four executives) is unchanged** — `AA`, `AB`, `B-185`, `OF-0002` still
carry the exact same `updated_at = 2026-08-10 13:16` signature and `payroll_eligible = false`. Still
not urgent per the 08-29 reading below; still needs owner intent before "fixing."

**The base-0-with-allowances shape has one new member, still all resigned/terminated.** `AI-0004`
Abdelrahman Alaa (terminated, last day 2026-07-07) joins `AI-0006` and `PD-0007` at
`base_salary = 0`, `net_salary = 2500` — none of the three is active, so the "quietly reduces an
active person's pay" risk the 08-29 note warned about has still not materialized.

**`PD-0011` is unchanged** — still the sole resigned all-NULL instance, still `excluded = true` in
August, still not urgent.

The August-2026 readings below are left intact as a dated record; they are no longer current.

---

**A person with no compensation figure is not refused — they are priced at nothing.**
`recommend.ts:174-189` sets `hasAnyRawCompensationFigure` by testing `base_salary`,
`basic_salary`, `gross_salary` and `net_salary`; if **none** is above zero, `baseSalary` comes back
null and `netSalary` is forced null with it. Nothing throws. That mechanism is the durable fact
here — **the list of people it applies to changes, so re-measure before quoting anyone.**

## Correction, re-measured 2026-08-29 against production

**Group 2 below is RESOLVED and Group 3 is RESOLVED. Do not act on either.** `AI-0009` Omayma Wael
now reads 15,000 / 2,000 / 500 and `AI-0013` Weaam Mahmoud Mohamed 29,500 / 3,000 / 500; both are
`payroll_eligible` and both priced correctly in the August run. `HR-009` Yasmine El Safoury
(16,000 / 1,500 / 500) and `HR-010` Aya Mohamed Mahmoud (19,000 / 1,500 / 500) both have figures and
the flag. The sections below are left intact as the dated 08-28 record — they are simply no longer
current, which is the whole point of re-measuring rather than quoting this file.

**Only `PD-0011` Mohamed Eldomiaty is still all-NULL** — resigned, `payroll_eligible = false`, hired
2026-08-24, priced at nothing. He is the sole remaining instance of the mechanism this memory exists
to describe.

**A SECOND, different shape has appeared, and this file's title does not cover it.** `AI-0006`
Mohamed Yasser and `PD-0007` Bahaa Gamal read **`base_salary = 0` with `extra_cost_of_living = 2000`
and `fuel_allowance = 500`**, so `net_salary` is 2,500 and `hasAnyRawCompensationFigure` is **true**.
They are NOT priced at nothing — they are priced at the allowances alone, which reads as a plausible
small salary rather than as missing data. **That is harder to spot than a NULL**, because nothing
looks empty anywhere. Since the 2026-08-29 joiner rule prorates on net, their allowances now prorate
too: Bahaa Gamal moved from 2,500 (allowances paid whole) to **1,935.49** for 24 of 31 days. Both are
`resigned` and `payroll_eligible = false`, so nothing is owed today — but a zero base on an ACTIVE
person would now quietly reduce pay rather than quietly inflate it. See
[[a-payroll-rule-change-does-not-reach-an-already-open-run]].

## Live state, re-measured 2026-08-28 evening Cairo

**8 active employees** have all four NULL, and they fall into three groups that need completely
different handling. `payroll_eligible` is what separates them, and it is a strong signal: only
**6 of 105 active** people carry `false`.

**Group 1 — the 08-10 16:16 wipe, four rows still not restored** (`payroll_eligible = false`):

| HR ID | Name | Job title |
| --- | --- | --- |
| `AA` | Anwar Gaweesh | Ceo |
| `AB` | Sahar Khalil | R And D Manager |
| `B-185` | Ahmed El Maraghy | Finance and Admin Manager |
| `OF-0002` | Adel El Sayed | Financial Advisor |

All four are Head office, all four carry `updated_at = 2026-08-10 16:16` Cairo to the minute, and
**all four still hold `fuel_allowance = 500` while base/basic/gross/net are null** — the exact
survivor signature that identifies this event (see the employee-import memory: the import blanks the
salary columns and leaves ecol + fuel standing). Four here plus the three restored below is **7**,
matching the seven head-office rows that import is known to have hit. None has ever had a
`salary_records` row, and all four are `payroll_eligible = false`, which is the normal, deliberate
state for executives — so **this group is not urgent and may never need a figure at all.** Confirm
intent before "fixing" it.

**Group 2 — the actual live risk** (`payroll_eligible = TRUE`, zero `salary_records` ever):

| HR ID | Name | Job title | Hired |
| --- | --- | --- | --- |
| `AI-0009` | Omayma Wael | Medical Representative | 2026-08-20 |
| `AI-0013` | Weaam Mahmoud Mohamed | District Sales Manager | 2026-08-24 |

These two are **in the August population, are payroll-eligible, and have no figure to price** — the
August run will value them at nothing, silently. Neither shows the wipe signature (`fuel_allowance`
is null on both), so they are incomplete new-hire records, not victims: nobody ever entered their
compensation. `AI-0009`'s `updated_at` of `2026-08-10 16:18` sits two minutes after the wipe batch
but her row lacks the surviving allowance, so read it as adjacency, not membership.

**Group 3 — the two new HR seats**, `HR-010` Aya Mohamed Mahmoud (HR Business Partner) and `HR-009`
Yasmine El Safoury (HR Operations Coordinator), created 2026-08-28 20:07 Cairo, first working day
2026-09-01. Both need a salary figure **and** `payroll_eligible` flipped to `true` before the
September run. **Flip the flag and set the figure together, never the flag alone** — eligibility
without a figure is precisely what puts someone in Group 2.

## What changed from the original reading

**`A-12`, `A-9` and `B-10` are no longer on this list** — they were restored on 2026-08-28 from their
July payslips and now carry figures plus 7 `salary_records` each. **Do not re-raise them.** They were
the three that made this memory urgent (each had drawn a full, correct July salary while their
employee row read null), and that specific hole is closed. `PD-0011` Mohamed Eldomiaty has since gone
`resigned` and drops out of the active set.

The original 2026-08-28 morning measurement — six people, `A-12` 95,500 / `A-9` 51,500 / `B-10`
37,000 July net — stands as a dated record of that moment and is left intact above. It is simply no
longer current.

## The parts that did not change

**A part-2 derivation cannot lean on `employees.net_salary`.** Validating a part-2 formula against
the 105 published July rows, the only two it could not reproduce were `A-12` and `B-10` — the
NULL-salary people. The failure is silent twice over: Postgres **`greatest()` ignores NULL
arguments**, so `greatest(null, 0)` returns `0` rather than null, turning "unknown" into "zero owed"
with no error anywhere. See [[a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace]].

**23 people leave during August** and every one already reads `payroll_eligible = false` with
`employment_status = 'resigned'`. That is **not** a problem: the population builder deliberately uses
`getEmployeeDirectoryRows({includeInactive: true})` and keys the leaver test on
`leaverLastWorkingDate` scoped to the period, precisely because status flips at approval rather than
at departure (`recommend.ts:198-255`, written after `B-157` lost a full month of July pay that way).
A query that filters `payroll_eligible is true` will show **zero** August leavers and be wrong — ask
for the last working date instead.

**August is run number two.** July 2026 is the only run this system has ever completed (created
2026-07-20 19:07, part 1 frozen 07-26 08:59, published 08-10 10:11). The August run row exists —
created 2026-08-01 18:32 — but had **0 draft rows and no part 1 frozen** as of 2026-08-28. One run is
a sample, not a schedule.

Rough August shape at 2026-08-28: **121 people, ~2,238,226 EGP** — 87 full month, 23 leavers
(~270,161), 11 joiners (~199,565).

Related: [[employee-import-blanks-salaries-and-job-title-creates-positions]] ·
[[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]] ·
[[reps-who-never-appear-in-any-salary-record]] ·
[[exit-records-copy-one-date-into-all-four-columns]]
