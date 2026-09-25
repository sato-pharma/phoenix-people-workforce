---
name: claude-config-audit-2026-07-31
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Config audit + Sentry retirement — what was APPLIED 07-31, what is still owner-only, Healthchecks gate before merging PR #1514"
metadata:
  node_type: memory
  type: project
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-08-01T04:12:37.732Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Report artifact: https://claude.ai/code/artifact/0d0b01f4-e88c-4ec5-827c-d77ddac5ce1a · Plan: `~/.claude/plans/implement-a-phased-plan-goofy-stonebraker.md`

**APPLIED 2026-07-31 (the 4 P0s are fixed in code; nothing merged yet):**
- **PR #1506 `codex/config-hardening` — MERGED 2026-07-31 19:38Z (squash `58910af6`); gates are LIVE on main:** `.claude/settings.json` gains `permissions.ask` (prod `execute_sql`/`apply_migration`, staging `apply_migration`, `git push`, `gh pr merge`, + the 3 owner-locked files) and `deny` (`gh pr merge --auto`, `vercel deploy`, UUID Supabase connector `mcp__b345e47e-*`, `.env` reads). `settings.local.json` rebuilt 296 KB/1,644 allows → empty. CLAUDE.md unlock phrase DELETED (lock is now permissions-based; phrase still in git history). AGENTS.md: new Hard-Learned Rules + tier-routing Parallel Work Model (cloud default → 2–3 woken worktrees → 1 control tower) + squash-aware merge check. `.mcp.json`: github/v0/shadcn removed. session-lock STALE_MS 12h→2h. New `.claude/agents/role-sweeper.md` (haiku) + `.claude/skills/worktree-triage/SKILL.md`.
- **User-level (local, no commit):** sentry-skills + vercel plugins and the sentry-cli skill DELETED from disk; `enabledPlugins` github+sentry-skills+vercel = false; machine-wide risky allows removed; tracker hook slimmed; `enabledMcpjsonServers` = supabase-staging/production/cloud-run.
- **Worktrees 24 → 15** (12 removed + corrupted remnant `_wt-dm-area-scope` rescued+removed; all xlsx/pdf were identical to tracked copies). Root cause fixed in AGENTS.md.
- **GCP:** log-based metric `phoenix_app_error_log_severity` + alert policy **"Phoenix HR production ERROR log alert"** (log-match, severity>=ERROR on phoenix-hr, ≤1 email/30min → achieverrr303@gmail.com) — created and LIVE. Replaces Sentry's new-issue email.
- **🚀 LIVE IN PRODUCTION 2026-07-31 20:19Z** — revision `phoenix-hr-00739-sab`, 100% traffic, `COMMIT_SHA=sha-c79d9c31` (contains both merges). Verified: `/` + `/login` 200, **`/monitoring` now 404** (Sentry tunnel gone), 0 sentry refs in served HTML, no ERROR logs on the new revision, no ping failures, all 8 Healthchecks `up`, and `phoenix-inbound-intake` + `phoenix-process-notifications` pinged **from the Sentry-free build** — end-to-end proof the dead-man's-switch works without Sentry. Deployed via `gh workflow run deploy-cloud-run.yml --ref main` (owner-approved); `gate:success deploy:success`.
- **NEXT: 5e-i — disable the Sentry alert rule** (owner, Sentry dashboard). Then a 1–2 week soak before 5e-ii decommission.
- **PR #1514 `codex/retire-sentry` — MERGED 2026-07-31 19:51Z (squash `d1c50e43`).** Sentry is OUT of `main`: 0 `@sentry` deps, no `withSentryConfig`, no sentry config files tracked. Healthchecks all 8 `up` at merge time. Staging auto-deploys after CI; **production ships in its scheduled window — verify prod after that window, not immediately after merge.**

**✅ Healthchecks gate CLEARED 2026-07-31 19:48Z** — all 8 checks configured and `up`, email+Telegram wired, real cron pings confirmed. See [[healthchecks-live-8-checks-configured]]. **PR #1514 is now free to merge.** Original gate notes below for reference:

**🔴 Healthchecks gate (was blocking PR #1514):** owner creates project + 8 checks, sets `HEALTHCHECKS_PING_KEY` on **`phoenix-hr` production ONLY**. NEVER on staging — slugs are not env-namespaced and staging runs the same image, so a staging ping would reset/mask prod's checks (`isProductionRuntime()` is the only other gate; staging does carry `APP_ENV=staging`). Prod already has the key set (seen in env list) — confirm the value is real. Slugs/grace: phoenix-notify-daily(1h) · phoenix-process-notifications(10m) · phoenix-background-jobs(2h) · phoenix-inbound-intake(10m, **was missing from every doc**) · phoenix-ireports360-sync(30m) · phoenix-reconcile-visits(2h) · phoenix-ireports360-live-sync(15m) · phoenix-recruitment-email-intake(10m). Cron Expression mode + Africa/Cairo. Force-provision by firing all 8 routes with `Bearer $CRON_SECRET` — don't wait 7 days for the weekly jobs.

**✅ Owner-only items CLOSED 2026-07-31:** connectors removed (verified — the live `b345e47e` Supabase
connector disconnected mid-session) · **extra usage CAPPED** · `main` protected (PR required,
**enforce_admins true**, 0 approvals so the sole collaborator isn't locked out; required status
checks deliberately still OFF) · **no GitHub Pro purchase was needed — the account was already on
Pro**, contrary to the recommendation below · `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` added, and the
drift check's production leg **ran for the first time ever** and came back clean (127 local / 566
recorded on `ozucdzovmcqvepbozvqf`).

**✅ Sentry MCP connector REMOVED 2026-08-01** — it lived in `~/.claude.json` under
`projects["F:/Phoenix Workforce/phoenix-workforce"].mcpServers.sentry`
(`https://mcp.sentry.dev/mcp/phoenix-workforce/phx-b9`), NOT in `.mcp.json`, which is why the
07-31 sweep missed it and `mcp__sentry__*` tools kept loading in every session. Backup:
`~/.claude.json.bak-2026-08-01-sentry`. Leftovers are inert and were deliberately NOT touched:
`sentry-skills` is registered in `plugins/installed_plugins.json` pointing at an install path
that no longer exists (files were deleted 07-31) plus an 832 KB marketplace clone at
`plugins/marketplaces/sentry-skills`; `claudeAiMcpEverConnected` and `pluginUsage` keep
historical "sentry" strings. **Do NOT delete `"sentry-skills@sentry-skills": false` from
`enabledPlugins`** — that line is what keeps it disabled.

**Owner-only remaining:** rotate old unlock phrase — **deferred on purpose** to the staging rebuild,
which replaces `app_auth_users` wholesale ([[protected-files-phrase-was-a-live-credential]]) · after prod verify: disable Sentry alert rule (5e-i), then after a 1–2 week soak (5e-ii) delete SENTRY_AUTH_TOKEN GitHub+Secret Manager secrets/IAM, strip SENTRY_* env vars, rotate+delete `.sentryclirc`/`.env.sentry-build-plugin`/`cloud-run-env.yaml` (that file points at a DIFFERENT Sentry org `sato-pharma` than source did — check which really receives prod events), uninstall Sentry GitHub App (kills the "Seer Code Review" CI check), cancel subscription.

**Cost:** keep Max 20x ($200) + GitHub Pro ($4). Fable only for audits/architecture/incidents (~2× Opus, ~3.3× Sonnet, 10× Haiku); cloud sessions Sonnet; sweeps Haiku.

**Why:** owner asked for a deep audit + best monthly cost, then approved a phased fix-everything plan with full Sentry retirement.
Related: [[parallel-work-model-2026-07]] · [[gh-pr-merge-auto-merges-immediately]] · [[whatsapp-cv-intake-silent-since-2026-07-25]] · [[prod-deploy-scheduled-not-on-push]] · [[subagent-model-tiering-by-task-difficulty]]
