---
name: crm-checkin-address-reverse-geocode-backlog
description: "CRM check-in \"—\" addresses = reverse-geocode backlog (all have GPS); sync caps 200/run + window-scoped; backfill script is the catch-up"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d20aeb9-9413-4a9f-b937-e9c675075ca7
  modified: 2026-07-28T04:58:37.459Z
---

CRM Check-ins tab showing many `—` in the Address column is NOT a bug. iReports360 sends check-ins with **GPS coords but usually a blank address** (vendor reverse-geocoding is unreliable). Phoenix reverse-geocodes it itself at sync time (`backfillMissingCheckinAddresses` in `src/lib/crm/sync.ts` → `resolveCheckinAddress` in `crm/checkin-geocode.ts`: **LocationIQ first (free, confidence-gated) → Google fallback**). Two reasons the historical backlog stays `—`:
1. **Capped `maxNewCheckinGeocodesPerSync = 200`** per sync run (protects cron time/cost budget).
2. The sync only touches check-ins in its **rolling ~10-day window** (+ rotating 30-day reconcile), so older check-ins outside the window are never revisited.

Prod 2026-07-27: 91,673 check-ins, **65.9% (60,372) null address, ALL of them have lat/lon** (100% geocodable). July ~98.5% addressed (recent), Jan–June mostly null.

**Fix = one-time catch-up script** `scripts/backfill-checkin-addresses.ts <dateFrom> [dateTo]` (idempotent/resumable, only selects rows still missing an address, writes each as it resolves). Run locally with `.env.local` (hits PROD Supabase); needs `LOCATIONIQ_API_KEY` or `GOOGLE_MAPS_SERVER_KEY` (both present locally). It's a PROD bulk write + geocoding-quota spend → get owner approval per range.

**Done so far (2026-07-27):** July (`2026-07-01`) → 222 fixed / 0 failed, July now 0 null. Jan–Jun (`2026-01-01 2026-06-30`, 60,150 rows) run was **STOPPED by owner at ~56%**: ~33,912 fixed / 3 failed. **Prod coverage 34%→71%** (has_address 31,301→65,435; null 60,372→**26,238 remaining, ALL in Jan–Jun**). Near-zero failure rate (LocationIQ+Google resolve almost everything). **To finish: re-run the same command** (idempotent — only selects rows still missing an address; no double-charge). Address is a convenience label only; GPS lat/lon (the authoritative location) is always present. See [[locationiq-geocode-provider]] [[google-maps-legacy-places-disabled]] [[ireports360-crm-integration]].

**SHIPPED — GPS→brick IN the CRM module (PR #1409, MERGED `69132980`, 2026-07-28):** `src/lib/crm/brick-geo.ts` resolves a coordinate to the nearest brick centre (`geo_locations` source_type='brick_centroid' joined to `source_of_sales_bricks`; **active bricks only**), exposing 4 columns — **Brick (GPS) / Area (GPS) / Region (GPS) / Confidence Note** — on the **Check-ins** tab (own GPS) AND **Visits/Double-Visits** (via the matched check-in, inside the checkin column block; the 2 No-Check-in tabs drop the cols). Confidence = distance band High ≤1km / Good ≤3km / Review ≤10km / Weak >10km. Prod: **668 usable centroids across all 48 areas**; **72,044/108,760 visits (66.2%) gain geography, up from ZERO** (CRM region→brick still 0/294); 400-row sample 54% High/29% Good/11% Review/6% Weak, avg 1.99km. Centroid index cached 5 min. **Caveat: some centroids are mis-geocoded** (البلينا sits ~35km off, next to Akhmim) → shows as large distance; permanent fix = brick boundary polygons (point-in-polygon).

**Address→brick mapping (2026-07-28):** owner wanted the 27,665 distinct geocoded check-in addresses mapped to bricks (an xlsx like the customer→brick file). Built a matcher: governorate gazetteer (EN+AR names, bare + "X Governorate" forms) → narrows to the governorate's specific area codes, then locality→brick by Arabic-exact + English consonant-skeleton transliteration (Mallawi→ملوي, Akhmim→أخميم) against brick_name, with a generic-word blocklist (عزبة/كفر/شارع + governorate words like sheikh) to kill false positives, + a city→area fallback. Result: **Brick 31.5% / Area 70.8% / Region 98.9%**. **CRITICAL MASTER GOTCHA:** the remap target is the NEW consolidated **627-brick master = `fixed_parsed.json`** in the PARALLEL session scratchpad (`369dd08d-.../scratchpad`), NOT the live DB `source_of_sales_bricks` (1036 active = OLD for the remap; "no old brick is ever a target"). `fixed_parsed.json` (Jul 28 00:37) is newer+correct vs `corrected_parsed.json` (Jul 27 20:01, had Sharm/Tor Sinai as Suez not South Sinai). The parallel session's richer gazetteers (`bricks_separated_with_boundaries.xlsx`, `Areas x Disrb database.xlsx`) would lift brick coverage further. See [[sos-master-complete-704-applied-2026-07-28]].
