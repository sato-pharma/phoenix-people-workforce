---
name: vercel-workspaces-and-smi-flag
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — TWO Vercel workspaces exist; live prod is under phoenix-hr-workspace-s-projects (AGENTS.md scope is stale). Stale old deployment deleted 2026-07-04. SMI fast-table flag already live; CEO center bypasses it."
metadata: 
  node_type: memory
  type: reference
  originSessionId: be16768f-c208-447f-be4f-1cf91b93e99a
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Discovered 2026-07-04 while writing steps to retire the stale deployment.

**Two Vercel workspaces:**
- **`phoenix-hr-workspace-s-projects`** — hosts the LIVE production project `phoenix-workforce` (→ https://phoenix-workforce.vercel.app) + a stray `_wt-ceo` project. CLI account `gawishomarr-7047` has access to ONLY this team. **AGENTS.md says the scope is `phoenix-workspace-s-projects` — that is STALE/wrong; use `phoenix-hr-workspace-s-projects` for `vercel --scope`.**
- **`phoenix-workspace-s-projects`** (no "hr") — a SEPARATE workspace under a DIFFERENT account that hosted the stale `phoenix-workforce-old` copy. Not visible to the CLI login above.

**Stale deployment `phoenix-workforce-old` — DELETED 2026-07-04 (by owner, from the old account).** It was pointed at prod Supabase with its own copy of prod keys. Auth logs proved it was the sole source of ALL logged auth errors: 100/100 recent auth-service entries + all 38 errors (12×400 invalid_credentials, 13×404 user_not_found, 13×500 "DB error checking email") carried its referer. The real app uses app-managed auth (HR_ID+bcrypt), NOT GoTrue, so the Supabase `auth` service log is normally near-empty — deletion should make it go silent. Consequence: audit items #15/#16 (add pre-check/existence-guard on /admin/users) are MOOTED — those GoTrue admin errors were entirely the old deployment.

**SMI fast-table flag (`NEXT_PUBLIC_SMI_USE_FACT_TABLES`):** already set on prod (Production env) and the fast path is LIVE — `phx_marketing_roi_fast` runs ~0.8s vs the old `phx_marketing_roi_customer_dashboard` ~12.8s (16x). It's `NEXT_PUBLIC_`-prefixed so it's baked in at build → needs a redeploy to change (the in-code comment at service.ts:798 saying "no redeploy" is WRONG). The two SMI dashboard pages + mm-intel-sections use the flag-aware `getSalesMarketingDashboard()` (fast). The CEO center (`getCeoLandingDeferred`, command-center.ts) called `getSalesMarketingDashboardSnapshot()` DIRECTLY (always-slow 12.8s path), bypassing the flag — which is why the slow RPC kept growing (402 calls). **FIXED: PR #805 (merged 2026-07-04, squash d08bb275) swapped it to the flag-aware `getSalesMarketingDashboard()`** → CEO landing now uses the ~0.8s fast path. NB: on main the `getCeoAdminSignals` double-compute was already handled separately via a `prefetchedAdminSignals` arg. Local pre-push hook blocked on a stale-node_modules missing dep (html-to-image) → pushed with owner-approved `--no-verify`; CI ran the full gate green. Related: [[page-performance-audit-2026-07-04]], [[supabase-deep-audit-2026-07-04]], [[nextjs-node-env-inlined-at-build]].
