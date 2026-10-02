---
name: ireports360-crm-integration
description: "iReports360 (vendor EGYDEV) is the company's field-force pharma CRM and system of record for field activity; Phoenix reads it READ-ONLY (Reporting API v2.0, payload wrapped {success,count,data} — read .data) to feed the FWC report. Day cells: type 0 = visit count; -4 is the ONLY leave (AV); -8 is CAMPAIGN (CP, counted beside coverage); -15 and -30 are CP working time. Classify codes only in src/lib/crm/visit-type-meaning.ts. Never store the password in memory or git."
metadata:
  node_type: memory
  type: project
  originSessionId: 3c8dd832-1759-43c2-aafa-98c6db7e1468
  modified: 2026-10-02T16:35:38.432Z
---

## What iReports360 is

The company's field-force CRM (vendor **EGYDEV**, branded "Everything & More 360"; SQL Server backend).
Reps are **"agents"**, doctors/clinics/hospitals are **"contacts"**. It is a genuine **vertical pharma
field-force / SFA CRM** and the **system of record for field activity** — but NOT a general company CRM (no
pipeline/opportunities, quotes/orders, marketing automation or ticketing). The web app is a **.NET Blazor
SPA** (MudBlazor UI, Leaflet live-map/heatmaps, e-detailing); the legacy `.aspx` **Tracker** /
`CoverageVisits.aspx` pages are report drill-downs alongside it. It is **vendor-locked and read-only —
Phoenix cannot modify the CRM**; the design is Phoenix as the umbrella + analytics layer over it.

## The read-only Reporting API v2.0

- Base URL `https://hmaxhmax-001-site7.rtempurl.com` (SmarterASP.NET public hosting) — **publicly
  reachable, so Phoenix pulls directly on a daily cron; no local agent needed.**
- `POST /api/ReportsApi/login` ({username,password}; a Priv=3, IsWorking=1 agent) → **30-day JWT**;
  `GET /api/ReportsApi/visits?startDate&endDate` and `GET /api/ReportsApi/checkins?startDate&endDate`
  (Bearer).
- 🔴 **Both data endpoints wrap the payload as `{success, count, data:[...]}` — the client MUST read
  `.data`.** No public Swagger.
- **Real-data keys/gotchas:** stable keys are `agentID` + `contactID`; non-doctor visit types (e.g.
  Conference −1) return `contactID 0` / null `contactName` / empty `customerName`; **`visitDate` is
  date-only (midnight) while `saveDate` carries the real timestamp**; check-in `address` is often empty but
  lat/lon are present (**reverse-geocode ourselves**).

## The integration is the FWC report's new input, not a new module

The goal is to **replace the existing "Field Workforce Compliance" (FWC) report's input** — a hand-made
monthly Excel upload — with live CRM data, keeping the name and route
`/admin/field-workforce-compliance`. The adapter produces the same `FieldWorkforceParsedWorkbook`
(rawDailyValues keyed by dateIso; classifier maps each cell → N / AV / CP / VISITS, auto-handling
Friday / pre-hire / holiday, hire date from the employee directory). Files:
`src/lib/field-workforce-compliance/ireports360-{config,client,source}.ts` and route
`app/api/admin/field-workforce-compliance/import-from-ireports360/route.ts`. **Downstream is untouched** —
the deductions connector reads the `field_workforce_compliance_decisions` table, permission stays
`hr_calendar` (the registry `**` rule already covers the new route).

**Agent → HR_ID** maps via `employees.crm_id` / `crm_username`; the Agents roster export carries CRM ID +
HR ID to backfill `employees.crm_id`.

## The day-cell mapping (validated 1:1 against the real Tracker)

The report being replaced is the iReports360 **Team Calendar / "Tracker"** — a daily grid whose cell
vocabulary is exactly `{N, F, CP, AV, numeric count}`, matching the adapter 1:1. Mapping:

- **Regular (0) → the visit count.** A day cell is the count of the day's regular (type `0`) visits;
  every other code is looked up in the ONE table, `src/lib/crm/visit-type-meaning.ts`
  (`crmVisitTypeMeaningLenient` — an unlisted code reads as CP). Priority: regular count > CP > AV. A
  mixed day (regular visits AND a campaign-class activity) shows the regular count with a campaign
  overlay (owner decision 2026-07-20); only a day with no regular visit reads "CP".
- 🔴 **visitType `-8` is CAMPAIGN (Prospection)** — `CAMPAIGN_TYPE = -8` (`src/lib/crm/visit-types.ts`),
  classified CP (worked, not a regular visit). Some reps log ALL their field work as `-8`, and campaign
  is counted BESIDE Doctor Coverage, never inside it (owner ruling 2026-08-27, #2448 —
  [[campaign-visits-make-a-working-rep-look-like-a-zero]]); plan-vs-actual still counts type `0` only.
  **Superseded 2026-10-02:** previously "`-8` 'prospection' is a NORMAL visit, it counts toward the day's activity, not a marker" — `CAMPAIGN_TYPE = -8` and the 2026-08-27 campaign-beside-coverage ruling.
- **`-4` (Annual Vacation) is the ONLY leave type → AV.** `-15` (Health Day) is CP / working time
  (owner ruling 2026-08-01 — reading it as leave had charged 22 days across 11 employees in July
  2026), and `-30` is an unlabelled field visit (Pharmacy Visit / Regular by comment) → CP, not a
  campaign marker. `-5`, `-6` and `-16` are CP working days too
  ([[crm-visit-type-maps-there-are-three-not-two]]).
  **Superseded 2026-10-02:** previously "`-30` = campaign marker; `-4` / `-15` → AV" — the owner's 2026-08-01 Health Day ruling and the unified table in `src/lib/crm/visit-type-meaning.ts`.
- **Friday** shows the count if a visit exists, else "F"; an eligible no-record day → **N**; a future day →
  blank.
- **The Tracker lists EVERY seat including zero-activity reps (rows of all-N) and vacant seats — the
  adapter must include the full active-rep population, not only reps with ≥1 visit.**
- AM/PM is encoded by cell COLOR in the Tracker (AM=blue, PM=orange, both=green), reproducible from
  `visits.ampm` — a "better than Tracker" detail.

## Parity is conservative — keep deductions DISPLAY-FIRST

Matched against the real May Tracker by AGENT ID: **compliance-class fidelity (worked / N / AV / F) ≈ 95%,
and over-credit = 0 — it never shows "worked" where the rep did not** (safe for a deduction input).
Exact-cell agreement is lower, and the whole gap is the Tracker's **"CP" campaign-period overlay**, which
the Tracker shows even on days the rep logged real visits while `/visits` only partially exposes it. So a
false-"N" is a campaign period or a visit attributed to another agent id — **not a missed workday.** **Keep
the deductions path DISPLAY-FIRST until the campaign-period questions below are resolved.**

**Open questions for the vendor/developer:** (1) does the API expose campaign PERIODS (date ranges) or a
campaigns endpoint? (2) should double/accompanying visits (`doubleID`) credit the second rep? (3) any
marker visit types beyond `-4` / `-15` / `-30`? — (3) is since answered in-house: the undocumented
codes were resolved from the reps' comments and classified in `src/lib/crm/visit-type-meaning.ts`
([[ireports360-undocumented-visit-type-codes]]).

## Enabling it, and the security posture

- The import route **503s `ireports360_not_configured`** until the env vars `IREPORTS360_BASE_URL` /
  `IREPORTS360_USERNAME` / `IREPORTS360_PASSWORD` are set (`ireports360-config.ts`); the FWC page then
  shows a "not configured — use manual upload" notice instead of the import button. To enable, set the
  three vars in the target env with a Priv=3 agent's creds (ideally a dedicated read-only account).
- 🔴 **Only a weak, personal top-admin login exists so far ("Omar-Gaweesh", Priv=3), and its password was
  shared in chat** — ask the developer for a **dedicated read-only integration account**, rotate the admin
  password, store creds as env secrets, and **NEVER store the password in memory or git.**
- **Three risks to raise with vendor EGYDEV before this is business-critical:** (1) `rtempurl.com` is
  free/temp SmarterASP.NET hosting; (2) a single weak shared admin login (needs per-user accounts + a
  dedicated read-only integration account + rotation/MFA); (3) read-only / vendor-locked (cannot modify the
  CRM).
- **Reference files** (API HTML doc, Postman collection, a Visits xlsx export, CRM screenshots) live on the
  owner's machine and contain real PII (rep + doctor names, GPS coords) — keep them OUT of git and email.

Relates to [[source-of-sales-rebuild-rules]] and [[command-center-perf-on2-sales]].
