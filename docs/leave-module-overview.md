# Phoenix Leave Management Module Overview

This guide covers the final Leave Management module for Phoenix Workforce. Payroll integration remains intentionally excluded: do not modify payroll tables, payroll services, payroll APIs, payslip logic, or payroll dashboards while validating this module.

## Module scope

- Employee route: `/employee-portals/leave`
- Manager route: `/employee-portals/leave-approvals`
- HR/Admin route: `/admin/leave`
- API namespace: `/api/leave/**`
- Database domain: `leave_*`, `employee_leave_balances`, and `public_holidays`

The module uses HR_ID as the employee identifier, policy-driven entitlement rules, ledger-based balances, transactional RPCs for critical balance mutations, non-blocking notification hooks, centralized master audit logs for lifecycle visibility, and a Vacation Report layer for business reporting.

## Employee guide

Employees can use the Vacation Request tab to review wallet cards for annual entitlement, accrued, used, pending, and available days. They can submit leave with a leave type, inclusive start/end date range, working-day calculation, reason, optional or required attachment, and conflict warning. Submitted leave starts in manager review and appears in the request history with status badges and a detail timeline.

Employees can use My Vacation Report to review their own vacation/leave records only. Managers with reporting hierarchy also see Team Vacation Report. HR/Admin users see Company Vacation Report.

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

National vacations are excluded from working-day duration, availability, conflict, analytics, and reporting calculations.

Leave type date behavior:

- Emergency Leave: From Date must be today. To Date cannot be before From Date.
- Annual Leave: From Date must be tomorrow or later; today and past dates are disabled.
- Sick Leave: today is allowed, and backdated leave is allowed within the configured `LEAVE_SICK_BACKDATE_DAYS` window. Future Sick Leave is rejected.
- Other Leave: today and future dates are allowed; past dates are rejected.

Annual entitlement is intentionally simple: employees with less than 1 year of service receive 15 days annually, and employees with 1 year or more of service receive 21 days annually. Monthly accrual is `15 / 12` before the first service anniversary and `21 / 12` from the first anniversary onward.

## Manager guide

Managers use `/employee-portals/leave-approvals` to review only in-hierarchy requests. The page includes pending approval actions, mandatory rejection comments, a team calendar, availability by date range, and conflict indicators. Managers cannot approve requests outside their hierarchy; the UI and service layer both enforce this.

## Vacation reports

Vacation Reports are business reports, not an audit log. The tabs are:

- My Vacation Report: every linked employee, scoped to the current employee only.
- Team Vacation Report: managers with direct or indirect reporting employees, scoped to their hierarchy only.
- Company Vacation Report: HR/Admin only, scoped to the full company.

Exports are XLSX files with styled headers, frozen header rows, filters, report title, generated date, and scope label. Balance Before and Balance After are derived from reliable leave transactions where available and otherwise shown as unavailable.

## Historical vacation template and upload

HR/Admin users can download the Historical Vacation Template Download from `/api/leave/historical-vacations/template`. The workbook has an Instructions sheet and a Historical Vacation Data sheet with columns required to reconstruct old vacation history, approval state, paid/unpaid behavior, deduct/no-deduct behavior, and ledger rows.

Historical upload is for old records only. It does not change the current new-request rules. Uploaded historical rows preserve the HR decision that happened at the time:

- `Payment_Status = unpaid` and `Balance_Deduction = no_deduct` does not consume balance.
- `Payment_Status = paid` and `Balance_Deduction = deduct` consumes balance even if the leave date was inside the employee's first 6 months.

Dry-run validates the workbook before confirmation and does not create leave requests, leave transactions, balances, or payroll records. Confirmation re-validates the same workbook server-side, writes accepted historical leave records, records rejected rows in historical import tracking tables, and writes centralized master audit entries. No payroll tables are mutated.

The historical import tracking migration is `supabase/migrations/20260515160000_leave_historical_vacation_import_tracking.sql`. It must be applied only through the controlled Supabase migration process after review.

## Admin guide

HR/Admin users use `/admin/leave` to manage the full leave domain. The information architecture is separated into Vacation Request, Vacation Reports, and HR/Admin-only Leave Management. Leave Management includes Active Employees Accrual, approval queue, analytics, accrual controls, policies, leave types, national vacations, adjustments, and Historical Vacation Upload.

Active Employees Accrual is read-only. It shows active employees, entitlement, monthly accrual, accrued to date, used/consumed, pending, carry forward, adjustments, available balance, service duration, last accrual month, and last leave transaction date.

National Vacations can be maintained manually or synced by HR/Admin from Google Calendar. The sync updates `public_holidays`, which is the same table used by working-day calculations, leave request previews, conflict checks, calendars, availability, and analytics. The default Egypt source is `en.egyptian#holiday@group.v.calendar.google.com`; set `GOOGLE_HOLIDAY_CALENDAR_ID_EG` to override it, `GOOGLE_HOLIDAY_ICAL_URL_EG` for a private iCal feed, or `GOOGLE_CALENDAR_API_KEY` to use the Google Calendar API instead of public iCal. If Google public iCal returns an upstream error and no API key/private iCal is configured, the sync falls back to Nager.Date public holidays for continuity and reports that fallback in the UI.

Accrual dry run previews the current period without mutation. Safe Run uses transactional database functions and idempotency checks to prevent duplicate accrual transactions.

## Attachment handling

Local mode stores validated files under `/uploads/leave` and exposes them through the secure leave attachment route after request-level access validation. Supabase Storage mode is prepared through the private `leave-attachments` bucket and signed download URLs. Attachment URLs are not rendered directly from arbitrary request data.

## Notification hooks

The workflow calls non-blocking notification hooks for request submitted, manager decision, HR decision, accrual completed, adjustment completed, failed notification, and cancellation. Missing email configuration must not fail the leave workflow; failures are recorded as audit events where possible.

## Access control

- Employee: own leave requests and wallet only.
- Manager: own requests plus hierarchy requests for approval and team availability.
- HR/Admin: full leave scope, settings, accrual, adjustments, analytics, historical upload, and centralized master audit logs.
- Finance: payroll-impact leave visibility only where existing permissions allow it; no payroll integration is implemented here.

## Known risks

- Private Supabase Storage is prepared but existing local files are not migrated.
- E2E tests require staging credentials and predictable employee-manager-HR test data.
- Production rollout must use official Supabase CLI dry-run and push flow only.
- Historical Vacation Upload requires the tracking migration before confirmation can succeed in staging or production.
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
13. Admin analytics, calendar, availability, settings, national vacations, export, and master audit link render correctly.
14. Normal employee access cannot reach admin analytics, settings, accrual, adjustments, historical upload, or audit logs.
15. HR/Admin downloads Historical Vacation Template Download and verifies Instructions plus Historical Vacation Data sheets.
16. HR/Admin dry-runs historical upload and sees accepted, rejected, duplicate, warning, affected employee, and projected balance impact summaries.
17. HR/Admin confirms only after dry-run validation; paid/deduct historical rows consume balance and unpaid/no_deduct rows do not.
18. Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test:e2e:leave` when E2E env vars are present.
