---
name: prod-mcp-token-owns-staging-supabase
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: RESOLVED 2026-09-12 by PR #3726 ... it now runs on SUPABASE_PROD_TOKEN pinned with ?project_ref=cifwmndunmlxjhyjugxa. Do NOT route staging through mcp__supabase-production__* any more (see `supabase-staging-named-server-broken-2026-08-10`, `supabase-staging-mcp-server-sees-zero-projects`). Older text follows: Prod Supabase MCP token owns BOTH prod and staging projects — drive staging DB via prod MCP with project_id=staging when the staging MCP token is wrong-account; hold code-coupled destructive migrations until merge"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4d2c7ad3-4ca0-47d6-8233-3a6e95d3b5bc
---

Learned during the 2026-07-17 outstation-redesign staging verification.

**Supabase MCP token routing:**
- The `supabase-staging` MCP token comes from `C:\Users\satoh\.claude\settings.json` `env.SUPABASE_STAGING_TOKEN` — a Claude **settings.json env block**, NOT a Windows env var, so `[Environment]::SetEnvironmentVariable(...)` can't change it (that was a dead end).
- That token was a WRONG-account PAT: `ph.oag3003@gmail.com`'s org `whgmpfdyqzyspjrmkbix`, which owns **zero** projects → every staging MCP call fails `-32600 "You do not have permission"`.
- The **prod** MCP token (`SUPABASE_PROD_TOKEN`) belongs to org **Gawish** (`rovnkzmhokgsruftjsaw`), which **owns BOTH** prod (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`) — Supabase PATs are **account-scoped, not project-scoped**. So drive staging DB with `mcp__supabase-production__*` + `project_id=cifwmndunmlxjhyjugxa` (get_project, execute_sql, and DDL all confirmed working this way).
- To actually fix the dedicated staging MCP: owner sets settings.json `SUPABASE_STAGING_TOKEN` = the prod token value (or a fresh Gawish PAT) and fully restarts Claude — I cannot write a token into a file (credential rule).

**Destructive-migration timing on staging:**
- Do NOT apply a code-coupled destructive migration (e.g. DROP COLUMN that main still writes) to staging while staging serves main — it silently breaks main-on-staging (bites on the next write). Staging auto-redeploys main constantly, so its steady state IS main. Verify the migration applies (both outstation drops were proven to apply cleanly), then ROLL BACK on staging and apply for real via the pipeline AFTER merge. Faithful rollback DDL comes from the committed baseline `supabase/migrations/*_phoenix_production_schema_baseline.sql` (table + identity + PK + indexes + FK + RLS + policies + grants + view arm all live there).
- To durably test the unmerged branch itself on staging, tag its Cloud Run revision with a CUSTOM (non-`sha-*`) tag for a stable URL that survives the churn — see [[staging-churn-pin-branch-with-cloud-run-tag]]. Traffic-pinning (`update-traffic --to-revisions`) does NOT survive; the next auto-deploy reverts it in seconds.

**Why:** burned ~an hour chasing the broken MCP token + fighting pin reverts + reconciling a migration that outran its code.
**How to apply:** [[agents-md-stale-staging-ref]], [[staging-cloud-run-url-2026-07-12]], [[outstation-expense-deep-audit-2026-07]].
