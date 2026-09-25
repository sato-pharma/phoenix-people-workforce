---
name: error-monitor-hides-null-environment-rows
description: "The Error Monitor / System Issues read filter silently hides app_error_events rows whose environment is NULL, not just 'development'"
metadata: 
  node_type: memory
  type: project
  originSessionId: d60d8a91-f36e-45bd-a9a4-e70d9623fb01
  modified: 2026-08-13T01:03:33.612Z
---

`app_error_events` is the one table holding errors employees actually hit (columns: `hr_id`,
`role`, `module_key`/`module_label`, `route`, `source` = client|server, `message`, `digest`,
`environment`, `release`). Every read path applies `.neq("environment", "development")` to strip
the 275 historical rows a local `next dev` server wrote into production before the write gate
landed on 2026-07-30.

**But `neq` in PostgREST/SQL also drops NULLs** — `NULL != 'development'` is NULL, not true. So
any row written without an `environment` stamp is invisible on `/admin/error-monitor` and
`/admin/system-issues`. Confirmed live 2026-08-13: 16 such rows on 2026-08-12, all
`source='server'` on `/api/admin/outstation/expenses`, `release` also NULL — 12 × `[object Object]`
(the error message was serialized wrong, so the real reason is lost) and 4 × Postgres 42501
`permission denied for table expense_claims`.

**Why:** the filter was written to solve the dev-noise problem and NULL was assumed impossible —
`service.ts` even documents "the column has no NULLs (verified on production)". That is no longer
true, so the dashboard under-reports.

**Status 2026-08-13:** a fix is open in PR #2080 (branch `codex/portal-error-fixes`, CI green, NOT
merged) — `logAppError` stamps `environment`/`release` itself so no caller can omit them, and all
seven read sites use a NULL-safe filter. Until that merges the dashboard still under-reports.

**How to apply:** when querying this table by hand, filter with
`environment is distinct from 'development'`, never `!= 'development'`, or NULL-stamped rows vanish.
Do not trust the Error Monitor screen as a complete count. Related:
[[list-migrations-reports-ledger-not-reality]] — same shape of trap, the UI is not the data.
