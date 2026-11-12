# An accepted Private Calendar review request clears the day's deduction

## The rule, in the owner's words (2026-11-13)

> In private calendar … it pulls all the daily record sources and populate it. If no records recorded in a day,
> that means this day will be deducted. So some employees ask for review — not that the system has issue, but
> because they follow up when they have no records — so they can request a review, and send me, and I accept or
> approve. What I accept is appeared in the [calendar] and the day is not considered deducted.

So, for one person and one working day:

1. The Private Calendar reads every daily record source (fingerprint, CRM visits old and Phoenix, a manager's own
   single visits, vacations, excuses, outstation trips, holidays, the approved weekly plan where it is the only
   record).
2. Nothing in any source → the day reads "No Activity Recorded" and can become a deduction.
3. The employee files **Request review** on that day. It is a follow-up of his own empty day, not a complaint about
   the system, so nothing about it accuses anyone.
4. The Super Admin accepts it (or rejects it).
5. Accepted → the day carries a lime "Admin-verified correction" entry on the calendar **and is not deducted**.

## What was missing, and what was built

The calendar half was built on 2026-10-29 (`buildAcceptedCorrectionItems`, `withoutCorrectedDayFindings` in
`src/lib/private-calendar/logic.ts`). The deduction half was not: no deduction reader read
`private_calendar_data_disputes`.

Measured on production on 2026-11-13: 38 accepted whole-day requests from 16 people (2 Sep – 12 Nov 2026), and 25
still pending. Seven of the accepted October days, across five people, were still live CRM deduction lines in the
October 2026 month. The owner had already set every one of those lines to "Do Not Take Action" by hand on
9 November, so nobody was charged — but each day had to be cleared twice.

The fix adds a fourth source to the one map every deduction reader asks first, `loadProvenWorkedDays`
(`src/lib/deductions/proven-worked-days.ts`), beside Phoenix CRM work, outstation trips and a manager's own single
visits:

- `src/lib/private-calendar/accepted-review-days.ts` reads `status = 'accepted'` and `item_source is null`
  (whole-day requests, the same set the calendar turns into its correction entry) inside the window.
- Pending and rejected requests spare nothing. An item-scoped request annotates something already recorded that
  day, so it never stood for an empty day.
- HR ids are matched case-blind through the compact key, because a request carries the login's spelling
  (`pd-0026`) and the deduction carries the employee master's (`PD-0026`).
- A failed read throws. A silent "nothing accepted" would be a charge.
- Like the other three sources it only ever removes a day from a charge. It never brings a person into one.

The readers it reaches: the CRM connector, the district-manager no-record connector, the half-day connector, the
holiday-bridge connector and the daily no-records connector. The no-weekly-plan deduction is a different rule (a
plan not filed) and is not touched.

Pinned by `tests/deductions-accepted-review-days.test.ts`. Both breaks were checked: removing the fold fires
"the accepted day is a proven-worked day", and unwiring the loader fires "loadProvenWorkedDays reads the accepted
review requests".
