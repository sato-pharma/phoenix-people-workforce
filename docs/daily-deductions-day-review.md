# Daily Deductions — deduct a day by hand

**Owner, 23 Nov 2026:** "I want to be able to choose a person and choose a date. It doesn't have to be the
system identifying … I choose the person, I choose the date, and then his activity record for this day
appear to me. Then I can push deduction for this day to a person with a comment shown to him, and this if
approved to payroll, then it is deduction to be added to the payroll."

## What it does

A panel at the top of **Daily Deductions** (`/admin/daily-deductions`), for the Super Admin only:

1. **Choose a person** by name (the same picker as the Deductions screen's "Add a deduction"; it offers
   current staff plus anyone who left in the chosen day's month) and **choose a day** (today or earlier).
2. **The day's record appears** — everything the private calendar's one-day reader
   (`getPrivateCalendarDayEvidence`) holds for that person and day: fingerprint punches and corrections,
   Phoenix CRM field visits and double visits, leave, excuses, outstation trips, holidays, interviews and
   the approved plan. A plan is marked "what was intended, not a record". When a source cannot be read the
   panel names it, so an empty list is never mistaken for "nothing happened".
3. **The deductions already on that day** are listed (any live row whose charged days include it). While
   one exists the push is off: one day is charged once.
   So is a day already **released on this page** (a line of the active snapshot under "Released to
   employees" whose days include it): those lines are a separate store, and the month collection charges
   the same day later, so a push on top would charge it twice. Withdraw that line first. When the released
   list cannot be read the push stays off and the panel says so.
4. **Push** one day or half a day, each shown with its price (Base ÷ that month's calendar days), with a
   **required comment** of up to 1,000 characters.

## How it reaches payroll

The push writes ONE month-module candidate (`deductions_candidates`):

| Field | Value |
| --- | --- |
| category | `other` — needs an approval, paid through Other deductions |
| source_system | `daily_day_review` |
| source_record_id | `day-review:<hr id>:<day>` — one per person per day, whatever the comment or size |
| dates | the day itself |
| unit / raw value | days / 1 or 0.5 |
| reason | the comment |
| month | the payroll month that day is charged to (`dayChargeTarget`: a one-part employee's 22nd onward goes to the next payroll month, with its cycle marker) |

It is born **Pending** (no automatic decision). Then:

- **The employee sees it at once** on their own Deductions page as "Under review", with the comment as its
  reason (the portal ledger reads every live candidate from September 2026 on).
- **Payroll charges it only once it is "Approved for Payroll"** on the Deductions screen, Other tab, in
  that payroll month — the same gate as every other category.
- **When it is pushed to the employee** from the Deductions screen, the employee's email carries the
  comment as "Comment from HR" beside the amount and the day (email only — in-app and Telegram stay free
  of figures and reasons, as for every deduction).

## Why it refuses

- A day that has not come yet, a day before the person joined, a leaver's day after their last working
  day, or any day of a leaver with no last working day on record.
- A day already charged by another live deduction. Ignored: retired rows, rows marked "Do Not Take
  Action", a day the reviewer unticked, and Loan / Other entries typed on the Deductions screen
  (`manual_hr`, dated on the month's 1st as a placeholder — the publish-time day guard skips them the same
  way).
- A day already released on this page (`daily_deductions_lines` of the active publication whose `dates`
  hold the day), or a moment when that list cannot be read. The server push refuses it too.
- A second push for the same person and day (the candidate key collides).

🔴 **It claims its day.** Unlike a `manual_hr` entry, a `daily_day_review` row names a real day, so the
publish-time day guard (`findDayCollisions` and the database trigger on the publication lines) treats it
like a detected day. Refusing at push time says so while the screen is still open.

## Where it lives

- Rules (pure): `src/lib/daily-deductions/day-review.ts`
- Server: `src/lib/daily-deductions/day-review-service.ts`
- Route: `app/api/admin/daily-deductions/day-review/route.ts` (GET the day, POST the push; both
  `deductions:create` plus Super Admin)
- Panel: `src/components/admin/daily-deductions-day-review.tsx`
- The email comment: `DeductionPushNoticeLine.note` in `src/lib/deductions/notify-deduction.ts`, set in
  `src/lib/deductions/push.ts`
- Test: `tests/daily-deductions-day-review.test.ts`

The one-day reader now also lists the day's **interviews** (it loaded them and never listed them), so the
private calendar's day evidence and this panel both show them.
