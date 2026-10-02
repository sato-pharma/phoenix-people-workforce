---
name: prod-mcp-token-owns-staging-supabase
description: "The prod Supabase token (SUPABASE_PROD_TOKEN, org Gawish) owns BOTH prod and staging projects. Since PR #3726 (2026-09-12) the staging MCP server runs on that token pinned to the staging ref — call mcp__supabase-staging__* with no project_id and never route staging through mcp__supabase-production__* any more; hold code-coupled destructive migrations off staging until merge"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 4d2c7ad3-4ca0-47d6-8233-3a6e95d3b5bc
  modified: 2026-10-02T16:38:46.547Z
---

Learned during the 2026-07-17 outstation-redesign staging verification.

**Supabase MCP token routing:**
- 🔴 **Current state — RESOLVED 2026-09-12 by PR #3726** ([[supabase-staging-named-server-broken-2026-08-10]]):
  `.mcp.json`'s `supabase-staging` server now runs on `${SUPABASE_PROD_TOKEN}` pinned with
  `?project_ref=cifwmndunmlxjhyjugxa`. Call `mcp__supabase-staging__*` directly with **no
  `project_id`** (passing one is an error), and **do NOT route staging through
  `mcp__supabase-production__*` any more**. `${VAR}` in `.mcp.json` is expanded at app start, so the
  pinned server appears only after a full quit-and-reopen of the desktop app. Second sighting of the
  old fault: [[supabase-staging-mcp-server-sees-zero-projects]].
  **Superseded 2026-10-02:** previously "drive staging DB with `mcp__supabase-production__*` + `project_id=cifwmndunmlxjhyjugxa` while the staging token is wrong-account; owner to swap `SUPABASE_STAGING_TOKEN` in settings.json" — PR #3726 (`supabase-staging-named-server-broken-2026-08-10`).
- History (2026-07-17): the `supabase-staging` MCP token then came from `C:\Users\satoh\.claude\settings.json` `env.SUPABASE_STAGING_TOKEN` — a Claude **settings.json env block**, NOT a Windows env var, so `[Environment]::SetEnvironmentVariable(...)` couldn't change it (that was a dead end).
- That token was a WRONG-account PAT: `ph.oag3003@gmail.com`'s org `whgmpfdyqzyspjrmkbix`, which owns **zero** projects → every staging MCP call failed `-32600 "You do not have permission"`. It is still valid in that other account and should be revoked there.
- The **prod** MCP token (`SUPABASE_PROD_TOKEN`) belongs to org **Gawish** (`rovnkzmhokgsruftjsaw`), which **owns BOTH** prod (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`) — Supabase PATs are **account-scoped, not project-scoped**. That is why the fix pins the staging server to the staging ref: on `supabase-production` the `project_id` argument is still the only thing separating the two (AGENTS.md §8).

**Destructive-migration timing on staging:**
- Do NOT apply a code-coupled destructive migration (e.g. DROP COLUMN that main still writes) to staging while staging serves main — it silently breaks main-on-staging (bites on the next write). Staging auto-redeploys main constantly, so its steady state IS main. Verify the migration applies (both outstation drops were proven to apply cleanly), then ROLL BACK on staging and apply for real via the pipeline AFTER merge. Faithful rollback DDL comes from the committed baseline `supabase/migrations/*_phoenix_production_schema_baseline.sql` (table + identity + PK + indexes + FK + RLS + policies + grants + view arm all live there).
- To durably test the unmerged branch itself on staging, tag its Cloud Run revision with a CUSTOM (non-`sha-*`) tag for a stable URL that survives the churn — see [[staging-churn-pin-branch-with-cloud-run-tag]]. Traffic-pinning (`update-traffic --to-revisions`) does NOT survive; the next auto-deploy reverts it in seconds.

**Why:** burned ~an hour chasing the broken MCP token + fighting pin reverts + reconciling a migration that outran its code.
**How to apply:** [[agents-md-stale-staging-ref]], [[staging-cloud-run-url-2026-07-12]], [[outstation-expense-deep-audit-2026-07]].
