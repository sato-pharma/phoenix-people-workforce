---
name: people-with-no-salary-figure-are-priced-at-nothing
description: "A person with no compensation figure is NOT refused — recommend.ts prices them at NOTHING, silently (base/basic/gross/net all NULL → baseSalary null → netSalary forced null, nothing throws). The named list it applies to changes constantly — RE-MEASURE against production, never quote a count or a roster from this file. Harder-to-spot sibling: base_salary=0 WITH allowances prices at the allowances alone and reads as a plausible small salary. Two payroll rules: never flip payroll_eligible without setting a figure in the same edit, and NEVER key a leaver query on payroll_eligible — it flips at approval, not departure, so key on last working date."
metadata:
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-09-25T23:51:20.315Z
---

## The mechanism — priced at nothing, silently

**A person with no compensation figure is not refused — they are priced at nothing.** `recommend.ts`
sets `hasAnyRawCompensationFigure` by testing `base_salary`, `basic_salary`, `gross_salary` and
`net_salary`; if **none** is above zero, `baseSalary` comes back null and `netSalary` is forced null
with it. Nothing throws, nothing looks wrong — the person is simply valued at zero in the run. That
mechanism is the durable fact here.

🔴 **The list of people it applies to changes constantly — RE-MEASURE against production before quoting
anyone; never quote a count or a named roster from this file.** The named instances this file once
tracked have all since been filled, resigned, or moved by other sessions — twice a "still open" reading
here was false within twenty minutes, in the same session, with no action by the writer. **Re-read a
payroll row immediately before asserting its state, never from earlier in the same conversation.**

## The harder-to-spot sibling — base 0 with allowances

`base_salary = 0` **with** `extra_cost_of_living` / `fuel_allowance` set makes `net_salary` a small
positive number, so `hasAnyRawCompensationFigure` is **true** and the person is priced at the
**allowances alone** — which reads as a plausible small salary, not as missing data. **Harder to spot
than a NULL, because nothing looks empty.** On a resigned/terminated person nothing is owed, but on an
**active** person a zero base now quietly **reduces** pay rather than inflating it, because the joiner
rule prorates on net ([[a-payroll-rule-change-does-not-reach-an-already-open-run]]).

## The two rules that keep someone from being priced at zero

- 🔴 **Flip `payroll_eligible` and set the figure TOGETHER, never the flag alone.** Eligibility without
  a figure is precisely what puts someone in the run with nothing to price.
- 🔴 **NEVER key a leaver query on `payroll_eligible is true` — it shows ZERO leavers and is wrong.**
  Status flips at **approval**, not at departure, so the population builder deliberately uses
  `getEmployeeDirectoryRows({includeInactive: true})` and keys the leaver test on
  `leaverLastWorkingDate` scoped to the period (`recommend.ts`, written after `B-157` lost a full month
  of July pay that way). Ask for the last working date instead
  ([[exit-records-copy-one-date-into-all-four-columns]],
  [[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]],
  [[reps-who-never-appear-in-any-salary-record]]).

## `payroll_eligible = false` is normal for executives — confirm intent before "fixing"

The 2026-08-10 employee-import wipe left a cluster of Head-office rows with base/basic/gross/net NULL
but **`fuel_allowance` still standing** — that surviving allowance beside four NULL salary columns is
the wipe **signature** ([[employee-import-blanks-salaries-and-job-title-creates-positions]]). These are
`payroll_eligible = false`, have never had a `salary_records` row, and that is the **normal, deliberate
state for executives** — the group is not urgent and may never need a figure. Confirm the owner's intent
before entering one; do not treat `false` as a defect.

A differing `social_insurance_wage` (or `social_insurance_status`) between two people on the same
package is **not an error** and costs them nothing — neither statutory figure touches take-home
([[payroll-reads-the-insurance-wage-never-the-status]]).

## A part-2 derivation cannot lean on `employees.net_salary`

Validating a part-2 formula against the published July rows, the only ones it could not reproduce were
the NULL-salary people. The failure is silent twice over: Postgres **`greatest()` ignores NULL
arguments**, so `greatest(null, 0)` returns `0` — turning "unknown" into "zero owed" with no error
anywhere ([[a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace]]).
