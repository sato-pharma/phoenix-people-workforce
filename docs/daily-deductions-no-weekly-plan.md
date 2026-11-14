# Daily Deductions — the no-weekly-plan deduction

Owner request, 2026-10-12: *"add a no weekly plans deduction of one day in the daily connectors if
not submitted a weekly plan till monday of this week a 1 day deduction but never fired automatic
always under the approval of system admin"*, narrowed in the same turn to *"and this rule for head
office employees only for now"*.

## The rule

One day's deduction, charged on that week's **Monday**, for a head-office employee on the allow-list
who had not submitted a weekly plan for that week by the **end of Monday, Cairo (23:59:59)**. It is a
**daily-module connector only**, and nothing is ever charged without the Super Admin releasing the
line.

The deadline was 23:59:00 exactly until 2026-10-19, so a plan sent at 23:59:30 read as late. The
owner chose the end of the day that morning: anything sent before midnight Cairo is on time
(`planDeductionGraceDeadlineForMonday` in `src/lib/weekly-planning/week.ts`).

## Who it applies to — his own ruling, not an inference

`WEEKLY_PLAN_REQUIRED_TITLES` is an **allow-list of two titles**: Product Manager and Group Product
Manager. Measured on production the day it was built: of **17 active head-office employees, only 3
have ever submitted a weekly plan** — Nahed Hattab (A-10), Ahmed SharafEldeen (B-155) and Rasha
Sabry (A-8), who hold exactly those two titles.

Read literally, "head office employees" would have charged the other 14 — the CEO, the owner
himself, the Buffet staff and the Admin Assistants — one day **every week**, for a document their
roles do not produce. The narrower reading was therefore put to him rather than shipped silently,
and he confirmed it the same day: *"keep the weekly-plan rule on the two product-manager titles"*.

🔴 **Never widen it back to every head-office employee on the strength of his earlier wording.** The
earlier sentence is the scope he was narrowing; the later one is the scope he chose.

## What counts as having submitted

`submitted_at` on the plan row — **never the status**. A plan that is submitted but not yet approved
still clears the guard. That is deliberate and matches his words ("if not submitted"), and it is the
one place this connector is looser than the Private Calendar, which counts only approved plans.

Proven on live W41 data, with today set to 2026-10-12:

| Person | W41 plan | Why the Monday is clear |
| --- | --- | --- |
| Rasha Sabry | submitted 11 Oct 09:27 Cairo, `hr_acknowledged` | submitted in time |
| Ahmed SharafEldeen | submitted 10 Oct 16:01 Cairo, `submitted` | submitted in time — status is not the test |
| Nahed Hattab | **no W41 plan at all** | on approved leave on 12 Oct, so the leave guard clears it |

## The guards, and the floor

A Monday is skipped when the employee was not yet hired, has left, was on approved leave, carries no
salary record, or the Monday falls before the **2026-10-12 policy floor** — the floor is what keeps
the rule non-retroactive. Through `runConnectorForRange` on production October data the connector
charges **0 employees / 0 EGP**: the last Monday is below the floor and today is never counted. The
raw connector proposes 6 drafts, all on future Mondays (19 and 26 Oct) — Ahmed SharafEldeen
838.71/week, Rasha Sabry 1,387.10, Nahed Hattab 1,032.26.

## 🔴 The week-key trap

`planDeductionGraceDeadlineForMonday` takes the **Monday date**, never a week key, and the connector
derives both the Monday and its week key from one calendar walk.

When this was built, `buildWeekKey` and `sundayFromWeekKey` disagreed by a whole week:
`buildWeekKey('2026-10-11')` and `buildWeekKey('2026-10-12')` both answer `2026-W41` — which matches
production's own plan rows, where `2026-W41` runs 11–15 Oct — while `sundayFromWeekKey('2026-W41')`
answered 2026-10-04. A helper taking the week key would have charged every day on the Monday of the
wrong week.

**#5768 fixed that inverse** (merged 2026-10-12), so the planning module's own
`submissionDeadlineForWeek('2026-W41')` now lands on Thursday 8 Oct 17:00 Cairo — the Thursday that
really does precede W41 — instead of 1 October. The Monday-date signature stays anyway, because the
caller holds the Monday already and the two deadlines answer different questions. The deduction's
grace deadline must stay the **later** of the two: being late in the planning module is a flag,
missing this one costs a day's pay. `tests/daily-deductions-no-weekly-plan.test.ts` pins both the
corrected inverse and that ordering, because this file is where a week's slip turns into money.

## Why it is absent from `DEDUCTION_COLLECTORS`

Registering it there would let a **month scan write the ledger automatically**, which is the one
thing he ruled out. It is therefore deliberately not a month collector, its category row carries
`requires_approval = true`, and `tests/deductions-module-safety.test.ts` pins both the absence and
the fact that the category stays hidden from the month workspace (a registered-but-empty tab reads
as a broken connector). The category row itself ships in
`supabase/migrations/20261012120000_deductions_no_weekly_plan_category.sql`, which had to drop and
re-add `deductions_categories_category_check` because both `daily_deductions_lines.category` and
`deductions_candidates.category` are foreign keys onto that table.

## Pinned by

`tests/daily-deductions-no-weekly-plan.test.ts` (15 guards, each broken one at a time and its own
assertion watched to fire), `tests/deductions-module-safety.test.ts`.

## Phoenix CRM weeks count too (14 Nov 2026)

The owner made Phoenix CRM the one plan store on 14 Nov 2026 (decision DR-02), and the legacy Weekly Plans form stopped accepting writes (`src/lib/weekly-planning/legacy-closed.ts`). The product managers had planned their weeks in Phoenix CRM since 17 Oct and stopped filing the legacy form after 24 Oct, so a connector reading the legacy form alone would have charged a day for weeks they did plan.

The connector now counts a week when either store holds a plan sent on time:

- the legacy `employee_plan_headers` row, as before, for the weeks before the switch;
- a `phoenix_crm_manager_plans` week whose `submitted_at` is no later than the deadline of the Monday inside it (a Phoenix CRM week starts on Saturday, so it holds exactly one Monday). Test personas never count.

Who owes a plan, the deadline, the first Monday and the one-day charge are unchanged. A failed Phoenix CRM read fails closed, like the legacy read: the connector reports a warning and charges nobody. Pinned by `tests/weekly-plans-one-store.test.ts`.
