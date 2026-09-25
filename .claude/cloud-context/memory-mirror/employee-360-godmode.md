---
name: employee-360-godmode
description: "Employee 360 god-mode expansion, PR #1138 - 9 phases behind a NEW 360-only gate src/lib/employee-360/access.ts, which is why global canSeeEmployee was never widened. The two items this file records as GATED ARE BOTH DONE: PR #1138 merged 2026-07-18 and public.pm_product_assignments is live in production (6 rows, verified 2026-09-04). Read the correction banner, not the gated section."
metadata: 
  node_type: memory
  type: project
  originSessionId: f2052a5b-d2b4-46ea-9c8a-82be1c8eb6a0
---

> **CORRECTED 2026-09-04 - the "GATED, NOT DONE" section below is STALE. Both items shipped.**
> - **PR #1138 is MERGED** (2026-07-18T15:41:55Z), not "ready for review, NOT merged".
> - **The migration IS applied.** `public.pm_product_assignments` exists in production carrying 6
>   rows (queried via `pg_class` + `query_to_xml`, not the migration ledger). So PM assignment reads
>   no longer return empty and PM sales no longer fall back to an empty team roll-up.
>
> Everything else below is the dated 2026-07-18 record and is left untouched.

Employee 360 "god-mode" expansion — **PR #1138** (`codex/e360-godmode`, worktree `_wt-e360-godmode`), owner-approved plan, 9 phases all shipped; `check:harden` green; PR **ready for review, NOT merged**.

Phases: P1 access opened to all roles via a NEW 360-only gate `src/lib/employee-360/access.ts` (never widened global `canSeeEmployee`) — CEO/SFE Manager/Super Admin=company, TM=all reps+self, RM=hierarchy, NSM/PM/GPM=line, DM=team, rep=self. P2 index grouped by line (reps also by DM). P3 managers (DM/RM/NSM) don't check in / never "coached". P4 expenses month-over-month. P5 manager team-health = coaching coverage of their reps (`team-health.ts`). P6 PM/GPM product master + product-based sales. P7 TM effectiveness (`tm-analytics.ts`): coverage/neglect/concentration + 0-100 efficiency verdict. P8 tooltips on all new cards. P9 verify.

**GATED, NOT DONE (need owner approval):**
1. **Migration `supabase/migrations/20260718233000_pm_product_assignments.sql` is NOT applied** (staging first, then prod). Until applied, PM assignment reads return empty (table-missing-safe) and PM sales fall back to the empty team roll-up. Owner chose "build code, pause for approval."
2. **Merge + prod deploy** not done.

Master page `/admin/pm-products` (Super Admin edits; CEO/SFE read-only) writes `pm_product_assignments(hr_id → source_of_sales_products.product_code)`. Product sales via `getEmployeeSalesByProducts` (sales_records matched by product NAME resolved from code — known name-match fragility, tune after migration). Route registered in access-registry as `guard:"domain-helper"`. Verified builders vs prod (DM coaching coverage, TM A-7 22% coverage/verdict, product sales Saginko 3.04M). See [[b155-two-line-pm-scope]], [[sales-marketing-product-code-namespaces]], [[employee-360-module-design]].

**Follow-ups SHIPPED to prod after god-mode:** PR #1155 (PM sales map by product code→family + PostgREST ~1000-row pagination fix), #1160 (manager DV coverage + PM marketing-ROI), and **#1163 MERGED+prod LIVE 2026-07-18** (`sha-2f8aa8cb`, rev phoenix-hr-00115-puf @100% europe-west3; healthz/employee-360/home all 200). #1163 = (a) new `src/lib/employee-360/team-lifecycle.ts` "Team Compliance" section for DM/RM/NSM: weekly-plan compliance (`employee_plan_headers`, period-scoped) + field discipline + probation (hire_date+90, no query); (b) GPM multi-line viewer scope — `buildEmployee360Scope`/`resolveEmployee360VisibleRows` now async, resolve `resolveViewerAllowedLines` line_scope_override for NSM/PM/GPM so a Group PM spans all owned lines. Worktree `_wt-e360-more` (branch `codex/e360-more-teamhealth`) awaits CLEAN. Key data-source finding: see [[e360-attendance-source-field-not-device]].
