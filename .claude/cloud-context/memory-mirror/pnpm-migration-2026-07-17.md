---
name: pnpm-migration-2026-07-17
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — npm→pnpm 11 migration (PR #1108)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c5c85464-4f08-4e5d-ad74-009779055182
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Repo migrated npm→**pnpm 11.13.1** — **PR #1108 MERGED 2026-07-17 19:02 Cairo, deployed to production same evening** (merge 550e6b50 → image sha-550e6b50 → revision phoenix-hr-00014-som at 100%; prod deploy run 7m44s incl. the one-time cold pnpm build; public domain + staging verified 200). Production runs on pnpm now. Base was 44744f52. Full green: check:harden (391 test files), dev+dev-auth boot, local BuildKit deps stage, Cloud Build cold 449s / warm 132s with `[deps 5/5] RUN pnpm install --frozen-lockfile → CACHED` from registry `:deps-cache` (validate images under `cloud-run-source-deploy/phoenix-hr-pnpm-validate`, deletable; prod `phoenix-hr` cache tags untouched).

pnpm-11 specifics that WILL bite again:
- Settings home is **pnpm-workspace.yaml** (overrides + allowBuilds). A `pnpm` key in package.json and top-level npm `overrides` are BOTH ignored.
- **allowBuilds is mandatory**: undecided build scripts hard-fail install (`ERR_PNPM_IGNORED_BUILDS`). Approved true: supabase, sharp, protobufjs, unrs-resolver. Any newly added dep with a build script fails install until a decision is added there.
- Phantom deps exposed by strict layout (declared now): google-auth-library ^9.15.1 (prod, gcp-metrics.ts), jszip, playwright 1.61.1 (exact, lockstep with @playwright/test).
- phase30/phase33 gate scripts keep **`npx supabase`** deliberately — their tests assert `doesNotMatch(/exec|spawn|execFile/)` over the script text, so `pnpm exec` trips the safety net. Don't "fix" this.
- Machine-local pre-push hook (`phoenix-workforce/.git/hooks/pre-push`) still calls `npm run` — works fine (scripts only), untracked, update by hand if wanted.

Metrics (Windows, F: drive): npm ci 51s + 919MB/worktree vs pnpm warm 26s; **extra worktree 19s, reused 961/downloaded 0**, store 931MB shared via hardlinks (`F:\.pnpm-store`, fsutil shows one file = N worktree paths). Kills the "15 node_modules copies" failure mode.

Ops notes: `gcloud builds submit` with `logging: CLOUD_LOGGING_ONLY` streams nothing — pull BuildKit output via `gcloud logging read 'resource.type="build" AND resource.labels.build_id="…"'` (`gcloud builds log` returns a truncated head while indexing). First post-merge CI + first prod deploy build are cold-cache (one slow run each). `taskkill /F` on `next dev` can leave a corrupt `.next/dev/types/routes.d.ts` that breaks typecheck — `rm -rf .next/dev` fixes.

Related: [[parallel-work-model-2026-07]], [[gcp-speed-audit-2026-07-17]], [[worktree-audit-20260626]]
