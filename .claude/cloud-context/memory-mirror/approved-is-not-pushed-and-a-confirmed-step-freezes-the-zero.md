---
name: approved-is-not-pushed-and-a-confirmed-step-freezes-the-zero
description: "Automated Payroll showing fewer deductions than the Deductions module is TWO different things, and the first is not a bug - a row must be PUSHED, not merely approved; the second is that confirming a step freezes the figure the module proposed AT THAT MOMENT, so a push after the confirm reaches nobody's payslip and the drift report used to be blind to it."
metadata:
  node_type: memory
  type: project
  originSessionId: 02b15773-349d-45f7-b725-9ffb4deee410
  modified: 2026-10-06T06:05:41.341Z
---

**"Approved for Payroll" releases nothing.** From `2026-09` the single gate for pay is the PUSH
(owner rule 2026-09-22, `DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY` in
`src/lib/deductions/push-cutover.ts`). Measured 2026-10-06: of four approved unpaid-vacation rows
for September, one was pushed, and Automated Payroll correctly showed that one person. That is the
system working, not losing three deductions. July and August 2026 are NOT re-gated - they published
under the old approval rule.

🔴 **The real defect sat behind it: a module-sourced step is a SNAPSHOT.** Confirming one copies the
module's figure onto `automated_payroll_draft_rows`, and `assembleRows` reads that copy and never
the module. The push gate inverted the order the module was built for - the September run confirmed
all ten Part 1 steps on 2026-09-24 and every push landed on 2026-10-06, so **8 pushed fingerprint
lines worth 3,333.32 EGP sat behind a step frozen at 0.00**, the step's own breakdown listing them
and the sheet charging nothing. `p1_fingerprint` emits no row at all for an employee worth 0.00, so
its confirm snapshot was EMPTY, and `detectModuleDrift` skipped any employee absent from the
snapshot - blinding the one safety net to nothing -> something, the direction the push gate made
normal.

**How to apply:** Part 2 steps stay live until confirmed, so a push lands there by itself; Part 1
(`p1_fingerprint` - which covers EVERY employee regardless of payment mode - `p1_crm`,
`p1_resignation_crm`, `p1_unpaid_vacation`, `p1_other_deductions`) is usually confirmed long before
anybody pushes. Route by the run's own `settled_in_part1`, never a fresh derivation: leavers and
one-part employees settle in Part 1 and a LEAVER's vacation/CRM is remapped onto the shared
`unpaid_vacations`/`crm` columns rather than the `p1od_*` pair. Before telling him a deduction is
missing, read the step state's `confirmed_at` against `deductions_publication_lines.pushed_at` -
and read what the DRAFT holds, because the step's own `values` falls back to the live
recommendation when the column is null, which makes a 0.00 the sheet will pay look like a figure
somebody chose. Outstation expenses already had the fix (`expense-resync.ts`, after the July 2026
run paid 1 Aug figures for 2 Aug decisions); `deduction-resync.ts` is its twin.
See [[a-payroll-rule-change-does-not-reach-an-already-open-run]] and
[[automated-payroll-crm-bucket-misses-one-part-and-leavers]].
