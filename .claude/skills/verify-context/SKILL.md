---
name: verify-context
description: Spot-check that AGENTS.md §2/§3 (Stable Environment Facts + Hard-Learned Rules) still match live infra — catches the Cloud-Run→Railway class of drift before it misleads a tired operator. Read-only; slash-only.
disable-model-invocation: true
---

# /verify-context — is AGENTS.md §2/§3 still true?

Run these READ-ONLY checks and compare each to what `AGENTS.md` asserts. Report each as
✅ matches / ❌ drift (with the live value). Fix any ❌ in AGENTS.md §2/§3 and the `docs/` that
point there. **This skill never changes infra, settings, or the database — it only reads.**

1. **Production is live on the current commit** (§2, §3)
   ```bash
   curl -s https://phoenix-hr.satopharma.com/api/healthz
   ```
   Expect `"status":"ok"` and `"revision"` = a real commit SHA (never `null`). Once a deploy
   settles it equals `git rev-parse origin/main`.

2. **Railway topology** (§3)
   ```bash
   railway status
   ```
   Expect project `Phoenix-HR-Workforce`, env `production`, service `phoenix-people-workforce`.
   AGENTS.md §3 must name the same. (There is NO Cloud Run.)

3. **Deploy = push to main, via Railway** (§2)
   ```bash
   gh api repos/Phoenix-HR-CRM/phoenix-people-workforce/deployments --jq '.[0] | {environment, description}'
   ```
   Expect `"Deployed to Railway"`. Any `gcloud`/Cloud Run deploy path in the docs is dead.

4. **Branch protection** (§2)
   ```bash
   gh api repos/Phoenix-HR-CRM/phoenix-people-workforce/branches/main/protection \
     --jq '{checks:[.required_status_checks.checks[]|"\(.context) app=\(.app_id)"], reviews:.required_pull_request_reviews.required_approving_review_count}'
   ```
   Expect the 2 required checks (`validate`, `checks`), both of them `app=15368` (GitHub Actions —
   a context with `app_id: null` can be satisfied by any app that reports that name), and
   `reviews: 0` (solo owner can't self-approve). AGENTS.md §2 must match.
   🔴 **This command IS the source of truth — do not "correct" it from a doc.** The list has changed
   five times (4 → 5 → 6 → 4 → 2); `lint`, `typecheck` and `test` stopped existing as check names on
   2026-09-27 (#4527 folded them into `checks`), and **`mobile` and `secret-scan` were dropped from
   protection on 2026-09-29** — they still run, they no longer gate. If what it returns disagrees
   with AGENTS.md §2, the API is right and §2 is the bug. `node scripts/check-required-checks.mjs`
   makes that comparison for you and prints which side is stale.

5. **Supabase project refs** (§3, §8)
   Call `mcp__supabase-production__list_projects`. Expect exactly production `ozucdzovmcqvepbozvqf`
   and staging `cifwmndunmlxjhyjugxa`. Any other ref named in docs (e.g. an `oaif…` sandbox) is dead.

6. **Scheduler** (§3)
   The live scheduler is the third-party **cron-job.org** (outside the repo). Confirm automation is
   actually running via the outbox / `ireports360_visits_sync_runs`, NOT by assuming GCP Cloud
   Scheduler (those jobs 401 on every route). Never report crons as "stalled" without this check.

End with a one-line verdict: all-green, or the list of ❌ facts to correct and where.
