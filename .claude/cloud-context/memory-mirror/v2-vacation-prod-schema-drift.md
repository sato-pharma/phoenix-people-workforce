---
name: v2-vacation-prod-schema-drift
description: "Prod v2_vacation_requests was missing weekly_off_policy_snapshot col + dup-active index even though migration 20260523220000 was RECORDED as applied — schema drift. Backfilled 2026-06-10. Blocked all vacation submissions (0 rows in prod)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 685a79be-68ed-421c-bf32-95f173d2c3e1
---

Production (ozucdzovmcqvepbozvqf) hit a PostgREST error on vacation submit:
`Could not find the 'weekly_off_policy_snapshot' column of 'v2_vacation_requests' in the schema cache`.

**Root cause = schema DRIFT, not the new feature.** Migration `20260523220000_vacation_integrity_hardening.sql`
was **recorded** in `supabase_migrations.schema_migrations` (version 20260523220000) but two of its objects never
actually landed on prod: the `weekly_off_policy_snapshot jsonb` column on `v2_vacation_requests` AND the partial
unique index `v2_vacation_requests_no_duplicate_active`. (The migration's third object — `updated_at` + trigger on
v2_vacation_weekly_off_policies — WAS present.) This is the [[supabase-dual-project-schema]] divergence: history
says applied, actual schema differs. It had been silently failing every vacation submission (prod had 0 requests).

**Fix (2026-06-10):** MCP apply_migration `vacation_requests_weekly_off_snapshot_backfill` — `add column if not
exists weekly_off_policy_snapshot jsonb` + `create unique index if not exists v2_vacation_requests_no_duplicate_active
... where status not in ('rejected','cancelled')` + `notify pgrst, 'reload schema'`. Additive, prod had 0 rows.

**Verified:** swept EVERY code-referenced column across all 10 v2_vacation_* tables + the phx_vacation_report_rows
RPC + approval-steps columns — ZERO other gaps. The drift was isolated to those two objects.

**Lesson:** prod v2_vacation_* schema can diverge from recorded migration history. When a "column not in schema
cache" error appears, it's drift — backfill the missing object with `if not exists` + `notify pgrst`. The repo's
20260523220000 already defines the column idempotently, so repo and prod are consistent now (the MCP backfill is a
prod-only corrective record; no new repo migration strictly needed). Relates to [[vacation-action-center-build]].
