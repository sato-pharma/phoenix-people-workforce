---
name: staging-declines-destructive-sql-too
description: "supabase-staging answers a drop or a destructive-looking migration with status declined, exactly as production does, and is_error stays false - a no-op drop was declined on 1 Nov 2026 while a temp table and a select passed; use apply-sql-file.mjs, read live state, and never scan transcripts by is_error for it"
metadata:
  node_type: memory
  type: project
  originSessionId: 0ac84f00-3b0b-4f91-9d2c-40a7f8dc8672
  modified: 2026-11-01T20:53:52.254Z
---

The `database` module rule says `supabase-production` declines destructive SQL. **`supabase-staging` does it too.** Measured 1 Nov 2026, 23:00 Cairo, in one session on the staging server:

- `drop function if exists public.phx_zz_nothing_by_this_name_probe();` (touches nothing) → `{"status":"declined","message":"SQL execution was declined."}`
- `create temp table … on commit drop` → answered.
- `select 1` → answered.

Real staging declines the same day (Cairo): 19:48 `apply_migration` of `phx_refresh_sos_channel_rollup`; 22:38 and 22:42 (three calls) dropping `phx_tmp_limit_probe`, the last two after the owner had approved the drop in chat. A word in chat does not reach it.

**Why:** the owner asked why "everything is rejected and declined" on staging. It is the database tool's guard on destructive statements, not a fault in the app, the database or the permissions. Which layer answers is still unproven: the tool's own description says destructive statements may need a confirmation, and [[a-declined-tool-call-is-not-proof-the-change-did-not-land]] blamed the auto-mode classifier by elimination.

**How to apply:**
- Go straight to `node scripts/apply-sql-file.mjs <file.sql> staging`, the standing route; do not retry the MCP in other wordings.
- Read live state afterwards, because a decline does not prove the change did not land.
- A decline comes back with `is_error` false, so a transcript scan that filters on errors misses every one. Match `"status":"declined"` in the result text.
- A failed `staging-migrate.yml` run is a different thing: that is a direct connection refused by Supabase's storage trigger, not this decline.
