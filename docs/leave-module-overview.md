# Phoenix Leave Management Module Overview

This guide covers the final Leave Management module for Phoenix Workforce. Payroll integration remains intentionally excluded: do not modify payroll tables, payroll services, payroll APIs, payslip logic, or payroll dashboards while validating this module.

## Module scope

- Employee route: `/employee-portals/leave`
- Manager route: `/employee-portals/leave-approvals`
- HR/Admin route: `/admin/leave`
- API namespace: `/api/leave/**`
- Database domain: `leave_*`, `employee_leave_balances`, and `public_holidays`

The module uses HR_ID as the employee identifier, policy-driven entitlement rules, ledger-based balances, transactional RPCs for critical balance mutations, non-blocking notification hooks, and audit logs for lifecycle visibility.

## Employee guide

Employees can review wallet cards for annual entitlement, accrued, used, pending, and available days. They can submit leave with a leave type, inclusive start/end date range, working-day calculation, reason, optional or required attachment, and conflict warning. Submitted leave starts in manager review and appears in the request history with status badges and a detail timeline.

Employees can cancel requests that are still pending manager or HR processing. Cancellation writes an approval-history entry, updates the request status, emits a non-blocking notification hook, and records audit metadata.

Employee-facing leave choices are limited to:

- `annual_leave`
- `emergency_leave`
- `sick_leave`
- `other`

Employees cannot select `casual_leave` or `unpaid_leave`. Those codes may remain in the database for legacy compatibility, reporting, or internal/system-controlled workflows.

## Business policy rules

Annual Leave and Emergency Leave are the only employee-submitted leave types that normally reserve and consume the annual leave balance. Sick Leave is tracked through the approval workflow but does not automatically consume annual balance. Other Leave starts in review; HR/Admin must decide at approval whether to deduct from annual balance or approve as non-deducted.

The system automatically marks Annual/Emergency leave as unpaid when the employee is within the first 6 months from `hire_date`, or when available annual balance is insufficient. Employees see a warning before submit explaining whether the reason is probation period, insufficient balance, or both. This is metadata only; payroll deduction logic is intentionally excluded.

Payment status appears in history, manager/admin views, exports, details, and audit metadata:

- `Paid`: normally Annual/Emergency leave with enough eligible balance.
- `Unpaid`: automatic unpaid classification, or HR-approved non-deducted treatment where unpaid terminology applies.
- `In Review`: Sick Leave and Other Leave before HR final treatment.
- `Non-Deducted`: HR-approved Other Leave that does not consume annual balance.

Sick Leave requires an attachment before submission. The employee helper text is:

- Arabic: شهادة مرضية مختومة من مستشفى حكومي
- English: Medical certificate stamped by a governmental hospital

HR/Admin may reject Sick Leave when documents are invalid or non-matching; rejection requires a comment.

Other Leave requires a detailed reason. If HR/Admin approves it, they must choose either `deduct from leave balance` or `do not deduct from leave balance`. Deduct creates balance transactions; no-deduct does not mutate balance.

The approval flow is Employee -> Direct Manager -> HR/Admin. Manager's manager is not an approval step; they can only be notified or copied if notification configuration exists.

## Duration and date rules

Date ranges are inclusive. Full Day uses calculated working days. AM only and PM only are valid only for single-day leave and count as 0.5 day. Multi-day leave must use Full Day.

Working-week logic is title-aware:

- Medical/sales field titles (`Medical Rep`, `Medical Representative`, `MR`, `DSM`, `District Sales Manager`, `NSM`, `National Sales Manager`) work Saturday through Thursday, with Friday off only.
- All other employees use Friday and Saturday as weekly off days.

Public holidays are excluded from working-day duration, availability, conflict, analytics, and reporting calculations.

Leave type date behavior:

- Emergency Leave: From Date must be today. To Date cannot be before From Date.
- Annual Leave: From Date must be tomorrow or later; today and past dates are disabled.
- Sick Leave: today is allowed, and backdated leave is allowed within the configured `LEAVE_SICK_BACKDATE_DAYS` window. Future Sick Leave is rejected.
- Other Leave: today and future dates are allowed; past dates are rejected.

Annual entitlement is intentionally simple: employees with less than 1 year of service receive 15 days annually, and employees with 1 year or more of service receive 21 days annually. Monthly accrual is `15 / 12` before the first service anniversary and `21 / 12` from the first anniversary onward.

## Manager guide

Managers use `/employee-portals/leave-approvals` to review only in-hierarchy requests. The page includes pending approval actions, mandatory rejection comments, a team calendar, availability by date range, and conflict indicators. Managers cannot approve requests outside their hierarchy; the UI and service layer both enforce this.

## Admin guide

HR/Admin users use `/admin/leave` to manage the full leave domain. The page includes executive KPI cards, calendar, availability, analytics, accrual controls, filters, Excel export, HR approve/reject actions, manual audited adjustments, policy settings, leave type settings, holiday management, and the Leave Activity & Audit Trail.

Accrual dry run previews the current period without mutation. Safe Run uses transactional database functions and idempotency checks to prevent duplicate accrual transactions.

## Attachment handling

Local mode stores validated files under `/uploads/leave` and exposes them through the secure leave attachment route after request-level access validation. Supabase Storage mode is prepared through the private `leave-attachments` bucket and signed download URLs. Attachment URLs are not rendered directly from arbitrary request data.

## Notification hooks

The workflow calls non-blocking notification hooks for request submitted, manager decision, HR decision, accrual completed, adjustment completed, failed notification, and cancellation. Missing email configuration must not fail the leave workflow; failures are recorded as audit events where possible.

## Access control

- Employee: own leave requests and wallet only.
- Manager: own requests plus hierarchy requests for approval and team availability.
- HR/Admin: full leave scope, settings, accrual, adjustments, analytics, and audit logs.
- Finance: payroll-impact leave visibility only where existing permissions allow it; no payroll integration is implemented here.

## Known risks

- Private Supabase Storage is prepared but existing local files are not migrated.
- E2E tests require staging credentials and predictable employee-manager-HR test data.
- Production rollout must use official Supabase CLI dry-run and push flow only.
- Large analytics/reporting datasets may need server-side pagination as leave history grows.

## Testing checklist

1. Employee submits leave and sees the wallet pending amount update.
2. Employee sees conflict warning without being blocked by default.
3. Employee uploads an allowed attachment and opens it through the attachment route.
4. Employee cancels a pending request and sees the cancellation in history.
5. Manager approves an in-hierarchy request.
6. Manager rejects with a mandatory comment.
7. Manager cannot view or approve outside-hierarchy requests.
8. HR approves a manager-approved request and only one consumed transaction is created.
9. HR rejects with a mandatory comment and no consumed transaction is created.
10. HR records a balance adjustment with a reason.
11. HR runs accrual dry run and confirms no transactions are created.
12. HR runs accrual execution twice and confirms the second run skips duplicates.
13. Admin analytics, calendar, availability, settings, holidays, export, and audit log render correctly.
14. Normal employee access cannot reach admin analytics, settings, accrual, adjustments, or audit logs.
15. Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test:e2e:leave` when E2E env vars are present.
