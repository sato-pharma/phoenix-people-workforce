---
name: employee-360-module-design
description: "Employee 360 per-employee scoring module — BUILT and live at app/(admin)/employee-360 (list + per-hrId page). The durable half is the owner rules (exclude plan-adherence — MR/DM/RM don't submit plans; never guess a placeless trip's destination; hide expenses for Medical Reps) and the DATA-REALITY caveats: GPS check-ins are a PARTIAL feed and must never be scored on, campaign visits make a working rep look like a zero, ~1/5 of CRM 'doctors' aren't, and coaching is one-rater sparse — a scoring module built without these is confidently wrong about real people."
metadata: 
  node_type: memory
  type: project
  originSessionId: c38f1e94-c37f-48f9-a47a-2fe21c834dce
  modified: 2026-09-26T05:30:00.235Z
---

**Employee 360** — one per-employee page (`app/(admin)/employee-360/page.tsx` + `[hrId]/page.tsx`) plus a
sidebar tab that consolidates every domain (visits, check-ins, sales, coaching, double-visit, expenses, HR
lifecycle) into a RATING/SCORE. Owner calls it "the most important module system-wide." Roles in scope:
Medical Rep, District Manager, Regional Manager, National Sales Manager, Product Manager, Group Product
Manager, Training Manager. Aggregation lives in `src/lib/employee-360/{service,deep-service,benchmarks}.ts`
(small per-agent queries, no migration; `getEmployee360Profile`), gated `canSeeEmployee` per row.

## Owner rules (must apply)

- 🔴 **MR/DM/RM do NOT submit weekly/monthly plans on Phoenix — EXCLUDE all plan-adherence KPIs.** Score on
  ACTUAL visits / check-ins / sales / coaching only. Owner scored a visits-only v1 as 2/10 → build the FULL
  consolidated profile, not thin slices. He directed: master visits + check-in + sales FIRST; HR/lifecycle
  comes AFTER (deferred).
- Heavy focus on **number of visits**, **Campaign-vs-Regular** comparison, **check-in timing**, and **GPS
  geocoding** of check-ins.
- 🔴 **"Nothing should be Unknown EVER", and a placeless trip is QUARANTINED, never guessed.** Owner rejected
  inferring a trip's destination from the rep's territory — a trip with no recorded destination moves to an
  "Unresolved" tab and never appears in the dashboard until resolved (`isUnresolvedRow` = empty destination
  AND not a meeting). **Home is NEVER a destination** — read `to_location`/`location`, never `from_location`
  (= the employee's home/origin).
- 🔴 **Medical Reps: HIDE the whole Expenses & Outstation section** (expense analysis is a manager view). Gate
  on `resolveJobFunctionRole(jobTitle ?? positionTitle) !== "Medical Rep"` from `src/lib/employees/job-function.ts`
  — the job-function classifier, NOT the deliberately title-free security-role parser `normalizeRole`.
- Meetings legitimately have no destination → excluded from the no-destination count; classify by
  `request_type` into Travel/Meeting/Other.

## 🔴 The data reality (the trap this file exists to prevent)

A scoring module built without these produces confident numbers that are wrong about real people.

- **GPS check-ins are a PARTIAL feed — never score a rep on them.** All check-ins carry GPS but only ~17%
  have a text address, and ~36 reps log visits with ZERO check-ins (~18 are real field reps with app-GPS
  off; the rest are PM/coach/office roles that legitimately don't check in).
  [[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]]
- **`visit_date_time` has NO clock time** (date-only) → intra-day timing must come from
  `ireports360_checkins.check_date` (real `timestamptz`) plus the AM/PM flag (which has casing dirt).
- **`geo_bricks` is EMPTY** — there is no per-rep territory geometry to validate check-ins against.
- **Campaign visits (type -8) make a working rep look like a zero** — plan-vs-actual counts `visit_type = 0`
  only. Report Campaign-vs-Regular against the company SAME-month share.
  [[campaign-visits-make-a-working-rep-look-like-a-zero]]
- **Coaching is SPARSE and single-rater** (one coach = TM A-7 Ahmed Elkawas, covering ~a quarter of reps) →
  cannot weight it heavily; needs an explicit "insufficient data" state, and future-dated rows are excluded.
- **Sales lags ~2 months** and covers ~two-thirds of reps; lead each section with a plain-English
  auto-summary and honest "no fake zero" states.
- **~1/5 of CRM "doctors" are not doctors** — [[crm-speciality-has-one-authority-dont-build-a-second]].
- **Unmapped visits (~8%) are all resigned CRM seats** (`ireports360_crm_identity_resolutions`
  status='resigned') EXCEPT a genuinely new hire not yet coded in Phoenix — onboard with the CRM id and the
  weekly reconcile back-links the visits; never treat the unmapped block as a data defect.

## Architecture facts to reuse

- **Expense data source of truth is `payroll_expenses`** (Excel-imported), NOT `outstation_expense_requests`
  (the GPS self-submission system, ~1 row). `total = travel_cost + meeting_amount + allowance + other_amount`
  (`other_amount` is always 0); `request_type` ∈ Traveling/Outstation/Meeting/Other (**Outstation IS travel**);
  approval is 3-state via `status` (Approved / Rejected / Pending-blank — show all three, not just approved).
- **Manager sales = SUM of the whole team** (the subject plus all org descendants — walk the directory
  `managerHrId` chain to `teamHrIds`; `sales_records.manager_hr_id` also gives a direct DM roll-up). This is
  what lets expenses-vs-sales populate for managers, who have no direct sales of their own.
- 🔴 **The canonical Egypt place module is `@/lib/geo/egypt-locations`** — `resolveGovernorate`,
  `canonicalizeLocation`, `canonicalizeTransport`, `placeAliases`, `extractKnownPlace`, `CENTROIDS`,
  `resolveRegionCentroid`, normalizing Arabic orthography (أ/ا, ة/ه, ى/ي, diacritics/tatweel) and mapping
  every EN/AR/street-address variant to one of 27 governorates (unrecognised → cleaned own name, never
  "Unknown"). Three older copies (`utils/places.ts`, `outstation/region-centroids.ts`,
  `employee-360/egypt-locations.ts`) are now thin re-export SHIMS. **Reuse this one module for any Egypt
  place/governorate/centroid need — do NOT make a fourth copy.**

**Still pending:** the composite score itself, PM/GPM ROI, confidential-product masking for non-exec viewers
([[la003-la004-confidential-products]] — exclude confidential products from any exec/sales tile), portal
(non-admin) hosting, and the HR/lifecycle spine. Incentive data via the public interface only
([[incentive-policy-lock]]). For v2 reuse `double-visit-analytics` ([[double-visit-analytics-live-rebuild]]),
`field-workforce-compliance`, `coaching/scoring`, `sales/metrics`, and the CRM linkage
([[ireports360-crm-integration]]).

**Verify gotchas:** the dev-auth cookie only sticks via `/api/dev-auth?role=Super Admin&next=/employee-360/<hrId>`
(direct nav races → redirects to root); local dev network to Supabase is flaky (ConnectTimeout hangs the
client shell on "Loading workspace"), so verify with `get_page_text` or an offline pure-logic harness rather
than screenshots.
