---
name: notification-recipients-and-migration-backlog-2026-07-19
description: "PR #1184 (admin-editable notification-recipient roles) shipped; applying its migration surfaced 6 OTHER merged-but-unapplied migrations on both staging+prod, including a live unauthenticated analytics data leak — all 7 applied+reconciled same day."
metadata: 
  node_type: memory
  type: project
  originSessionId: 38d7683c-a0c4-407a-875b-0a9dd5b70200
  modified: 2026-07-19T18:32:02.172Z
---

**PR #1184 shipped 2026-07-19**: Super-Admin-only "Notification Recipients" section on
`/admin/cron-control`, admin-editable `app_auth_users` role lists for the 12 cron-triggered
system notifications (new `notification_role_policies` table). Sits alongside PR #1183's cron
schedule editor — both "when" and "who" now live together on that one page, per owner's explicit
ask. See [[mcp-apply-migration-version-drift]] for the bookkeeping-reconciliation mechanics.

**Bigger finding, while applying that migration**: staging and production were IDENTICALLY behind
by 7 migrations already merged to `main` — not just mine. The other 6 were a same-day security
sweep: closing a LIVE unauthenticated company-wide sales-data leak (undocumented plural-array
overloads of `analytics_sos_by_*` / `analytics_weekly_fact` / `analytics_closing_by_employee`
carried the Postgres built-in PUBLIC EXECUTE grant, bypassable via raw `POST /rest/v1/rpc/...`
with the public anon key — full SoS/Weekly/Closing data, including confidential Head Office, for
anyone holding the anon key, no login needed), plus a `sos_fact` region-name display bug, a
period-lock TOCTOU race in SoS finalize, default-privilege hardening (new `public` functions no
longer auto-grant EXECUTE to anon/authenticated), and 2 leftover anon-executable trigger
functions.

**Why this matters going forward:** this repo's migrations are NOT auto-applied on merge to
`main` — CI passing and merging only lands the SQL file in the repo; someone must separately run
`apply_migration` (staging, then production, each needing its own explicit approval per
AGENTS.md). That means a security fix can sit merged-but-unpatched-in-the-actual-database
indefinitely if nobody happens to apply it. The leak above was merged same-day but the DB fix
lagged until this session's owner said "apply migrations" for an unrelated reason and I found the
backlog as a side effect.

**How to apply:** After any migration-touching PR merges, don't assume it's live — check
`supabase_migrations.schema_migrations` (or `list_migrations`) against the repo's
`supabase/migrations/` directory for gaps, on BOTH staging and production, especially if the merge
touched security/RLS/grants. Consider proactively suggesting a periodic "any pending migrations?"
sweep rather than waiting for an unrelated migration request to surface a backlog. Verified-closed
via `get_advisors(security)`: zero `anon_security_definer_function_executable` findings on either
DB after the sweep.
