# Phoenix CRM — the daily caps escaped on the send, and how they were closed

The account behind the module rule in `.claude/rules/phoenix-crm.md`: *the PM / AM daily caps are
re-checked when the rep **sends** the week, not only when he saves a day.* Measured on production
(ref `ozucdzovmcqvepbozvqf`) on 2026-10-03; pinned by `tests/phoenix-crm-plan-cap-on-send.test.ts`.

## What was found

One approved weekly plan held **18 PM** customers on a single day against a cap of **15**.

| | |
| --- | --- |
| Rep | Yasmeen Samy Shawky Mahdy, seat `SEAT-CNS-REP-D11` (CNS, Delta (1)) |
| Week | `week_start` 2026-10-03; the day is Saturday 3 October |
| The day | **18 PM** (cap 15) and 2 AM (cap 5 — within) |
| Plan | `206559bf-3155-4170-a0a7-3bb94b9d4af9`, `is_test = false`, status `approved` |
| Sent | 2026-10-02 **21:30** Cairo, by the rep's own account |
| Approved | 2026-10-02 **22:35** Cairo, by her district manager |

The cap had not moved: `phoenix_crm_settings.updated_at` is 2026-09-17 13:33 Cairo with
`pm_daily_cap` 15 and `am_daily_cap` 5. Fleet-wide, across every real plan of every week, that one
day is the **only** breach — so this is a hole that is rarely walked through, not a routine one.

## Where the items came from

The plan's own event log says the rep saved twice — 2026-10-02 13:12 (2 items) and 13:15 (**17**
items for the whole week) — and then submitted at 21:30. The submit event's payload lists **85**
items. Nothing in between is a `saved` event and the version went 3 → 4 on the submit alone, so the
missing items did not arrive through `savePlan`.

The rows say the same thing twice over:

- **62 of the plan's items carry a `created_at` OLDER than the plan row they hang on** — 2026-10-01
  16:32 Cairo against a plan row born 2026-10-02 13:12. An item cannot precede its own plan through
  the RPC, which creates both in one transaction.
- every one of those rows carries the same `updated_at`, 2026-10-02 **21:20** Cairo — ten minutes
  before the send, one write touching every day and both list types at once.

Two other seats show the identical shape and nothing else does: `SEAT-PED-REP-D13` (51 rows, oldest
2026-10-01 16:23) and `SEAT-PED-REP-D16` (38 rows, oldest 2026-10-01 16:15). All three are the week
of 3 October, the week Delta (1) started on, inside the window the weekly-plan rework landed in. So
the items were **re-parented onto the new weekly plan rows by a repair**, not written by the app.
The repair is not in this repository; its exact author was not identified and does not need to be,
because the lesson is the one below.

## Why nothing stopped it

- `savePlan` → `resolvePlanItems` (`src/lib/phoenix-crm/plan-rules.ts`) tested the caps against the
  items of **that save's payload**, which covers only the days the rep touched in it. A day he did
  not touch was never counted.
- `transitionPlan` (`src/lib/phoenix-crm/server/plans.ts`) called the
  `phoenix_crm_plan_transition` RPC with **no item or cap validation at all**. Its one item read
  existed for the stale-customer test and was filtered to the changeable days.
- the SQL side checks only week-passed, status, an empty plan, the decision note and the returnable
  day. **No cap exists in the database** — `phoenix_crm_plan_items` constrains `list_type` to
  `('AM', 'PM')` and nothing else.

So the only gate on a cap was the save, the save could not see the whole week, and the send promoted
whatever was stored straight past the manager.

## What was built

1. **The caps became one rule.** `planCapRefusal` holds the only comparison of a count with a cap,
   `countPlanDays` the only counter, and the two sentences ("Saturday 3 Oct has 18 PM. A day holds
   15 PM at most.") live there once. `resolvePlanItems` now calls it, so the save and the send can
   never drift to two limits or two wordings. The days are answered in **date order**, so the
   earliest offending day is named rather than whichever row a read returned first.
2. **The send re-checks the whole week.** `transitionPlan`'s `submit` branch reads every item row of
   the plan **once** — unfiltered — uses the changeable-day subset for the stale test as before, and
   hands the whole week to `planSendCapRefusal`. Narrowing that read back to the changeable days
   re-opens the hole, and a test asserts on the unfiltered read by name.
3. **It may only name a day the rep can still change.** `planSendCapRefusal` takes
   `repChangeableDays` as `onlyDays`: every day is counted, but a day outside the list is passed
   over. Without that, an over-cap day that has **passed** would refuse a send the rep has no way
   to fix — he can neither edit the day nor send the week, and the plan is stuck for good. The same
   covers a week returned for one *other* day, where that returned day is all he may touch.
4. **The refusal is one he can act on** (Golden rule #1): it names the day, the count and the cap,
   and adds *"Take one off that day, save, then send."* — the shape the stale-customer refusal
   already uses. Nothing about it reads as a check on him.

## The decision on `approve`

**A reviewer's `approve` is deliberately not refused.** Two reasons:

- the rep's send is now refused, so nothing over cap reaches a manager from here on. Blocking
  `approve` only ever bites a plan that is **already** over cap — and once its over-cap day has
  passed, the rep cannot fix it, so the plan would be unapprovable and unfixable at the same time;
- the manager is the person the cap exists for. Letting him see a week and decide on it is his job;
  refusing his decision because of a day neither of them can now edit moves the problem nowhere.

The week of 3 October's own plan is left exactly as it stands. Editing a live approved plan is the
owner's call, not a session's.
