---
name: a-slow-railway-day-is-measured-from-the-build-log-not-the-github-status
description: "Railway is slow today" audit method and baseline (2026-10-16) — true serving time is the build log's "Healthcheck succeeded", NOT GitHub's deployment "success" (it lagged 17 min once); Railway build median 2.84 min, +1.06 with the Sentry source-map step; push-to-serving 8.5 min before, 9.8 on the bad day
metadata:
  type: project
---

**How to measure a "Railway is slow" day:** the deploy's true go-live is the `Healthcheck succeeded` line in its build log (`railway logs -b <deployment-id> -p Phoenix-HR-Workforce -e production -s phoenix-people-workforce --json`, from a worktree pass `-p/-e/-s` because it is not linked; on Windows spawn it with `shell: true` from node). GitHub's deployment `success` status is NOT that moment: on 2026-10-16 it came 17 minutes after the app was already serving (the old container stopped 9 s after the new one started), and the 4.3 and 16.9 minute lags were the only two in 114 deployments — both after the second Railway service (`phoenix-workforce-worker`, same repo and sha) was created at 18:25 Cairo. Cause of the lag unproven.

**Baseline (Cairo, measured 2026-10-16):** push to serving median 8.5 min on 13 and 15 Oct (9.1 on the 14th), 9.8 today. Main CI re-run 5.2–5.6 min on 13–15 Oct, 6.6 today (the `checks` job's unit-suite step swings 170–190 s vs 220–320 s on the same GitHub-hosted `ubuntu-latest` runner — hosted-runner variance, same workflow). Railway scheduled-to-healthy median 2.84 min without the Sentry source-map step, 3.90 min with it (the step itself 17–42 s, median 28 s). Railway's own status page and githubstatus.com were clean all day.

**Why:** the owner asked "what happened, Railway was faster" and the GitHub deployment timestamps pointed at the wrong culprits (a 27-minute "deploy" that was really 11).

**How to apply:** read build-log time, not the GitHub status; separate CI wait, Railway build, and held-by-another-suite wait (`commits/<sha>/check-suites` — a scheduled `Security Scan (OSS)` run held one deploy 9 minutes at 12:45 Cairo, and it runs ~10 min in business hours every day). See [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]] and [[railway-deployment-list-omits-the-active-deployment]].
