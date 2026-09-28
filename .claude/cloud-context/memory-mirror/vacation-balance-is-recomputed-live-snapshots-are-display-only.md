---
name: vacation-balance-is-recomputed-live-snapshots-are-display-only
description: "A vacation balance is RECOMPUTED from approved paid days at read time — there is no balance column, so correct it by inserting the missing approved day-rows (no deploy). The used/balance_before/balance_after columns are a display-only frozen snapshot; a back-dated insert makes every later PAID row stale, fixed by re-sequencing the whole period (never over unpaid rows). Two money traps: salary_records.unpaid_vacations is a SECOND, older deduction path that has already taken real money and is invisible to the deductions module (diff before publishing or people get charged twice), and a backfilled day inside the first six months lands UNPAID and consumes nothing. Price by unpaid_duration_days, never by counting dates. Weekly-off policy is keyed by SEAT title, not employees.job_title."
metadata:
  node_type: memory
  type: project
  originSessionId: bcdb86ed-6cb6-4e0d-a467-134df4215d8e
  modified: 2026-09-26T01:30:14.723Z
---

## The balance is recomputed — there is no balance column

Never try to "set" a vacation balance. The live number comes from `approvedPaidDaysInPeriod`
(`src/lib/vacation/service.ts`, called by `calculatePaymentForRequest`), summed at READ time from:

- `v2_vacation_requests`, `status='approved'`, `vacation_type in ('annual','emergency')`;
  `employee_hr_id` **uppercased** by the query (a lowercase row is invisible); `start_date >= period_start`
  and **`start_date < period_end`** (period_end is EXCLUSIVE — rows run `2026-01-04 → 2027-01-04` for a
  2025-01-04 hire); value from `paid_duration_days`, falling back to `duration_days` only when
  `payment_status='paid'`;
- **plus** `payroll_copilot_vacation_settlements` (`settlement_method in (balance, partial_balance,
  defer_to_balance)`, `superseded_at is null`, keyed by `employee_hr_id_compact` — `'B-25'` → `'b25'`);
- **plus** unpaid debt from earlier periods via `getDeferredDebtFromPreviousPeriods`.

Balance = `entitlement − used`; entitlement is **15 in year one, 21 after** (period model:
[[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]]). **So the only way to correct a
balance is to insert the missing approved day-rows** — no deploy, the next page load recomputes.

🔴 **OWNER RULE 2026-09-14 — a day he rules "not leave" is DELETED, never marked `rejected`.** ("do not
mark hr rejected remove them from records totally.") Copy the row AND its `v2_vacation_request_events`
into an `ops_backup` table first (children cascade: events, approval steps, email tokens, evidence
reviews), then delete. Caveat: `scripts/import-crm-vacation-backfill.ts` skips only days a request still
covers, so a re-run would **recreate** a deleted CRM leave day.

## The snapshot trap and its re-sequencer

`used_paid_days` / `balance_before_days` / `balance_after_days` on each row are a frozen RUNNING SNAPSHOT,
**display-only** — read by `company-vacation-report.ts`, never by the payroll, deduction or settlement
paths (those all re-call `calculatePaymentForRequest`). Insert a **back-dated** day and every later row's
snapshot reads off by one even though the balance is right.

- **Fix by RE-SEQUENCING the whole period per employee** in `start_date, created_at` order: `used` =
  running total BEFORE the row, `before = max(0, entitlement − used)`, `after = max(0, before − paid)`.
  **Not the older `+1` delta** — a delta breaks the moment more than one day is inserted. Use **each row's
  own `entitlement_days`** (it grows 1.25/month through year one, so three rows can carry three different
  entitlements).
- 🔴 **NEVER run the re-sequencer over UNPAID rows — it corrupts them.** An unpaid row's snapshot trio is
  deliberately **0**, written by `calculateVacationPayment`'s unpaid branches regardless of
  `entitlement_days`. An unpaid row has `paid_duration_days = 0`, so it can never shift a running total or
  make another row stale — restrict the re-sequencer to `payment_status='paid'` and confirm
  `unpaid_rows_consuming_balance = 0`.

## 🔴 The two money traps — check both before publishing anything

1. **`salary_records.unpaid_vacations` is a SECOND, OLDER deduction path that has taken real money.** It is
   a plain numeric column the payroll process writes directly; it owes nothing to the deductions module and
   is invisible to every guard in it (measured live: real money already taken across Jan–Jul 2026). So
   `deductions_publications = 0` means the *module* has never charged anyone — it does **not** mean nobody
   was charged. **Before publishing any month from the deductions module, diff its candidates against
   `unpaid_vacations` per employee-month, or people get charged twice.** The column is a single EGP figure
   with no day list, so the match is **INFERRED** (amount ÷ (base ÷ days-in-month)), never certain — say so
   to the owner rather than presenting it as fact. Both over- and under-charges have occurred, some in
   locked months, so look both ways.
2. 🔴 **A backfilled day inside the employee's first six months lands UNPAID and consumes nothing.**
   `calculateVacationPayment` returns `defaultUnpaid("first_six_months")` for any annual day before
   `hire_date + 6 months`, whatever the manager approved, so it charges 0 — "I inserted the day" is not
   "the day was counted." Both admin paths re-run the same engine, so the correction is hand SQL: set
   `payment_status='paid'`, `paid_duration_days`, `unpaid_duration_days=0`, `unpaid_reason=NULL`, then
   re-sequence later **paid** rows using each row's own `entitlement_days`. **Check `salary_records`
   FIRST** — Phoenix may hold no salary row for that month at all, so nothing was ever deducted and "paid"
   is the true state, not a favour.

🔴 **Price by `unpaid_duration_days`, NEVER by counting calendar dates.** A half day carries `day_part`
`am_only`/`pm_only` and `duration_days = 0.50`; counting rows as whole days overstates the charge and can
invert a recommendation. For a multi-day request weight each date by `unpaid_duration_days ÷ span`. Pricing
is `base_salary ÷ days_in_month`, so a 30-day month prices higher per day than a 31-day one.

## The deductions module itself is safe, and never published

`collectCrmSubmittedUnpaidVacationDays` reads the CRM directly for days with no matching HR request, but
three guards stop a double charge: the CRM scan skips HR-covered days, `mergeVacationSourcesHrRequestWins`
drops CRM drafts an HR draft claims, and `excludeAlreadyClaimedVacationDays` + `loadAlreadyDeductedDays`
(fails **CLOSED**) drop already-claimed days. `deductions_publications = 0` — no deduction of any category
has ever been published. Collection runs only from `POST /api/admin/deductions/collect`; nothing fires on a
schedule.

## Weekly-off policy is keyed by SEAT title, not `employees.job_title`

`employeeVacationPolicyTitle` resolves `positionTitle || jobTitle || "Unassigned"`, and `positionTitle` is
`positions.title` looked up by `employees.position_id` — so a record saying "Finance and Admin Manager" is
governed by the seat's "Finance Manager." **Match on the seat title when auditing.** **A title with no row
does not fail — it silently defaults** to Thursday working, Friday off, Saturday **WORKING** (the FIELD
pattern). House split: field roles (Medical Representative, District Sales Manager) work Saturday; every
office title has Friday **and** Saturday off. `job_title` carries a UNIQUE constraint (so the
`maybeSingle()` lookup can't throw on a duplicate). The `Admin Assist` / `Admin Assistant` pair are
**deliberate twins** (the seat model is protected, so a spelling miss was added as its own row rather than
renaming the seat) — do NOT "dedupe" them.

- **`calculateVacationDurationDays` THROWS on a non-working day.** Simulate every day through it before a
  bulk insert, or you write rows the module itself would have refused.
- **A leave day landing on a weekly day off means the CRM date is wrong, not the policy.** Verify by
  weekday volume before touching a policy (Medical Reps carry vastly more Saturday CRM marks than Friday —
  Friday-off is real). An office seat with zero CRM activity can never be adjudicated by the CRM — judge it
  by the office pattern.

## Bulk-insert hygiene

- **Rows can be written with NO audit event** when inserted by raw SQL rather than the script that writes
  events in the same run. Detect with a `not exists` on `request_id` and backfill the events — never leave
  a production write unattributed.
- **Shape to copy for a backfilled row:** `INSERT … SELECT` from an existing row of the same employee so
  no column is missed, overriding only the dates, the snapshot trio and `notes`. Tag `notes` with a
  `[CRM_BACKFILL_<date>]` prefix — it is the only handle for finding or reversing the batch later.
- **A `public` backup table is ANON-READABLE** — keep pre-images in a non-public `ops_backup` schema
  ([[ad-hoc-backup-tables-are-anon-readable]]).
- **Owner decision (standing): "skip everyone who left."** When recording missing unpaid days, record them
  for staff still employed and skip anyone `resigned`/`terminated`; unrecorded days for leavers are the
  finished state, not a backlog.

## `compensatory` charges nothing by design

`calculateVacationPayment` returns early for `compensatory` with `entitlementDays: 0` and
`paidDurationDays = duration`, before the six-month branch — so the owner's "in stead of Friday" day maps
straight onto it; do not model it as annual-and-refunded. A manual compensatory entry is refused without
event name, date, location, first manager AND an event photo, and `validateCompensatoryDetails` **expires
it 14 days after the event**, so a mailbox-sourced one usually cannot be entered — leave it unrecorded and
say so; a compensatory day costs the employee no balance either way.
