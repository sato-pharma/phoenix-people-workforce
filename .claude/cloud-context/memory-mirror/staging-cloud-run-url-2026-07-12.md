---
name: staging-cloud-run-url-2026-07-12
description: "Staging now has its own real, public, always-on app URL (Cloud Run service phoenix-hr-staging) separate from the local-only dev-server option — use this instead of spinning up npm run dev."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e44e8d87-99cf-4dcc-af01-e13043d94bf5
---

**Staging app URL: `https://phoenix-hr-staging-897559113412.us-central1.run.app`**

Cloud Run service `phoenix-hr-staging`, project `phoenix-workforce-498619`, region
`us-central1`. Deployed 2026-07-12 from a clean checkout of `origin/main` via
`gcloud run deploy --source .`. Public, `allUsers` → `roles/run.invoker`, no login needed to
reach the URL itself (the app's own auth still applies once you're on it).

**Points at staging Supabase** (`cifwmndunmlxjhyjugxa`, see
[[agents-md-stale-staging-ref]]) — fully isolated from production's
database. Edits made through this URL never touch production data.

**Deliberately does NOT have production's third-party secrets** (Resend, OpenAI, Telegram,
Sentry, CRON_SECRET, Google server key, attendance-agent token, iReports360) — only staging
Supabase credentials + a freshly-generated `PHOENIX_AUTH_SECRET` + `APP_ENV=staging` (forces
`isForceTestingDelivery()` on, so any email path that *did* fire would redirect to test
recipients anyway). This was a deliberate scope-down after the Claude Code auto-mode
classifier correctly blocked copying prod's full secret set onto a second, less-protected
public service — don't "fix" this by copying them in without re-deciding that tradeoff.

**Does not auto-deploy.** No CI/CD wired to this service — pushes/merges to `main` only
feed *production's* pipeline. To update staging's code, re-run
`gcloud run deploy phoenix-hr-staging --source . --region us-central1 --project phoenix-workforce-498619 --build-env-vars-file=<public-vars-only.yaml> --env-vars-file=<full-vars.yaml>`
manually, splitting build vs. runtime env files so secrets never pass through Cloud Build
logs via `--build-env-vars-file` (only `NEXT_PUBLIC_*` values belong there).

**Org policy blocker + fix, if this ever needs redoing on a new service:** the GCP org
(id `876942796781`) enforces `constraints/iam.allowedPolicyMemberDomains`, which blocks
`allUsers` (and even specific external Gmail accounts) from being granted `run.invoker` —
confirmed by 3 independent failures (public binding, named-account binding, `gcloud run
services proxy` needing an uninstallable component). The user confirmed they're the GCP org
admin; the actual fix (not a workaround) is a **project-level policy override**, not an
org-wide change:
```
gcloud resource-manager org-policies set-policy <file-with: constraint: constraints/iam.allowedPolicyMemberDomains / listPolicy: { allValues: ALLOW }> --project=phoenix-workforce-498619
```
Then retry the IAM binding — it can take ~30-45s to propagate, first retry attempt right
after setting the override will still fail, that's expected, not a sign it didn't work.

**How to apply:** default to this URL for "can you test/click around staging" requests
instead of setting up a local dev server + worktree — it's zero setup for the user going
forward. Only fall back to local dev if code changes not yet pushed to `main` need testing
(this service only reflects whatever was last manually deployed to it).
