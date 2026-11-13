# Phoenix Role Alignment Production Readiness

> **Reconciled 2026-08-04 — historical record.** The validation summarized below ran against
> sandbox ref `oaifhavixhdtwmseshff`, which **no longer exists** (`list_projects` returns only
> production `ozucdzovmcqvepbozvqf` and staging `cifwmndunmlxjhyjugxa` — see AGENTS.md §3).
> Treat the PASS results as a point-in-time record, not a live gate: any re-validation needs a
> rebuilt sandbox target. Per this document itself, the role-alignment migration was **never
> applied to production**.

## 1. Executive Summary

Phoenix Workforce role-alignment validation is complete in the approved sandbox project only. The migration, helper functions, table grants, RLS policies, read-only authenticated assertions, mutation assertions, and cleanup checks all passed.

Final recommendation: **GO for controlled production rollout** for role-alignment, with one reviewed tracked exception: `public.employee_probation` RLS remediation is deferred to a separate security workstream. Production execution still requires a change window, fresh production backup, final target confirmation, and human review of the exact migration to be applied.

## 2. Scope And Target

Validated target:

- Sandbox name: `sato.hr2@hotmail.com`
- Sandbox ref: `oaifhavixhdtwmseshff`
- Sandbox URL: `https://oaifhavixhdtwmseshff.supabase.co`

Production project explicitly excluded:

- Production name: `Phoenix HR`
- Production ref: `ozucdzovmcqvepbozvqf`

Production Phoenix HR has since been inspected by read-only preflight, and the `admin-HR` identity blocker has been remediated. The role-alignment migration has not been applied to production.

## 3. What Was Changed

The role-alignment migration was validated and refined in sandbox:

- Added/validated `phoenix_role` and `scope_type` support.
- Added explicit role helper functions for Phoenix enterprise roles.
- Replaced broad `admin` assumptions with explicit helper checks.
- Preserved CEO as company-reader, Finance Manager as finance, HR Specialist as HR/payroll, and Super Admin as unrestricted admin.
- Added minimal table-level grants required for RLS policy evaluation.
- Kept `anon` denied for protected tables.
- Kept RLS enabled.
- Tightened `user_access_profiles` update to Super Admin only.
- Tightened employee self expense insert to `Employee` and `Medical Rep` only.

## 4. What Was Validated In Sandbox

Completed sandbox validation:

- Base schema bootstrap: PASS
- Admin/auth bootstrap: PASS
- 15-role test users: PASS
- Dry-run: PASS
- Role-alignment migration: PASS
- Read-only RLS harness: PASS, `108 passed / 0 failed`
- Mutation RLS harness: PASS, `134 passed / 0 failed`
- Cleanup: PASS, zero leftover marked rows

All RLS assertions used Supabase anon key plus real authenticated sandbox user sessions. Service/admin access was used only for sandbox setup, backups, migration application, and metadata checks.

## 5. PASS/FAIL Matrix By Phase

| Phase | Result |
|---|---:|
| Sandbox target safety gates | PASS |
| Base Phoenix schema bootstrap | PASS |
| Sandbox admin/auth bootstrap | PASS |
| 15-role test-user preparation | PASS |
| Dry-run validation | PASS |
| Backup table creation | PASS |
| Role-alignment migration application | PASS |
| Schema validation | PASS |
| Helper function validation | PASS |
| Function grant validation | PASS |
| Role mapping validation | PASS |
| Dangerous policy detectors | PASS |
| Read-only authenticated RLS harness | PASS |
| Mutation authenticated RLS harness | PASS |
| Cleanup verification | PASS |

## 6. PASS/FAIL Matrix By Role

| Role | Read Validation | Mutation Validation |
|---|---:|---:|
| Employee | PASS | PASS |
| Medical Rep | PASS | PASS |
| District Manager | PASS | PASS |
| Regional Manager | PASS | PASS |
| National Sales Manager | PASS | PASS |
| Product Manager | Covered in 15-role setup | Not in smoke harness |
| Group Product Manager | Covered in 15-role setup | Not in smoke harness |
| SFE Manager | Covered in 15-role setup | Not in smoke harness |
| Training Manager | Covered in 15-role setup | Not in smoke harness |
| Marketing Manager | Covered in 15-role setup | Not in smoke harness |
| Finance Manager | PASS | PASS |
| HR Specialist | PASS | PASS |
| Manager | Covered in 15-role setup | Not in smoke harness |
| CEO | PASS | PASS |
| Super Admin | PASS | PASS |

The current harness asserts the critical 9-role smoke matrix. The sandbox preparation flow successfully created and mapped all 15 enterprise roles.

## 7. Table/Policy Permission Summary

Validated access model:

- `employees`: authenticated table writes are granted only so RLS can evaluate. RLS permits HR Specialist and Super Admin employee-management writes. CEO, Finance Manager, employees, and managers were denied.
- `user_access_profiles`: authenticated writes are granted only so RLS can evaluate. RLS permits Super Admin admin writes and denies non-super-admin user administration.
- `payroll_expenses`: authenticated writes are granted only so RLS can evaluate. RLS permits Employee/Medical Rep own expense insert and payroll-manager update/delete through Finance Manager, HR Specialist, and Super Admin. Managers and CEO were denied.
- `payroll_expense_reports`: authenticated writes are granted only so RLS can evaluate. RLS permits payroll-manager writes through Finance Manager, HR Specialist, and Super Admin. Employees, managers, and CEO were denied.
- `sales_records`: authenticated `SELECT` is granted only so RLS can evaluate. RLS controls visible rows. `anon` remains denied.

No blanket `ALL` grants were added to protected application tables. No writes were granted to `anon`.

## 8. Security Advisor Findings

### Migration Blockers

No migration blockers remain from sandbox validation. Read and mutation harnesses both passed after table-level grants were aligned with existing RLS policies.

Reviewed tracked exception:

- `public.employee_probation` has RLS disabled in production.
- This is a reviewed tracked exception, not a blocker for the role-alignment rollout.
- It is separated into its own security remediation workstream.
- Do not enable RLS automatically as part of role alignment. Enabling RLS without complete, reviewed policies can break probation tracker reads/writes.
- Current probation workflow access is service-role controlled through server-side app paths.
- No direct authenticated client writes to `employee_probation` are currently required by the app.
- A reviewed SQL remediation draft exists in `docs/security/production-blocker-remediation-plan.md`.
- Probation RLS remediation will be scheduled separately.

Documentation-only remediation draft, not executed by role-alignment:

```sql
alter table public.employee_probation enable row level security;
```

Before applying that SQL, define and test the matching probation policies for the confirmed access model. Current recommended first step is service-role-only RLS for existing server-controlled workflows.

### Sandbox-Only Noise

The following findings are known sandbox noise and should not block production planning:

- Sandbox backup/marker tables have RLS disabled.
- Old pre-existing sandbox tables such as `orders`, `customers`, `call_logs`, and `upload_batches` have permissive policies.
- Some sandbox findings relate to legacy/non-Phoenix test artifacts.

These should be cleaned up in sandbox separately, but they are not blockers for the Phoenix role-alignment production migration.

### Intentional Reviewed Exceptions

The `current_access_*` helper functions are `SECURITY DEFINER` and executable by `authenticated`. This is intentional because RLS policies need authenticated users to execute these helpers during policy evaluation.

Reviewed exception requirements:

- Helpers must keep a fixed `search_path`.
- Helpers must return only scoped authorization facts.
- `anon` must not receive helper execution grants.
- Helpers must not expose payroll, salary, or personal data directly.

### Production Action Items

Before production execution:

- Enable leaked password protection for production Auth if available.
- Review any `SECURITY DEFINER` views and convert to `security_invoker` or restrict exposure where appropriate.
- Confirm production has no legacy permissive policies on Phoenix-owned tables.
- Confirm backup tables or temporary validation artifacts are not introduced into production without an explicit cleanup plan.

## Deferred Security Remediations

The following item is deferred from the role-alignment rollout and tracked separately:

- `public.employee_probation` RLS remediation.

Justification:

- Current probation workflows use service-role controlled server access.
- No direct authenticated client writes are required by the current app flow.
- The remediation SQL has been reviewed and documented separately.
- Applying probation RLS in the role-alignment change would mix two independent security changes and complicate rollback.

Required follow-up:

- Schedule a separate security remediation window.
- Apply the reviewed service-role-only RLS remediation first.
- Verify probation dashboard, command-center risk counts, and probation workflow actions.
- Add authenticated policies later only if direct authenticated table access becomes an explicit requirement.

## 9. Remaining Production Risks

- Production data may contain role values, missing `HR_ID`, or inactive users not represented in sandbox.
- Existing production policies may differ from sandbox if hotfixes were applied directly.
- Production Supabase Auth settings may differ from sandbox, including leaked password protection and email validation settings.
- Helper grants must be reviewed carefully because they are intentional RLS exceptions.
- Table-level grants are safe only when paired with the validated RLS policies in the same migration.

## 10. Production Rollout Checklist

1. Schedule a production change window.
2. Freeze auth, employee, payroll, and access-control changes during the window.
3. Export production backups for `user_access_profiles`, `app_auth_users`, affected policies, and helper definitions.
4. Run production dry-run only.
5. Review the final migration SQL against the sandbox-passed version.
6. Apply migration once to production during the approved window.
7. Run read-only production validation only.
8. Do not run mutation probes on production.
9. Monitor Auth, PostgREST, and Postgres logs after rollout.
10. Keep rollback SQL and backup exports available until sign-off.

## 11. Production Preflight Checklist

Required before production migration:

- Run the read-only preflight runner:

  ```powershell
  pnpm run db:preflight:role-alignment:production
  ```

- Confirm target ref is Phoenix HR production only after explicit approval.
- Confirm ref is not the sandbox ref.
- Confirm production backup export is complete.
- Confirm `phoenix_role` values map to approved enterprise vocabulary.
- Confirm `HR_ID` and `Manager_HR_ID` integrity for active employees.
- Confirm no unknown roles exist in production `app_auth_users`.
- Confirm no stale `admin` assumptions remain in active production RLS policies.
- Confirm `anon` has no protected-table write grants.
- Confirm all Phoenix-owned production tables have RLS enabled or are documented reviewed exceptions.
- Confirm `public.employee_probation` remains documented as a reviewed tracked exception deferred from role-alignment.
- Confirm helper functions include fixed `search_path`.
- Confirm production Auth leaked password protection setting is reviewed.

## 12. Rollback Checklist

Rollback should be prepared before migration:

- Restore prior helper function definitions if helper behavior causes production errors.
- Restore prior RLS policies from backup if access regressions occur.
- Restore prior `user_access_profiles.role`, `phoenix_role`, and `scope_type` values from backup if mapping issues occur.
- Revoke newly added table-level write grants if rolling back to policies that do not require them.
- Leave additive columns in place unless a separate reviewed cleanup migration is approved.
- Validate login, employee profile, payroll, expenses, and admin-user flows after rollback.

## 13. Exact Production Migration Recommendation

Recommended production path:

- Use the sandbox-passed `supabase/scripts/20260511_phoenix_role_alignment.sql` as the forward migration candidate.
- Apply only after backup and final preflight.
- Do not manually edit production policies in the dashboard.
- Do not apply partial SQL snippets.
- Do not run mutation validation on production.
- Run read-only production validation after migration.

## 14. Final Recommendation

Status: **GO for controlled production rollout** for role-alignment.

Execution status: **GO after approved change window, backup, final target confirmation, and final SQL review**.

Production migration should proceed only after:

- Change window is approved.
- Backups are complete.
- Final preflight passes.
- The production target is explicitly confirmed.
- A human reviews the final SQL diff against the sandbox-passed migration.

Known tracked exception carried into rollout:

- `public.employee_probation` RLS remains disabled and is deferred to a separate reviewed security remediation workstream.
