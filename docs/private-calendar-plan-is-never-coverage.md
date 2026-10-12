# A weekly plan is never coverage — his ruling of 2026-10-12, and the five-day window it closed

The rule itself is a one-line hook in `.claude/rules/payroll.md` and `.claude/rules/time-off.md`.
This file is the account: his words, what the code did before, what changed, and what it costs.

## His words

Asked, in chat, whether a submitted weekly plan should count as coverage for a `no_records_activity`
day — the one source the deduction audit of 12 October had never settled:

> **NO NEVER COUNT WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?**

Asked how far that reaches, given the Half Day (CRM) connector cleared a half day from an approved
plan item whose activity type was Admin, Event, Meeting, Meeting with Team, Other, Training or
Travel:

> **ever touch a weekly plan. Do not ever touch a weekly plan. All what you do that you see the
> weekly plan and the daily reports and compare the plan versus the actual, any title.**

And the one carve-out, unprompted, in the same conversation:

> **The only thing that touches the weekly monthly plan is a head office employee that not submitted
> a weekly plan until Monday the same week.**

So: the plan is read for COMPARISON — plan against actual, any title — and for exactly one charge,
`no_weekly_plan`, which charges a head office employee who filed no plan by the Monday of that week.
It excuses nothing.

## What the code did before, and for how long

Two places had made the plan into coverage, five days apart, both for the same honest reason: a
manager-approved Travel or Training day produces no fingerprint punch and no logged visit, so it read
as an empty day.

| Added | Where | What it did |
| --- | --- | --- |
| 2026-10-07 | `src/lib/private-calendar/logic.ts` — `isCovered` | An approved plan item whose type Phoenix records nowhere else made the day COVERED, so "No Activity Recorded" never fired and the day could not reach the Deductions module's No Records Activity connector. The day instead carried an `info` note, "Covered by the approved plan". |
| 2026-10-08 | `src/lib/deductions/half-day-rule.ts` — `judgeHalfDay` | The same approved plan item filled `planAm` / `planPm` and cleared that half, so a day with one worked half and one planned half was not a half day. The plan reached the connector through `loadApprovedCoveringPlanItems` in `src/lib/private-calendar/plan-items.ts`. |

Both were live on production. Neither looked like coverage at the call site: one was a filter over
calendar items, the other a display flag named `plannedActivityCoversTheDay` carried onto an item.
That is the reason the replacement rule is pinned by a SOURCE test as well as by behaviour tests.

## What changed

- `isCovered` no longer names a plan at all. A day whose only entry is an approved plan reads **No
  Activity Recorded**, with a second `info` note, **"Planned, but nothing recorded"**, naming what was
  planned — the comparison he asked for, beside the finding instead of in place of it.
- `judgeHalfDay` has no plan field to read: `HalfDayCover` lost `planAm` / `planPm`, `coveredBy`
  lost `approved_plan`, and `planItemHalves` — which existed only to place a plan item in a half — is
  gone.
- The Half Day connector reads no plan source. `loadApprovedCoveringPlanItems`, which existed only
  for it, is deleted; `loadPlanPrivateCalendarItems` (the calendar's own display loader) stays.
- `plannedActivityCoversTheDay` is renamed **`plannedActivityIsRecordedNowhereElse`**, and its
  meaning is stated: it says there is nothing else to look for beside the plan, never that the day is
  proven. The old name is how a display fact became a money decision.
- The Calendar Disputes reviewer still sees the plan, in neutral chrome rather than the green
  "this activity is the day's own record" chip, and the dispute-evidence tone is no longer `success`.
- `no_weekly_plan` is untouched. It is his carve-out, and it charges a missing plan.

## What it costs

More days are now flagged, and more can become candidates: every approved Travel, Admin, Meeting,
Meeting with Team, Training, Event or Other day on which nothing at all was recorded. That is the
intended effect of his ruling — a planned day nobody worked is the case he named. Nothing is charged
by any of this on its own: a candidate still has to be raised, and he still has to approve it for
payroll himself.

## Pinned by

| Test | What it would catch |
| --- | --- |
| `tests/deductions-plan-is-never-coverage.test.ts` | ANY new file in `src/lib/deductions` or `src/lib/daily-deductions` that reads a plan table or a plan-derived flag — the next wiring, not the two that were removed. Allows only `no-weekly-plan.ts` and its select half. |
| `tests/private-calendar-plan-source.test.ts` | The engine: an approved Travel day still reads No Activity Recorded, the comparison note names what was planned, and the covered-day test may not mention a plan. |
| `tests/deductions-half-day.test.ts` | The half-day rule: `judgeHalfDay` reads no plan, and the connector imports no plan source. |

All three run inside the required `validate` job.
