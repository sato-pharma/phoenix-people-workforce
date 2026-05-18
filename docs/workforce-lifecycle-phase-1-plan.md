# Workforce Lifecycle Phase 1 Plan

Security, RLS, and auth hardening are intentionally out of scope for this phase.

## Goal

Make employee entry and exit a single production workflow across Phoenix Workforce.

The key rule is:

```text
The employee record can change status, but the structure seat must remain.
Hiring fills a vacant seat. Resignation or termination opens a vacant seat.
```

## Sources That Must Behave The Same Way

| Source | Required workflow |
| --- | --- |
| Manual employee add | Create employee, auto-generate HR_ID when needed, mark active, make visible in organogram, make payroll eligible, close matching open vacancy. |
| Bulk employee upload | Create/update employees, auto-map org entities, make new employees visible/eligible, close matching open vacancies for newly filled seats, create open vacancies for rows without HR_ID. |
| Accepted offer approval | Convert accepted candidate into employee, set compensation/start data, make visible/eligible, close matching vacancy, initialize downstream employee lifecycle views. |
| Resignation | Keep historical employee record, mark employee resigned/inactive for active workflows, open replacement vacancy in the same structure position. |
| Termination | Same as resignation, but status is terminated and the vacancy is still opened. |
| Probation termination | Route through the same resignation/termination workflow and open the replacement vacancy. |

## Modules That Must Hear The Change

| Module | Expected effect |
| --- | --- |
| Employees | Active directory shows active/on-leave employees; historical exit records are not reactivated by normal edit/import. |
| Organogram | Structure seat remains. Filled seats show employee; open seats show vacancy. |
| Vacancies Report | New exits appear as open vacancies; new hires close the matching vacancy. |
| Payroll | Active/payroll-eligible employees feed salary source; resigned/terminated employees stop being payroll eligible unless payroll history needs them. |
| Probation | New hires appear by hire date; probation termination opens vacancy through the same exit workflow. |
| Contract Renewal | New hires enter renewal calculations through hire date; exits stop active renewal queue. |
| Hiring Documents | New hires appear in document workflow; exited employees stay historical. |
| Attendance | Active employees can be mapped to devices; exited employees should not be treated as active workforce. |
| Leave | New hires get hire-date-based entitlement; exited employees should not create new active requests. |
| Sales | Filled vacancies move ownership to the new employee where applicable; vacant territories remain classified as vacant sales ownership. |
| Command Center / Data Health / Monitoring | Total structure equals active employees plus open vacancies. |

## Sales Continuity Rule

Sales history must not break when a person leaves and a replacement fills the same seat.

The rule is:

```text
Personal HR history follows the employee.
Sales territory history follows the seat / territory / manager scope.
```

Examples:

- A Medical Rep covering Nasr City resigns.
- Phoenix opens a Nasr City vacancy for the same line, area, manager, and position.
- A new Medical Rep is hired into that vacancy.
- The new rep should see the relevant Nasr City sales history for the territory/seat view.
- The resigned rep still owns their personal historical employee record.

Manager continuity follows the same principle:

- A District Manager resigns or is terminated.
- A replacement District Manager is hired into the same manager seat.
- Team sales history and future team ownership should remain continuous for the replacement manager.
- Old sales rows should remain auditable, but dashboards and scoped views should resolve continuity through the replacement chain.

This prevents every new hire from starting with a broken sales view just because the previous HR_ID left.

## Current Implementation Findings

| Area | Current state | Score |
| --- | --- | --- |
| Manual employee add | `upsertEmployee()` creates/updates employee data and closes a matching open vacancy after new employee creation. | 4/5 |
| Direct employee edit | Blocks resigned/terminated status and forces lifecycle workflow. | 5/5 |
| Bulk employee upload | Creates/updates employees and creates vacancies from rows without HR_ID, but does not clearly close matching existing vacancies when a bulk row fills a seat. | 3/5 |
| Offer approval | Uses `phx_approve_accepted_offer` to convert accepted offer into an employee lifecycle record. Needs regression coverage that vacancy closure and downstream visibility are consistent with manual add. | 4/5 |
| Resignation / termination | `resignEmployeeAndOpenVacancy()` opens a vacancy and marks employee non-active/non-payroll in fallback path; RPC path needs regression coverage. | 4/5 |
| Probation termination | Routes termination through `resignEmployeeAndOpenVacancy()`. | 4/5 |
| Sales rep continuity | Current sales filtering is heavily HR_ID based. It supports vacant ownership classification, but Phase 1 must prove replacement hires can see inherited territory/seat sales history. | 3/5 |
| Sales manager continuity | Manual replacement flow has `phx_reassign_replacement_ownership` / fallback logic for manager ownership and future sales rows. It needs regression proof and consistent behavior for offer/bulk hire paths. | 3/5 |
| Cross-module proof | No single regression test currently proves manual add, bulk add, offer approval, resignation, and probation termination all preserve the same seat lifecycle rule. | 2/5 |

## Phase 1 Implementation Ticket

Title: Standardize Workforce Lifecycle Seat Logic

Files to audit and likely update:

- `src/lib/employees/employee-directory.ts`
- `app/api/imports/employees/confirm/route.ts`
- `src/lib/offers/service.ts`
- `src/lib/resignations/service.ts`
- `src/lib/probation/service.ts`
- `src/lib/reports/vacancies.ts`
- `src/lib/admin/service.ts`
- `src/lib/admin/command-center.ts`
- `tests/workforce-lifecycle.test.ts`
- `tests/run-tests.ts`

Acceptance criteria:

1. Manual employee add closes the matching open vacancy.
2. Bulk employee upload closes matching open vacancies for newly filled seats.
3. Bulk vacant rows create open vacancies only when they are true vacant structure rows.
4. Accepted offer approval fills the target vacancy and creates/updates the employee consistently with manual add.
5. Resignation opens a replacement vacancy and removes the employee from active/payroll-eligible workforce.
6. Termination opens a replacement vacancy and removes the employee from active/payroll-eligible workforce.
7. Probation termination uses the same termination path, not a separate side path.
8. Organogram and vacancy report show the seat as filled or vacant from the same source.
9. Command Center, Data Health, and Monitoring use the same structure totals.
10. Sales continuity is preserved:
    - replacement Medical Rep can see the territory/seat sales history after filling the vacancy
    - replacement District Manager can see team/manager-scope sales continuity after filling the manager seat
    - old employee records remain historical and auditable
11. Regression tests prove:
    - `totalStructure = activeEmployees + openVacancies`
    - hire closes vacancy
    - resignation/termination opens vacancy
    - bulk import follows the same rule as manual add
    - replacement hire inherits seat/territory sales visibility without rewriting personal HR history

## Updated Starting Order

The first phase should now start with lifecycle workflow, not dashboard metrics.

1. Standardize employee lifecycle seat logic.
2. Standardize sales continuity through replacement seat logic.
3. Build canonical workforce structure metrics on top of that lifecycle logic.
4. Connect Command Center, Data Health, Monitoring, Organogram, Employees, Vacancies Report, and Sales views to the canonical lifecycle/seat logic.

## Phase 1 Implementation Notes

Implemented:

- `src/lib/workforce/seat-lifecycle.ts` owns shared seat matching, hire vacancy closure eligibility, workforce structure totals, and sales seat continuity matching.
- Manual employee add already used vacancy closure; this remains the canonical behavior.
- Bulk employee upload now closes matching open vacancies for newly inserted employees.
- Accepted offer approval now defensively closes the matching vacancy after `phx_approve_accepted_offer`.
- Employee portal sales now includes a seat-continuity fetch path so replacement hires can see territory/seat continuity records.
- Command Center and Data Health use the same structure summary helper for `activeEmployees + openVacancies = totalStructure`.
- `tests/workforce-lifecycle-seat.test.ts` protects the lifecycle and sales continuity contract.

Still open:

- Live database verification is still needed for the two Supabase RPCs.
- Admin Sales Dashboard still needs its own service-level metric extraction in a later phase.
- Overview still contains duplicated cross-domain aggregation and should be handled in the platform metrics phase.
