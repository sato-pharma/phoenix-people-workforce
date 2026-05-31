# Leave Module Closure Checklist

Use this checklist before closing the leave management hardening work, before staging approval, and again before any production deployment.

## 1. Branch And Change Scope

- [ ] Confirm the branch is `codex/leave-governance-compliance`.
- [ ] Confirm the branch was created from `origin/codex/work-from-production`.
- [ ] Confirm no unrelated dirty worktree changes are included.
- [ ] Review the final diff for leave, security, migration, test, and documentation changes only.

## 2. Database And Migration Readiness

- [ ] Review `supabase/migrations/20260531202329_vacation_leave_governance_compliance.sql`.
- [ ] Confirm migration is applied to staging before production.
- [ ] Confirm no destructive migration step runs without backup and approval.
- [ ] Confirm retention tables, policy seed rows, rate-limit table, and indexes exist after migration.
- [ ] Confirm rollback notes are available before production apply.

## 3. Access Governance

- [ ] Confirm XLSX audit export requires `leave:export`.
- [ ] Confirm users with only `leave:read` cannot call the export API.
- [ ] Confirm export UI is hidden or disabled for users without export permission.
- [ ] Confirm weekly-off policy audit records use `vacation_weekly_off_policy`.
- [ ] Confirm audit viewer displays the policy entity type clearly.

## 4. Workflow Governance

- [ ] Submit annual, emergency, sick, compensatory, partially paid, and other leave requests.
- [ ] Confirm admin-created leave defaults to a governed pending status, not approved.
- [ ] Confirm sick and compensatory evidence can be reviewed by HR/Super Admin.
- [ ] Confirm the same actor cannot accept evidence and perform final HR approval on the same evidence-required request.
- [ ] Confirm manager approval, HR final approval, rejection, and timeline entries are recorded correctly.

## 5. Retention Governance

- [ ] Confirm the documented retention periods are present:
  - Requests and audit history: 7 years.
  - Evidence attachments: 3 years after final decision.
  - Decision tokens: 90 days.
  - SLA run logs: 1 year.
- [ ] Run retention purge in dry-run mode only.
- [ ] Review dry-run counts before approving any purge.
- [ ] Confirm actual purge is blocked unless explicit approval is provided.
- [ ] Confirm no production purge runs without a backup and written approval.

## 6. Security Controls

- [ ] Confirm leave POST/PATCH/DELETE routes use the route-level CSRF guard.
- [ ] Confirm payroll, contracts, resignations, probation, employees, and outstation mutation routes use the same CSRF guard.
- [ ] Confirm signed token GET decision links remain excluded from CSRF.
- [ ] Confirm upload routes reject oversized requests by `Content-Length` before `formData()`.
- [ ] Confirm file size is checked before `arrayBuffer()`.
- [ ] Confirm files above 10 MB return `413`.
- [ ] Confirm rate limiting exists for upload, XLSX export, timeline, evidence review, and token decision endpoints.

## 7. Performance And Production Readiness

- [ ] Confirm XLSX export does not use N+1 timeline loading.
- [ ] Confirm export events and reviews are batch-loaded for exported request IDs.
- [ ] Confirm export row cap behavior is clear to the user.
- [ ] Confirm report filtering is pushed into the existing database RPC where practical.
- [ ] Confirm holiday lookup uses timeout and short server-side cache.
- [ ] Confirm failure of the holiday provider does not block leave submission.

## 8. UI And Mobile Verification

- [ ] Verify `/leave-management/vacation-report` on desktop width.
- [ ] Verify `/leave-management/vacation-report` on phone width.
- [ ] Verify `/leave-management/vacation-control` on desktop width.
- [ ] Verify `/leave-management/vacation-control` on phone width.
- [ ] Confirm phones use card/list layouts instead of horizontal scrolling as the primary experience.
- [ ] Confirm dense controls remain tappable and long modal content scrolls correctly.

## 9. Validation Commands

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `git diff --check`

## 10. Release Gates

- [ ] Commit approved.
- [ ] Push approved.
- [ ] Pull request approved.
- [ ] Supabase staging migration approved and applied.
- [ ] Staging preview smoke test completed.
- [ ] Production migration approved.
- [ ] Production deployment approved.
- [ ] Production URL verified: `https://phoenix-workforce.vercel.app`.

## Stop Conditions

Do not close or deploy the module if any of these are true:

- Export is available without `leave:export`.
- Evidence separation of duties can be bypassed.
- Upload accepts files above 10 MB into memory.
- Retention purge can run without dry-run review and explicit approval.
- `npm run typecheck`, `npm run test`, or `npm run build` fails.
- Phone workflows require horizontal scrolling as the main way to use report/control screens.
