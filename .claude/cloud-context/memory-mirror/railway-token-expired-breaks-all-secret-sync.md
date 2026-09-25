---
name: railway-token-expired-breaks-all-secret-sync
description: "The RAILWAY_TOKEN GitHub secret is expired, so sync-railway-production-secrets fails Unauthorized on EVERY variable — no secret can reach production"
metadata: 
  node_type: memory
  type: project
  originSessionId: d0007173-7b15-4def-a4c3-f0d0670c67f0
  modified: 2026-08-09T07:41:18.055Z
---

`.github/workflows/sync-railway-production-secrets.yml` has been **failing on every run** since at
least 2026-07-07 (checked 2026-08-09: last two runs both `failure`). The cause is a single expired
credential — the `RAILWAY_TOKEN` GitHub secret:

```
- ATTENDANCE_AGENT_TOKEN failed: Unauthorized. Please check that your RAILWAY_TOKEN
  is valid and has access to the resource you're trying to use.
```

Every one of the ~25 variables fails the same way — `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
`CRON_SECRET`, `PHOENIX_AUTH_SECRET`, `TELEGRAM_BOT_TOKEN`, all of them.

**Why it matters:** no secret can be rotated into production. This is why
`CLOUDFLARE_API_TOKEN`/`NOTIFICATION_WEBHOOK_SECRET` stayed "unresolved" after the 2026-08-08
corruption — the fix could not be pushed. It also silently froze `ATTENDANCE_AGENT_TOKEN`, which
diverged from the local agent and returned HTTP 401 on every punch upload, so attendance data
stopped reaching payroll for 10 days.

The workflow runs on push to `main`, so it fails on *every* merge and the red run is easy to
dismiss as unrelated noise.

**How to apply:** the **locally installed Railway CLI is separately authenticated**
(`railway whoami` → oagaweesh@gmail.com) and still works, so it is the workaround for an urgent
single variable:
`railway variables --set "KEY=VALUE" --service phoenix-people-workforce --environment production`
(this triggers a production redeploy). The real fix is minting a new Railway account token and
replacing the `RAILWAY_TOKEN` GitHub secret — only the owner can do that.
See [[attendance-agent-needs-the-office-lan]] for the incident this masked.

## 2026-08-23 — THIS WAS FIXED THE SAME DAY IT WAS WRITTEN. Two claims above are now false.

The body above was written 2026-08-09 at 10:41 Cairo, and the credential was replaced **hours
later that same day**. It then sat stale for two weeks, saying "no secret can reach production"
when secrets could.

Run history for `sync-railway-production-secrets.yml`, read from `gh run list` on 2026-08-23:

| Cairo time | Result |
| --- | --- |
| 2026-08-09 11:26 / 11:31 / 11:54 | `failure` — the Unauthorized runs the body describes |
| 2026-08-09 13:19 | **`success`** |
| 2026-08-10 02:14 | **`success`** |

The later run did not merely exit 0 on a no-op: the job has a second step,
**`Validate synced Railway variables`**, which also passed. So the ~25 variables reached the
Railway `production` service.

**Correction 1 — "failing on every run" is false.** The last two runs succeeded.

**Correction 2 — "The workflow runs on push to `main`, so it fails on *every* merge" is false**, and
this is the part that would mislead a future session most. The trigger is `workflow_dispatch` plus a
**path-filtered** push:

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main, master]
    paths:
      - '.github/workflows/sync-railway-production-secrets.yml'
      - 'scripts/sync-railway-production-secrets.mjs'
```

It fires only when one of those two files changes. Neither has changed since 2026-08-09, which is
the whole reason there are no runs after that date.

**How to apply:**
- **Do not report secret sync as broken, and do not read the empty run history as breakage.** With a
  paths filter, "no runs in two weeks" is the expected state, not a symptom.
- **Equally, do not claim the token is valid today.** It has not been exercised since 2026-08-10
  02:14 Cairo. Account tokens expire; this one already did once. To prove it now, re-run the
  workflow by hand (`gh workflow run sync-railway-production-secrets.yml`) and read the
  *Validate* step — that is the only check that actually proves reachability.
- The locally installed Railway CLI is still separately authenticated and remains the single-variable
  workaround.

**Why this sat wrong for two weeks:** the memory recorded an incident at its worst moment and nothing
re-checked it. A memory that names a live outage needs a re-verify step, or it becomes a false alarm
that costs someone an investigation. See [[list-migrations-reports-ledger-not-reality]] for the same
shape — a ledger read as reality.
