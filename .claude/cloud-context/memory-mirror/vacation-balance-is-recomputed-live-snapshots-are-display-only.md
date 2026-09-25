---
name: vacation-balance-is-recomputed-live-snapshots-are-display-only
description: "A vacation balance is RECOMPUTED from approved paid days — never read from a stored number. Inserting a back-dated leave day also requires re-sequencing every later row's snapshot columns."
metadata: 
  node_type: memory
  type: project
  originSessionId: bcdb86ed-6cb6-4e0d-a467-134df4215d8e
  modified: 2026-09-13T21:56:16.453Z
---

**Never try to "set" a vacation balance.** There is no balance column anywhere. The live number comes
from `approvedPaidDaysInPeriod` (`src/lib/vacation/service.ts`, called by `calculatePaymentForRequest`
~line 2362), which sums, at read time:

- table `v2_vacation_requests`, `status = 'approved'`
- `vacation_type in ('annual','emergency')` when the request is annual or emergency
- `employee_hr_id` **uppercased** by the query (`.eq(..., hrId.toUpperCase())`) — a lowercase row is invisible
- `start_date >= period_start` and **`start_date < period_end`** (period_end is EXCLUSIVE — rows carry
  `2026-01-04 → 2027-01-04` for a 2025-01-04 hire, not `2027-01-03`)
- value taken from `paid_duration_days`, falling back to `duration_days` only when `payment_status='paid'`
- **plus** `payroll_copilot_vacation_settlements` (`settlement_method in (balance, partial_balance,
  defer_to_balance)`, `superseded_at is null`, keyed by `employee_hr_id_compact` — `'B-25'` → `'b25'`)
- **minus** nothing; unpaid debt from earlier periods is added on via `getDeferredDebtFromPreviousPeriods`

Balance = `entitlement − used`. Entitlement is 15 in the first year, 21 after — see
[[a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them]] for the period model.

**So the only way to correct a balance is to insert the missing approved day-rows.** No deploy is
needed — the next page load recomputes.

**🔴 OWNER RULE 2026-09-14 — a day he rules "not leave" is DELETED, never marked `rejected`.** He
reversed a rejected+`admin_updated` correction on B-94 (5 May, 16 Jun): "donot mark hr rejected remove
them from records totally". Copy the row AND its `v2_vacation_request_events` into an `ops_backup`
table first (children cascade: events, approval steps, email tokens, evidence reviews), then delete.
Backups: `ops_backup.v2_vacation_requests_taha_deleted_20260914` + `..._events_taha_deleted_20260914`.
Caveat: `scripts/import-crm-vacation-backfill.ts` skips only days a request still covers, so a re-run
would recreate a deleted CRM leave day.

**The trap: `used_paid_days` / `balance_before_days` / `balance_after_days` on each row are a frozen
RUNNING SNAPSHOT, display-only** (read by `company-vacation-report.ts` and the report tables, never by
the payroll, deduction, or settlement paths — those all re-call `calculatePaymentForRequest`). Insert a
**back-dated** day and every later row's snapshot is off by one: the history column reads wrong even
though the balance is right. Fix it in the same operation —
`used_paid_days + 1`, `balance_before_days - 1`, `balance_after_days - 1` for every approved
annual/emergency row with a later `start_date` in the same period.

**Shape to copy for a backfilled row** — `INSERT ... SELECT` from an existing row of the same employee so
no column is missed, overriding only the dates, the snapshot trio, and `notes`. The 2026-08-03 batch set
`submitted_by_login_id`, `manager_decision_by_hr_id`, `hr_decision_by_hr_id` all NULL, `manager_decision`
and `hr_decision` `'approved'`, and wrote **one** `v2_vacation_request_events` row of type
`admin_created` and **zero** `v2_vacation_approval_steps`. Tag `notes` with a
`[CRM_BACKFILL_<date>]` prefix — it is the only handle for finding or reversing the batch later.

**The CRM backfill of 2026-08-24 — what was applied and what was deliberately NOT.** Of 520 CRM leave
days, 240 were missing across 79 employees. **159 rows were applied** across 47 employees — 144 paid,
plus 15 unpaid for B-14 alone (see below). Backup of all 320 pre-change rows is in
`ops_backup.v2_vacation_requests_20260824` (non-public schema — a `public` backup table would be
ANON-READABLE, see [[ad-hoc-backup-tables-are-anon-readable]]).

**OWNER DECISION 2026-08-24 — "skip everyone who left".** Asked whether to record the 79 unpaid days, he
ruled: record them for staff still employed, skip anyone `resigned` or `terminated`. Applied on that
basis — **35 days for 24 active people, EGP 19,118.84** of deduction proposals. **48 days remain
unrecorded and that is the finished state, not a backlog:** 45 belong to people who have left (his call,
do not revisit), and 3 are impossible (A-2 2026-03-14 Sat, B-15 2026-05-29 Fri, B-94 2026-04-03 Fri).

**A day the module cannot record at all** — the rep logged leave on their own weekly day off, and
`calculateVacationDurationDays` THROWS on a non-working day. Simulate every day through it first; a bulk
insert that skips that check writes rows the module itself would have refused.

**The weekly-off policy is keyed by the SEAT title, not `employees.job_title`.**
`employeeVacationPolicyTitle` resolves `positionTitle || jobTitle || "Unassigned"`, and `positionTitle`
is `positions.title` looked up by `employees.position_id` (`employee-directory.ts` ~1558) — so an
employee record saying "Finance and Admin Manager" is governed by the seat's "Finance Manager". Match on
the seat title when auditing. **A title with no row does not fail — it silently defaults** to Thursday
working, Friday off, Saturday **WORKING** (`weeklyOffPolicyForDateCalculation`), which is the FIELD
pattern. The house split is field roles (Medical Representative, District Sales Manager) Saturday
working, and every office title Friday **and** Saturday off.

**Audited and closed 2026-08-24.** 12 active people had no row. **The owner approved adding the 5 office
titles and they are now live in prod** — `Ceo`, `Finance Manager`, `Financial Advisor`, `R And D Manager`
and **`Admin Assist`** (a one-character spelling miss against the pre-existing `Admin Assistant` row —
added as its own row rather than renaming the seat, because the seat model is protected; the two rows are
deliberate twins, do not "dedupe" them). Table went 14 → **19 rows**. No recalculation was needed: the
only one of the five with any leave history, B-185, has 10 approved requests and **0** Saturdays inside
them. The remaining 7 without a row are correct as-is — 5 field people (4 National Sales Managers, 1
Regional Sales Manager) whose fallback already matches, and 2 system placeholders (`c-o1`, `O-3`) that
are not people. `job_title` carries a UNIQUE constraint, so the `maybeSingle()` lookup can never throw on
a duplicate, and CHECK constraints police the three day values.

**A leave day landing on a weekly day off means the CRM date is wrong, not the policy.** Verify by
weekday volume before touching a policy: across 121 Medical Representatives the CRM holds **20,569**
Saturday marks against **306** Friday ones, and across 26 District Sales Managers **804** against **17**.
Friday-off is real. A-2, the sole Sfe Manager, has **zero** CRM activity of any type, so the CRM can
never adjudicate an office seat — judge those by the office pattern instead.

**🔴 THERE IS A SECOND, OLDER DEDUCTION PATH, AND IT HAS TAKEN REAL MONEY — check it before publishing
anything.** `salary_records.unpaid_vacations` is a plain numeric column the payroll process writes
directly; it owes nothing to the deductions module and is invisible to every guard described below.
Measured live 2026-08-24: **32 salary rows across Jan–Jul 2026 carry EGP 32,253.08 of unpaid-vacation
deductions already taken** (Jan 1,122 · Feb 1,250 · Mar 2,481 · Apr 4,933 · May 4,753 · Jun 10,352 ·
Jul 7,362.08). So "`deductions_publications` = 0" means the *module* has never charged anyone — it does
**not** mean nobody has been charged for unpaid leave. Do not say the latter; this note said it once.

**Reconciled in full 2026-08-24** — workbook `unpaid-leave-reconciliation.xlsx`, built by
`build-reconciliation-xlsx.mjs` (scratchpad; read-only, reproducible — it re-reads all four tables
itself). 104 employee-months, 144 unpaid days, three groups: **18** where money was taken AND days are
recorded, **14** where money was taken and Phoenix holds NO leave day for that month, **72** never
charged at all (EGP 40,933.07). Of the 18, **12 match to the pound** — charging those again takes the
same money twice.

**🔴 PRICE BY `unpaid_duration_days`, NEVER by counting calendar dates.** A half day carries
`day_part` `am_only`/`pm_only` and `duration_days = 0.50`. Counting rows as whole days overstated the
first build by **EGP 1,637 in group A and 8,328 in group C**, and produced two *inverted*
recommendations — days that were already paid for in full read as half-owed. For a multi-day request
weight each date by `unpaid_duration_days ÷ span`. `payroll_copilot`/deduction pricing is
`base_salary ÷ days_in_month`, so a 30-day month prices higher per day than a 31-day one.

**Two real OVER-charges, both in locked months, EGP 776.69 total** — the risk runs both ways, so look
for it. B-164 Jul: payroll took 1,451.63 = exactly 3 full days, but the record holds 5 Jul (half),
6 Jul (half), 7 Jul (full) = **2 days** — one day too many, EGP 483.89. B-136 Mar: took 567.00 for a
**half** day, and 567 is `17000 ÷ 30` in a **31**-day month — wrong duration *and* wrong divisor,
EGP 292.80. Under-charges are larger: B-138 Mar (981 taken vs 13 days worth 5,870.93) and B-14 Jun
(3,383 vs 14 days worth 6,766.62).

**`unpaid_vacations` is a single EGP figure with no day list, so the match is INFERRED, never certain**
— the only handle is amount ÷ (base ÷ days-in-month). Say so plainly to the owner rather than
presenting a match as fact. Before publishing any month from the deductions module, diff its candidates
against that column per employee-month, or people get charged twice for real.

**Within the deductions module itself there is no double-charge, and it has never published.**
`collectCrmSubmittedUnpaidVacationDays` in `src/lib/deductions/connectors/vacation.ts` does read the CRM
directly for days with no matching HR request, but three guards stop a day being charged twice — the CRM
scan skips HR-covered days, `mergeVacationSourcesHrRequestWins` drops CRM drafts an HR draft claims, and
`excludeAlreadyClaimedVacationDays` + `loadAlreadyDeductedDays` (which fails CLOSED) drop already-claimed
days. Measured live 2026-08-24: 171 vacation candidates ever, only **8 live** (EGP 3,064.52), **0** of
which collide with any backfilled row — and **`deductions_publications` = 0 rows**, so no deduction of
any category has ever been published to payroll. Collection only runs from
`POST /api/admin/deductions/collect`; nothing fires on a schedule.

**Two traps this backfill hit — check both after any bulk insert here.**

1. **Rows can be written with NO audit event.** 21 B-14 rows (6 paid, 15 unpaid) existed with the
   backfill `notes` tag but no `v2_vacation_request_events` row, because they were inserted by SQL rather
   than the script that writes events in the same run. Detect with a `not exists` on `request_id`;
   backfill the events rather than leaving a production write unattributed.
2. **A bulk insert of PAID days appends its snapshot sequence instead of interleaving by date.** The
   simulation seeds `used_paid_days` from the period total and walks the missing days in date order, so
   back-dated rows get numbers that continue past the existing rows (a January day landing at
   `used = 6`). The real balance stays correct — only the display ledger reads scrambled. Fix by
   RECOMPUTING the whole period per employee in `start_date, created_at` order (`used` = running total
   BEFORE the row, `before = max(0, entitlement − used)`, `after = max(0, before − paid)`), not by the
   `+1` delta the older note prescribed — a delta breaks as soon as more than one day is inserted. 46
   rows across 5 employees needed it; 0 mismatches across 328 paid rows afterwards.

3. **NEVER run that re-sequencer over UNPAID rows — it corrupts them.** An unpaid row's
   `used_paid_days` / `balance_before_days` / `balance_after_days` are deliberately **0**, written by
   `calculateVacationPayment`'s own unpaid branches (`defaultUnpaid`, ~lines 320–350 of
   `calculations.ts`), *regardless* of the row's `entitlement_days` — so a first-six-months row can
   carry `entitlement_days = 3.75` with `balance_before_days = 0`. The formula
   `before = entitlement − used` disagrees with every one of them and would overwrite the module's own
   output. After the 35-day unpaid insert the re-sequencer flagged 60 rows; **all were unpaid and all
   were correct.** The check that actually settles it: an unpaid row has `paid_duration_days = 0`, so
   **unpaid rows cannot shift anyone's running total and can never make another row stale.** Verify with
   a windowed SQL comparison restricted to `payment_status = 'paid'` and confirm
   `unpaid_rows_consuming_balance = 0`; do not run the re-sequencer at all after an unpaid-only insert.

**🔴 A BACKFILLED DAY INSIDE THE EMPLOYEE'S FIRST SIX MONTHS LANDS UNPAID AND CONSUMES NOTHING
— and `updateVacationRequestAsAdmin` cannot fix it.** `calculateVacationPayment` returns
`defaultUnpaid("first_six_months")` for any annual day before `hire_date + 6 months`
(`calculations.ts` ~line 366), whatever the manager approved at the time. Because the live balance
sums `paid_duration_days`, such a row charges **0** — so "I inserted the day" is not the same as
"the day was counted", and the insert can read like success while the entitlement is untouched.
Both admin paths re-run the same engine, so the correction is hand SQL: set `payment_status='paid'`,
`paid_duration_days`, `unpaid_duration_days=0`, `unpaid_reason=NULL`, then re-sequence the snapshot
trio of every later **paid** row in that period using **each row's own `entitlement_days`** (it grows
1.25/month through year one, so the three rows carry three different entitlements). Check
`salary_records` FIRST: Phoenix may hold no salary row for that month at all — A-10's records start
January 2026, so nothing was ever deducted for an October 2025 day, which is what makes "paid" the
true state rather than a favour. Applied 2026-09-17 to A-10 Nahed Hattab (VAC-0554, 29 Oct 2025);
pre-image `ops_backup.v2_vacation_requests_a10_pre_paidfix_20260917`.

**Phoenix's `compensatory` vacation type charges nothing by design** — `calculateVacationPayment`
returns early for it with `entitlementDays: 0` and `paidDurationDays = duration`, before the
six-month branch. So the owner's rule that a day worded "in stead of Friday" is a compensatory day
maps straight onto the existing type; do not model it as annual-and-refunded. A manual compensatory
entry is refused without an event name, date, location, first manager AND an event photo, and
`validateCompensatoryDetails` also expires it **14 days after the event** — so a mailbox-sourced
one usually cannot be entered at all (her 1 March 2026 request names a 13 February event, 16 days).
Leave it unrecorded and say so: a compensatory day charges nothing either way, so the omission
costs the employee no balance.

Verified after the run: 194 rows created across 65 employees (144 paid, 50 unpaid), 0 without an audit
event, 0 rows where `balance_after > balance_before`, 0 snapshot mismatches on 328 paid rows, 48 CRM days
still unrecorded by decision. B-25 Hayam went 10 → **5**; B-14 Omnia Nader sits at exactly **0**.
