---
name: ireports360-api-is-nine-endpoints-and-has-no-audit-trail
description: "iReports360 publishes a Swagger spec listing its ENTIRE API — 9 endpoints, no audit/history/approval-for-leave. Stop probing for one."
metadata: 
  node_type: memory
  type: reference
  originSessionId: bcdb86ed-6cb6-4e0d-a467-134df4215d8e
  modified: 2026-08-23T20:54:45.320Z
---

**The vendor DOES publish a Swagger spec** — `https://hmaxhmax-001-site7.rtempurl.com/swagger/v1/swagger.json`
(title `iReports360.Web`, OpenAPI 3.0.4, ~8.5KB), reachable **without a token**. [[ireports360-crm-integration]]
says "No public Swagger" — that was true when written, it is not true now. Fetch the spec instead of
guessing route names; a route sweep of 70 plausible audit names returned **69 × 404**.

**The complete API surface is NINE endpoints — verified live 2026-08-23:**

| Method | Path |
| --- | --- |
| POST | `/api/Auth/login` |
| POST | `/api/ReportsApi/login` |
| GET | `/api/ReportsApi/visits?startDate&endDate` |
| GET | `/api/ReportsApi/checkins?startDate&endDate` |
| GET | `/api/ReportsApi/weekly-plans?startDate&endDate&agentId` |
| PUT | `/api/ReportsApi/weekly-plans/{planId}/status` |
| GET | `/api/ReportsApi/monthly-plans?month&year&agentId` |
| PUT | `/api/ReportsApi/monthly-plans/{planId}/status` |
| POST | `/api/Tenant/resolve` |

**There is NO audit trail, no history, no change log, no per-record detail endpoint, and no
approval object for leave.** The only "approval" in the whole API is `planStatus` on a weekly/monthly
PLAN header (0 New, 1 Supervisor Verified, 2 Area Manager Verified) — that approves a VISIT PLAN, never
a vacation. So "who approved this leave and when" is **unanswerable from the API by construction**, not
because we looked in the wrong place. Only the vendor's own database can answer it; ask them by record id.

**A leave row (`visitType -4`) carries a DATE-ONLY `saveDate`** (`T00:00:00`) — 218 of 285 rows measured
2026-06-01→08-23. Regular visits carry a real clock time. So the exact minute a rep logged leave does not
exist in the feed. **To bracket it, use the `id` sequence:** ids are issued in creation order (checked on
789 same-day rows: **0 inversions**), so a timeless row is bounded by the neighbouring ids' timestamps.
Prefer OUR `created_at` (true UTC) over the vendor stamp for that bracket — see
[[ireports360-timestamps-cairo-local-mislabeled-utc]] for why the vendor stamp is an unreliable clock.

`/visits` returns exactly **20 fields** and `GET` only (every other method → 405 `Allow: GET`). The JWT
carries `sub/unique_name/privLevel/iss/aud` and nothing scope-like, so a higher privLevel would not
reveal more routes — Swagger lists them all regardless of the caller.

Casing is not enforced on the controller: `/api/ReportsAPI/visits` and `/api/reportsapi/visits` both 200.
