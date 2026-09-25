---
name: visits-report-module-audit
description: "/admin/visits-report deep audit from 2026-07-04 — SUPERSEDED, most findings below fixed by PR #796 same day. See [[crm-integrity-module]] for the current dependent picture."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

`/admin/visits-report` = Super-Admin-only full mirror of every iReports360 CRM visit. Audited 2026-07-04.

**Files:** page `app/(admin)/admin/visits-report/page.tsx` (SA-gated redirect); UI `src/components/visits-report/visits-report-workspace.tsx`; service `src/lib/visits-report/service.ts`; cron `app/api/cron/ireports360-visits-sync/route.ts` (0 9,12,19 UTC, cron-secret); backfill `app/api/admin/visits-report/backfill/route.ts` (SA+CSRF, max 45d/req); migration `supabase/migrations/20260703150000_ireports360_visits_report.sql`. Pulls via the shared FWC client `ireports360-client.ts` (`iReports360GetVisits`, single-shot, no pagination).

**Tables:** `ireports360_visits` (upsert onConflict crm_visit_id) + `ireports360_visits_sync_runs` (audit log). RLS = service_role only (verified live prod, anon/auth denied). Correctly wired in access-registry (cron-secret + backfill).

**Live prod (ozucdzovmcqvepbozvqf) @ 2026-07-04:** 93,698 visits (Jan 1–Jul 3 2026), all crm_visit_ids unique, cron current. 8.1% unmapped agent_hr_id = mostly CRM territory placeholders (45 agents/6,843 visits have no person name); only 35 named/755 visits, 1 rescuable by name.

**STATUS AS OF 2026-07-04 (later same day) — SUPERSEDED, do not trust the two sections below without re-checking:**
- Double Visit Analytics was rebuilt (PR #788) to read `ireports360_visits` LIVE as its sole source of truth — "Dependents = NONE" below is now WRONG. [[crm-integrity-module]] (PR #809) also now depends on it, plus the sibling `ireports360_checkins`/`ireports360_crm_identity_resolutions` tables (an "Unmapped Agents" CRM-identity tab and GPS check-in correlation shipped between this audit and the rebuild).
- PR #796 ("visits-report accuracy fixes") fixed items 4, 5, 6, 7 from the "confirmed issues" list below the same day: added delete-reconciliation with a 50% sanity cap, widened the cron lookback 10→21 days plus a new weekly 120-day wide-reconciliation cron, added dedup + null-guard on `visitDate`, and surfaced `attendance`/`crm_save_date`. Items 1/2/3/8 (agent filter, export range, 45-day backfill timeout, `schemaMissing` regex) were NOT part of that fix — re-verify their status against current `main` before assuming either way.

**Original audit findings (2026-07-04, before same-day fixes above):**

**Dependents = NONE.** Nothing reads `ireports360_visits` except its own service/UI. FWC + rep-day drilldown pull iReports360 live independently; double-visit-analytics uses its own `double_visit_rows`. Standalone evidence sink, pushes to nothing. Two overlapping CRM mirrors (this vs double_visit_rows) — intentional, documented.

**Confirmed issues (as of this audit; see STATUS above for what's since fixed):** (1) Agent filter BROKEN — dropdown emits agent_name but service does `.eq(agent_hr_id, name.toUpperCase())` → always 0 rows; filter state also not rehydrated from URL so pagination drops it. (2) Export is page-only (≤500) but sold as full range. (3) 45-day backfill exceeds 120s Vercel limit (prod evidence 141s/435s ran locally). (4) Rolling 10-day window keyed on visit_date misses backdated/late-edited old visits. (5) Upsert-only, no delete-reconcile → CRM-deleted visits linger/over-count. (6) attendance column dropped on read; crm_save_date never shown/exported. (7) no dedup before upsert (latent 21000 crash); no null guard on visit.visitDate; crm_id keyed raw (no trim vs FWC). (8) schemaMissing regex too broad masks real errors as "not provisioned". See [[ireports360-crm-integration]], [[double-visit-gpm-line-id-scope]].
