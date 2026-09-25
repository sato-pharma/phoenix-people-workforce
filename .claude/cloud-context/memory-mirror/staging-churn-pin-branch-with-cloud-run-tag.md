---
name: staging-churn-pin-branch-with-cloud-run-tag
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging auto-deploys from main and wipes unmerged branch previews; pin the branch revision with a durable custom Cloud Run tag for a stable URL."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
  modified: 2026-07-31T19:23:53.331Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Staging (`phoenix-hr-staging`, project `phoenix-workforce-498619`, region `us-central1`)
**auto-deploys from `main` on every PR merge**, promoting main to 100% traffic on the
main service URL. So an unmerged branch preview on the main staging URL
(`phoenix-hr-staging-897559113412.us-central1.run.app`) gets **clobbered ~every main merge**
— the whole feature (e.g. the CRM tab + `/admin/crm` page) vanishes and the URL 404s. This
is the recurring "churn"; re-running the branch deploy only holds until the next main merge.

**Durable fix — pin the branch revision to a custom Cloud Run tag** (does NOT shift traffic;
just exposes an existing healthy revision at a stable named URL that main never touches):
The staging workflow already tags every revision `sha-<shortsha>`, but `sha-*` tags get
pruned by revision cleanup. A **custom tag survives indefinitely** (the old `drill-detail`
tag has persisted through months of churn). Command:

```
gcloud run services update-traffic phoenix-hr-staging \
  --region=us-central1 --project=phoenix-workforce-498619 \
  --update-tags crm=<revisionName>     # e.g. phoenix-hr-staging-00157-noc
```

Find the revision for a commit via `status.traffic` in
`gcloud run services describe phoenix-hr-staging ...` (each has a `sha-<shortsha>` tag) or
`gcloud run revisions list --service=phoenix-hr-staging ...`.

Stable CRM branch URL: **`https://crm---phoenix-hr-staging-6k25rcfldq-uc.a.run.app/admin/crm`**
(created 2026-07-17 for branch `codex/crm-single-source-module`, PR #1072, unmerged). Owner insisted
the branch also live on the **primary** staging URL, so the main service traffic is pinned to the
branch revision too (`--to-revisions <rev>=100`), and a background watcher (`scratchpad/keep-crm-pinned.sh`)
re-pins on churn — **re-point BOTH the crm tag and the 100% traffic + restart the watcher with the new
revision after every branch deploy.** Current live revision: `phoenix-hr-staging-00288-xos` (commit
`0ea29ddb` — Phase 3 single-door complete + merged main: everything from d32deed9 plus all
consumers routed through crm/reads, the crm-single-source guardrail test, and main's 75 commits
incl. employee-360 role tabs with its deep-service migrated onto the door).
IMPORTANT for branch deploys: staging is build-once (reuses the PROD image for the commit) — a
branch commit has no prod image, so `gh workflow run deploy-cloud-run-staging.yml --ref <branch>`
FAILS at "Resolve image" unless you pass `-f build_from_source=true` (scratchpad/deploy-triples.sh
now does). NOTE: when a session ENDS, the auto-guard watcher stops and the
main staging URL churns back to main within ~an hour — on resume, re-pin (see command above)
and restart `scratchpad/keep-crm-pinned.sh` before assuming the CRM tab is still on the main URL.

⚠️ The staleness below is only half the story: staging is not merely a stale clone, it is a
**schema skeleton with no RLS, no FKs and no triggers** since that same 2026-07-11 creation date —
see [[staging-is-a-schema-skeleton-not-a-clone]].

**Staging employees roster is a STALE clone (2026-07-11)** — it's missing anyone hired to prod
since. Consequence: staging's CRM Issues tab is INFLATED (flags agents that prod already maps),
and mapping a CRM agent to a newer HR ID fails "No employee found" because that HR ID isn't in
staging. Fix per-agent by inserting the row (only hr_id + full_name are NOT NULL) — e.g. added
`CN-0005 Amira Samy crm_id 1543` to staging 2026-07-17 so the Map button works. See
[[amira-samy-crm-identity-cn-0005]].

Deploys sometimes fail at the "Deploy new revision" step with Cloud **Build** rate-limit
`GetRequestsPerMinutePerProject` (60/min) when many deploys churn concurrently — transient,
NOT a code/quota-exhaustion problem; just retry (the clear-lanes wait helps). Distinct from
the [[cloud-run-stale-tag-cpu-quota-exhaustion]] CPU-quota issue.

**Two gotchas:**
- The tagged URL is a **different host** than the main staging URL, and `.run.app` is on the
  public-suffix list, so session cookies do NOT carry over — the user must **log in again** on
  the tagged host (same Super Admin credentials).
- The `crm` tag does NOT auto-follow new deploys. After each new branch deploy, **re-point it**:
  `--update-tags crm=<new-revision>`. Otherwise the URL keeps serving the old revision.

See [[staging-cloud-run-url-2026-07-12]].
