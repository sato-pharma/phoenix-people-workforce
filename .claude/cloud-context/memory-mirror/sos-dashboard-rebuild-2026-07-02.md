---
name: sos-dashboard-rebuild-2026-07-02
description: "SoS dashboard rebuild + CEO/SA-only BI export + MoM layer, built 2026-07-02 in worktree sos-dashboard-rebuild. UNRESOLVED: the migration this claims is pending, 20260702160000, does not exist in supabase/migrations and NO migration is dated 2026-07-01..03 — so whether it shipped under another timestamp or was abandoned is unknown. Verify against production before acting on anything here."
metadata: 
  node_type: memory
  type: project
  originSessionId: 59925d58-ed9a-4512-ac10-802ff1dded87
  modified: 2026-08-22T22:25:56.263Z
---

Built 2026-07-02 in worktree `.claude/worktrees/sos-dashboard-rebuild` (branch `worktree-sos-dashboard-rebuild` off f1327c4c): full SoS dashboard rebuild — MoM layer (`src/lib/sales/sos-analytics.ts` + `momComparison`/`paretoProducts`/`detailRows` optional flags on `getSosDashboard`), CEO/SA-only BI export (`sos-bi-workbook.ts`, 15 sheets, `/api/sales/sos-dashboard/export`, gate = `canExportSosDashboard()` in access-scope.ts), Line multi-filter. All flag-gated → portal payload byte-identical.

**Why:** owner wants SoS to outclass the weekly module; two modules stay separate; zero calculation changes.

**FULLY SHIPPED 2026-07-02:** [PR #718](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/718) MERGED to main (commit 6319a1dc, 17:47 UTC). Migration `20260702170000_sos_brick_customer_head_office_pushdown` applied+verified on BOTH staging (izhmxvgiktiafqusolot) AND production (ozucdzovmcqvepbozvqf) — same 3-proof check each time: signatures single 2-arg overload, CEO/no-exclude byte-identical to pre-migration baseline, exclusion param arithmetically exact (prod: TE002 excluded → 10547987−4235964=6312023 exact). Gotcha hit during prod verify: picking LA003 as the "exclusion test product" gave a false "no change" result because LA003 is ALREADY hard-excluded by the earlier 20260702130000 migration — not a bug, just don't pick a restricted code (LA003/LA004/SS001) when testing the NEW p_exclude_codes param; always verify with a normal product. Still needed: post-deploy smoke test at **`https://phoenix-hr.satopharma.com/sales`** as Super Admin + confirm SFE brick/customer stripping live. *(Retargeted 2026-08-23 — this named `https://phoenix-workforce.vercel.app/sales`; Vercel is fully decommissioned and production has been Railway since 2026-08-01. The staging ref named above, `izhmxvgiktiafqusolot`, is also dead — staging is now `cifwmndunmlxjhyjugxa`.)* Round 2 (YoY + report-delivery + click-to-drill) planned per C:\Users\satoh\.claude\plans\okay-now-i-without-wobbly-muffin.md, not started — fresh branch off main now that #718 merged.

**How to apply:**
- Migration `20260702160000_sos_brick_customer_head_office_pushdown.sql` adds `p_exclude_codes` to `phx_exec_brick`/`phx_exec_customers` (closes the remaining Head-Office half of the SFE leak; the LA003/LA004/SS001 half was hard-coded by the swarm's `20260702130000` — for EVERYONE incl. CEO). DEPLOY MIGRATION BEFORE CODE. Grants: service_role + guarded analytics_readonly (both required).
- TS passes `p_exclude_codes` to those 2 RPCs **only when non-empty** → CEO/SA single-arg calls work pre-migration; SFE fails CLOSED (empty bricks/customers, PGRST202 swallowed by safeRpcAll) until migration lands. Verified live 2026-07-02.
- `tests/portal-sos-scope.test.ts:188` greps `const byArea = groupByArea(detail, totalValue)` — renaming the grouping helpers breaks it.
- check:harden green; local browser verify blocked (F: disk 100% full + other session's dev server owns port 3000 — repo `npm run dev` wrapper swallows `-p`, use `npx next dev --webpack -p <port>`); visual smoke deferred to Vercel preview.

Later same day: multi-month `periods[]` filter (MoM suppressed when >1 month); KPI cards → command-center tiles; workbook REWRITTEN on ExcelForge (`@node-projects/excelforge`, same engine as weekly) — 22 sheets, 8 native charts, native `tblSos` table, iconSet/cellIs CF, REPT bars, outline drill-downs, executive narrative, self-reconciliation row. Ultracode verify found+fixed 4 payload-fidelity gaps. Head-to-head vs weekly export: 8v5 charts, 2607v1906 formulas, 71v47 CF rules; both repair-clean. Sample: Downloads/phoenix-sos-dashboard-SAMPLE.xlsx (May 2026).

Related: [[la003-la004-confidential-products]], [[sos-dashboard-perf-and-0621-revert]], [[sales-territory-scope-build]], [[weekly-excelforge-bi-hardening]]

## 2026-09-04 — the named migration does not exist; treat this file as unverified

The description said **"migration 20260702160000 pending approval."** I could not confirm or
refute that:

- no file in `supabase/migrations/` carries the prefix `20260702160000`
- **no migration in the repo is dated 2026-07-01, -02 or -03 at all**
- the worktree `sos-dashboard-rebuild` is gone

So the work either landed under a different timestamp or was abandoned, and this file cannot tell
you which. **Do not treat the migration as pending and do not create it from this description** —
check what the SoS dashboard actually does in production first.

Two details in the body are separately dead and would mislead a session verifying this: the visual
smoke test is deferred **to a Vercel preview** (Vercel is decommissioned — production is Railway),
and it cites **`check:harden` green** (retired 2026-08-18 at the owner's instruction; CI is the
gate now). Neither is a reason to distrust the design notes above them, which are about grouping
helpers and test greps and still hold.
