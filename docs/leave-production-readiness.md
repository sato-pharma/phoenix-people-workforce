# Leave Management Production Readiness

This checklist is for the Phoenix Workforce Leave Management Engine only. Do not modify payroll tables, payroll services, payroll APIs, payslip logic, or payroll dashboards as part of this rollout.

For the final user, manager, and admin operating guide, also review `docs/leave-module-overview.md`.

## Production rollout checklist

1. Confirm staging has the Phase 1 and Phase 2 leave migrations applied and no pending unrelated migrations.
2. Review `supabase/migrations/20260513100825_leave_production_readiness.sql` for the transactional RPCs, audit tables, private attachment bucket preparation, and indexes.
3. Review `supabase/migrations/20260514135726_leave_business_policy_corrections.sql` for employee-selectable leave types, payment status metadata, AM/PM duration support, and transactional cancellation.
4. Review `supabase/migrations/20260514163534_simplify_leave_entitlement_policy.sql` for the final 15/21 annual entitlement policy cleanup.
5. Review `supabase/migrations/20260515160000_leave_historical_vacation_import_tracking.sql` for historical import tracking tables. Do not apply it until HR/Admin historical import is approved for staging.
6. Run `supabase db push --dry-run` against staging first and confirm only expected leave migrations appear.
7. Apply to staging with the official Supabase CLI only after the dry run is clean.
8. Run `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
9. Run the leave E2E suite with `npm run test:e2e:leave` after browser binaries and test credentials are configured.
10. Manually verify `/employee-portals/leave`, `/employee-portals/leave-approvals`, and `/admin/leave`.
11. Confirm audit rows are written to `leave_audit_logs` for submit, manager decision, HR decision, cancellation, accrual, adjustment, historical import dry-run/confirm, failed notification, and attachment download URL events.
12. Confirm no payroll behavior changed.

## Rollback checklist

1. Stop leave production rollout if transactional RPCs fail, audit inserts fail repeatedly, or attachment signing fails.
2. Disable the new app build and redeploy the prior known-good build.
3. If the migration was applied and must be rolled back, create a forward-only rollback migration that:
   - revokes execute on the new `phx_leave_*_atomic` functions,
   - drops the new functions,
   - keeps `leave_audit_logs`, `leave_accrual_runs`, and `leave_attachment_objects` unless retention/legal review approves removal,
   - leaves Phase 1 leave tables untouched.
4. Do not drop leave request, transaction, approval, employee, auth, access-control, dashboard, sales, or payroll tables.
5. If private storage was enabled, keep the bucket private and preserve objects for investigation.
6. If historical import has been enabled, keep `leave_historical_import_batches` and `leave_historical_import_rows` for traceability unless legal/retention review approves removal. Reverse bad historical data through a forward-only corrective import or adjustment workflow, not by deleting payroll or core employee records.

## Monitoring checklist

1. Track request failures for `/api/leave/requests`, `/api/leave/requests/[id]/manager-decision`, `/api/leave/requests/[id]/hr-decision`, `/api/leave/accrual/run`, and `/api/leave/adjustments`.
2. Monitor `leave_audit_logs` for `*.failed` event types.
3. Monitor `leave_accrual_runs` for skipped/processed counts and total amount by period.
4. Monitor Supabase function errors for `phx_leave_submit_request_atomic`, `phx_leave_manager_decision_atomic`, `phx_leave_hr_decision_atomic`, `phx_leave_adjust_balance_atomic`, and `phx_leave_run_accrual_atomic`.
5. Monitor private storage signed URL creation latency and failures.
6. Watch for repeated double-submit attempts; the transactional RPC row locks and transaction existence checks should prevent duplicate consumption.
7. Monitor `/api/leave/historical-vacations/dry-run` and `/api/leave/historical-vacations/confirm` failures separately. Confirmation failures usually indicate an unapplied tracking migration, duplicate data, or stale employee/leave type references.
8. Monitor `/api/leave/settings/holidays/google-sync` failures. If public iCal access is blocked, configure `GOOGLE_CALENDAR_API_KEY` or `GOOGLE_HOLIDAY_ICAL_URL_EG`; if Google changes the Egypt calendar ID, configure `GOOGLE_HOLIDAY_CALENDAR_ID_EG`. If Google is unavailable and no key/private iCal is configured, the endpoint falls back to Nager.Date and returns `source: nager_date_fallback`.

## Post-deployment verification checklist

1. Employee submits annual leave and sees pending status.
2. Employee sees conflict warning for overlapping team leave without being blocked by default.
3. Manager approves one in-hierarchy request and rejects one with mandatory comment.
4. Manager cannot approve or view details outside hierarchy.
5. HR approves a manager-approved request and one rejection path.
6. HR approval creates one consumed transaction and does not duplicate on double-click.
7. Accrual dry run does not create `leave_transactions`.
8. Accrual execution creates one transaction per eligible employee/period and is idempotent on repeat run.
9. Admin adjustment creates one transaction with reason and an audit log.
10. Attachment upload works in local mode; private Supabase Storage mode creates signed URLs only after access validation.
11. Analytics render for HR/Admin and are not visible to normal employees.
12. Admin audit log renders submit, approval, cancellation, adjustment, accrual, notification, and attachment events where present.
13. Employee dropdown shows only Annual, Emergency, Sick, and Other leave.
14. Sick Leave requires an attachment and shows the bilingual governmental-hospital certificate helper text.
15. Annual Leave cannot start today; Emergency Leave must start today; Sick Leave rejects dates outside the configured backdate window and future dates.
16. AM/PM leave counts as 0.5 day and is rejected for multi-day ranges.
17. Medical/sales field titles count Saturday as a working day; non-field titles do not.
18. Annual/Emergency leave during the first 6 months or with insufficient balance is marked unpaid without touching payroll.
19. HR approval of Other Leave requires the deduct/no-deduct decision and records the payment status.
20. HR/Admin sees Vacation Request, Company Vacation Report, and Leave Management. Normal employees see Vacation Request and My Vacation Report only. Managers with hierarchy also see Team Vacation Report.
21. Historical Vacation Template Download contains Instructions and Historical Vacation Data sheets, dropdown validation, frozen headers, filters, readable widths, and no corrupt XML.
22. Historical upload dry-run returns accepted rows, rejected rows with reasons, warnings, duplicate counts, affected employees, and projected balance impact without creating leave requests or leave transactions.
23. Historical upload confirmation re-validates the workbook server-side, preserves uploaded paid/unpaid and deduct/no-deduct behavior, writes import tracking rows, and does not mutate payroll.
24. Active Employees Accrual is read-only and shows entitlement, monthly accrual, balances, carry forward, adjustments, service duration, last accrual month, and last leave transaction date.
25. HR/Admin syncs National Vacations from Google Calendar and verifies the updated dates appear in leave request working-day previews and admin calendars.

## Leave E2E configuration

Set these variables before running `npm run test:e2e:leave` against a QA or staging app:

- `E2E_LEAVE_BASE_URL`
- `E2E_LEAVE_EMPLOYEE_LOGIN`
- `E2E_LEAVE_EMPLOYEE_PASSWORD`
- `E2E_LEAVE_MANAGER_LOGIN`
- `E2E_LEAVE_MANAGER_PASSWORD`
- `E2E_LEAVE_HR_LOGIN`
- `E2E_LEAVE_HR_PASSWORD`
- Optional date overrides: `E2E_LEAVE_START_DATE`, `E2E_LEAVE_END_DATE`, `E2E_LEAVE_CONFLICT_START_DATE`, `E2E_LEAVE_CONFLICT_END_DATE`

## Known risks

1. The production-readiness migration introduces new RPCs and audit tables. It must be dry-run checked before staging or production push.
2. The business-policy correction migration adds backward-compatible columns to `leave_types` and `leave_requests`; confirm downstream reports tolerate the new metadata.
3. The entitlement simplification migration drops obsolete leave entitlement columns and the unused leave-specific employee flag if present.
4. Existing local attachments under `public/uploads/leave` are not migrated to Supabase Storage in this phase.
5. Playwright is installed in this repo, but browser binaries still need to be installed in CI or QA machines with `npx playwright install chromium`.
6. Failed transactional RPC calls should be investigated through app logs and `leave_audit_logs` failed events.
7. Historical import confirmation requires `leave_historical_import_batches` and `leave_historical_import_rows`; the UI can dry-run before the migration, but confirmation must wait until the migration is applied.
8. Historical upload intentionally does not reapply today's automatic unpaid rule to old rows. QA must verify paid/deduct rows consume balance and unpaid/no_deduct rows do not, even for first-six-month historical dates.
9. Production deployment should wait until all leave migrations have passed an official Supabase dry run against staging and the E2E suite has run with real test users.
