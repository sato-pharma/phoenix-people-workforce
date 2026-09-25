---
name: vercel-pro-and-deploy-recovery
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Vercel plan tier has flip-flopped before — confirm live, don't trust old notes; plus how to manually push latest main to prod when auto-deploy lags"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 06f7989f-6910-4a16-973a-673ad1fd295c
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**Plan tier history (this has changed at least twice — don't trust any single note, verify live):** Pro → corrected to **Hobby** on 2026-06-17 → user confirmed **Pro** again on 2026-07-02 (owner said "pro" directly in chat, after `vercel crons ls` showed the live `*/30 * * * *` notification cron registered and deploying successfully, which per Vercel's own docs would hard-fail at deploy time on Hobby). CLAUDE.md + docs/deployment.md + docs/architecture.md + docs/current-operating-state.md + docs/troubleshooting.md + CONTRIBUTING.md were all corrected to say Pro in [[cron-docs-drift-2026-07]] (branch `codex/fix-cron-docs`). Given the flip-flop history, re-verify plan tier via the Vercel dashboard billing page before relying on it for anything consequential (e.g. deciding whether a sub-daily cron is safe to add).

**On Hobby specifically:** 100-deploys/day cap and 2-cron limit apply, and cron schedules more frequent than daily hard-fail deployment outright (not silently coerced). Heavy multi-session merge churn hit the Hobby deploy cap once (2026-06-17) and froze production auto-deploys for ~1h (newest prod build stuck ~57m old while main kept advancing) — that specific failure mode should not recur on Pro.

**Cap-lift/plan-upgrade does NOT replay missed builds.** When auto-deploy has lagged/stalled and you need the *current* `main` live, trigger a manual production deploy from a clean checkout (don't deploy a parallel-session working dir — it's likely on another branch):

```bash
git worktree add /path/_wt-deploy origin/main            # clean checkout of latest main
cp -r <mainrepo>/.vercel /path/_wt-deploy/.vercel        # carry the project link (gitignored)
cd /path/_wt-deploy && vercel --prod --yes               # cloud build, auto-aliases phoenix-workforce.vercel.app
rm -rf /path/_wt-deploy/.vercel && git worktree remove /path/_wt-deploy --force
```

Vercel CLI auth is global (already logged in — `vercel ls` works). `.vercel/project.json`: projectId `prj_e1kBhJwJ3OVFkNC5w4muy7WVK6ft`, org `team_MF9h6hXmL5sA5i1m1iAs8ueb`. The CLI build runs `npm install` in the cloud, so the worktree needs no node_modules. Read-only checks that don't touch git/files: `vercel crons ls --scope phoenix-hr-workspace-s-projects`, `vercel ls phoenix-workforce --scope phoenix-hr-workspace-s-projects`.

Still verify the public domain after any deploy: `curl -s -o /dev/null -w "%{http_code}" https://phoenix-workforce.vercel.app/...`. See [[premium-design-language]] for the rollout this unblocked (PR #118 expenses + #114/#107/#109 etc., all live via deploy fpcy9jb7k).
