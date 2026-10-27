---
name: deploy-speed-levers-audit-2026-07-30
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Merge→live latency is dominated by the 2-hourly deploy cron, not compute — and both compute levers (E2_HIGHCPU_8, larger GitHub runners) are empirically unavailable on this project"
metadata: 
  node_type: memory
  type: project
  originSessionId: 754fd1a7-c721-44c9-a3f6-4ec9eeebba77
  modified: 2026-07-30T03:31:47.457Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Measured 2026-07-30 when the owner asked for the fastest possible deploys for 5 hours.
**Merge→live latency is a waiting problem, not a compute problem:**

| Term | Measured | Source |
| --- | --- | --- |
| CI | ~5–6 min | last 8 `ci.yml` runs, consistently 5–6 |
| **Wait for the deploy cron** | **0–120 min** | `cron: "0 */2 * * *"`; GitHub lag adds more (the "0 20" cron actually started 20:15:56Z) |
| Deploy job | ~7–12 min | Cloud Build ~4–5 min + no-traffic deploy + smoke + promote |

So the cron wait is ~10× everything else combined. Chasing minutes off the build is
near-worthless until that term is gone.

**Both compute levers are RULED OUT — verified, do not re-investigate:**
- **Cloud Build `E2_HIGHCPU_8`** (would save ~2 min/deploy): zero quota in **europe-west3
  too**, not just the pre-cutover `us-central1`. Probed directly with a `--no-source`
  build → `FAILED_PRECONDITION: due to quota restrictions, Cloud Build cannot run builds
  of this machine type in this region`. `cloudbuild.yaml`'s comment only claims
  `us-central1`, so it *looks* like the region cutover might have freed it up. It did not.
  Builds stay on the default `e2-standard-2` (240s warm / 330s cold with BuildKit cache).
- **Larger GitHub-hosted runners**: `gh api user` → `plan: pro` on a **personal** account
  (`it-gawish-hr/phoenix-people-workforce`). Larger runners need Team/Enterprise.

**Lever 1 that works:** a `workflow_run: [CI]` trigger on `main` collapses the wait term to
~0. Proven 2026-07-30: CI green at 02:09:12Z → deploy fired the same instant → live in 9 min.

**Lever 2 that works:** `prebuild-image.yml` builds the image on the same push that starts
CI, so the deploy's existing Artifact-Registry preflight skips its build. VERIFIED at job
level — deploy job **110s with prebuild (build step `skipped`) vs 687s / 628s without
(build step 594s / 515s)**. The build is entirely off the deploy path.

**MEASUREMENT TRAP that fooled me once — read before judging any deploy timing.** A deploy
RUN's wall duration includes time spent QUEUED in the `cloud-run-deploy-prod` concurrency
group behind another session's deploy. Run `fea4d31d` showed 518s and looked like no gain;
its deploy JOB was 110s and it had sat queued ~6.5 min behind `9fb61a39`. I reported "this
isn't buying anything" off the run-level number and had to retract it. **Always compare the
`deploy` JOB duration (`/actions/runs/<id>/jobs`), never the run duration.** Same trap
inflates prebuild timings: a prebuild racing another deploy's Cloud Build in the same GCP
project contends for e2-standard-2 capacity (489s contended vs ~240-330s expected).

**Why:** the instinct is to buy a faster machine; here that was both impossible AND ~10×
less valuable than deleting a queue.
**How to apply:** if asked to speed up deploys again, go straight to the cadence/trigger,
not the hardware. Two design points worth reusing: (1) on `workflow_run`, ship
`github.event.workflow_run.head_sha`, **not** `github.sha` — the latter is not the commit
CI validated; (2) make any temporary "hot" production config **self-expiring at run time**
(a `FAST_DEPLOY_UNTIL` timestamp checked inside the gate job) so a missed revert, a dead
session, or a sleeping laptop cannot leave production on a hot trigger. The cleanup PR then
only deletes dead config and is not load-bearing.
[[prod-deploy-scheduled-not-on-push]] [[one-prod-deploy-per-task]] [[gcp-cloud-run-migration-2026-07]]
