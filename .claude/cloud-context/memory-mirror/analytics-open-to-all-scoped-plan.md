---
name: analytics-open-to-all-scoped-plan
description: "SHIPPED (PR #1150, prod-live 2026-07-19): sales analytics is open to portal sales roles through a SEPARATE URL, per-viewer scoped. Owner ruling — portal users must NEVER reach analytics via /admin/*: /admin/analytics/* stays admin-only (CEO/SA/SFE), portal roles get /employee-portals/sales-analytics/* only. Tile matrix (owner-picked): MR/DSM = 3 core (SoS/Closing/Weekly); RM/NSM/PM/GPM/MM = all 5 (adds Exec Comparison + Reconciliation). Durable lesson: curl text-match cannot test Next.js App Router redirects — grep for the NEXT_REDIRECT digest, not page text."
metadata:
  node_type: memory
  type: project
  originSessionId: 7a426ddb-95c0-494b-928f-6af0ac0d891a
  modified: 2026-09-26T00:00:36.009Z
---

## The live architecture (shipped 2026-07-19, PR #1150)

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
