---
name: cloud-run-runtime-sa-least-privilege
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — phoenix-hr + phoenix-hr-staging Cloud Run now run as a dedicated least-privilege SA (phoenix-hr-run), split from the compute SA which stays the CI deployer/builder."
metadata: 
  node_type: memory
  type: project
  originSessionId: 68d7ba56-d3bb-4d18-8f81-e77a6b01dbf8
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**2026-07-16 IAM hardening (Fix 1 Phase A).** Both Cloud Run services (`phoenix-hr` prod + `phoenix-hr-staging`) previously ran as the **default compute SA** `897559113412-compute@developer.gserviceaccount.com`, which holds `run.admin` + `storage.admin` + `artifactregistry.writer` + `cloudbuild.builds.builder` — huge blast radius for an internet-facing app.

Created a dedicated runtime SA **`phoenix-hr-run@phoenix-workforce-498619.iam.gserviceaccount.com`** with an **exact-minimal** role set derived from the code (the only `@google-cloud/*` dep is `@google-cloud/logging`; Drive/Maps/Calendar use their own env-var keys/API keys, NOT the runtime identity):
- `roles/logging.logWriter` (write app logs)
- `roles/logging.viewer` (System Issues dashboard reads log entries via `src/lib/observability/gcp-logs.ts`)

The compute SA remains the **CI deployer/builder** (confirmed via audit logs — it's the `WIF_SERVICE_ACCOUNT`), and was granted `roles/iam.serviceAccountUser` on `phoenix-hr-run` so deploys can run revisions as it. `gcloud run deploy --source` preserves the service account across deploys, so the change is durable without a workflow edit (optional belt-and-suspenders: add `--service-account=phoenix-hr-run@…` to both deploy YAMLs).

**If the app ever needs a new GCP permission at runtime, grant it to `phoenix-hr-run`, NOT the compute SA.**

Rollback (either service): `gcloud run services update <svc> --region=us-central1 --project=phoenix-workforce-498619 --service-account=897559113412-compute@developer.gserviceaccount.com`.

**Fix 2 (governance) — backup owner DONE 2026-07-16:** project now has TWO owners, `phoenixx.oag@gmail.com` (original, = gcloud active acct) + `achieverrr303@gmail.com` (break-glass, = user's primary). Both personal Gmail (Workspace/company-domain owner still a nice-to-have). 2FA can't be verified via gcloud/API (account-level setting) — user self-confirms on both accounts.

**Fix 1 Phase B — DONE 2026-07-16:** compute SA project-wide `roles/storage.admin` REPLACED with bucket-scoped `roles/storage.admin` on `gs://run-sources-phoenix-workforce-498619-us-central1` (the only bucket; sole use is `run deploy --source` staging — images→Artifact Registry, logs→Cloud Logging). Compute SA project roles now: `artifactregistry.writer`, `cloudbuild.builds.builder`, `logging.logWriter`, `logging.viewer`, `run.admin` (kept — deployer needs run.admin). Validated by a real staging `workflow_dispatch` deploy (full source build+deploy as compute SA succeeded; staging 200; runtime SA preserved as phoenix-hr-run). Rollback if a future build ever fails reaching other storage: `gcloud projects add-iam-policy-binding phoenix-workforce-498619 --member=serviceAccount:897559113412-compute@developer.gserviceaccount.com --role=roles/storage.admin`.

Only remaining IAM item: Fix 2 governance long-term (move an owner to a company-domain Workspace account; both current owners are personal Gmail). See [[cloud-run-stale-tag-cpu-quota-exhaustion]], [[gcp-cloud-run-migration-2026-07]].
