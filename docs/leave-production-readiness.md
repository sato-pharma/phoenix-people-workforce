# Leave Management Production Readiness

This checklist is for the Phoenix Workforce Leave Management Engine only. Do not modify payroll tables, payroll services, payroll APIs, payslip logic, or payroll dashboards as part of this rollout.

For the final user, manager, and admin operating guide, also review `docs/leave-module-overview.md`.

## Production rollout checklist

1. Confirm staging has the Phase 1 and Phase 2 leave migrations applied and no pending unrelated migrations.
2. Review `supabase/migrations/20260513100825_leave_production_readiness.sql` for the transactional RPCs, audit tables, private attachment bucket preparation, and indexes.
3. Run `supabase db push --dry-run` against staging first and confirm only the expected leave production-readiness migration appears.
4. Apply to staging with the official Supabase CLI only after the dry run is clean.
5. Run `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
6. Run the leave E2E suite with `npm run test:e2e:leave` after browser binaries and test credentials are configured.
7. Manually verify `/employee-portals/leave`, `/employee-portals/leave-approvals`, and `/admin/leave`.
8. Confirm audit rows are written to `leave_audit_logs` for submit, manager decision, HR decision, accrual, adjustment, failed notification, and attachment download URL events.
9. Confirm no payroll behavior changed.

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

## Monitoring checklist

1. Track request failures for `/api/leave/requests`, `/api/leave/requests/[id]/manager-decision`, `/api/leave/requests/[id]/hr-decision`, `/api/leave/accrual/run`, and `/api/leave/adjustments`.
2. Monitor `leave_audit_logs` for `*.failed` event types.
3. Monitor `leave_accrual_runs` for skipped/processed counts and total amount by period.
4. Monitor Supabase function errors for `phx_leave_submit_request_atomic`, `phx_leave_manager_decision_atomic`, `phx_leave_hr_decision_atomic`, `phx_leave_adjust_balance_atomic`, and `phx_leave_run_accrual_atomic`.
5. Monitor private storage signed URL creation latency and failures.
6. Watch for repeated double-submit attempts; the transactional RPC row locks and transaction existence checks should prevent duplicate consumption.

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
2. Existing local attachments under `public/uploads/leave` are not migrated to Supabase Storage in this phase.
3. Playwright is installed in this repo, but browser binaries still need to be installed in CI or QA machines with `npx playwright install chromium`.
4. Failed transactional RPC calls should be investigated through app logs and `leave_audit_logs` failed events.
5. Production deployment should wait until the production-readiness migration has passed an official Supabase dry run against staging and the E2E suite has run with real test users.
