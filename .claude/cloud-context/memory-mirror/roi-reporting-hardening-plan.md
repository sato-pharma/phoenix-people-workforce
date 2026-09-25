---
name: roi-reporting-hardening-plan
description: "ROI/reporting hardening plan (Phase 0-3) status + the open approval-gated PRs and the Phase-3 scope-gate finding"
metadata: 
  node_type: memory
  type: project
  originSessionId: 237cb115-80cb-491a-a5e7-eedefae026e9
---

The post-[[roi-tracking-filter-engine-rebuild]] hardening plan (Phase 0–3) is COMPLETE as of 2026-06-21. #393/#397/#399 were **MERGED to main 2026-06-21** (owner-approved); **only #394 remains open and approval-gated (destructive — do NOT apply without explicit OK)**:

- **#393** — MERGED. Phase 1 guardrails: 45s `statement_timeout` on the 4 live report RPCs (migration `20260622130000`, already applied+verified on prod) + `tests/report-rpc-guardrails.test.ts` (timeout-revert guard + brick-rule lock).
- **#397** — MERGED. Phase 2a Data Health "Pharmacy Map Coverage" card. RPC `phx_marketing_pharmacy_mapping_coverage()` (migration `20260622150000`, applied+verified on prod: 76% = 275/361 target pharmacies; 74 of 202 requests have an unmapped pharmacy). Best-effort call (never breaks the page).
- **#399** — MERGED. Phase 3 fix: iReports360 visit-day drill-down used the active-only directory → departed reps' historical day rendered blank; flipped to `includeInactive:true` to match its sibling matrix loader. Code-only, no DB — deploys to prod via the main Vercel build.
- **#394** — STILL OPEN. Drops 14 confirmed-dead `phx_exec_*_snapshot` / `phx_closing_*` RPCs (0 callers/views/grants/code-refs). **Destructive, NOT applied to prod** — needs explicit approval + a CEO-dashboard sanity check before prod-apply.

**Phase 2b (E2E smoke) was DE-SCOPED**: a `*.data-bearing.spec.ts` only runs on manual `full-e2e` dispatch (not PRs) and the default CI user can't reach the admin ROI page — so it wouldn't catch the 500 in CI. The 500 is already guarded by the live timeout + the #393 unit test.

**Phase 3 per-site finding (important):** the report-surface directory sweep produced only ONE safe flip (#399). The rest are correctly active-only and MUST NOT be flipped:
- **Vacation timeline/report/metrics** (`vacation/service.ts:3833,4363,4413`) feed `filterVacationEmployeesForAccess()` — a **visibility scope gate**; `includeInactive` there could widen who-sees-what (security regression).
- **HR birthday calendar** (`hr-calendar/service.ts:27`) is a current-employee surface by design.
- SMI dashboard / monthly closing / vacancy report no longer load the active-only directory (employee data comes via the RPC path); the ROI report's departed-requester region was already fixed in #385.
RULE for future sweeps: before flipping a `getEmployeeDirectoryRows()` caller to `includeInactive:true`, confirm it feeds a name/line/region LOOKUP, not a scope/visibility gate.
