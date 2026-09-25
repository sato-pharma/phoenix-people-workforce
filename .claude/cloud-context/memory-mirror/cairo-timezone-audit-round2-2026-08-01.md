---
name: cairo-timezone-audit-round2-2026-08-01
description: "Round-2 Cairo/UTC sweep (8 agents + live SQL): entry-point period seeds are the rot, not the services. 10 HIGH findings, NONE has fired in production yet"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T14:47:03.152Z
---

Round 2 of the Cairo audit, 2026-08-01. Round 1 ([[cairo-utc-timezone-audit-and-fix]], 07-25) is
**fully closed** — both PRs merged, both migrations live on staging AND production; verified today
via `pg_get_functiondef` that `probation_provision_case_on_hire` is Cairo-zoned. **The memory index
line calling round 1 "unapplied" was stale.**

## The one-sentence finding

**The domain SERVICES are clean — they take `{month, year}` / `period` as explicit arguments. The rot
is at the ENTRY POINTS**: server components compute a default period from the raw UTC clock and pass
it into client `useState`, where it sticks as the working period for the entire session.

Cairo is AHEAD of UTC (+2 EET / +3 EEST), so `toISOString()` between **Cairo 00:00 and 02:00/03:00**
returns the PREVIOUS day. Note `toISOString()` inside a `"use client"` component is still UTC — it is
wrong for correctly-configured Cairo browsers too, unlike a bare `toLocaleDateString()`.

## ✅ Verified in production: NONE of these has actually fired

- `direct_order_requests` with a `sales_month`: **0** (module unused).
- `au.monthly_targets`: 270 rows, **0** saved in the 00:00–03:00 Cairo window.
- `automated_payroll_runs`: 1 total, **0** started in the window. `salary_batches` in window: **0**.
- `v2_vacation_requests` filed in window: **0**.
- 7 `deduction_candidates` created in-window are a red herring — June deductions deliberately
  back-computed on 21 July with an explicit month key (`matches_utc_month = false`).
All preventive. Fix before the first month-boundary incident, not after.

## ✅ The five HIGH entry-point seeds are FIXED — **MERGED `ba390854` (#1585) 2026-08-01T12:23Z**

Branch `codex/cairo-entry-point-period-seeds`, worktree `_wt-cairo-entry-points`. All 6 pages
(the 5 + the portal targets twin, which holds a byte-identical `buildPeriods()`) now seed from
`currentCairoDateParts()`. New guard test `tests/cairo-period-seed-guard.test.ts` pins all six and
bans reading a calendar field off a clock-derived Date — but deliberately does NOT ban `new Date()`
(passing the instant into `currentCairoDateParts(now)` is correct, as is `Date.UTC()` arithmetic
over already-Cairo parts). Typecheck/lint/build clean, **516 test files**.
**Items 7 + 8 (vacation Entitlements reference date, excuse monthly allowance) are FIXED —
MERGED `17dccd75` (#1586) 2026-08-01T14:46Z** — plus a third defect the audit under-stated: the excuse form
CONTRADICTED ITSELF, defaulting the date field from UTC while `validateExcuseDate` compared against
the BROWSER-local day, so Submit was disabled before the employee typed anything. Note
`currentCairoDateOnlyIso` IS client-safe (i18n/format.ts is pure Intl, no server-only imports).
Guard test `tests/cairo-leave-today.test.ts` pins that the form default and its validator can never
diverge again. 517 test files green.

Still OPEN after that: items 9 (WAU heatmap 2-day spread), 10 (report-it month KPI), the MEDIUM
list, and all 9 prod SQL functions.

## HIGH — money/data moves (all confirmed by file:line, several by me directly)

1. **`app/(admin)/sales/targets/page.tsx:26-36`** — WORST. Server component seeds the period from
   UTC; the grid SAVES with it. `phx_upsert_monthly_targets` is `on conflict (period,line,area,product)
   DO UPDATE` — **verified in prod** — so entering August targets just after Cairo midnight
   **overwrites July's targets** and July achievement recomputes against them. Silent data loss.
2. **`app/(admin)/admin/automated-payroll/page.tsx:25-29`** — whole company salary run assembled
   under the previous month's period key.
3. **`app/(admin)/admin/deductions/page.tsx:17-18`** — explicit `getUTCFullYear/getUTCMonth`; drives
   `POST /api/admin/deductions/publish` → deductions land on the wrong payslip month.
4. **`app/(admin)/admin/automated-payroll/finance/page.tsx:22-23`** — FAB bank-transfer value date
   stamped `YYYY-07-25` instead of `-08-25`. **This one reaches an actual bank.**
5. **`app/(admin)/admin/m-payroll/page.tsx:39-40`** — HR downloads/fills/uploads the wrong month's
   salary template.
6. **`src/lib/direct-orders/service.ts:699-701`** — `sales_month` from `toISOString().slice(0,7)`;
   injects into the previous month's SoS `DirectReq` batch and is STICKY (batch rebuilt from truth).
7. **`src/lib/vacation/service.ts:5260`** — admin Entitlements table reference date; HR sees the
   PREVIOUS entitlement year and can reject a funded request. (Its employee-facing twin at :2548 is
   already Cairo-correct — this is the un-fixed sibling.)
8. **`src/lib/excuses/service.ts:109-111`** + **`employee-excuses-workspace.tsx:73-74,497`** —
   employee who used 2 excuses in month M is UI-blocked from filing in M+1 for the first 2–3h, and
   the date field pre-fills to yesterday so the form opens pre-blocked.
9. **`src/components/admin/activity-control-dashboard.tsx:177,186-196,235`** — the WAU/adoption
   heatmap the owner watches: buckets keyed UTC, grid keyed browser-local → a **two-day spread**
   between the "today" ring and the data, all day, every day. Panel is literally labelled "(Cairo)".
10. **`src/lib/report-it/service.ts:182-183`** — "this month" ADR KPI systematically undercounts.

## MEDIUM highlights

`au.f_seat_occupant_asof` (prod, unzoned `current_date`) — **writer is Cairo**
(`20260728010000...:130` stamps `(now() at time zone 'Africa/Cairo')::date`), **reader is UTC** →
SoS credit moves between people for 2–3h nightly, defeating the owner's "always today's geography"
rule. · Calendar API routes still UTC though their pages were fixed in round 1 · `contracts/
date-rules.ts:34` returns an already-passed renewal date · `getCompanyWideOutageDates`
(`ingestion-health.ts:155`) is the last hand-rolled UTC boundary in attendance · `export/
table-workbook.ts:82,197` stamps every XLSX in UTC · `marketing-request-drafts.tsx:207` freezes
`todayDate` at MODULE scope — an SPA tab left open overnight submits with yesterday's date.

## 9 prod SQL functions still use unzoned `current_date` (DB TimeZone = UTC)

Stores a wrong date permanently: `accept_offer_and_create_employee` (**hire date** → propagates to
+90d probation end and contract anniversary), `finalize_manual_employee_lifecycle`,
`phx_autofill_replacement_vacancy_from_employee_insert`, `phx_reassign_replacement_ownership`,
`phx_ensure_terminal_employee_vacancy`. Transient: `au.f_seat_occupant_asof`. Cosmetic: several
`'... on ' || current_date` note strings + one md5 idempotency key.

## Structural facts worth keeping

- **No `TZ` env var anywhere** (Dockerfile/workflows/deploy) → Node runs UTC. **Postgres TimeZone =
  UTC** too.
- **All 8 crons are `--time-zone="Africa/Cairo"` and DST-aware**, and every DAY-SCOPED job fires at
  ≥03:00 Cairo — outside the divergence window. So UTC date math inside them is **latent fragility,
  not active breakage**; it bites the moment a schedule moves earlier. Thinnest margin:
  `phoenix-background-jobs` Fri 03:00 Cairo = exactly 00:00 UTC in EEST.
- Canonical helper `currentCairoDateOnlyIso` (src/lib/i18n/format.ts:97) is used by ~26 files but by
  **ZERO files** in payroll, deductions, CRM, DV-analytics, coaching or E360 — each rolled its own
  UTC `todayIso()`. **Three separate `cairoTodayIso()` copies** exist (attendance/working-days,
  crm/dates, vacation/holiday-confirmation).
- 🔴 **CRM/E360 exception — do NOT "fix" these**: iReports360 timestamps are stored as zone-less
  strings that are ALREADY Cairo wall-clock. Reading them with `timeZone:"UTC"` is CORRECT;
  converting through Africa/Cairo double-applies the offset. `crm-first-visit-board.tsx:11-27` is the
  reference implementation. Audit found ZERO double-conversion bugs.
- ⚠️ **Unguarded assumption**: every punch's correctness rests on the on-prem agent PC's Windows
  timezone being Egypt. The agent records `agent_timezone` into `raw_payload` but
  `raw-punches/route.ts:46-58` never checks it. Re-image that machine to UTC and everyone's
  late/early-leave minutes shift 2–3h with no alert. Cheapest real safeguard in the whole audit.
- `double-visit-analytics-workspace.tsx:79` uses a UTC boundary DELIBERATELY to match the server —
  client and server must move together or you introduce a mismatch.

Full agent transcripts: session e0491122 task outputs (8 agents, ~1.3M tokens).
