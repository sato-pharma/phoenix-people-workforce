# Outstation trip days are not a deduction source — the audit

Owner instruction, 2026-10-12: *"check outstation trips as a deduction source too"*, following
*"check every source throughout everywhere … this is people money its a deduction"*. This is the
audit, not a fix: which trip states count as proof of work is his ruling, and it has not been made
yet.

Sister account: `docs/deductions-phoenix-work-evidence.md`, the same defect in the CRM door.

## What reads outstation trips today: nothing

Two tables hold trips:

| Table | Shape | Rows (read live 2026-10-12) |
| --- | --- | --- |
| `outstation_expense_requests` | the live request flow — `trip_start_date` / `trip_end_date`, `status`, `same_day_trip`, `overnight_days`, and the CRM `am_workload` / `pm_workload` matched onto the trip | 207 |
| `outstation_expenses` | imported and legacy expense rows — `expense_date` / `to_date`, `hr_status`, `hr_approved` | 420 |

Neither is read by **any** deduction reader. A `git grep` for both table names across
`src/lib/deductions`, `src/lib/daily-deductions`, `src/lib/private-calendar` and
`src/lib/attendance` returns nothing at all. So a person who spent the day travelling on approved
company business, with no visit to log and no office device to punch, arrives at every connector as
a day with no activity.

## What it is worth, measured on production

1 September – 12 October 2026, production (`ozucdzovmcqvepbozvqf`). Trip days expanded from
`trip_start_date`..`trip_end_date` in Cairo dates, for statuses `accepted_by_admin`,
`accepted_by_system`, `approved` and `submitted`:

- **131 trip-days** in the window.
- **65 of them carry no CRM row of any kind** — not a Phoenix visit, not a Phoenix day activity, not
  a row through `crm_visits_unified`.
- **Zero of those 65 carry a fingerprint punch.** Nothing else rescues them.
- 3 are Fridays, which every connector already excludes, leaving **62 chargeable days**.

Priced the way both connectors price a day — `base_salary / calendar days in month × day weight`,
Thursday counting half for field titles (`calculateDeductionAmountFromBaseSalary`,
`sumDetectedDeductionDayWeights`):

| Connector | Trip state | Days | Day units | EGP | People |
| --- | --- | --- | --- | --- | --- |
| `dsm_no_record` | submitted (pending) | 34 | 33.50 | 29,979.30 | 10 |
| `no_records_activity` | accepted | 10 | 10.00 | 20,401.61 | 3 |
| `no_records_activity` | submitted (pending) | 14 | 14.00 | 15,436.56 | 5 |
| `dsm_no_record` | accepted | 4 | 4.00 | 3,850.00 | 2 |
| **Total** | | **62** | **61.50** | **69,667.47** | **18** |

The people are District Sales Managers (→ `dsm_no_record`) plus Product Managers, a Group Product
Manager, three National Sales Managers, a Regional Sales Manager and a Training Manager — titles
that `isOwnedByAnotherDeductionConnector` deliberately leaves to `no_records_activity`. The heaviest
single case is Saad Mohamed Saad Salama, District Sales Manager, **12 bare trip-days** between
1 September and 12 October.

## 🔴 Nothing has been charged, and that is verified, not assumed

- `daily_deductions_publications` holds **0 rows** — the daily module has never published anything.
- `deductions_candidates` has never produced a single `dsm_no_record` candidate, in any month, and
  `no_records_activity` is new as of 2026-10-12.
- Joining all 65 bare trip-days against every live `deductions_candidates` row by hr id and by date
  returns **0 matches**.

So the exposure is entirely **forward-looking**: it is what the next refresh and publish would
produce, not money already taken. The categories that have charged September are `crm`,
`crm_half_day`, `fingerprint`, `unpaid_vacation`, `other`, `loan` and
`insufficient_balance_vacation`, and none of them touches a trip day in this window.

## The ruling that is missing

A trip day is proof of work only once it is decided which states count. The statuses in play:

| Status | Rows | What it means |
| --- | --- | --- |
| `submitted` | 97 | the employee claims the trip; nobody has decided |
| `accepted_by_admin` | 61 | a human accepted it |
| `accepted_by_system` | 22 | the rules accepted it automatically |
| `approved` | 3 | legacy wording, July 2026 only |
| `rejected_by_admin` | 24 | refused |

An accepted trip is work that the company has already agreed happened. A **submitted** trip is a
claim — and it carries most of the exposure (48 of the 62 days). Treating a pending claim as proof
would let a day be rescued by a trip nobody has checked; refusing it charges the day before the
claim is even read, and the decision may land weeks later.

Until he rules, no suppressor is wired. When it is wired, it goes in as a **suppressor only**, never
into `anySignal` / `hasAnySignalThisMonth` / `firstSignalByPerson`, for the reason set out in
`docs/deductions-phoenix-work-evidence.md`.
