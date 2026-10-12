# A day Phoenix CRM proves was worked is never charged

The account behind the rule in `.claude/rules/payroll.md` (the deduction half) and
`.claude/rules/crm.md` (the door half). Owner instruction, 2026-10-12:

> you must also check the phoenix crm before deciding a deduction check every source throughout
> everywhere to confirm u give acurate data bec this is people money its a deduction

## The counting door is not an evidence door

`crm_visits_unified` serves every deduction reader. Its Phoenix branch is INNER-joined to a started
team:

```sql
join phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
```

That join is **correct for counting** — a team the Super Admin has not pressed Start on is not yet
scored by the Phoenix rules, and serving its rows to the KPI boards would score it on a basis it is
not on. The cost is that until Start is pressed, a rep's logged field work reaches **no reader at
all**, and a day spent in the field reads as a day with no activity.

## What it was worth, measured on production

7–12 October 2026, production (`ozucdzovmcqvepbozvqf`):

- **121 real Phoenix visits, 6 Medical Reps, 17 person-days** — every one of those days carrying
  **zero** iReports360 rows, so nothing else could rescue them.
- **14 of those days, 7,193.54 EGP**, were past `computeZeroCrmSignalKeys` and would have been
  charged.

| Rep | Days | Amount |
| --- | --- | --- |
| Snagik Ayman | 4 | 2,258.06 |
| Samah Ashraf Elsaied Mohamed Abdullah | 4 | 2,000.00 |
| Mariam Younan Gaber Kends | 3 | 1,451.61 |
| Osama Mohamed Ali Mohamed | 2 | 1,000.00 |
| Taha Sheeba Alhammed Mohamed Abdelkhaleq | 1 | 483.87 |

Ahmed Mohamed Abd-Elnaim (3 days, 1,693.55) was protected only by accident — he happened to have
iReports360 rows elsewhere in the month, so the zero-signal guard took him out of scope.

Also invisible to every reader: **9 `phoenix_crm_day_starts` person-days** and **18 day-activity
person-days** logged before their team's start.

**No money had moved when the fix landed.** October 2026 held no `daily_deductions_publications`
row and the last published month was September 2026.

## The evidence loader

`src/lib/crm/phoenix-work-evidence.ts` asks the Phoenix **base tables** directly:

| Table | Why this one | What it proves |
| --- | --- | --- |
| `phoenix_crm_visits` | never `phoenix_crm_countable_visits` — an unapproved off-plan visit is still work that happened | a worked day |
| `phoenix_crm_day_activities` | all seven kinds are working time; leave is deliberately absent from them, so no kind needs screening out | a worked day |
| `phoenix_crm_day_starts` | carried so a reader can describe the day | **nothing on its own** |

All three filter `is_test = false` and key on the `rep_hr_id` the rows carry themselves, so no seat
or occupancy join is needed — which is exactly what keeps the started-team gate out of the answer.
`phoenix_crm_visits` also carries `manager_hr_id`, `senior_hr_id` and `product_manager_hr_id`, so a
manager's own day is proved by the visits his reps logged him onto.

**It throws on a failed read.** A loader that swallowed the error and returned an empty map would
charge every day it failed to read — the silent failure mode is a charge, so it fails closed.

`crm-single-source.test.ts` permits these reads: that guard forbids `ireports360_*` and
`crm_*_unified`, not the Phoenix tables, and `src/lib/crm/phoenix-team-starts.ts` already names
them.

## Where it is wired

`src/lib/deductions/phoenix-worked-days.ts` holds the Phoenix half. Since the outstation audit the
same day, the connectors read **`src/lib/deductions/proven-worked-days.ts`**, which folds the Phoenix
map together with the outstation trip days (`src/lib/outstation/trip-work-evidence.ts`,
`docs/deductions-outstation-trip-days.md`) under one key shape:
`${compactDeductionsHrId}:${date}`. **`compactDeductionsHrId` lowercases** (`canonicalHrIdKey`, then
strip `[^a-z0-9]`), so the keys read `mr0101:2026-10-07`.

| Reader | Where the guard sits |
| --- | --- |
| `deductions/connectors/crm.ts` | `excludeProvenWorkedDays` — a weighted re-price at the one exit both the leaver and the continuing path pass through, before the suspect-date step |
| `deductions/connectors/dsm-no-record.ts` | inside the `missing` filter |
| `deductions/connectors/holiday-bridge.ts` | before **both** causes, so a vacation-cause bridge day is spared too |
| `deductions/connectors/half-day.ts` | before `judgeHalfDay` |
| `daily-deductions/no-records-select.ts` | `continue` on a hit |
| `attendance/crm-day-maps.ts` | folded into `fieldVisitMap` — this is what lets a Phoenix field day cancel a **fingerprint** deduction |

`src/lib/private-calendar/phoenix-work-evidence-items.ts` registers the same evidence at **all
three** assembly points in `service.ts` — the calendar workspace, `getCompanyNoActivityDays` and the
day-evidence pass — so the calendar, the gap notice and the connector can never disagree about a
disputed day. The third matters most: without it a disputed day renders as "Phoenix has nothing for
this day" while the connector has already excused it.

## 🔴 It is a suppressor and never a signal

Never feed this evidence into `anySignal`, `hasAnySignalThisMonth` or `firstSignalByPerson`. Those
decide whether a person is **in scope at all** — a person with no signal all month is excluded
entirely, on the reasoning that the month's data is missing rather than the work. Adding Phoenix
evidence there would drag a rep whose only evidence all month is Phoenix **into** the charge, by his
own proof of work: the fix would charge the exact people it exists to protect.

`tests/deductions-phoenix-work-evidence.test.ts` guards that by source — it asserts no wiring writes
into those three maps, that the loader never reads the counting door, and that `call-rate.ts` and
`early-birds/collect.ts` never import it.

## What this does NOT cover

`attendance/crm-day-maps.ts` reads the Phoenix evidence only — a trip day does not cancel a
**fingerprint** deduction, and on production no trip day has ever produced one (the travellers are
District Sales Managers and head-office managers, and the enrolled devices are Head Office only).

Outstation and business trips WERE not a deduction source anywhere in the code when this document was
first written — nothing read `outstation_expense_requests` or `outstation_expenses`. Measured
1 September – 12 October 2026, 131 trip-days fell in that window and **65 carried no CRM row of any
kind and no fingerprint punch**. They are now a suppression source alongside Phoenix CRM:
`docs/deductions-outstation-trip-days.md`.
