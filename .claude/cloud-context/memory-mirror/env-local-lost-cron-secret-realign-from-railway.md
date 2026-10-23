---
name: env-local-lost-cron-secret-realign-from-railway
description: "CRON_SECRET not found in .env.local" is a missing local key, not a rotation — realign FROM Railway production (64 chars) and prove it against cron-job.org job 8200914, whose Authorization header is byte-comparable.
metadata:
  type: project
---

On 2026-10-23 a local command failed with `CRON_SECRET not found in .env.local`. The file genuinely
held no `CRON_SECRET` line at all (45 keys, only `CRONJOB_API_KEY` matched `CRON`), while
`.env.example` documents both `CRON_SECRET` and `CRON_SECRET_PREVIOUS`. Nothing had rotated.

**The fix, and the direction it flows.** Read the live value from Railway **production**, service
`phoenix-people-workforce` — `railway variables --service phoenix-people-workforce --environment
production --json` — strip the BOM, assert **length 64** and no interior whitespace, then append the
line to `.env.local` (gitignored, so this is safe; never into git). Local is DOWNSTREAM of Railway,
unlike the GitHub Actions copy, which is UPSTREAM of it — so a bad value here breaks only this
laptop, whereas the same carelessness on the Actions secret is pushed into production by
`sync-railway-production-secrets.yml`.

**The proof that costs one API call and no production side effects.** `scripts/cronjob-sync.mjs`
only length-checks the bearer when it is about to WRITE a job, so a clean dry run proves nothing
about the value. Instead read cron-job.org job **8200914** (`phoenix-process-notifications`, the
script's own `REFERENCE_JOB_ID`) with `CRONJOB_API_KEY` and compare
`jobDetails.extendedData.headers.Authorization` to `Bearer <local>` — it came back **identical**,
which is stronger than the length comparison the script settles for. Never prove the bearer by
calling a `/api/cron/*` route: the bearer check passes and then the job RUNS on production.

Related: [[a-stale-cron-secret-401s-every-job]] · [[the-error-table-never-says-which-needs-you-source-timed-out]]
