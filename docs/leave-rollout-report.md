# Phoenix Leave Management Staging Rollout Report

- Generated at: 2026-05-13 02:53:09 +03:00
- Started at: 2026-05-13 02:53:09 +03:00
- Final status: FAILED
- Staging DB modified: No
- Migration status: Not executed
- SQL executor: uninitialized
- Rollback possible: No backup tables were created during this run.

## Backup Results
No backup manifest rows were captured during this run.

## Validation Results
| Check | Status | Details |
| --- | --- | --- |
| Required rollout files | PASS | Backup and migration SQL files exist. |
| Staging environment guards | FAIL | PHOENIX_CONFIRM_STAGING_RLS_RUN must equal YES_STAGING_ONLY. PHOENIX_STAGING_ENVIRONMENT must equal staging. PHOENIX_STAGING_DATABASE_URL is required. |

## Test Results
App validation commands were not reached during this run.

## Detailed Failures
- None

## Warnings
- Staging only: never run this script with production database URLs or production credentials.
- The leave migration drops and rebuilds old leave/vacation domain tables after the backup verification passes.

## Failed Checks
- Staging environment guards: PHOENIX_CONFIRM_STAGING_RLS_RUN must equal YES_STAGING_ONLY. PHOENIX_STAGING_ENVIRONMENT must equal staging. PHOENIX_STAGING_DATABASE_URL is required.

## Production Blockers
- This script must never be pointed at production.
- Run and review the staging report successfully before planning any production rollout.
- Production needs a separate approved backup, rollout, monitoring, and rollback plan.
