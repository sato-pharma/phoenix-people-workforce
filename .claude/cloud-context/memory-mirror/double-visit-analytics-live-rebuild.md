---
name: double-visit-analytics-live-rebuild
description: "Double Visit Analytics rebuilt to read LIVE off Visits Report (ireports360_visits); import/publish/Excel deleted. MERGED (PR #788) + verified in production, 2026-07-04."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

2026-07-04: owner ordered `/admin/double-visit-analytics` deleted and rebuilt from scratch to read **only** `ireports360_visits` (the [[visits-report-module-audit]] mirror) directly — no second CRM pull, no Excel upload, no import/publish snapshot, no new tables/views. Built in worktree `F:/Phoenix Workforce/_wt-dv-rebuild` on branch `codex/double-visit-analytics-live-rebuild`, off `origin/main` (NOT off `codex/agents-policy-v2` — that branch was stale for this module). **COMPLETE** — PR #788 merged 2026-07-04 (commit e5f180a6), deployed to production, verified clean (4 routes 200/clean-redirect, zero errors in logs). Both migrations applied to staging + prod (owner-approved separately per environment). The `*_backup_20260705` tables (prod verified exact-count: 10,100 rows / 1 import before drop) were kept until the first production cron cycle against the new code succeeded (12:00 UTC 2026-07-04, sync_runs row confirmed success/6,043 rows/zero errors), then dropped on both DBs per owner's "once stable" condition. `double_visit_rows`/`double_visit_imports` and their backups no longer exist anywhere — the live rebuild is the only version now, nothing to roll back to. Full lifecycle: audit → rebuild → PR → staging migration → prod migration → merge → prod verification → stability wait → backup cleanup, all in one session.

**Critical lesson:** initial audit + plan were built against a stale branch. `origin/main` already had a working "Unmapped Agents" CRM-identity mapping tab (`ireports360_crm_identity_resolutions` table + `resolve-identity` route + `resolveEmployeeHrId`: manual override → crm_id → crm_username) and a `/employee-portals/double-visit-report` page already serving DSM/RM/NSM/PM/GPM/TM. Always re-check `origin/main` before planning a rebuild — do not trust an audit done on a different branch.

**Design:** `double_crm_id<>0 AND visit_type IN (0 Regular, -8 Campaign)` = the DV definition (owner decision, ~99.7% of prod double rows). New `getLiveDoubleVisitRows(dateFrom,dateTo,employees)` in `src/lib/double-visit-analytics/service.ts` queries `ireports360_visits` directly and enriches into the same `DoubleVisitDbRow` shape the old engine used — so `buildKpis/buildMrScores/buildExecutiveReports/buildManagerSummariesDetailed/buildExecutiveSummary/buildManagerMrPairs/resolveDoubleVisitAccessScope` all ported **verbatim**. Deleted: `parser.ts`, all import/preview/publish/mirror-sync functions, both DB tables (gated migration, not applied).

**6 dependents repointed:** `employee-portal/home-snapshot.ts` + `probation/feedback-service.ts` (`tickDvCheckboxesFromSync`, now called from the visits-report cron route after each sync) needed table-query rewrites; `private-calendar`, `outstation` expense evidence, CEO command-center, MM-intel-sections needed **zero call-site changes** (same function signatures).

**Migrations (files only, NOT applied):** `20260705090000_outstation_drop_dv_import_fk.sql` (drops `outstation_expense_requests_workload_source_import_id_fkey`; confirmed 0 live rows reference it in prod), `20260705091000_drop_double_visit_tables.sql` (GATED — backs up to `*_backup_20260705` then drops `double_visit_rows`/`double_visit_imports`; prod has 10,100 rows / 1 published import as of 2026-07-04).

**Verified green:** typecheck, lint, all 302 test files (incl. `access registry coverage`), build — all in the worktree, none yet merged. Added a "Trends" tab (weekly DV trend + neglected-MR list with 90-day trend direction) replacing the deleted Imports tab.
