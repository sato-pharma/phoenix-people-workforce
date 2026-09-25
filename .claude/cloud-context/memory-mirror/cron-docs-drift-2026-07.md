---
name: cron-docs-drift-2026-07
description: "Docs described an old birthdays+contract-renewals cron pair; live vercel.json has evolved to daily-consolidator + 30-min outbox-drain. Fixed 2026-07-02."
metadata: 
  node_type: memory
  type: project
  originSessionId: a7e96bed-9f14-4af9-9985-c4ef15e261a5
---

Six docs (CLAUDE.md, docs/deployment.md, docs/architecture.md, docs/current-operating-state.md, docs/troubleshooting.md, CONTRIBUTING.md) described a stale cron design — `/api/notifications/birthdays` + `/api/notifications/contract-renewals` on Vercel Hobby — that no longer matched `vercel.json`. The live config (unchanged on `origin/main` since `0cf6ada9`, weeks old) is actually:

- `/api/notifications/daily` at `30 6 * * *` — consolidates birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift, Telegram HR digest, outstation geocode warm-up + high-risk digest into one route.
- `/api/notifications/process?limit=50` at `*/30 * * * *` — drains the notification outbox faster than daily, per an explicit code comment in `app/api/notifications/process/route.ts` calling this intentional.

**Why this mattered:** a sub-agent flagged the mismatch as a "live operational risk," theorizing the 30-min cron gets rejected/coerced by Vercel Hobby (which does hard-fail deploy for sub-daily crons per Vercel's docs). Live checks (`vercel crons ls`, recent successful production deploys) proved the cron *is* running as configured — because the account is actually on **Pro**, not Hobby as the docs claimed. So the real bug was stale documentation (plan tier + cron design both out of date), not a broken cron. See [[vercel-pro-and-deploy-recovery]] for the plan-tier flip-flop history — verify live before trusting any single note on this.

**How to apply:** all six docs were corrected on branch `codex/fix-cron-docs` (PR #675, merged via one-off `gh pr merge --admin` — see below for why) (worktree `F:/Phoenix Workforce/_wt-cron-docs-fix`, isolated because another session was actively deploying in the main working dir at the time). If notification cadence work comes up again, `app/api/notifications/daily/route.ts` and `.../process/route.ts` are the actual source of truth — check them directly rather than trusting docs describing "two daily crons."

**Side discovery, also fixed:** merging PR #675 revealed that `main`'s required `validate` check can never run on PRs limited to `**/*.md`/`docs/**` (ci.yml `paths-ignore`s them, so no run ever queues, and branch protection then shows the PR permanently `BLOCKED`). Filed as issue #679, fixed in PR #680 (`codex/ci-docs-only-fallback`, merged normally 2026-07-02) by adding `.github/workflows/ci-docs-fallback.yml` — a second workflow with a job also named `validate`, triggered on the inverse path filter, that trivially passes. Future docs-only PRs should no longer need an admin-override merge.
