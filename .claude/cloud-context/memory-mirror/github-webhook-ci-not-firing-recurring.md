---
name: github-webhook-ci-not-firing-recurring
description: "Zero check-runs on a commit has TWO causes: a rare dropped event (dispatch to recover) or a platform-wide Actions outage where events are only DELAYED. Forcing a synchronize with an empty commit BACKFIRES — the replayed backlog cancels the real head via the concurrency group. Also: secret-scan is PR-only by design, never on a main push."
metadata: 
  node_type: memory
  type: project
  modified: 2026-10-01T00:00:00.000Z
  originSessionId: 38d7683c-a0c4-407a-875b-0a9dd5b70200
---

**Recurring pattern, not a one-off:** this repo's push webhook to GitHub Actions intermittently
fails to fire after a PR merges to `main` — the merge succeeds, but zero
`workflow_runs`/`check_runs` ever get created for that commit. Confirmed 3 times: this repo's own
git history has a prior commit literally titled "chore: retrigger CI (pull_request-synchronize
webhook did not fire on prior push)"; then in one session (2026-07-19) it happened again for BOTH
PR #1185 and PR #1186's merges back-to-back within ~10 minutes of each other.

🔴 **Two corrections, 2026-08-23 — read before using the Fix/Gotcha sections below.**

1. **This paragraph used to say "main has no branch protection … so this doesn't block anything."
   `main` IS protected now** — `enforce_admins: true` and two required checks (`validate`,
   `checks`), verified live against the branch-protection API on 2026-10-01. *(Corrected 2026-10-01 — the gate is TWO, `validate` and `checks`; read the protection API, never this line.)* Those gate the
   **merge** on the PR, so a dropped *post-merge* push run still does not block a merge — but it
   matters far more than it used to, because a merge to `main` now **deploys to production
   immediately** ([[railway-merge-is-the-production-deploy]]). A silent zero-run merge is now a
   silent unverified production ship.
2. **The `gcloud` / Cloud Run guidance below is DEAD.** GCP billing closed 2026-08-01; every API in
   `phoenix-workforce-498619` returns `BILLING_DISABLED`, and `deploy-cloud-run.yml` is
   trigger-disabled. Do **not** verify production with `gcloud run services describe` — production
   is Railway. Ground truth for "what is actually serving" is now `GET /api/healthz` and reading
   `revision`. See [[railway-is-prod-cloud-run-workflow-is-dead]].

The **detection and retrigger mechanics are unaffected and still correct** — the zero-`check_runs`
signature, and `gh workflow run ci.yml --ref main` as the fix. That is what this file is for.

**Detection:** `gh run list --branch main` shows nothing for the new HEAD, and
`gh api repos/OWNER/REPO/commits/<sha>/check-runs` returns `{"total_count":0}` — confirms zero
runs exist, not just that they haven't shown up yet in a cache.

**Fix:** `ci.yml` has `workflow_dispatch` enabled — `gh workflow run ci.yml --ref main` manually
fires it for the current HEAD. `deploy-cloud-run.yml` is `workflow_run`-triggered off CI success,
so it auto-follows once the manual CI run completes; no separate action needed for that.

**Gotcha found while chasing this:** `gh run list`'s `headSha` field for a `workflow_run`-triggered
run (the deploy workflows) does NOT reliably reflect the specific commit that workflow's own steps
actually checked out/built — it appears to just reflect `main`'s branch tip at some point during
the run's lifecycle, not the triggering CI run's tested SHA. Ground truth for "what did production
actually deploy" is `gcloud run services describe <service> --format="value(status.traffic)"` (the
live tag on the 100%-traffic revision) or `gcloud artifacts docker images describe
<path>:sha-<8char>` (does the image exist at all) — NOT `gh run list`'s metadata. This caused real
confusion in one session: two merges landed ~10s apart with neither triggering webhook CI; a manual
CI dispatch for the OLDER commit still ended up deploying the NEWER commit's full state (main is
cumulative, correct behavior) while `gh run list` mislabeled which SHA that deploy run was "for."
The staging deploy workflow separately failed in this scenario because it computes its target
image tag from `main`'s tip at ITS OWN checkout time rather than pinning to what production
actually built — a real inconsistency between the two workflows, currently unfixed, but low-stakes
(staging self-heals on the next commit that gets a normal CI run).

**How to apply:** After merging anything migration/security/deploy-relevant, don't assume CI ran —
check `gh run list --branch main` (or the check-runs API) shows a run for the new HEAD before
considering it live.

**Investigated 2026-07-19 — "webhook" is the wrong mental model, correct it:** `gh api
repos/OWNER/REPO/hooks` shows this repo has exactly ONE registered webhook (builder.io's
integration), and it only listens for `check_run`/`issue_comment`/`pull_request`/
`pull_request_review`/`pull_request_review_comment` — NOT `push`. There is no repo-configured
webhook responsible for triggering Actions on push at all; GitHub Actions' push-triggering is an
internal platform mechanism with no user-inspectable delivery log (unlike third-party webhooks,
which DO have one under Settings → Webhooks → Recent Deliveries — a dead end for this specific
issue, don't bother checking it). Also ruled out: repo not archived/disabled, Actions enabled with
normal `allowed_actions: "selected"` (a scoping setting, not a block — would fail loudly on a
specific disallowed action, not silently produce zero runs), and this does NOT match the billing
lockout signature from [[ci-billing-block-and-unprotected-main]] (that one produces a run that
exists and fails in ~1-2s with a billing annotation; this one produces ZERO run records at all,
confirmed via the check-runs API returning `total_count: 0`). Conclusion: this is a rare,
undocumented GitHub platform-level reliability gap where a push event occasionally fails to
trigger workflow evaluation — nothing on the repo side is misconfigured, and there is no further
diagnostic surface available to root-cause it further. The only real mitigation is detect-and-
retrigger (`gh workflow run ci.yml --ref main`), not a one-time fix.

🔴 **2026-08-26 — a SECOND cause with the same signature, and the fix that makes it WORSE.**

Zero check-runs is now ambiguous. Two different things produce it:

- **The rare per-event drop** described above — the event is genuinely lost, `workflow_dispatch`
  is the only recovery.
- **A platform-wide Actions outage** — the events are **DELAYED, NOT DROPPED**, and GitHub replays
  the whole backlog later. Distinguish them in one call:
  `curl -s https://www.githubstatus.com/api/v2/components.json` and read the **Actions** component
  (`major_outage` vs `operational`). Webhooks / API Requests / Pull Requests can all read
  `operational` while Actions is out, so the repo looks perfectly healthy from every other angle.
  Another tell: `workflow_dispatch` fires instantly while `push`/`pull_request` produce nothing —
  dispatch is a direct API call and does not travel the event path that is down.

**What NOT to do: push an empty commit to force a `synchronize`.** I did this on PR #2418 and it
was the wrong call. Because the events were only delayed, the backlog eventually replayed — and it
replayed the event for the **obsolete** SHA too. `ci.yml`'s concurrency group is keyed on the ref
with `cancel-in-progress: true`, so the late-arriving run for the dead commit **cancelled the
running job on the real head**. The extra SHA bought nothing and handed the concurrency group a
second head to fight over. Recovery cost another full CI cycle.

**Do instead:** leave the head alone. `gh workflow run ci.yml --ref <branch>` to get an answer now,
then wait for the backlog to drain (poll until no `in_progress`/`queued` runs remain) and
`gh run rerun <id>` on the head's own run so branch protection sees a fresh result attached to the
real SHA. Branch protection reads the **latest** check-run per name, so an older green dispatch is
superseded the moment a newer run of the same name starts — a dispatched green does not stay green.

**Also learned the same day:** `secret-scan` is **not expected on a `main` push at all** — its
workflow is `on: pull_request` + a daily `schedule`, deliberately not `push` (Actions cost). Its
absence from a merge commit's check-runs is correct, not a missed gate; it ran on the PR head
against the identical tree. Do not go hunting for it or dispatch it after a merge.
