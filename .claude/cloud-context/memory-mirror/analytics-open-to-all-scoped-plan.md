---
name: analytics-open-to-all-scoped-plan
description: "RETIRED 2026-09-17 — THE SALES ANALYTICS MODULE NO LONGER EXISTS, by the owner's Ruling 11 ('no analytics module, no sales analytics', said three times). Everything below describes a module that was deleted: src/lib/analytics/ is gone entirely (portal-access.ts, scope.ts, canViewPortalDetailedAnalytics, resolveAnalyticsViewerScope, scopeAnalyticsFilters all absent), there is no /employee-portals/sales-analytics route, and next.config.ts redirects the old addresses. NEVER restore it or re-add a nav row — tests/sales-analytics-retired.test.ts and tests/navigation-ruling-11-analytics.test.ts both run in the suite and fail the PR. The ONE address the ruling left behind is /admin/analytics/monthly-closing/details for Finance Manager, gated by src/lib/sales/closing-details-page-access.ts. Kept only as the account of what was built in PR #1150 and why it went. The durable lesson still holds: curl text-match cannot test Next.js App Router redirects — grep for the NEXT_REDIRECT digest, not page text."
metadata:
  node_type: memory
  type: project
  originSessionId: 7a426ddb-95c0-494b-928f-6af0ac0d891a
  modified: 2026-10-01T00:00:00.000Z
---

> 🔴 **RETIRED 2026-09-17 — READ THIS BEFORE ANYTHING BELOW.**
>
> The owner retired the **whole Sales Analytics module** by **Ruling 11 — "no analytics module, no
> sales analytics", which `system-navigation.ts` records him saying three times.** Nothing below is
> live. Verified against `origin/main` on 2026-10-01:
>
> - `src/lib/analytics/` **does not exist** — `portal-access.ts`, `scope.ts`,
>   `canViewPortalDetailedAnalytics`, `resolveAnalyticsViewerScope` and `scopeAnalyticsFilters` are
>   absent from the entire tree.
> - There is **no `/employee-portals/sales-analytics` route**; the pages were deleted in #3911
>   (`9f31a4e1b`) and `next.config.ts` redirects their addresses.
> - The five-tile matrix, the three/five split and the detailed-pair gate describe nothing that runs.
>
> 🔴 **DO NOT RESTORE IT, and do not re-add a nav row** — `tests/sales-analytics-retired.test.ts` and
> `tests/navigation-ruling-11-analytics.test.ts` both run in the suite (invoked from
> `tests/run-tests.ts`, inside the required `validate` job) and fail the PR if any role's rail
> exposes `/admin/analytics` or a rail label reads exactly "Sales Analytics".
>
> **The one address the ruling deliberately left behind** is
> `/admin/analytics/monthly-closing/details` for **Finance Manager**, gated by
> `src/lib/sales/closing-details-page-access.ts`. The ruling removed the module, not that export.
>
> Everything from here down is the account of what PR #1150 built on 2026-07-19 and is kept for that
> reason only. See [[rm-dsm-portal-provisioning-gaps]], whose RM tab diff named the same dead gate.

## What PR #1150 built on 2026-07-19 — RETIRED, not live

Owner direction 2026-07-18: open the analytics dashboards to every sales role, but each sees **only
their own scope (line/region) and only relevant filters.** Mid-build he made the ruling that decided
the shape:

🔴 **Portal users must NEVER reach analytics through `/admin/*` — "for safety, make a SEPARATE url."**
So the live design is two surfaces, not a dual-mode admin page:

- **`/admin/analytics/*` stays admin-only** (CEO / Super Admin / SFE Manager; SFE sees 6 of 9 tiles, no
  Exec/Recon — pre-existing). The `(admin)` group layout bounces any portal-mode user out.
- **`/employee-portals/sales-analytics/*`** is the portal module — the 13 dashboards mirrored via shared
  components `src/components/analytics/dashboards/*-dashboard.tsx`, each taking a `mountRoot`
  (`/admin/analytics` for the admin page, `/employee-portals/sales-analytics` for the portal page) so one
  component serves both. The nav link goes to the portal URL for all seven sales roles.

**Tile matrix (owner-picked):** MR + DSM see **3 core** tiles (SoS / Closing / Weekly); RM + NSM / PM /
GPM / MM see **all 5** (adds Exec Comparison + Reconciliation, the "detailed" pair). Gate:
`canViewPortalDetailedAnalytics(role)` in `src/lib/analytics/portal-access.ts` (true for RM/NSM/PM/GPM/MM);
the portal exec/recon pages redirect a non-detailed viewer back to the hub.

**Per-viewer scoping** lives in `src/lib/analytics/scope.ts` (`resolveAnalyticsViewerScope`,
`scopeAnalyticsFilters` — **fail-closed**, region NAME→CODE bridge). It pushes allowed lines/regions into
the RPC args as an intersection-with-selection (forced-empty when empty) and re-filters rows in TS as
defence in depth, then trims and hides filter dropdowns the viewer can't change. 🔒 **Confidential
Head-Office line and products LA003 / LA004 / SS001 stay CEO / Super-Admin-only regardless of scope** —
enforced by the scope engine, not by hiding a link.

Context worth keeping: the `/admin/analytics` module runs on a **different engine** from the portal
SoS/Weekly dashboards — `src/lib/analytics/service.ts` + `analytics_*` RPCs, which originally applied
only the Head-Office + restricted-product locks with no line/region scope. The scope engine above is what
added per-viewer scope to it. Portal SoS/Weekly already scoped via `resolveSalesAccessScope`.

## Durable lesson — testing App Router redirects

**curl + text-match on a 200 response is NOT reliable for testing Next.js App Router redirects.** Next
often ships a **"soft redirect"** — HTTP 200 with an RSC flight payload that contains the target page's
serialized data mixed with a `"digest":"NEXT_REDIRECT;replace;<url>;307;"` marker — instead of a raw 307,
when the response has already started streaming. A naive grep for expected page text then produces a
**FALSE POSITIVE** (looks like the wrong page rendered). **Always grep for the `NEXT_REDIRECT` digest
specifically** — its presence/absence is unambiguous regardless of streaming quirks.

Related: [[one-prod-deploy-per-task]] · [[analytics-module-audit-2026-07]] ·
[[analytics-multi-select-time-filters]]
