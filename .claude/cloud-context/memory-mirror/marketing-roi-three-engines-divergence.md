---
name: marketing-roi-three-engines-divergence
description: "Marketing ROI has 3 independent attribution engines that disagree; CEO's confidential checkbox silently routes to the pre-direct-orders v1 RPC and LOWERS actual sales. Found in the 2026-07-27 deep audit."
metadata: 
  node_type: memory
  type: project
  originSessionId: ac63cfc1-6251-4c01-afbd-b51e164335b2
  modified: 2026-07-28T09:18:52.960Z
---

Deep audit 2026-07-27 (8 parallel agents, read-only). The four ROI report surfaces sit on
**three independent attribution engines**, and two were never updated when the Direct Orders
module shipped 2026-07-18.

| Engine | Defined in | Direct orders? | `awaiting_data`? | Powers |
| --- | --- | --- | --- | --- |
| `phx_marketing_request_roi_actuals_v2` | `20260719151000_..._direct_branch.sql` | YES | YES | ROI Tracking, Marketing ROI Report |
| `phx_marketing_request_roi_actuals` (v1) | baseline `20260711135352` only | **NO** | YES | ROI Tracking on one path |
| `marketing_roi_request_facts` (materialized) | `20260719152000` | YES | YES | Coverage Report (STALE) |
| `phx_marketing_roi_customer_dashboard` | baseline only | **NO** | **NO** | SMI / ROI Dashboard, `/employee-portals/roi` |

**~~CRITICAL BUG~~ — ALREADY FIXED on `origin/main`; I reported it in error.** The v1-vs-v2
dispatch bug (`excludeCodes.length > 0 ? v2 : v1`) was real on branch
`codex/inbound-intake-dashboard` @ `3fbaae9a`, which is where the audit ran. `origin/main`
@ `69132980` already always prefers v2 and falls back to v1 only when v2 *errors*, with a
long explanatory comment and a dedicated test (`tests/marketing-roi-actuals-toggle-parity.test.ts`,
which mocks both RPCs and asserts v1 is never called). Also latent regardless:
`track_direct_sales` is false for all 217 production requests, so v1 and v2 return identical
results today.

**LESSON (this is [[stale-checkout-verify-against-origin-main]] recurring):** the working
directory was ~40 commits behind `origin/main`. Every "verified directly in the code" claim was
verified against the stale branch. **Before reporting any code finding, diff the file against
`origin/main`, not just the working tree.** The other findings in this file were re-verified
against `origin/main` and DO still hold.

**CRITICAL BUG 2:** TS `resolveRoiResultStatus` (`roi-report-service.ts:671-681`) has 4 states
incl. `awaiting_data`; the SQL in `phx_marketing_roi_customer_dashboard` (baseline :5747-5751)
has only 3 and falls through to `behind`. So a mid-window campaign reads "Data pending" in ROI
Tracking and **"Behind"** in the ROI Dashboard; every `behind_requests` rollup over-counts, and
it flows into the CEO command center. The TS doc comment names this exact failure as the thing
to avoid. TS is right; SQL needs the branch (migration + approval).

**CRITICAL BUG 3:** both export workbooks fork their own `RESULT_LABELS`
(`marketing-roi-workbook.ts:34-39`, `marketing-coverage-workbook.ts:50-55`) instead of importing
`ROI_RESULT_STATUS_LABEL` from `roi-labels.ts` — the module that exists to prevent this. Excel
says "No data"/"Awaiting data"; screen says "No attributed sales"/"Data pending".

**Why nothing caught it — THREE tests are blind.** Migrations were squashed into a baseline
2026-07-11 and the originals moved to `supabase/_migrations_archive/pre-baseline-2026-07-11/`.
`marketing-roi-attribution-consistency.test.ts`, `report-rpc-guardrails.test.ts`, and
`marketing-bulk-import-atomicity.test.ts` all still read the ARCHIVE, not `supabase/migrations/`.
Their assertions are false against live SQL yet they pass green. **RULE: after a migration
squash, re-point every test that reads migration files, or it silently guards nothing.**

**RESOLVED 2026-07-28 (PR #1415, applied to staging AND production):** the two genuinely-blind
guards were rewritten. `report-rpc-guardrails` now REPLAYS every migration chronologically and
models Postgres semantics (last CREATE wins and clears, later ALTER restores) — run against the
repo it independently reproduced the exact same 5 offenders as a live `pg_proc.proconfig` query.
`marketing-bulk-import-atomicity` now resolves the latest definer across both dirs. **NOTE:
`marketing-roi-attribution-consistency` was NEVER blind — it already scanned both dirs; I reported
that in error from the stale branch.** Migration `20260728100000` restored 45s on all 5 RPCs that
had none: `phx_marketing_roi_latest_validated_period`, `phx_monthly_closing_matrix`,
`phx_monthly_closing_direct` (all three had lost it to a recreate), plus
`phx_marketing_coverage_export_sales_detail` and `phx_marketing_roi_fast` (never had one).

Related: `CREATE OR REPLACE` silently wipes `ALTER FUNCTION ... SET` — that's how
`phx_marketing_roi_latest_validated_period` lost its `statement_timeout` and the guardrail test
never noticed. 6 of 14 marketing RPCs have no timeout, incl. `phx_marketing_roi_fast`
(SECURITY DEFINER) and `phx_marketing_coverage_export_sales_detail` (joins the 410MB SoS table,
called live from the coverage export).

Full report artifact: https://claude.ai/code/artifact/2007994e-c64d-432c-8b77-23d49cd48393
Related: [[roi-tracking-filter-engine-rebuild]], [[marketing-duplicate-report-surfaces]],
[[mcp-apply-migration-version-drift]].
