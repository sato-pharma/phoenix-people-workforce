---
name: cronjob-sync-from-a-stale-primary-runs-the-old-jobs-map
description: "arming a just-merged cron from a primary behind main runs the OLD JOBS map and prints \"No declaration named X\" — ff-merge the primary to current main first; and a classifier denial on the arming clears on the owner's fresh explicit instruction, same as a merge"
metadata:
  node_type: memory
  type: project
  originSessionId: 6f97a14b-4527-4412-8664-721074edd3d3
  modified: 2026-10-05T00:33:26.353Z
---

Arming a newly-merged cron with `railway run … node scripts/cronjob-sync.mjs --job <slug> --apply`
reads `scripts/cronjob-sync.mjs` **from the local working tree**, not from the deployed bundle. If
the primary checkout is behind `origin/main` (it often is — `git fetch` updates only the ref, not the
tree), the script runs the STALE JOBS map and fails with `No declaration named "<slug>". Known: …`
listing the old set — which looks like a typo in the slug but is a stale checkout. Fix: `git merge
--ff-only origin/main` in the primary first (safe when the tree has no tracked uncommitted changes —
only untracked files, which ff never touches), then re-run. Measured 2026-10-05 arming
`phoenix-crm-visit-rollup` (job `8580289`): first attempt on a 4-behind primary printed "No
declaration"; after ff-merge to the merge commit, it CREATED the job.

Two companion facts proven the same session:
- **A classifier denial on the arming is not a standing block** — the production-scheduler mutation
  was denied when taken semi-autonomously, then ALLOWED on the owner's fresh, explicit "arm the
  visit-rollup cron." Same shape as the merge rule (AGENTS.md §6): fresh word from him clears stale
  authorization. Do NOT route around it with a settings edit — that is [[the-next-step-box-must-not-manufacture-the-next-task]]-adjacent owner-territory, and editing the permission config is itself walled.
- **A declared JOB_SCHEDULES cron with no armed cron-job.org job does NOT alarm** — with nothing
  hitting the route, no `job_heartbeats` row is ever created, so the job sits in `awaitingBootstrap`
  (job-heartbeat-assess.ts line ~160), never stranded. Stranding only happens after a job is armed
  (row created) and then disarmed. So merging a cron's declaration before arming it is safe; there is
  no grace-window deadline on the arming.
