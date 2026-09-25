---
name: sos-import-dashboard-head-office-line-lock
description: "loadSourceOfSalesDashboard now takes a REQUIRED viewer {role} — its old positional canViewRestricted=true was a fail-open default with no line filter at all"
metadata: 
  node_type: memory
  type: project
  originSessionId: 73e17b1a-b911-4f54-91a1-e54eb3d313b0
  modified: 2026-08-02T02:13:02.153Z
---

`src/lib/sales/monthly-distributor-import.ts` → `loadSourceOfSalesDashboard(period, viewer)`.

✅ **MERGED + LIVE IN PRODUCTION** — PR #1617, squash `092b70b2`, merged 2026-08-02 05:10 Cairo.
`/api/healthz` revision flipped to `092b70b2e592…` in ~80s. Verified post-deploy against prod: a
scoped viewer's 2026-06 byLine is Pedia 4,231,982.29 / CNS 4,109,041.65 / Anti Infective
1,021,155.60 with **no Head Office row**, and the reconciliation guard does **not** fire
(line-scoped total 9,362,179.54 == geography total, diff 0.00) so geography still renders.

**What was wrong (fixed 2026-08-02, branch `claude/elegant-swanson-d6d0f1`):** the second parameter
was `canViewRestricted = true` — a **positional boolean defaulting to fail-open**, and there was no
Head Office LINE filter anywhere in the loader. The `canViewHeadOfficeLine` / `stripHeadOfficeRows`
guards existed but were only applied by `analytics/service.ts` and
`sales-marketing-intelligence/service.ts`, never by this loader's callers.

**All three callers leaked to the same role.** `sales:import` is granted to exactly ONE
non-Super-Admin role — **SFE Manager** (`permissions.ts:760`):
- `app/(admin)/sales/import/page.tsx`
- `app/api/sales/monthly-import/dashboard/route.ts`
- `src/lib/ceo/command-center.ts` → `/admin/sfe-command-center` (hard-redirects all but SFE Manager)

**The fix is the API shape, not a per-caller patch.** `viewer: { role }` is **required**, and both
confidential locks are derived inside the loader (`canViewRestrictedProducts` +
`canViewHeadOfficeLine`). A caller can no longer forget one, and the compiler catches every site.
🔴 Do not "simplify" this back to booleans.

**Three things that are easy to break here:**
1. `buildSourceOfSalesDashboard`'s unrestricted fast path sums **whole-batch** totals, which bake in
   every line. It is therefore only safe when BOTH locks are open — `if (!restrictedSet &&
   !stripHeadOffice)`. All **3** build sites pass `excludeHeadOfficeLine`, including the two early
   returns (a period whose batches are all *blocked* would otherwise take the fast path).
2. `byRegion/byArea/byBrick` have **no line dimension** — they come from
   `phx_sos_geo_aggregates_without_restricted`, which can only exclude **product codes**. The loader
   therefore resolves the Head Office line's codes **live from the master** and appends them to
   `p_exclude_codes`. Master unreadable ⇒ `geoSummaries = []` (withhold), never a partial list.
3. Backing that up: a **reconciliation guard** in `buildSourceOfSalesDashboard`. `byRegion` must sum
   to the line-scoped `totals`; if geography is **higher** by >1.00, the code-based exclusion
   under-filtered, so all three geo dimensions are withheld. Lower is fine (unmapped geography).
   Only scoped viewers reach it — the CEO path returns earlier and is deliberately not reconciled.

Regression: `tests/sos-import-dashboard-head-office-lock.test.ts` (wired in `tests/run-tests.ts`).
Both guards were prove-it-failed separately — headline assertions fire, not adjacent ones.

🔴 The exposure numbers are NOT what they look like — read
[[head-office-line-leak-is-ry001-not-212m]] before quoting 212.5M or "78% of revenue".

⚠️ A separate unmerged branch `codex/sfe-overview-scope` carries a per-caller stopgap
(`applySfeSalesLineScope` in `command-center.ts`). It is redundant once this lands but harmless
(idempotent double-filter); expect a merge conflict on that one call site.

Related: sales-head-office-lock-all-surfaces · [[app-visibility-is-application-scoped-not-rls]]
