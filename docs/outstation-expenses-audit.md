# Outstation Expenses — Forensic System Audit

**Audit date:** 2026-08-12 (Africa/Cairo) · **Branch:** `codex/finance-six-module-access` ·
**Production Supabase:** `ozucdzovmcqvepbozvqf` (Phoenix HR, eu-central-1) ·
**Method:** repository-wide discovery + reverse discovery from the database + production data
reconciliation. Every conclusion below was re-derived from live evidence for this audit; the
previous version of this file was treated as a lead list, not as fact.

**Scope of this document:** describe what the system IS. No redesign, no implementation plan.

**Evidence labels used throughout**

| Label | Meaning |
| --- | --- |
| `CONFIRMED IN PRODUCTION` | Observed in live production data or live schema |
| `ARMED BUT NOT OBSERVED` | The code path exists and is reachable; production has not hit it yet |
| `CODE DEFECT — DATA IMPACT UNKNOWN` | Defect proven in code; production effect not measurable |
| `UX/RUNTIME CONFIRMED` | Proven from rendered component source and route resolution |
| `UNCONFIRMED` | Stated as a hypothesis, evidence incomplete |

---

## 1. Executive Summary

Outstation Expenses is **not one module. It is two systems fused at a single table, plus a third
system that actually pays the money.**

1. **A live claim workflow** (`outstation_expense_requests`, 36 rows) — a GPS/photo/CRM-evidence
   capture wizard that an employee or an admin fills in.
2. **A historical spreadsheet ledger** (`outstation_expenses`, 360 rows + `outstation_expense_reports`,
   38 rows) — originally built to import Excel expense sheets.
3. **Phoenix Payroll**, which is where the money is actually paid, and which the outstation module
   does not reach by its own designed route.

System (1) does not pay anybody. When a request is approved it **manufactures a fake spreadsheet
upload** into system (2): a report named `outstation-request-<id>.workflow` containing exactly one
row. **36 of the 38 "Historical Uploads" in production are these synthetic one-row artefacts.**
Only two are real files. `CONFIRMED IN PRODUCTION`

System (2) then hands off to payroll through `phx_import_approved_expenses_to_payroll(month, year)`.
That function **has never run successfully, and structurally cannot**: it refuses any batch whose
status is not one of `part1_paid | adjustments_open | part2_ready | under_review | rejected`, and
**every one of the seven 2026 payroll batches is `locked` or `approved`**. Not one of the 360 ledger
rows carries `imported_to_payroll_at`. `CONFIRMED IN PRODUCTION`

The money nevertheless reaches employees — **EGP 258,748.50 across Jan–Jul 2026** sits in
`salary_records.expenses`. It gets there by **three other, undocumented routes**: the payroll
template pre-fill, the Automated Payroll wizard's Expenses step, and manual entry. The July 2026 run
matched the module's approved totals to the pound for 12 of 14 employees and **missed EGP 2,354.00
for two** (B-175 EGP 1,849 — no July salary record at all; B-74 EGP 505 — one trip dropped).
`CONFIRMED IN PRODUCTION`

Everything else follows from that split:

- **There is no manager approval step.** Only `Super Admin` holds `outstation:approve`. A District
  Manager receives a Cc email and has no decision surface anywhere in the product.
- **Approval state is stored in nine places** across two tables and three vocabularies, and they
  disagree in production: 70 rows are `hr_approved = true` while `hr_status` is blank; 21 requests
  read `submitted` while their ledger rows exist and are payable.
- **The ledger outlives its source.** 9 ledger rows and 3 report headers survive requests that were
  deleted — EGP 4,272.35 permanently approved and payable with no trip left to inspect.
- **Report counters are decorative.** 25 of 38 reports state an `approved_rows` figure that does not
  match their contents; one real upload is out by 29 rows and EGP 12,813.
- **The employee is told a falsehood on every paid expense.** The portal's "In payroll / Paid" stage
  reads `imported_to_payroll_at`, which is NULL on all 360 rows and can never be set. Every expense
  ever paid still displays "Not yet pulled into a payroll batch."
- **Financial mutations on the ledger are unaudited.** `audit_logs` has 116 rows for
  `outstation_request` and **zero for `outstation_expenses`** — the table the money is read from.

The module is not broken in the sense of being unusable. It is **operating outside its own design**,
with the gap between design and operation carried by a person doing arithmetic by hand once a month.

---

## 2. System Boundary

### In scope (proven to participate)

| Area | Why it is in |
| --- | --- |
| `outstation_expense_requests` | The live claim record |
| `outstation_expenses` | The ledger the money is summed from |
| `outstation_expense_reports` | Upload headers, real and synthetic |
| `outstation_policy_rules` | Rate/threshold policy (0 rows in production — defaults apply) |
| 10 pages under `/admin/outstation*`, `/employee-portals/*expense*`, `/workspace/*expense*` | Rendered UI |
| 36 API route handlers | Every mutation and read path |
| `phx_import_approved_expenses_to_payroll` | The designed (dead) payroll bridge |
| `salary_records.expenses`, `salary_batches` | Where the money lands |
| `automated_payroll_draft_rows.expenses` | The live payroll bridge |
| `/api/payroll/template` | The other live payroll bridge |
| Notification module `outstation` + `expense-approval.tsx` / `expense-rejection.tsx` | Employee comms |
| `audit_logs` (`entity_type='outstation_request'`) | Traceability |
| Approvals Hub (`/api/approvals-hub/hub-data`) | Sixth read-only surface listing outstation items |

### Out of scope but entangled — flag, do not touch

- **`expenses:read` also gates the entire `/api/marketing-requests/**` namespace** (~20 registry
  entries in `src/lib/security/access-registry.ts:335-445`). Removing `expenses` from a role to take
  them out of Outstation silently 403s their marketing approval rung.
- `payroll_copilot_expense_decisions` (0 rows) — FK to requests, `ON DELETE CASCADE`; a parallel,
  unused decision store.
- `geo_trip_routes` (0 rows) — dead table with claimed/expected/variance columns.

---

## 3. Technical Inventory

### 3.1 Pages (10 real + 2 thin wrappers + 3 redirects)

| Route | Component | Guard | Real purpose |
| --- | --- | --- | --- |
| `/admin/outstation-expenses` | hub of cards | hard-coded `["Super Admin","CEO"]` | Card menu into the 6 tools |
| `/admin/outstation/expense-command` | `ExpenseCommandTabs` + `ExpenseCommandDashboard` / `OutstationRequestsAdmin` | `assertOutstationAdminAccess(read)`; Queue tab needs `approve` | **Two unrelated screens on one route** — analytics (`?tab=intelligence`) and the approval queue (`?tab=queue`) |
| `/admin/outstation/expense-approvals` | `ExpenseApprovalsWorkspace` (1,793 lines) | `canReviewOutstationExpenseApprovals` | **The second approval surface** — unified request + ledger queue |
| `/admin/outstation/expenses` | `ExpensesReviewWorkspace` → `ExpenseReport` (1,505 lines) | `canAccessSystemAdministratorWorkspace` | "Historical Upload" + **the third approval surface** + the dead Import-to-payroll button |
| `/admin/outstation/expenses/dashboard` | `ExpensesDashboard` | `canAccessSystemAdministratorWorkspace` | Analytics — **overlaps expense-command intelligence** |
| `/admin/outstation/policy` | `OutstationPolicyAdmin` | `assertPermission(outstation, update)` | Rates/thresholds (table is empty) |
| `/employee-portals/expenses` | `MedicalRepExpensesWorkspace` | `expenses:read`, Medical Rep only in practice | Medical Rep simple submit + list |
| `/employee-portals/submit-expense` | `MobileOutstationWizard` (2,168 lines) | `outstation:create`, not Medical Rep | Manager/DSM submission wizard |
| `/employee-portals/expense-submissions` | `MyExpenseSubmissions` | `expenses:read` | The submitter's own trips + departure photo |
| `/employee-portals/expense-dashboard` | `PersonalExpenseWorkloadDashboard` | `expenses:read` | Analytics for managers |
| `/employee-portals/team-expenses` | `NsmTeamExpensesDashboard` | `expenses:read` + NSM | NSM-only team analytics |
| `/workspace/expense-dashboard` | wrapper → `WorkspaceExpenseDashboardPage` | admin-shell employee access | Same dashboard, admin shell |
| `/workspace/submit-expense` | wrapper → `WorkspaceSubmitExpensePage` | admin-shell employee access | Same wizard, admin shell |
| `/admin/outstation/requests` | — | — | **Redirect** → `expense-command?tab=queue` (preserves params) |
| `/admin/outstation/heatmaps` | — | — | **Redirect** → `expense-command` |
| `/employee/outstation/new` | — | — | **Redirect**, 4-way by role |

### 3.2 Backend surface

- **36 API route handlers** (35 under the two outstation namespaces + 1 payroll-copilot expenses
  route; `app/api/outstation/request-body.ts` is a shared parser, not a route).
  `/api/outstation/**` (employee, `outstation:read` + per-route
  `assertPermission`), `/api/admin/outstation/**` (`outstation:read` wildcard in the registry, plus
  `assertOutstationAdminAccess` or `assertSystemAdministratorWorkspaceAccess` in the handler).
- **No server actions.** Everything is route handlers + a domain service.
- **`src/lib/outstation/` — 39 files, 12,948 lines.** `service.ts` alone is 4,737 lines with 33
  exported functions.
- **`src/components/outstation/` — 46 files, 15,552 lines.** Five files above 800 lines.

### 3.3 Database objects (live, verified against `pg_class` / `pg_proc`)

| Object | Kind | Rows | Notes |
| --- | --- | --- | --- |
| `outstation_expense_requests` | table | **36** | 99 ordinal positions, 8 dropped columns |
| `outstation_expenses` | table | **360** | `trip_id` UNIQUE; FK `report_id` → reports `ON DELETE SET NULL` |
| `outstation_expense_reports` | table | **38** | no FK back, no trigger, denormalized counters |
| `outstation_policy_rules` | table | **0** | RLS on with only a `service_role` policy |
| `geo_trip_routes` | table | 0 | dead |
| `phx_import_approved_expenses_to_payroll(int,int)` | function | — | the dead bridge |
| **Triggers on any outstation table** | — | **none** | `updated_at` is app-maintained only |
| **Check constraints on any status column** | — | **none** | `status`, `hr_status`, `open_status`, `calculation_status` are free text |

RLS is enabled on all four tables with well-formed policies, **but the application uses the
service-role client on every path**, so RLS is not the operative boundary — application code is.

### 3.4 Notifications and emails

| Event | Recipients | Channels | Link destination | Actionable? |
| --- | --- | --- | --- | --- |
| Request submitted | **To** employee · **Cc** manager + skip-level · **Bcc** active Super Admins (CEO never) | in-app, email, telegram | `/admin/outstation/expense-command?tab=queue&requestId=<id>` | Yes, for the Super Admin |
| Request submitted (telegram button) | employee | telegram | `/employee-portals/expenses` | **Wrong page for a DSM** — that route redirects managers away |
| Request rejected | employee | in-app, email, telegram, push | `/employee-portals/expenses` (**no request id**) | No — generic landing |
| Departure-photo reminder | submitter only | in-app + email | portal | Yes |
| **Approved** | — | **none** | — | **No approval notification exists at all** |
| **"Expense added to payroll"** | — | **none** | — | `notifyExpensesAddedToPayroll` is defined at `src/lib/outstation/expenses.ts:1180` and **called from nowhere** — dead code `CONFIRMED` |

Email templates `src/emails/expense-approval.tsx` and `expense-rejection.tsx` exist; only the
rejection path has a live caller.

---

## 4. Current Data Model

```
employees (hr_id)
   │  FK ON DELETE RESTRICT
   ▼
outstation_expense_requests  ── id ──┐   "the claim"
   • status, calculation_status,      │   36 rows, all created Jul–Aug 2026
     eligibility_status,              │   8 report_* MIRROR columns (all NULL)
     territory_validation_status,     │
     evidence_gate_status,            │  NO FOREIGN KEY.
     workload_gate_status,            │  Linked only by the string
     workload_match_status            │  'OUTSTATION-' || id
   • claimed_total_amount             │
   • NO approved_amount column        │
                                      ▼
outstation_expenses  ◄── trip_id (UNIQUE)      "the ledger — where money is read from"
   • status / hr_status / open_status / hr_approved / approved_by / approved_at
   • total (claim) + approved_amount (HR's cut, NULL when untouched)
   • payout_month / payout_year          ← computed as trip month + 1
   • imported_to_payroll_at              ← NULL on all 360 rows, forever
   │  FK report_id ON DELETE SET NULL
   ▼
outstation_expense_reports                     "upload header — 36/38 are synthetic"
   • row_count / approved_rows / total_expenses  ← denormalized, never re-derived

                    ── the money leaves here, by three undocumented routes ──
                                      ▼
salary_records.expenses  ←── salary_batches (status: locked | approved | …)
   guarded by trigger phx_prevent_closed_salary_records_mutation
```

**Every duplicated fact and where it lives:**

| Fact | Storage locations |
| --- | --- |
| Is it approved? | `requests.status`, `requests.calculation_status`, `expenses.status`, `expenses.hr_status`, `expenses.hr_approved`, workflow-registry status (derived), `reports.approved_rows` (aggregate), `requests.approval_recommendation` |
| Who approved / when | `expenses.approved_by`, `expenses.approved_at` only — **the request row records neither** |
| Approved amount | `expenses.approved_amount` only — **the request has nowhere to store it** |
| Payout month | `expenses.payout_month/_year` — recomputed from the date on every save |
| Payment status | `expenses.imported_to_payroll_at` / `imported_payroll_batch_id` — structurally always NULL |
| Trip amounts | `requests.fuel/allowance/ticket/meeting/other/claimed/expected` **and** `requests.report_travel_cost/report_meeting_amount/report_other_amount` (all NULL) **and** `expenses.travel_cost/meeting_amount/allowance/other_amount/total` |
| Workload (AM/PM) | `requests.am_workload/pm_workload`, `requests.report_am_workload/report_pm_workload`, `expenses.am_workload/pm_workload` |

---

## 5. Current Status Models

### 5.1 Master status dictionary

| Value | Table.field | Code location | Meaning | Entered by | Exited by |
| --- | --- | --- | --- | --- | --- |
| `submitted` | requests.status | `service.ts:1681` | pending a human | every submission (unconditional since 2026-08-08) | approve / reject |
| `accepted_by_system` | requests.status | `service.ts:2600` | approved while `access.scope === "system"` | approve path | reject only |
| `accepted_by_admin` | requests.status | `service.ts:2600` | approved by a person | approve path | reject only |
| `rejected_by_admin` | requests.status | `service.ts:3438` | human rejection | reject path | **no supported exit** |
| `rejected_by_system` | requests.status | `decision.ts` (engine only) | **unreachable from the live submit path** since the 2026-08-09 flag-never-reject rule | — | 3 rows re-opened by hand-written SQL |
| `approved` / `rejected` | requests.status | pre-2026-06 vocabulary | legacy | historical | — |
| `accepted_by_system` / `submitted` | requests.calculation_status | `service.ts:1663` | did the automated checks pass | submission | approve/reject overwrite it |
| `eligible` / `needs_review` / `not_eligible` | requests.eligibility_status | `decision.ts` | distance + policy verdict | calculation | recalculation |
| `pending_arrival_photo` / `pending_departure_photo` / `complete` / `grandfathered` | requests.evidence_gate_status | CHECK constraint | photo gate | capture endpoints | photo capture |
| `pending_workload` / `complete` / `manual` / `grandfathered` | requests.workload_gate_status | CHECK constraint | CRM workload gate | capture/override | workload landing |
| `manual` / `matched` / `partial` / `no_activity` / `manual_override` / `stale_import` | requests.workload_match_status | CHECK constraint | CRM match quality | workload resolver | re-resolve |
| `manager_review` / `reject` / `auto_approve` | requests.approval_recommendation | `service.ts:1702` | advisory only | submission | — |
| `''` (blank) | expenses.status | default of the spreadsheet path | **pending** | Excel import, or the 2026-08-12 correction | approve/reject |
| `Approved` | expenses.status + expenses.hr_status | `payroll-expense-mapping.ts:119` | HR approved | approvals save | reject |
| `Rejected` | expenses.status | approvals save | HR rejected | approvals save | approve (approval wins) |
| `''` | expenses.open_status | — | **unused on all 360 rows** | never | never |
| `draft` / `pending` / `approved` / `rejected` / `added_to_payroll` | workflow-registry (derived) | `workflow.ts:18-32` | third vocabulary, folds the others | derived | derived |

### 5.2 The three vocabularies do not agree

Production distribution, live:

```
requests.status              submitted 31 · approved 3 · rejected_by_admin 2
requests.calculation_status  accepted_by_system 24 · submitted 7 · approved 3 · rejected_by_admin 2
expenses.status              '' 262 · Approved 82 · Rejected 16
expenses.hr_status           '' 348 · Approved 12
expenses.hr_approved         false 278 · true 82
expenses.open_status         '' 360   ← the column is dead
requests.report_hr_status    NULL 36  ← the mirror column is dead
```

`expenses.hr_status = 'Approved'` on **12** rows while `hr_approved = true` on **82**.
**70 rows disagree.** `CONFIRMED IN PRODUCTION`

### 5.3 The real state machine (as built, not as intended)

```
                     ┌───────── no manager step exists ─────────┐
employee submits ──► requests.status = 'submitted'  (ALWAYS)
                          │
   Super Admin approve ───┤────► accepted_by_system / accepted_by_admin
                          │        └─ evidence gate passes ──► ledger row created
                          │                                    (hr_approved = TRUE, hardcoded)
                          │        └─ gate holds ─────────────► NO ledger row, held indefinitely
                          │
   Super Admin reject ────┴────► rejected_by_admin
                                   └─ deletes the ledger row + the report if it empties

   ✗ no reopen        ✗ no return-for-correction        ✗ no cancel        ✗ no employee edit
```

Exits that do not exist in the application at all: reopen a rejection, un-approve, return to the
employee for correction, cancel by the employee, edit after submit. **Every one of those has been
performed in production by direct SQL** (§17).

---

## 6. Role & Permission Matrix

| Role | `outstation` | `expenses` | Can approve? | Surfaces reachable |
| --- | --- | --- | --- | --- |
| **Super Admin** | all actions | all actions | **YES — the only approver** | Everything |
| **CEO** | read, export | read, export | No (`executionOnlyOutstationRoles`) | Hub, expense-command (intelligence), expense-approvals (read), dashboards |
| **Finance Manager** | *(key deleted 2026-08-10)* | read *(marketing-requests only)* | No | **None** — deliberately excluded |
| District Manager | read, create, export | read, export | No | Submit wizard, expense-dashboard, expense-submissions |
| Regional Manager | read, create, export | read, export | No | same |
| National Sales Manager | read, create, export | read, export | No | same + team-expenses |
| Product / Group Product Manager | read, create | read, export | No | same |
| Training / SFE / Marketing Manager | read, create | read, export | No | same |
| Medical Rep | read, create | read, export | No | `/employee-portals/expenses` only |
| Financial Advisor | read, create | read, export | No | submit + dashboards |

**Enforcement is server-side and sound.** `assertOutstationAdminAccess` (`admin-access.ts:36`) gates
every admin route; the page guard on `/admin/outstation/expense-command` is deliberately the weaker
`read` and the Queue tab is hidden without `approve`, but the decision routes independently require
`approve`. CSRF (`assertSameOriginMutation`) is applied to every mutating route.

**The hypothesis that managers approve expenses is false.** `adminOutstationRoles` is
`new Set(["Super Admin"])` — one entry. `CONFIRMED`

---

## 7. Current User Journeys

Click counts are page transitions from the sidebar.

### 7.1 Medical Rep — "submit an expense and find out if I'll be paid"

`Sidebar → My Outstation Expenses (/employee-portals/expenses)` → submit inline → done. **1 hop.**
This journey is clean. It is also almost unused: **5 of 360 ledger rows, 3 employees, EGP 830.**

### 7.2 District Sales Manager — the module's real primary user (**328 of 360 rows, 15 people, EGP 121,533**)

Submitting: `Sidebar → Submit Expense` (1 hop) → 2,168-line wizard.
Checking on it: `Sidebar → Expense Submissions` (a *different* nav row).
Analytics: `Sidebar → Expense Dashboard` (a *third* nav row).

So the DSM has **three separate sidebar rows** for one job, and the module's own rejection email
sends them to `/employee-portals/expenses` — **which redirects a non-Medical-Rep away**. `UX/RUNTIME CONFIRMED`

### 7.3 Direct Manager — **no journey exists**

The manager is Cc'd on the submission email. There is no queue, no decision control, no route. The
Approvals Hub lists outstation items but is gated to `Super Admin` only
(`ALLOWED_VIEW_AS_ROLES = new Set(["Super Admin"])`).

### 7.4 HR / Super Admin — the approver

There are **four distinct routes to approve the same trip**:

| Path | Hops from sidebar | What it can decide |
| --- | --- | --- |
| Sidebar → **Outstation Expenses** hub → *Expense Requests* card → Queue tab → open request → Approve | **4** | requests only |
| Sidebar → hub → *Expense Approvals* → filter → open row → Approve/adjust/Save | **4** | requests **and** ledger rows, with amount adjustment |
| Sidebar → hub → *Historical Upload* → upload/select report → Approve rows → Save | **4** | ledger rows, with amount adjustment |
| Email link `?tab=queue&requestId=<id>` → Approve | **1** | requests only |

The email deep link is by far the shortest path and the only one that lands on the specific trip.
Everything else costs four transitions.

### 7.5 Finance — deliberately none

Removed 2026-08-10 by owner instruction. No Finance surface exists in Outstation.

### 7.6 Payroll operator — where the money actually moves

The designed path (`/admin/outstation/expenses` → "Import approved expenses to payroll") raises
*"Payroll batch cannot import expenses … while status is locked."* every time.

The **real** path is one of:
1. `/api/payroll/template` builds the month's XLSX with the Expenses column pre-filled from
   `getApprovedExpenseTotalsForPayroll` (hr_approved only), **falling back to last month's
   `salary_records.expenses`** when there is no approved outstation total; the operator edits and
   re-uploads it.
2. The Automated Payroll wizard's `p2_expenses` step, which reads the ledger with
   `payoutExpenseRowIsPayable` — **pending rows included by design**, only explicit `Rejected`
   dropped — writes `automated_payroll_draft_rows.expenses`, and assembles into `salary_records`.
3. Manual entry.

### 7.7 CEO / senior management

Read-only. Hub, expense-command intelligence, expense-approvals (buttons hidden server-side),
dashboards. No notification, no approval.

---

## 8. Page and Route Inventory

| Route | User label | Roles | Primary purpose | Primary action | Data source | Next destination | Suspected overlap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin/outstation-expenses` | Outstation Expenses | SA, CEO | card menu | click a card | nav config | 6 tools | — |
| `/admin/outstation/expense-command?tab=intelligence` | Expense Command Center | SA, CEO | analytics + heatmap | filter | `getOutstationExpenseCommandData` | itself | **`/admin/outstation/expenses/dashboard`** |
| `/admin/outstation/expense-command?tab=queue` | Expense Requests | SA | approval queue | Approve / Reject / Delete | `listOutstationRequests()` (all rows) | itself | **`/admin/outstation/expense-approvals`** |
| `…?tab=queue&action=create-manager-expense` | Add Manual Expense | SA | admin creates a claim | Create | modal | queue | — |
| `/admin/outstation/expense-approvals` | Expense Approvals | SA (decide), CEO (read) | unified queue + amount adjustment | Save decisions | `listUnifiedOutstationExpenses` | itself | **queue tab + historical upload** |
| `/admin/outstation/expenses` | Historical Upload | SA | Excel import **+ approvals + dead payroll import** | Upload / Approve / Import | `listPayrollExpenseReports` | `/payroll?batchId=` | **expense-approvals** |
| `/admin/outstation/expenses/dashboard` | Outstation Expenses | SA | analytics | filter | `getPayrollExpenseDashboardData` | itself | **expense-command intelligence** |
| `/admin/outstation/policy` | Outstation Policy | SA | rates | Save | `outstation_policy_rules` (empty) | itself | — |
| `/employee-portals/expenses` | My Outstation Expenses | Medical Rep | submit + list | Submit | `listMedicalRepExpenseRequests` | itself | — |
| `/employee-portals/submit-expense` | Submit Expense | DM/RM/NSM/PM/GPM/MM | wizard | Submit | portal + outstation context | expenses list | — |
| `/employee-portals/expense-submissions` | Expense Submissions | managers | own trips + departure photo | Capture photo | `listOwnOutstationSubmissions` | itself | **expense-dashboard** |
| `/employee-portals/expense-dashboard` | Expense Dashboard | managers | analytics | filter | portal service | itself | **expense-submissions** |
| `/employee-portals/team-expenses` | Team Expenses | NSM | team analytics | filter | NSM service | itself | **expense-dashboard** |
| `/workspace/expense-dashboard` | Expense Dashboard | admin-shell employees | duplicate of the above | — | same | — | **duplicate route** |
| `/workspace/submit-expense` | Submit Expense | admin-shell employees | duplicate of the wizard | — | same | — | **duplicate route** |
| `/admin/outstation/requests` | *(retired)* | — | redirect | — | — | `expense-command?tab=queue` | — |
| `/admin/outstation/heatmaps` | *(retired)* | — | redirect | — | — | `expense-command` | — |
| `/employee/outstation/new` | *(retired)* | — | 4-way role redirect | — | — | 3 portal pages | — |

**Classification (evidence-based):**
- Clearly operational: submit-expense, expenses (Medical Rep), expense-submissions, expense-command queue
- Reporting: expense-command intelligence, expenses/dashboard, expense-dashboard, team-expenses
- Administrative: policy, hub
- **Duplicate candidates:** expense-approvals vs expense-command queue vs historical-upload approvals; expenses/dashboard vs expense-command intelligence; `/workspace/*` vs `/employee-portals/*`
- **Legacy compatibility:** the 3 redirects
- **Unclear:** `/admin/outstation/expenses` — it is simultaneously an importer, an approval surface and a dead payroll bridge

---

## 9. Navigation Graph

```
ADMIN (Super Admin)
  Sidebar ─ "Outstation Expenses" (single row)
      └─► /admin/outstation-expenses  [hub of 6 cards]
             ├─► Expense Approvals ──────────► /admin/outstation/expense-approvals ──┐
             ├─► Expense Command Center ─────► /admin/outstation/expense-command      │  all three
             ├─► Expense Requests ───────────► …/expense-command?tab=queue ───────────┤  approve
             ├─► Add Manual Expense ─────────► …?tab=queue&action=create-manager-…    │  the SAME
             ├─► Outstation Expenses ────────► /admin/outstation/expenses/dashboard   │  trip
             ├─► Historical Upload ──────────► /admin/outstation/expenses ────────────┘
             └─► Outstation Policy ──────────► /admin/outstation/policy

  retired: /admin/outstation/requests ─► ?tab=queue   ·   /admin/outstation/heatmaps ─► expense-command

EMPLOYEE PORTAL (District Sales Manager — the real primary user)
  Sidebar ─ Expense Dashboard ─────► /employee-portals/expense-dashboard   (analytics)
  Sidebar ─ Expense Submissions ───► /employee-portals/expense-submissions (own trips, departure photo)
  Sidebar ─ Submit Expense ────────► /employee-portals/submit-expense      (wizard)
                                        └─ on success ─► back to the wizard, no return context

  rejection email ─► /employee-portals/expenses ─► REDIRECT ─► /employee-portals/submit-expense
                                                   (a DSM never sees the rejected trip from the email)
```

**Structural problems visible in the graph:**
- One trip is decidable from **three** admin destinations that do not link to each other.
- `?tab=` puts two unrelated screens (analytics, approval queue) behind one route; the browser back
  button leaves the queue for the dashboard.
- The employee's three portal rows are one job split three ways.
- Every rejection email dead-ends: no request id, and a role-dependent redirect.
- **No `returnTo` parameter exists anywhere in the module** (`git grep returnTo -- src/components/outstation` → 0 hits). After a decision the reviewer's filters, month and scroll position are gone.

---

## 10. Request Lifecycle

**Creation** (`submitOutstationRequest`, `service.ts:1504-1849`)

Server-enforced, in order: live arrival photo + metadata (**all transport types**, throws without
it) · workflow-registry `submit` transition · unpriceable car trip blocked (`fuel-policy.ts`) ·
ticket attachment mandatory for train/bus when online (offline is held instead) · GPS accuracy vs
policy → hold · offline sync delay vs policy → hold · eligibility, campaign/double-visit,
governorate → hold.

**Waived for three roles** (owner request 2026-08-19, `evidence-waiver.ts`): Product Manager,
Group Product Manager and National Sales Manager submit with **no evidence photo at all**, on
every transport type, and their train/bus ticket is **optional** (PDF or image). The waiver covers
BOTH photos — waiving only the arrival photo would park these requests at `pending_arrival_photo`
forever, since `resolveOutstationGateState` demands the first photo before it looks at anything
else. It is derived from the row's own `employee_role` on every read, so there is no new gate
status and no migration: `evidence_gate_status` goes on recording truthfully which photos a row
holds, and the gate decides separately whether that matters for the role. The **workload** gate is
untouched — only the photographs were waived. A waived role that *does* attach a photo is still
validated exactly like everyone else.

**The system flags, never rejects** (owner rule 2026-08-09). Every failed check appends to
`reviewHoldReasons`; the row persists as `status='submitted'` with the reasons joined into
`approval_reason`. `calculation_status` separately records `accepted_by_system` vs `submitted`.

Not enforced anywhere: duplicate-trip prevention beyond the allowance-day guard; an upper bound on
any amount; server validation that `claimed_total` equals the sum of its components (§16).

**Decision** — Super Admin only, from any of three screens.

**Payment** — see §13. The lifecycle has no "paid" state the application can ever set.

---

## 11. Approval Decision Architecture

### Approve (`approveOutstationRequestForPayroll`, `service.ts:2573`)

```
UI (queue / approvals workspace)
 → POST /api/admin/outstation/[id]        (assertOutstationAdminAccess "approve" + CSRF)
 → assert workflow-registry transition (skipped entirely for a Super-Admin override)
 → UPDATE outstation_expense_requests SET status, calculation_status, approval_reason
      ⚠ .eq("id", requestId) with NO status precondition
 → resolveOutstationGateState(photos + workload)
      ├─ eligible → pushAcceptedOutstationExpenseToPayroll
      │     → getLinkedOutstationPayrollExpense(trip_id)
      │     → mapOutstationRequestToPayrollExpenseRecord  ⚠ hardcodes status:"Approved",
      │                                                      hr:"Approved", hrApproved:true
      │     → savePayrollExpenseApprovals
      │           → INSERT a NEW outstation_expense_reports row when no linked report exists
      │           → UPSERT outstation_expenses ON CONFLICT (trip_id)
      │           → resyncPayrollExpenseStepForRows → clears the frozen payroll draft figure
      └─ held  → NO ledger row; logError only
 → writeRequiredAuditLog(entity_type='outstation_request')
 → notification ONLY if the previous status began with "rejected"
```

### Reject (`rejectOutstationRequestAsAdmin`, `service.ts:3347`)

Refuses if already imported to payroll · requires a comment · **DELETES** the ledger row and the
report when it empties · resyncs payroll · updates the request · audits · notifies the employee.

### Delete (`deleteOutstationRequestAsAdmin`, `service.ts:3627`)

Same ledger/report deletion, plus storage cleanup, then deletes the request. Audited.

### Bulk save (`applyOutstationRequestExpenseDecisions`, `service.ts:3539`)

A **serial `for` loop**. Per entry: request read + linked-expense read + (approve → a second request
read, a second linked read, registry check, update, push = report write + snapshot read + upsert +
resync + audit). **≈10–14 round trips per approved row, sequentially.** Uploaded ledger rows in the
same Save are batched into one upsert; request rows are not.

### Properties

| Property | Approve | Reject | Delete | Bulk |
| --- | --- | --- | --- | --- |
| Atomic across tables | **No** | **No** | **No** | **No** |
| Transactional | No | No | No | No |
| Idempotent | Partly (push skips if imported) | No | No | Per-row |
| Concurrency-guarded | **No** — bare `.eq("id",…)` | Guard present but `.in("status", […])` **lists every status including the target**, so it excludes nothing | No | No |
| Audited | Yes (request only) | Yes (request only) | Yes (request only) | Inherited |
| Reversible in-app | **No** | **No** | **No** | **No** |

---

## 12. Expense Amount Lifecycle

```
wizard/modal
  → fuel = distance × rate  |  allowance = policy per day  |  ticket = go + return  |  meeting/other
  → expected_total_amount, claimed_total_amount        [requests]
      ↓  outstationExpenseTotal(): claimed > 0 ? claimed : expected
  → outstation_expenses.total                          [ledger, the claim]
      ↓  HR adjusts on Expense Approvals / Historical Upload
  → outstation_expenses.approved_amount                [NULL when untouched]
      ↓  payableExpenseAmount(approved, total) = approved ?? total
  → payout_month = trip month + 1  (nextPayrollPeriod, recomputed on every save)
      ↓
  → payroll template pre-fill  |  automated-payroll draft  |  manual entry
      ↓
  → salary_records.expenses
```

**Rules that hold:** `approved + deduction === claimed` (`payable.ts`); clamped to `[0, claimed]`;
a DB check constraint forbids negative `approved_amount`; a bulk approve refuses an adjusted amount
with no written reason (`planBulkApproval`).

**Rules that do not hold:**
- `normalizeApprovedAmount` returns **NULL when approved equals claimed** (±0.005), so "HR reviewed
  and approved in full" is stored identically to "nobody touched it".
- **No upper bound** on `approved_amount` anywhere except `≤ claimed` in the UI helper; the DB only
  forbids negatives.
- The **request row has no `approved_amount` column at all**. If the evidence gate is holding a
  trip, there is no ledger row, and `writeOutstationRequestPayableAmount` returns false — the
  adjusted figure is discarded with only a skip message.
- **`total` and its components can disagree** and nothing checks it. Live: `OUTSTATION-31`
  total 240 vs allowance 300; `OUTSTATION-52` total 364 vs allowance 800. `CONFIRMED IN PRODUCTION`
- `nextPayrollPeriod` uses `getUTCMonth()` on a timestamptz. A trip starting between 00:00 and
  02:00 Cairo on the 1st of a month reads as the previous month in UTC → **payout one month early**.
  `ARMED BUT NOT OBSERVED`

---

## 13. Payroll Integration — designed vs actual

### 13.1 The designed path, and why it is dead

`phx_import_approved_expenses_to_payroll(p_month, p_year)`:

```sql
if v_batch.status not in ('part1_paid','adjustments_open','part2_ready','under_review','rejected')
then raise exception 'Payroll batch cannot import expenses … while status is %.'
```

Live batch statuses:

| Batch | Status | Records | `sum(expenses)` |
| --- | --- | --- | --- |
| 2026-01 | **locked** | 88 | 21,000.00 |
| 2026-02 | **approved** | 111 | 38,602.00 |
| 2026-03 | **locked** | 117 | 23,459.00 |
| 2026-04 | **locked** | 122 | 28,289.00 |
| 2026-05 | **locked** | 130 | 52,185.50 |
| 2026-06 | **locked** | 123 | 48,186.00 |
| 2026-07 | **approved** | 105 | 47,027.00 |

Not one is in the accepted set. `locked` is terminal. **The button cannot succeed for any existing
period.** `imported_to_payroll_at` is NULL on all 360 rows. `CONFIRMED IN PRODUCTION`

The RPC is also **destructive if it ever did run**: it `SET expenses = coalesce(at.approved_expense, 0)`
over a `LEFT JOIN`, so every employee in the batch **with no approved outstation expense would be
zeroed**. July alone carries EGP 19,354 for 9 such people. `ARMED BUT NOT OBSERVED`

### 13.2 The three live paths

| # | Path | Which rows it takes | Where it writes |
| --- | --- | --- | --- |
| 1 | `/api/payroll/template` → `getApprovedExpenseTotalsForPayroll(month, year)` | `hr_approved = true` only, `payableExpenseAmount` | Pre-fills the Expenses column of the downloadable XLSX; **falls back to `getLatestSalaryExpenseTotalsBefore` — last month's `salary_records.expenses` — when there is no approved total** |
| 2 | Automated Payroll wizard `p2_expenses` → `buildPayoutExpenseTripMap` | **everything except explicit `Rejected`** — pending rows included by design | `automated_payroll_draft_rows.expenses` → assemble → `salary_records` |
| 3 | Manual edit / salary sheet upload (`salary-import.ts` maps `Expenses`, `Expenses Prev Month`) | whatever is typed | `salary_records` |

Paths 1 and 2 **disagree about what is payable**: path 1 takes only approved rows, path 2 takes
pending ones too.

### 13.3 July 2026 — what the hand-carry actually did

| HR ID | Employee | Outstation approved | Paid in payroll | Gap |
| --- | --- | --- | --- | --- |
| B-175 | Ahmed Nashaat Ali Ahmed | 1,849.00 | **no July salary record** | **−1,849.00** |
| B-74 | Ahmed Mohamed Abdallah | 2,603.00 | 2,098.00 | **−505.00** |
| A-7, B-1, B-118, B-119, B-12, B-120, B-154, B-184, B-23, B-5, B-76, B-94 | 12 employees | matched | matched | 0.00 |
| A-12, A-8, B-122, B-189, B-25, B-34, B-7, B-82, PD-0001 | 9 employees | **none** | 19,354.00 | +19,354.00 |

**EGP 2,354.00 approved and not paid. EGP 19,354.00 paid with no outstation source.**
`CONFIRMED IN PRODUCTION`

### 13.4 What is queued now

| Payout period | Rows the wizard would carry | Employees | Amount | Of which **not yet approved** |
| --- | --- | --- | --- | --- |
| 2026-08 | 10 | 5 | 8,156.11 | **6,052.17** |
| 2026-09 | 14 | 7 | 7,383.27 | **7,383.27** |

`CONFIRMED IN PRODUCTION`

---

## 14. Historical Upload Architecture — what it really is

**Original purpose:** import legacy Excel expense sheets. Two real files exist:
`Jan - June Expenses.xlsx` (2026-06-16) and `jUNE EXPENSES CRM.xlsx` (2026-08-01).

**What it became:** the storage layer for the live workflow. Every approved request writes a
synthetic report named `outstation-request-<id>.workflow` carrying one row
(`service.ts:2528, 2551, 3516`).

Live composition of the "Historical Uploads" list:

| Kind | Reports | Ledger rows |
| --- | --- | --- |
| Real spreadsheet uploads | **2** (5.3%) | 327 |
| Synthetic `.workflow` artefacts | **36** (94.7%) | 33 |
| — of which hold **zero** ledger rows (ghosts) | **3** | 0 |
| — duplicate reports for the same request (18, 21, 22) | **3 pairs** | — |

**Answers to the specific questions asked:**

- *Why are `.workflow` reports generated?* Because `savePayrollExpenseApprovals` is the only writer
  of `outstation_expenses`, and it mints a report row whenever `reportId` is null. The approval path
  reuses it wholesale to inherit the payroll resync.
- *Who creates them?* `pushAcceptedOutstationExpenseToPayroll` and
  `writeOutstationRequestPayableAmount`.
- *What consumes them?* Nothing reads a `.workflow` report except the report list itself and the
  `report_id` back-link.
- *Are they required for payroll?* Only indirectly — the **ledger row** is required; the report
  header is a by-product.
- *Are real files mixed with synthetic ones?* Yes, in one undifferentiated list.
- *Can records survive their source request?* **Yes.** 9 ledger rows and 3 report headers outlive
  deleted requests 18–22 and 28–31. `CONFIRMED IN PRODUCTION`
- *Are counters denormalized and stale?* **Yes, by construction** — no trigger, and
  `approved_rows` is computed from the record set at write time and never re-derived.

Ghost reports (0 ledger rows, still claiming EGP 357.67 each):
`5061f6fe…` (request 21), `44afb035…` (request 22), `a77931e7…` (request 18).

---

## 15. Production Reconciliation, month by month

| Payout month | Batch status | Ledger rows | HR-approved | Rejected | Undecided | Claimed | Approved payable | Payroll `expenses` | Payroll − Outstation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-01 | locked | 0 | 0 | 0 | 0 | — | — | 21,000.00 | **+21,000.00** |
| 2026-02 | approved | 2 | 0 | 0 | 2 | 937.00 | 0 | 38,602.00 | **+38,602.00** |
| 2026-03 | locked | 53 | 0 | 5 | 48 | 15,758.00 | 0 | 23,459.00 | **+23,459.00** |
| 2026-04 | locked | 60 | 1 | 1 | 58 | 18,646.00 | 240.00 | 28,289.00 | +28,049.00 |
| 2026-05 | locked | 80 | 3 | 1 | 76 | 30,986.00 | 2,244.00 | 52,185.50 | +49,941.50 |
| 2026-06 | locked | 62 | 5 | 0 | 57 | 25,209.35 | 1,788.35 | 48,186.00 | +46,397.65 |
| 2026-07 | approved | 79 | 70 | 9 | 0 | 34,992.00 | 30,027.00 | 47,027.00 | +17,000.00 |
| 2026-08 | *no batch* | 10 | 3 | 0 | 7 | 8,156.11 | 2,103.94 | — | — |
| 2026-09 | *no batch* | 14 | 0 | 0 | 14 | 7,383.27 | 0 | — | — |
| **Total** | | **360** | **82** | **16** | **262** | **142,067.73** | **36,403.29** | **258,748.50** | |

**Rows ever imported by the RPC: 0, every month.**

**Classification of the differences:**

| Difference | Classification |
| --- | --- |
| Jan–Jun payroll expenses ≫ outstation approved | **Explained** — the module was populated retroactively (`Jan - June Expenses.xlsx` uploaded 2026-06-16 and never approved). Those months were paid outside the module entirely. |
| July +17,000 | **Explained** — 19,354 to 9 employees with no outstation row, less 2,354 approved-but-unpaid |
| B-175 −1,849 | **Unexplained — requires business confirmation.** Approved, no July salary record. |
| B-74 −505 | **Unexplained — requires business confirmation.** One trip dropped in transcription. |
| B-82 1,500 in Mar/Apr/May/Jun/Jul · PD-0001 5,000 in May/Jun/Jul · B-7 1,000 in May/Jun/Jul, all with zero approved outstation rows | **Likely explained** — reads as a fixed monthly expense allowance, but it is also the exact signature of the template's previous-month carry-forward. **Requires business confirmation.** |
| 262 undecided ledger rows worth EGP ~99,000 | **Explained** — the Jan–June import was never reviewed |

---

## 16. Data Integrity Findings (read-only checks, live)

| # | Check | Count | Verdict |
| --- | --- | --- | --- |
| A | `status='Rejected'` with `approved_at`/`approved_by` still set | **1** (`TRP-00285`, B-117, 455.00) | invariant violation |
| B | `hr_approved=true` but `status<>'Approved'` | 0 | clean |
| C | `status='Approved'` but `hr_approved=false` | 0 | clean |
| D | `hr_approved=true` but `approved_at` NULL | 0 | clean |
| E | `hr_status='Approved'` but `hr_approved=false` | 0 | clean |
| **F** | **`hr_approved=true` but `hr_status<>'Approved'`** | **70** | `hr_status` is unmaintained |
| G | `approved_amount > total` | 0 | clean |
| H | `hr_id` null/blank | 0 | clean |
| I | ledger rows with no `report_id` | 0 | clean |
| **J** | **`OUTSTATION-*` rows whose request no longer exists** | **9** — EGP **4,272.35**, all `hr_approved=true` | ghost payable rows |
| K | requests `accepted*` with no ledger row | 0 | clean |
| **L** | **requests `submitted` that HAVE a ledger row** | **21** | the 2026-08-08 revert set |
| **M** | **`total ≠ travel+meeting+allowance+other`** | **2** (`OUTSTATION-31` −60.00, `OUTSTATION-52` −436.00) | components contradict the total |
| N | `expense_date` null | 0 | clean |
| **O** | **reports with zero ledger rows** | **3** | ghost reports |
| **P** | **reports whose `row_count` ≠ actual** | **4** (incl. `Jan - June Expenses.xlsx`: says 277, holds 248) | stale counters |
| **Q** | **reports whose `approved_rows` ≠ actual** | **25 of 38 (66%)** | stale counters |
| **R** | **reports whose `total_expenses` ≠ actual sum** | **4** (`Jan - June` says 100,077, holds 87,264 — **out by 12,813**) | stale totals |
| **S** | **reports with `updated_at` < `created_at`** | **37 of 38** | `updated_at` is app-clock, set before insert — useless as a change signal |

All `CONFIRMED IN PRODUCTION`.

---

## 17. Manual Intervention Evidence

`audit_logs` holds **116 rows for `outstation_request`** and **zero for `outstation_expenses`**.
Four separate out-of-band interventions are provable:

**17.1 A migration rewrote business state (2026-05-27 09:23:19 Cairo).** Actor
`codex/manual-expense-approval-gate` reset requests 18, 21, 22 from `approved` to `submitted`.
Summary: *"Reset approved outstation expense to submitted because it had no payroll expense approval
row."* A migration is not a user; this is schema tooling deciding money state.

**17.2 Nine requests were deleted with no audit row.** Requests 18–22 and 28–31 are gone. Deletes
ARE audited (14 delete rows exist for requests 1, 2, 4, 5, 9–17, 23, 24, 32). These nine have none —
and `deleteOutstationRequestAsAdmin` deletes the ledger row and the empty report first, yet **their
ledger rows and reports survive**. The application path was not used. `CONFIRMED`

**17.3 A 21-row bulk revert with no audit row (2026-08-08 22:41:15.420963 Cairo).** 21 requests
moved to `submitted` while their `OUTSTATION-*` ledger rows kept `status='Approved'`. That day's
audit log holds 29 rows — 15 accepted, 11 released, 3 held — and **no revert**. The application has
no code path that produces that state. `CONFIRMED`
*(Corrected on 2026-08-12 by owner ruling to `status=''`, `hr_status=''`; pre-image in
`phoenix_backup.outstation_expenses_20260812_b3_preimage`. Owner has deferred the decision on all
21 — do not chase it.)*

**17.4 Three rejections re-opened by hand (2026-08-09 11:11–11:22).** Actor `owner`, requests 44, 64
and 42, `rejected_by_system` → `submitted`, with hand-written multi-sentence summaries. The workflow
registry has **no reopen action** (`add_to_payroll | approve | delete_before_payroll |
edit_before_payroll | reject | reject_before_payroll | submit`). This state change is unreachable
from the UI. `CONFIRMED`

**Why intervention was required, in each case:** the application provides no reverse gear. There is
no reopen, no un-approve, no return-for-correction, and no way to correct a ledger row whose request
is gone.

---

## 18. Notifications & Emails — full map

See §3.4 for the table. Findings:

- **No approval notification exists.** An employee whose claim is approved is told nothing. The only
  positive signal available to them is the portal's "In payroll" stage — which is permanently false
  (§16 / F-04).
- **`notifyExpensesAddedToPayroll` is dead code** — defined, never called.
- The rejection email links to `/employee-portals/expenses` with **no request id**; for every role
  except Medical Rep that route immediately redirects elsewhere.
- The submission email's Telegram button has the same problem.
- The submission email's **`actionUrl` is correct and deep** (`?tab=queue&requestId=<id>`) — it is
  the only well-formed deep link in the module.
- The CEO is deliberately on no outstation email in any slot.

---

## 19. Performance Findings

| Finding | Evidence |
| --- | --- |
| Queue tab loads **every** request with signed URLs, unfiltered and uncapped | `listOutstationRequests({includeCarEvidenceSignedUrls:true})`, `expense-command/page.tsx:73` |
| `listOutstationRequestExpenses` loads **all** requests then filters month/year **in memory** | `expenses.ts:647-682`; the query has no period predicate |
| Bulk decisions are **serial**, ≈10–14 round trips per approved row | `applyOutstationRequestExpenseDecisions`, `service.ts:3546` — a `for` loop with `await` per entry |
| `getPayrollExpenseDashboardData` fans out to the full directory + full ledger + full request list on every page load | `expenses.ts:787-794` |
| `listPayrollExpenseReports` batches `.in()` at 100 ids to dodge a 16 KB URL header limit | `expenses.ts:583-600` — the workaround is correct; the N-report design is what forces it |
| Report list grows by one row per approval, forever | 36 synthetic reports for 33 live ledger rows |

**Row caps found:**

| Location | Cap | Is the true count shown? |
| --- | --- | --- |
| `expense-report.tsx:1339` (Historical Upload table) | **250 rows** | **Yes — `{records.length} rows` badge at line 1208.** A 277-row upload displays "277 rows" and renders 250, with no indicator and no pagination |
| `expense-report.tsx:1010` (report picker) | 12 reports | No |
| `expenses-dashboard.tsx:332` (Specialist Comparison) | 50 rows | Adjacent panel prints `{rows.length} destinations` |
| `expenses-dashboard.tsx:234` / `:356` | 8 / 10 rows | Top-N by design |
| `nsm-team-expenses-dashboard-impl.tsx:444, 512` | 20 rows each | No |
| `recommend.ts:380`, `geocode-warmup.ts` | 1,000-row pagination | Correct — paginates properly |

---

## 20. Mobile UX Findings

Assessed from component source; **not runtime-verified** (see §26).

- **`MobileOutstationWizard` is genuinely mobile-first** — fixed bottom action bar with
  `env(safe-area-inset-bottom)`, `sm:hidden` sticky controls, step-by-step layout. This is the best
  mobile surface in the module.
- **`ExpenseApprovalsWorkspace` has 33 responsive breakpoints** and carries explicit comments about
  375px viewport fixes (lines 742, 928, 1550) — it has been deliberately worked on.
- **`ExpenseReport` (Historical Upload) fails the owner's admin-shell rule.** 20+ columns with
  fixed `min-w-[…]` totalling ≈2,900px, and **no `md:hidden` / `hidden md:block` card fallback
  anywhere in the file**. On a 375px screen this is an 8× horizontal scroll of a money table.
- **`ExpensesDashboard`** has only 8 responsive classes and `min-w-[860px]` tables — same problem,
  smaller.
- `MyExpenseSubmissions` (10 breakpoints) is the employee's phone surface for the departure photo,
  which is time-critical — it deserves runtime confirmation.

---

## 21. Navigation / UX Findings (evidence-based)

| # | Finding | Proof |
| --- | --- | --- |
| N-1 | Three admin pages expose the **same decision on the same trip** | `/admin/outstation/expense-command?tab=queue`, `/admin/outstation/expense-approvals` and `/admin/outstation/expenses` all POST to write `outstation_expenses` / decide requests; `listUnifiedOutstationExpenses` merges both tables for the middle one |
| N-2 | Two analytics pages read overlapping data | `getOutstationExpenseCommandData` vs `getPayrollExpenseDashboardData`, both summarising the ledger |
| N-3 | Every admin task costs **4 page transitions** from the sidebar | sidebar → hub → card → page → row |
| N-4 | `?tab=` hides an approval queue inside an analytics route | `expense-command/page.tsx:66` |
| N-5 | Rejection emails dead-end for every non-Medical-Rep | `OUTSTATION_EMPLOYEE_PORTAL_URL = "/employee-portals/expenses"` + the redirect at `expenses/page.tsx:26-28` |
| N-6 | **No `returnTo`, anywhere** — filters/month/scroll lost on every decision | `git grep returnTo -- src/components/outstation` → 0 |
| N-7 | The employee's one job is split across three sidebar rows | `system-navigation.ts:1047-1051` |
| N-8 | `/workspace/expense-dashboard` and `/workspace/submit-expense` duplicate the portal routes | thin wrappers over the same components |
| N-9 | The module's terminology changes per screen for one thing | "Expense Requests" / "Expense Approvals" / "Historical Upload" / "Outstation Expenses" / "Expense Command Center" / "Expense Submissions" / "Expense Dashboard" / "Team Expenses" — 8 labels |

---

## 22. Dead / Legacy / Duplicate Architecture

| Item | Status | Confidence |
| --- | --- | --- |
| `notifyExpensesAddedToPayroll` | **Dead** — no caller | High |
| `phx_import_approved_expenses_to_payroll` + the Import button | **Reachable but cannot succeed** for any existing period | High |
| `outstation_expenses.open_status` | **Dead column** — `''` on all 360 rows | High |
| `outstation_expense_requests.report_*` (8 columns) | **Dead** — NULL/0 on all 36 rows; `report_hr_status` still read at `payroll-expense-mapping.ts:166` where it falls back to the **employee name** | High |
| `geo_trip_routes` | **Dead table**, 0 rows, no reader in `src/` | High |
| `payroll_copilot_expense_decisions` | 0 rows; FK to requests | Medium — parallel decision store, may be intended |
| `outstation_policy_rules` | **0 rows** — every policy read falls back to code defaults | High |
| `rejected_by_system` | **Unreachable from the live submit path** since 2026-08-09; the pure engine still classifies it | High |
| `/admin/outstation/requests`, `/admin/outstation/heatmaps`, `/employee/outstation/new` | Redirects kept for bookmarks and email links | High — **do not delete**, the first carries live email deep links |
| `/workspace/expense-dashboard`, `/workspace/submit-expense` | Duplicate routes, admin shell | Medium — reachable, gated by `expenses:read` |
| `supabase/scripts/20260509_outstation_expenses.sql`, `phoenix-payroll-expenses.sql` | Pre-baseline setup scripts still referenced in UI error text ("Run supabase/scripts/phoenix-payroll-expenses.sql first") | High |

---

## 23. Test Coverage Gaps

**46 outstation/expense test files exist: 40 unit/integration — all 40 wired into
`tests/run-tests.ts`, zero unwired, verified per file — plus 6 Playwright e2e/synthetic specs on a
separate runner** (an unregistered test never runs). **All 40 were executed for this audit and
pass**; one guard was deliberately broken to confirm its assertion fires — see
`OUTSTATION_EXPENSES_REAUDIT.md` §11. Coverage is strong on pure logic: decision engine, fuel policy,
approval state, approved amount, payable, filters, summary, export, gates, workload, dedup, resync,
mapping, notifications routing.

**What no test covers — and what only production revealed:**

| Gap | Why it matters |
| --- | --- |
| That the payroll import RPC **can never run** against a real batch status | The single most consequential fact about the module |
| Report counter drift (`row_count`, `approved_rows`, `total_expenses`) | 25 of 38 reports are wrong in production |
| Ghost ledger rows outliving deleted requests | 9 rows, EGP 4,272.35 |
| Ghost reports with zero rows | 3 |
| `hr_status` divergence from `hr_approved` | 70 rows |
| `total` vs sum-of-components | 2 rows |
| The 250-row render cap vs the displayed true count | Silent data loss on the only real upload path |
| Concurrency on approve/reject | No guard exists and no test asserts one |
| End-to-end request → salary_records | No test crosses the module boundary |
| `paidAt` being structurally unreachable | Every employee sees a false payment status |

Passing tests do not prove the workflow works — they prove the pure functions do.

---

## 24. Full Findings Register

Severity: **P0** financial/data integrity · **P1** workflow integrity · **P2** operational UX ·
**P3** quality.

| ID | Sev | Finding | Evidence | Roles affected | Production impact | Root cause | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | **P0** | The designed payroll bridge cannot run for any existing period; money is transcribed by hand | RPC status guard vs 7 live batches, all `locked`/`approved`; `imported_to_payroll_at` NULL × 360 | Payroll, every claimant | EGP 258,748.50 moved by hand Jan–Jul | RC-4 | CONFIRMED IN PRODUCTION |
| F-02 | **P0** | July hand-carry dropped EGP 2,354.00 | B-175 1,849 (no salary record), B-74 505 (one trip) | 2 employees | Underpaid | RC-4 | CONFIRMED IN PRODUCTION |
| F-03 | **P0** | If the RPC ever ran it would **zero** `expenses` for everyone without an approved outstation row | `SET expenses = coalesce(at.approved_expense, 0)` over a LEFT JOIN | All in the batch | EGP 19,354 at risk in July alone | RC-4 | ARMED BUT NOT OBSERVED |
| F-04 | **P0** | Employees are shown a false payment status on every paid expense | `paidAt = imported_to_payroll_at` (`service.ts:4428`), NULL × 360; `my-expense-submissions.tsx:199-205` | Every claimant | Permanent "Not yet pulled into a payroll batch" | RC-4 | CONFIRMED IN PRODUCTION |
| F-05 | **P0** | 9 ghost ledger rows, approved and payable, whose request is gone | check J — EGP 4,272.35, all `hr_approved=true` | Payroll | Uninspectable money in the totals | RC-2 | CONFIRMED IN PRODUCTION |
| F-06 | **P0** | Financial mutations on the ledger leave **no audit record at all** | `audit_logs`: 116 `outstation_request`, **0** `outstation_expenses` | Audit, HR | 70 July approvals + every amount cut unattributable | RC-5 | CONFIRMED IN PRODUCTION |
| F-07 | **P0** | Payroll template carries **last month's** expense figure forward when there is no approved total | `template/route.ts:1448` `?? previousExpensesByEmployee`; `getLatestSalaryExpenseTotalsBefore` | Payroll | B-82 ×5 months, PD-0001 ×3, B-7 ×3 identical — needs business confirmation | RC-4 | CONFIRMED IN PRODUCTION (mechanism) · UNCONFIRMED (whether any repeat is unintended) |
| F-08 | **P0** | Two payroll paths disagree on what is payable — one takes pending rows | `getApprovedExpenseTotalsForPayroll` (approved only) vs `payoutExpenseRowIsPayable` (pending included) | Payroll | 6,052.17 unapproved pre-fills the Aug run; 7,383.27 for Sep | RC-1 | CONFIRMED IN PRODUCTION |
| F-09 | **P1** | No concurrency guard on approve; the reject guard excludes nothing | `service.ts:2610` bare `.eq("id")`; `service.ts:3442` `.in("status",[…])` lists every status | Super Admin | Two tabs can double-decide | RC-3 | CODE DEFECT — DATA IMPACT UNKNOWN |
| F-10 | **P1** | No supported exit from `rejected_by_admin`, and no reopen/un-approve/return | workflow action keys; 4 hand-authored interventions in `audit_logs` | Super Admin, employees | Every correction needs SQL | RC-3 | CONFIRMED IN PRODUCTION |
| F-11 | **P1** | 21 requests read `submitted` while their ledger rows are live and payable | check L; the 2026-08-08 22:41 unaudited bulk revert | Payroll, Super Admin | The two tables tell different stories | RC-1 | CONFIRMED IN PRODUCTION |
| F-12 | **P1** | An HR-adjusted amount is **discarded** when the evidence gate holds the trip | `writeOutstationRequestPayableAmount` returns false; requests have no `approved_amount` column | Super Admin | Silent loss of a decision, skip message only | RC-1 | ARMED BUT NOT OBSERVED |
| F-13 | **P1** | Approve/reject/delete are multi-table and non-transactional | §11 | All | A mid-sequence failure strands state | RC-3 | CODE DEFECT — DATA IMPACT UNKNOWN |
| F-14 | **P1** | Report counters are never re-derived — 25 of 38 wrong | checks P, Q, R; no trigger on any outstation table | Super Admin | `Jan - June` out by 29 rows / EGP 12,813 | RC-6 | CONFIRMED IN PRODUCTION |
| F-15 | **P1** | Ledger `total` can contradict its own components | check M — `OUTSTATION-31`, `OUTSTATION-52` | Payroll, reporting | Row totals and component sums disagree | RC-6 | CONFIRMED IN PRODUCTION |
| F-16 | **P1** | 1 row is `Rejected` while still carrying `approved_by`/`approved_at` | check A — `TRP-00285`, EGP 455 | Audit | Invariant violation | RC-3 | CONFIRMED IN PRODUCTION |
| F-17 | **P2** | The Historical Upload table renders 250 rows beside a badge showing the true count | `expense-report.tsx:1339` vs `:1208` | Super Admin | 27 rows of the only real 277-row upload are invisible | RC-6 | CONFIRMED |
| F-18 | **P2** | Three admin surfaces decide the same trip; four routes reach the decision | §21 N-1, §7.4 | Super Admin | 4 hops for every task; no shared context | RC-1 | UX/RUNTIME CONFIRMED |
| F-19 | **P2** | Rejection email and Telegram button dead-end for every non-Medical-Rep | `OUTSTATION_EMPLOYEE_PORTAL_URL` + `expenses/page.tsx:26-28` | DSM/RM/NSM/PM/GPM (91% of usage) | The rejected trip is not reachable from its own notification | RC-1 | UX/RUNTIME CONFIRMED |
| F-20 | **P2** | No approval notification exists at all | §3.4 | Every claimant | Approval is invisible to the employee | RC-4 | CONFIRMED |
| F-21 | **P2** | No `returnTo` anywhere; filters/month/scroll lost on every decision | §21 N-6 | Super Admin | Re-filter after every save | RC-1 | UX/RUNTIME CONFIRMED |
| F-22 | **P2** | Historical Upload is unusable on mobile — 20+ columns, ≈2,900px, no card fallback | `expense-report.tsx:119-138` | Super Admin | Violates the admin-shell mobile rule | RC-1 | UX/RUNTIME CONFIRMED (static) |
| F-23 | **P2** | Bulk decisions are serial: ≈10–14 round trips per approved row | `service.ts:3546` | Super Admin | 100 rows ≈ 1,200 sequential round trips | RC-3 | CODE DEFECT |
| F-24 | **P2** | 36 of 38 "Historical Uploads" are synthetic one-row artefacts; 3 are ghosts; 3 requests have duplicate reports | §14 | Super Admin | The list is 95% noise | RC-2 | CONFIRMED IN PRODUCTION |
| F-25 | **P3** | `hr_status` is unmaintained — 70 rows disagree with `hr_approved` | check F | — | Reads as pending in any surface that trusts it | RC-1 | CONFIRMED IN PRODUCTION |
| F-26 | **P3** | `report_hr_status` falls back to the **employee name**. **Resolved 2026-09-19:** the HR Status column is the request's own decision (Approved / Rejected / Pending), as `claims-read.ts` and the push mapper already had it; `report_hr_status` itself was dropped the same day (F-28). Data impact measured: none — the ledger's `hr_status` holds only Approved, Rejected or blank, never a name | `payroll-expense-mapping.ts:166` | — | Column is NULL × 36, so the fallback always fires | RC-6 | CODE DEFECT · RESOLVED |
| F-27 | **P3** | `updated_at` is app-clock and written before insert — 37 of 38 reports are "updated" before creation | check S | Forensics | Useless as a change signal | RC-6 | CONFIRMED IN PRODUCTION |
| F-28 | **P3** | Dead: `open_status`, `report_*` columns, `geo_trip_routes`, `notifyExpensesAddedToPayroll`, empty `outstation_policy_rules`. **Resolved 2026-09-19:** the email sender deleted; `open_status`, `report_hr_status`, `report_hr_notes` and `geo_trip_routes` dropped (`20260919021059`). The other six `report_*` columns and `outstation_policy_rules` are live now and stay | §22 | — | Carrying cost | RC-2 | CONFIRMED · RESOLVED |
| F-29 | **P3** | `[id]` routes accept any finite `Number()` (`1.5`, `1e2`, `""`) where the module's own trip parser demands a positive integer. **Resolved 2026-09-19:** one parser, `parseOutstationRequestId` in `src/lib/outstation/request-id.ts` (a positive safe integer in plain digits), now backs all 15 id checks in the 11 numeric outstation `[id]` routes and the trip-id parser itself; a malformed id answers the route's own 400. Pinned by `tests/outstation-request-id-parse.test.ts`, which walks both outstation API trees so a new `[id]` route is held to it too | `[id]/route.ts:36` vs `expense-approval-decisions.ts:34` | — | 404 instead of 400 | RC-3 | CODE DEFECT · RESOLVED |
| F-30 | **P3** | `payout_month` uses `getUTCMonth()` on a timestamptz — a 00:00–02:00 Cairo trip on the 1st pays a month early | `payroll-expense-mapping.ts:33` | Payroll | None observed | RC-6 | ARMED BUT NOT OBSERVED |
| F-31 | **P3** | `/api/approvals-hub/hub-data` calls `listOutstationRequests()` **unscoped** while every sibling feed gets `viewAccess`. **Resolved 2026-09-19:** the outstation feed is read only when the VIEWED person may decide outstation requests (`viewedPersonCanApproveOutstation` in `admin-access.ts`, the Action Center's own `canUseAdminOutstationWorkspace(…, "approve")` gate applied to the viewed person's own role and scope, never the caller's). Viewing as any other manager no longer lists every submitted trip in the company as awaiting them; pinned in `tests/approvals-hub.test.ts` | `hub-data/route.ts:99` | — | Contained today by `ALLOWED_VIEW_AS_ROLES = ["Super Admin"]` | RC-3 | CODE DEFECT · RESOLVED |
| F-32 | **P3** | `normalizeApprovedAmount` returns NULL when approved equals claimed | `payable.ts:83` | — | "Reviewed and approved in full" is indistinguishable from "untouched" | RC-1 | CODE DEFECT |
| F-33 | **P3** | No upper bound on `approved_amount` on the server or in the DB (only `≥ 0`) | constraint `outstation_expenses_approved_amount_non_negative` | Super Admin | A typo can exceed the claim via the API | RC-3 | ARMED BUT NOT OBSERVED |

---

## 25. Root-Cause Analysis

**RC-1 — One business object is modelled as two, joined by a string.**
`outstation_expense_requests` holds the claim; `outstation_expenses` holds the money; they are linked
only by `'OUTSTATION-' || id` with no foreign key. Every screen must union and dedupe them
(`listUnifiedOutstationExpenses`), every decision must write both, and the request cannot store an
approved amount at all.
→ F-08, F-11, F-12, F-18, F-19, F-21, F-22, F-25, F-32

**RC-2 — The live workflow was built on top of the legacy importer instead of beside it.**
Approving a request manufactures a fake spreadsheet upload, because `savePayrollExpenseApprovals` is
the only writer of the ledger. That is why 95% of "Historical Uploads" are synthetic, why ghost
reports exist, and why deleting a request can leave money behind.
→ F-05, F-24, F-28

**RC-3 — There is no transaction, no state guard, and no reverse gear.**
Multi-table writes are sequential and unguarded; the workflow registry has no reopen, un-approve,
return-for-correction or cancel. Every correction in this module's production history has therefore
been direct SQL.
→ F-09, F-10, F-13, F-16, F-23, F-29, F-31, F-33

**RC-4 — The payroll boundary was designed but never commissioned, and the manual workaround became
the system.** The RPC's status precondition does not match any status payroll actually reaches. The
gap is bridged by a person copying figures, and the product has no representation of that person's
work — no "paid" state it can set, no approval notification, no reconciliation surface.
→ F-01, F-02, F-03, F-04, F-07, F-20

**RC-5 — Auditability was attached to the wrong table.** `audit_logs` covers
`outstation_request` (116 rows) and not `outstation_expenses` (0 rows) — the table the money is
read from and the one HR actually edits.
→ F-06

**RC-6 — Derived values are stored instead of computed, with no trigger to keep them true.**
`row_count`, `approved_rows`, `total_expenses`, `total` vs components, `updated_at`,
`report_hr_status` — all written once and never re-derived. There is not a single trigger on any
outstation table.
→ F-14, F-15, F-17, F-26, F-27, F-30

---

## 26. Unknowns

Things the repository, production data and static analysis cannot settle:

1. **Runtime browser verification was not performed.** No dev server was running, `.claude/launch.json`
   is attach-only (`preview_start` cannot spawn from this `F:\` path), and the session guard reported
   2.75 GB free RAM across 10 live Claude sessions. Starting a Next dev server would have breached
   that guard, and `.env.local` points at production. **§20 (mobile) and the click-count claims in
   §7 are derived from component source and route resolution, not from a rendered page.** Everything
   labelled `CONFIRMED IN PRODUCTION` is database evidence and is unaffected.
2. **Whether B-82 (1,500 × 5 months), PD-0001 (5,000 × 3) and B-7 (1,000 × 3) are fixed monthly
   allowances or carry-forward artefacts.** The data signature is identical for both.
3. **Whether B-175's missing July salary record is a payroll omission or a deliberate exclusion.**
4. **Who performed the 2026-08-08 22:41 bulk revert and the nine unaudited deletions.** No actor is
   recorded anywhere.
5. **Whether the 262 undecided Jan–June ledger rows (~EGP 99,000) are abandoned or still owed.**
6. **Whether `payroll_copilot_expense_decisions` is intended as a future decision store or is dead.**

---

## 27. Questions for Omar

1. Are B-82 (1,500), PD-0001 (5,000) and B-7 (1,000) **fixed monthly expense allowances**, or should
   those repeated figures have been zero?
2. B-175 has EGP 1,849 approved for the July payout and **no July salary record at all** — left
   deliberately, or missed?
3. The 262 undecided Jan–June ledger rows (~EGP 99,000): abandoned, or still owed?

---

*Audit performed 2026-08-12. Read-only throughout: no application behaviour, production data,
schema, branch or deployment was modified.*
