---
name: approved-is-not-pushed-and-a-confirmed-step-freezes-the-zero
description: "Since 2026-10-07 \"Approved for Payroll\" IS the pay gate again, pushed or not (the 2026-09 push gate is RETIRED, owner) - but confirming a step still freezes the module's figure AT THAT MOMENT, so a decision after the confirm needs deduction-resync.ts, which recordDecision now calls itself. SAVING an open step froze it too: the resync now clears a saved figure unless the cell history says a person saved it, and a save writes only changed figures (saved-figures.ts). The admin re-collect (reconcileCandidateDrafts — run by hand from the Deductions page, there is NO cron) resyncs too since #5441, so every approval path re-opens a confirmed step EXCEPT once Part 2 is confirmed, where planDeductionResync skips (reason part2_already_confirmed) and the step is re-confirmed in Part 2 instead."
metadata:
  node_type: memory
  type: project
  originSessionId: 02b15773-349d-45f7-b725-9ffb4deee410
  modified: 2026-10-07T19:12:35.565Z
---

🔴 **RETIRED 2026-10-07 (owner: "make the Automated Payroll able to read them and every other
deduction from the Deductions module").** The push gate below left 16 approved September lines,
11,580.17 EGP across 6 people, off the sheet. Payroll now charges every "Approved for Payroll"
candidate, pushed or not, in every month; `monthRequiresPush` returns false; `recordDecision` runs
`deduction-resync.ts` when approval or the approved amount changes. The paragraph below is history.

**(History) "Approved for Payroll" releases nothing.** From `2026-09` the single gate for pay is the PUSH
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

🔴 **CORRECTED 2026-10-07: an UNCONFIRMED step is NOT live once it has been SAVED.** The grid sends
every row, and a saved figure beats the module (`pick`), so a whole-grid save of "Any more deductions?"
on 2026-10-06 froze 0.00 over 8,405.17 EGP approved for two employees (cleared and re-confirmed by the
owner at 10:56 Cairo the next day). Two halves, and they only work together: the resync clears a saved
figure on an open step unless the cell history's latest write says a PERSON saved it (`isTypedByHand`,
write_reason `step_saved`; #5437), and a save writes ONLY the figures somebody changed
(`saved-figures.ts`, branch `codex/open-step-saved-zero`) — without that second half the history
trigger records every cell a whole-grid save fills as "person saved it" and the next approval is kept
out of all of them again. `upsertDraftRows` writes one column set per request: a bulk upsert names the
union of columns and PostgREST writes NULL into a column a row left out, over the stored figure.
Same branch: Part 2's confirm refuses while a Part 1 deduction step is re-opened (its figure was
cleared and reads as 0.00), and the wizard keeps exactly that step editable during Part 2 — re-confirm
it there; "Unconfirm Part 1" re-freezes the paid first instalment and loses the deduction.

🔴 **EXTENDED 2026-10-07 (#5441): the re-collect resyncs too — it is the admin Deductions collect, run by hand, NOT a nightly cron.** `reconcileCandidateDrafts`
(the vacation/CRM re-collect) supersedes a decided candidate and carries, drops or retires its
decision onto a replacement — moving a figure a confirmed step had frozen, which left the sheet
paying the stale number after a routine re-collect. It was the LAST approval path that did not
resync. It now collects every employee whose SUPERSEDED decision was "Approved for Payroll" and
calls `resyncPayrollDeductionSteps` once at the end (a non-approved row charges 0.00 either side and
is left alone). So every approval path re-opens a confirmed step when an approved deduction
moves — `recordDecision`, the manual-entry route, the attendance day-report, and the re-collect —
EXCEPT a run whose Part 2 is already confirmed, which `planDeductionResync` deliberately leaves
alone (`part2_already_confirmed`, surfaced by `describeDeductionResyncNotApplied`); re-confirm that
employee's step in Part 2 instead.
Pinned in `tests/deduction-payroll-resync.test.ts` (verified on production first: September's
approved deductions, manual included, all reached the sheet — 0 frozen-misses).

**How to apply:** an open step follows the module only where nothing was saved for that employee; Part 1
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
