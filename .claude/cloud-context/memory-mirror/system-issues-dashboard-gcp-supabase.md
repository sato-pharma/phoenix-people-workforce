---
name: system-issues-dashboard-gcp-supabase
description: "/admin/system-issues dashboard (CEO + Super Admin): Supabase app_error_events with per-user attempt aggregation, deploy-aware auto-status, AI triage, repro trail, security lens, IP blocklist. BOTH PRs are merged — #999 and #1000 (MERGED 2026-07-12). WARNING: the live GCP Cloud Logging half is DEAD INFRASTRUCTURE — GCP billing is closed and every API returns BILLING_DISABLED, so treat that data source as gone, not as a feature to debug."
metadata: 
  node_type: memory
  type: project
  originSessionId: 63565252-68ee-432e-a29e-ae813b105264
  modified: 2026-09-05T06:35:54.142Z
---

Built 2026-07-11: `/admin/system-issues`, gated to Super Admin + CEO. PR
[#999](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/999) MERGED and
verified LIVE in production same day (branch `claude/admin-error-dashboard`, worktree
`_wt-error-dashboard`) — confirmed via a real deploy-watching mistake: the first
`gh run watch` I attached to was for the commit *before* the merge (a coincidentally
in-flight deploy), which made the new routes look like a broken 404 for a few minutes;
the actual merge-triggered deploy run was separate and succeeded. **Lesson: when
watching a post-merge deploy, verify the workflow run's `head_sha` matches the merge
commit before trusting its result — `gh run list` can return multiple recent
`workflow_run`-triggered runs and the most recently *started* one isn't necessarily the
one for your commit.**

**Tab 1 (Issues & Errors):** merges existing `app_error_events` (Supabase) with live
GCP Cloud Logging reads (`src/lib/observability/gcp-logs.ts`, new
`@google-cloud/logging` dependency, ADC-based) for the `phoenix-hr` Cloud Run service.
Degrades to a "not connected" banner if GCP is unreachable — never a silent empty list.

**Tab 2 (Per-User Attempts):** aggregates `app_error_events` + failed
`auth_login_attempts` by HR ID + module/route, computed in **application code**
(`getUserAttemptSummary` in `src/lib/error-monitor/service.ts`), not a DB
view/migration — kept the change migration-free.

**Why not gated on the "admin" permission resource:** `admin` is hard-locked to
Super Admin only (`hardBoundaryAllowedActions` in `src/lib/auth/permissions.ts`,
case `"admin"` → `role === "Super Admin" ? allActions : []`) — even
`role_permission_overrides` can't widen it (`isRolePermissionWithinHardBoundary` is
the ceiling checked when saving overrides). To include CEO, gated instead by direct
role check (`access.role === "CEO" || canAccessSystemAdministratorWorkspace(access)`),
matching the existing `/admin/ceo-command-center` pattern. **How to apply:** any future
CEO+Super-Admin-only page must use this same direct-role pattern, not the `admin`
resource — trying to widen the `admin` resource itself would be a much bigger, riskier
change touching every other `admin`-gated feature.

**Infra change already applied (with approval):** granted `roles/logging.viewer` to
the Cloud Run runtime service account (`897559113412-compute@developer.gserviceaccount.com`,
project `phoenix-workforce-498619`) — it previously only had `logging.logWriter`, so
Cloud Logging reads would have 403'd without this.

**Production env vars — ALL SET as of 2026-07-12 (verified live):** `OPENAI_API_KEY`
(valid sk- key), `GCP_PROJECT_ID=phoenix-workforce-498619`, `GCP_CLOUD_RUN_SERVICE=phoenix-hr`
are all present + correct on the running `phoenix-hr` Cloud Run revision
(region **us-central1**, URL phoenix-hr-6k25rcfldq-uc.a.run.app, project number 897559113412).
Confirmed via `gcloud run services describe phoenix-hr --region us-central1`. So the earlier
"still outstanding env vars" is DONE — no action needed. (GCP deploys are manual per
[[gcp-cloud-run-migration-2026-07]]; env persists across revisions as long as a deploy
doesn't pass `--set-env-vars`, which clears unlisted vars — use `--update-env-vars` or omit.)

**Gotcha hit:** the `access-registry-coverage` test (`tests/access-registry-coverage.test.ts`)
statically scans every `app/api/**/route.ts` for a literal call matching one of a fixed
set of permission-guard patterns (`assertPermission(`, `canAccess(`,
`assertSystemAdministratorWorkspaceAccess(`, etc.) — a boolean helper like
`canAccessSystemAdministratorWorkspace(access)` (no trailing exact match) doesn't
satisfy it even though it's a real check. Fix: register the route in
`src/lib/security/access-registry.ts` with `guard: "domain-helper"`, which bypasses
the static-pattern requirement (used elsewhere for the same "custom role check, not
the permission matrix" situations, e.g. the iReports360 visits-report routes).

**Browser-pane gotcha reconfirmed:** `preview_start`/Browser pane routed to a
*different* session's dev server on port 3000 (not the worktree's own server) —
see [[preview-start-ignores-worktree-cwd]]. Worked around by launching
`next dev --webpack -p <port>` directly via Bash in the worktree and verifying with
curl + real dev-auth cookies (role-based 200/403 + `NEXT_REDIRECT` marker checks)
instead of the Browser pane.

**Follow-up same day, PR [#1000](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1000)
OPEN (branch `claude/system-issues-resolve`):** added an actual "mark as fixed"
resolve/reopen workflow (the dashboard was previously just a raw event log — user
asked "whenever I fix any [issue] is it updated in the dashboard as fixed?" and the
honest answer at the time was no). New `resolved_issues` table (see
`supabase/migrations/20260711180000_resolved_issues.sql`), append-only, current state
derived as `MAX(resolved_at)` per group key so a fresh occurrence after a resolve
auto-reopens.

> 🔴 **THE `resolved_issues` TABLE DOES NOT EXIST ON PRODUCTION — measured 2026-09-05.** A
> `pg_class` sweep for `%resolved_issue%` on `ozucdzovmcqvepbozvqf` returns **nothing**, and the
> migration file is in neither `supabase/migrations/` nor `_migrations_archive/`. The paragraph
> below describes a design that **was never applied to production**, however live it was on staging
> at the time — and staging is not production ([[staging-is-now-mock-data-not-a-production-mirror]]).
>
> **What shipped instead is DERIVED status, and that is not a gap to fill.** The dashboard is
> thoroughly live — 12 files, `/admin/system-issues` plus five API routes — and
> `src/lib/error-monitor/` reads exactly four tables: `app_error_events` (9 call sites),
> `auth_login_attempts`, `app_auth_users`, `activity_events`. **No resolutions table is read
> anywhere.** Resolution state is computed in `derived-status.ts`, which is what §2.1 means by the
> dashboard's "deploy-aware auto-status". `src/lib/error-monitor/resolutions.ts`, named elsewhere in
> the store, is likewise gone.
>
> **Read this before "restoring" anything.** The obvious repair on finding a documented table
> missing is to re-apply its migration — which would add a write path the live code neither reads
> nor maintains, beside a derived one that works. **Verify against `pg_class` and the code's own
> `from(...)` calls, never against this paragraph.** Tab 1 resolve is global-scope `(category, module_key, route)`; Tab 2 is
user-scope `(hr_id, category, module_key, route)` and also honors a matching global
resolve. Migration applied to and verified live on staging — **but the staging project
ref had also gone stale same-day**, see
[[agents-md-stale-staging-ref]] for the full story (AGENTS.md's
documented ref was paused; had to deep-dive to find the real new one, and had to use
the `supabase-production`-named MCP connector, pointed at the staging project_id, since
the `supabase-staging` connector's org didn't include the new project). Caught and fixed
a real HR-ID-casing Map-key-mismatch bug during that staging verification — see
[[hr-id-normalization-fix-2026-07]] (third recurrence of that exact bug class). Not yet
merged/deployed to production as of PR open.

**PR #1000 evolved WELL past resolve/reopen (2026-07-11→12, still one PR, still branch
`claude/system-issues-resolve`, worktree `_wt-error-dashboard`):** the manual
resolve/reopen was **RIPPED OUT** at the owner's insistence ("NO manual resolve button —
misleading") and replaced with **deploy-aware auto-status** (`derived-status.ts`: Active
= error occurred on the current release `COMMIT_SHA||K_REVISION`; Resolved = not on
current release; zero human action). The `resolved_issues` table/migration was deleted.
Then, feature by feature (each committed+pushed after explicit approval): live polling +
sonner toast; minified-React-error decode (`message-decode.ts`); AI triage & cluster
summary (`ai-triage.ts`+`ai-redact.ts`, OpenAI, redact-before-send, needs
`OPENAI_API_KEY`); repro trail from `activity_events`; login **security lens**
(`getLoginSecuritySignals`: brute-force IPs, hammered/locked accounts, new-location);
hr_id→name resolution + notify-user action; deploy timeline + regression callout; and an
**in-app IP blocklist** (`src/lib/auth/ip-blocklist.ts`, table `blocked_ips`, enforced in
`app/api/auth/login/route.ts` **fail-open** after the rate-limit check, Super-Admin-only
block/unblock route, surfaced in the security lens). Finally a **weekly system-health
digest** (`src/lib/notifications/weekly-system-health-digest.ts`) piggybacking the daily
cron (`/api/notifications/daily`) — self-gates to Cairo Sunday, reuses
`createSystemNotification` in_app+telegram, audience **Super Admin ONLY** (owner
narrowed it from CEO+SA), `getWeeklyHealthSummary` keys on the same module_key|route
signature as the dashboard so counts match.

**CI-red fix (2026-07-12):** `validate` failed on a **duplicate migration timestamp** —
main had landed `20260712000000_sales_import_batches…` after this branch also picked
`20260712000000` for blocked_ips; the collision only shows in CI's *merged* tree, so the
local pre-push `check:migrations` (branch-only, 7 migs) passed while CI (9 migs) failed.
Fix: renamed to **`20260712020000_blocked_ips.sql`** (SQL unchanged + idempotent). Lesson:
before picking a new migration timestamp, check `git ls-tree origin/main supabase/migrations`,
not just the local branch.

**PROD MIGRATION APPLIED 2026-07-12 (with approval):** `blocked_ips` applied to
**production `ozucdzovmcqvepbozvqf`** via `mcp__supabase-production__apply_migration` →
verified: table + RLS-enabled + 0 policies + 3 indexes + correct columns, 0 rows. PR
#1000 CI fully GREEN (validate/lint-typecheck/preview-smoke pass; full-e2e skipped).
**MERGED + DEPLOYED LIVE 2026-07-12** (squash-merge a6dde345). All 3 prod env vars were
already set+correct and blocked_ips was applied to prod beforehand.

**Deploy is CI-GATED AUTO, not manual** (supersedes the old "manual deploys" note):
`.github/workflows/deploy-cloud-run.yml` triggers on `workflow_run` of the **CI** workflow
completing successfully on `main` → deploys a no-traffic SHA-tagged revision → smoke-tests
→ promotes to 100%. So merge → CI green on main → auto-deploy. Env `PROJECT_ID=phoenix-workforce-498619`,
`REGION=us-central1`, `SERVICE_NAME=phoenix-hr`. Live revision after this ship: **phoenix-hr-00098-yux**
at 100%; https://phoenix-hr.satopharma.com/ → 200, /admin/system-issues → 200 (not 404).

**INCIDENT during ship — cross-session migration-timestamp collision (2nd time same day):**
right after #1000 merged, a parallel session's M-series burst (#1013–#1020) merged a
migration `20260712020000_weekly_sales_batches_cycle_week_unique.sql` at the EXACT timestamp
I'd renamed blocked_ips to (`20260712020000`) to dodge the *first* collision. Both on main →
main's `check:migrations` red → **CI-gated deploy blocked for everyone** (deploy only fires
on CI success; every commit after failed the same check; prod stuck on old revision ea214a6f).
Fix: PR [#1021](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1021) renamed
blocked_ips to **`20260712030000`** (idempotent SQL unchanged, already-applied → no-op),
merged → main CI green → auto-deploy fired → live. **Lesson: with a parallel session churning
main, a new migration timestamp can collide even after you dedupe it locally; the CI-gated
deploy means ONE red migration-check on main blocks ALL prod deploys until fixed. When
racing another session, leave extra gap in migration timestamps and re-verify against
origin/main right before push AND expect to re-check after merge.** COMMIT_SHA is NOT set in
prod env, so deploy-aware status relies on the K_REVISION fallback (auto-injected) — works,
but if a build ever sets COMMIT_SHA the status keys change.

## 2026-09-04 — #1000 merged, and half of this is now built on dead infrastructure

Two corrections.

**1. `gh pr view 1000` — MERGED 2026-07-12**, *feat(admin): live System Issues dashboard with
automatic deploy-awareness*. The description's "PR #1000 OPEN+GREEN" is closed.

**2. The GCP Cloud Logging source is dead.** `AGENTS.md` §3 is explicit that GCP is dead, not
standby: billing is closed and every API in project `phoenix-workforce-498619` returns
`BILLING_DISABLED`. So the half of this dashboard that reads live Cloud Logging cannot be
returning anything, and the `COMMIT_SHA` / `K_REVISION` note at the end of the body describes a
Cloud Run environment that no longer serves this app — production is Railway.

**Do not debug that as a fault.** If the dashboard's GCP panel is empty, it is empty because the
platform is gone. The Supabase `app_error_events` half is the part that still works — and note the
standing rule that it returning 0 rows means quiet, not broken, and that the Error Monitor hides
rows whose `environment` is NULL.
