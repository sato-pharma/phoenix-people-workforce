# Half Day (CRM) — the morning or afternoon nobody accounted for

Owner ruling, 2026-10-08. The Deductions module's **Half Day (CRM)** tab lists every district
manager and medical rep who worked only one half of a field day and has nothing on file for the
other half. Code: `src/lib/deductions/half-day-rule.ts` (the rule, pure) and
`src/lib/deductions/connectors/half-day.ts` (the collector). Pinned by
`tests/deductions-half-day.test.ts`.

## His rulings

| Question | Ruling |
| --- | --- |
| What does one row charge? | Half a day: Base ÷ the month's calendar days × 0.5. One row per half day. |
| Who decides? | He does, row by row. Nothing is charged until the row is "Approved for Payroll" (`requiresApproval: true`, unlike CRM's mandatory rows). |
| Which payroll column? | The CRM column (`crm`): Part 2 CRM, the Part 1 CRM step and the leaver settlement all read it. |
| A day the visit clock contradicts? | Never flagged. |
| District managers? | "A manager is a normal employee." No team-size guard, but every day is confirmed against all evidence first, including double visits on a rep who has since resigned. |
| Thursday | A morning-only day for the field force, so it is never judged. Fridays, national holidays and company-wide CRM gap days are not judged either. |

## Who and which days

- **Population:** reps (`logsOwnCrmVisitsTitle`) and district managers (`/district (sales )?manager/i`).
  Active or on leave, or a leaver up to his last working day. Days before hire, after the last day,
  or before his first CRM record of the month are not judged.
- **Judged days:** Saturday to Wednesday, minus national holidays (read fail-closed), the CRM
  suspect dates the CRM connector already skips, and **GPS gap days**. A GPS gap day is one whose
  check-ins plus Phoenix captures arrived far short of normal, measured with the same detector
  (`detectSuspectDatesFromCounts` on `countGpsTracesByDate`). The sync keeps a window's visits
  when its check-in fetch fails, so such a day would otherwise be judged with no GPS at all, about
  2.8 times its real count. Each skipped day is named in the run's notes; re-sync the check-ins
  and collect again. A dense month with no GPS trace at all fails the run.

## How a half is placed

- An AM or PM tag names that half.
- An untagged customer call (regular, campaign −8, unlabelled −30), or a Phoenix "Pharmacy" row,
  is placed by its save time when saved the same day: 06–12 is the morning, 13–15 covers both, and
  anything else is the afternoon. A row saved on another day covers both.
- Any other untagged activity (meeting, training, public-holiday shift) covers the whole day.
- An Annual Vacation (−4) row on the day leaves the day alone, because the vacation connector owns it.
- **Campaign visits count exactly like regular visits** (12,204 of them since June).

## The tag is not the clock — what clears a missing half

Measured on production, August–September 2026: **1,962 visits tagged "PM" carry the rep's own GPS
check-in at that customer between 09:00 and 12:59.** Reading the tag alone would charge those
mornings. So before a half is charged, each of these clears it:

1. **His own GPS check-in.** 05:00–15:59 clears the morning and 13:00 onward clears the afternoon.
   The 13–15 band is genuinely mixed, so it clears either half. A check-in before 04:00 clears the
   previous evening.
2. **The rep's check-in at the customer of a visit he is credited on.** A manager logs no check-ins
   of his own, so his clock is the rep's.
3. **The save time.** Saved 06:00–12:59 on the day clears the morning. Saved from 17:00, or before
   04:00 the next day, clears the afternoon.
4. **A Phoenix CRM visit's capture time, read exactly like a check-in.** A started Phoenix team
   logs no iReports360 check-in; the phone captures each visit's location and time instead (owner,
   2026-10-08: "when they log a visit the location and time is captured, you can use it"). A
   Phoenix row's `ampm` is the customer list (AM or PM list), not the hour. In the database the
   row's `crm_save_date` is `captured_at`, the same value the check-in view serves as that
   team's `check_date`. It only ever clears a half; it never shows a rep a check-in.

**A Phoenix visit must have a location and a time — "no negotiation"** (owner, 2026-10-08). A
Phoenix customer visit with no captured location is not field evidence: it fills no half, clears
none, and does not start the person's month. Its count is written on the row's evidence and
reason, so the reviewer sees it was there. In the first week (3–7 October) this was 18 of 726
visits, all typed in by an admin for the rep (`capture_source` admin, `location_flag` no_place),
each on a day the rep also logged 5–18 located visits. Phoenix day activities (meeting,
training…) are not visits and carry no position by design. iReports360 visits keep counting by
their tag, because their location is their check-in. The check-in view already applies the same
condition to a Phoenix check-in (`lat` and `lon` not null).

Applied to June–October 2026, this is the difference between **862 apparent half days and 308
confirmed ones**.

## What covers a half

- An approved half-day vacation for that half ("AM off" / "PM off").
- An approved weekly-plan item of a covering type (Admin, Event, Meeting, Meeting with Team, Other,
  Training, Travel). If it starts before 14:00 it covers the morning. If it starts from 14:00, runs
  past 14:00, or has no end time, it covers the afternoon. If it has no start time, it covers both.

**The day is left alone entirely** when there is an approved full-day vacation, any request still
undecided or returned for edit, or a calendar review request that was not rejected.

## A district manager's half-day vacation (owner, 2026-10-08)

"A half-day vacation clears only its half." The district manager's full-day no-record check
(`connectors/dsm-no-record.ts`) used to skip the whole day for any approved request. A manager
with an afternoon off and nothing at all in the morning was charged nothing for that morning. It
now reads each request's `day_part` and asks `fullDayCheckLeaveVerdict`:

| Approved leave on the day | Saturday to Wednesday | Thursday (morning only) |
| --- | --- | --- |
| None | Judged as a full day | Judged at 0.5 |
| Full day, or AM off plus PM off | Cleared | Cleared |
| AM off | The afternoon goes to **this tab** | Cleared: the morning is the whole Thursday |
| PM off | The morning goes to **this tab** | Judged at 0.5: an afternoon off covers no Thursday field hour |

**Why the half comes here and not on the manager's no-record row.** That row is a `crm` row of
dates, and payroll weighs each date whole; only a Thursday counts as half
(`chargeableDeductionDays` → `sumDetectedDeductionDayWeights`). A Tuesday half on that row would be
billed as a day. This tab charges it at 0.5 ("PM off approved — nothing recorded for the morning")
through the same CRM column. The handed-over dates are listed on the manager's row evidence as
`halfDayVacationDatesOnTheHalfDayTab`.

Measured on production, 1 June to 7 October 2026: four district-manager days carried a half-day
vacation and no visit at all.

- Dina Hamdy Fadel Mohamed Bdair, Tuesday 4 August, PM off: the morning is owed. It is already
  a live Half Day (CRM) row at 0.5 for that date, and she has no no-record row in August.
- Momen Abdelhady Mohamed Shehata, Wednesday 9 September, AM off unpaid: the afternoon is owed.
  The date already carries his unpaid-vacation row at 0.5, so this is the known limit below.
- Amgad Ibrahim Tawfik Farag, Saturday 3 October, PM off: the morning is owed. October has not
  been collected yet.
- Amgad Ibrahim Tawfik Farag, Thursday 17 September, AM off: cleared, correctly.

So on a Saturday-to-Wednesday the money already landed right once the Half Day (CRM) tab went live:
the manager's row skipped the date and this tab charged the half. The fix makes that hand-off a
stated, pinned rule rather than a side effect of "any leave skips the day", and corrects the one
case this tab cannot see: a Thursday with an afternoon off and no record, whose morning is now
charged. No such Thursday exists in that window.

## Identity, resigned partners and collisions

- **Identity.** The hr id is used first. When a row has a blank hr id, the crm id is used instead;
  the mirror leaves `agent_hr_id` null for weeks (2,050 old-CRM rows since June). A crm id that two
  people claim credits neither of them. Every day such a row falls on is left alone for each of
  them rather than judged on half the evidence, and the count appears in the run's notes.
- **Resigned partners.** Visits are read through `scanVisitsForRangeIncludingDeparted`, and
  check-ins with `includeResignedAgents: true`. A manager's double visit lives on the rep's row, so
  the default door would erase his day the moment that rep resigned.
- **Collisions.** The publish guard (`deductions_publication_lines_guard_day_overlap`) allows one
  deduction per employee-day. A half day on a date another live deduction already charges is
  therefore listed in the collection's notes, not raised. A re-run replaces only this category's
  unpublished rows (`reconcilesWholeCategory`).
- **Run order.** The collector runs after every full-day connector and before `holiday_bridge`,
  which must stay last.

## The ticked-date rule (workspace and server)

A **single-date** candidate charges its own value when ticked and 0 when not
(`daysForTickedDates`). Before this, ticking a half-day date offered 1 day against a 0.5-day
finding, and the save was refused as "more than detected"; a fingerprint half day had the same
problem. `resolveDecisionCharge` applies the same rule on the server.

**Every multi-date candidate keeps the tick count, and its refusal.** Its dates do not all weigh
the same: a vacation row's `dates` lists every calendar day of the request, Fridays included,
while `rawValue` counts the unpaid working days. An earlier draft of this PR used a pro-rata
across the dates. On a 3-day request over 5 dates, unticking the Friday and Saturday read 1.8
days where 3 was right, and unticking a working day he came back for read 2.4 where 2 was right. For a full-day CRM row (`rawValue` equals the
number of dates) the count is exact either way.

## A known limit (one deduction per employee-day)

An unpaid AM-off vacation and an empty afternoon on the same date can only ever charge one row.
In normal run order the vacation row is created first, and the afternoon half day becomes a note.
If the vacation connector failed on the first collection, or the request later turned unpaid, the
half-day row claims the date first. The vacation connector then drops its single-day row on
every later run. Decide such a date on the Unpaid Vacation tab.

## The audit that preceded it (June 1 – October 7, 2026, read-only)

Confirmed half days, priced at Base ÷ calendar days × 0.5. These are estimates, not a collection:
nothing was written, and collection is the owner's click. **They are an upper bound.** The audit
predates two of the shipped guards: Phoenix captures clearing a half, and GPS gap days being
skipped. A collection can therefore only come out lower.

| Month | District managers | Reps | Half days | People | Estimate (EGP) |
| --- | --- | --- | --- | --- | --- |
| June | 44 (13 people) | 22 (20 people) | 66 | 33 | 24,991.67 |
| July | 45 (12) | 16 (15) | 61 | 27 | 23,233.87 |
| August | 39 (14) | 42 (22) | 81 | 36 | 26,975.81 |
| September | 26 (9) | 44 (17) | 70 | 26 | 23,025.00 |
| October 1–7 | 5 (4) | 25 (18) | 30 | 22 | 7,532.26 |
| **Total** | **159** | **149** | **308** | **83 distinct** | **≈105,758.60** |

214 of the 308 (seven in ten) are a missing **morning**.

Found along the way, and outside this tab:

- **Half-day vacations charged as a full day.** Five CRM half-day vacation days were each charged
  a full day: two in August's published deductions and three approved for September. Decided on
  the Deductions screen, never in chat.
- **`dsm_no_record`'s `approvedLeaveDays` ignored `day_part`.** A half-day vacation suppressed the
  manager's whole day there. Fixed 2026-10-08; see "A district manager's half-day vacation" above.
