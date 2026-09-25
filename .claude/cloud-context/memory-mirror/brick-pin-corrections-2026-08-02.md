---
name: brick-pin-corrections-2026-08-02
description: "7 of 22 GPS-derived brick-pin corrections applied to prod geo_locations (provider checkin_gps) — rollback values inline; out-of-territory flags did NOT collapse afterward"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5a652a2-e36f-4a55-9063-dcb32f0e0fdd
  modified: 2026-08-02T14:13:13.979Z
---

2026-08-02 ~17:30 Cairo, owner-approved: applied the top-7 GPS ground-truth corrections to
production `geo_locations` (`source_type='brick_centroid'`), setting `geocode_provider='checkin_gps'`
(a NEW provider value — `pinConfidence` in territory-management/service.ts:896 has no tier for it
and falls through to "Unverified 50%"; adding a proper ~90% tier is an open follow-up, see the
merged script PR #1634). geo_locations has NO history table — the only rollback is this table:

| brick | prior lat | prior lon | prior provider |
|---|---|---|---|
| B125-12 إطسا | 29.237895 | 30.791346 | google_geocode |
| B125-M1 سنهور | 29.410011 | 30.761438 | locationiq |
| B179-9 النخيل 6 أكتوبر | 31.084844 | 29.729524 | google_places_hint |
| B182-2 الرحمانيه | 31.10489 | 30.643144 | google_places_hint |
| B192-15 محلة زياد | 31.024386 | 31.231999 | google_places_hint |
| B206-2 ابو رواش | 30.045047 | 31.095012 | google_places_hint |
| B90-90 اسحاقة | 31.1225 | 30.998605 | google_places_hint |

**Batch 2 (remaining 15, owner-approved ~18:00 Cairo same day) — rollback values:**

| brick | prior lat | prior lon | prior provider |
|---|---|---|---|
| B101-12 الحسينيه | 30.8496411 | 31.9700618 | google_places_hint |
| B166-1 دار السلام-سوهاج | 26.238278 | 32.061017 | google_places_hint |
| B167-1 نقادة | 25.900518 | 32.722703 | google_places_hint |
| B182-1 دمنهور شبراخيت | 31.026032 | 30.671612 | google_places_hint |
| B187-21 منية سندوب | 31.005609 | 31.381103 | google_places_hint |
| B189-3 احمد عرابى | 30.065577 | 31.202653 | google_places_hint |
| B193-13 شبراقاص | 30.741368 | 31.067671 | google_places_hint |
| B194-1 البدراشين | 29.810728 | 31.251191 | google_geocode |
| B197-4 زهراء المعادى | 29.961732 | 31.305794 | google_places_hint |
| B199-5 سخا | 31.089707 | 30.94443 | google_places_hint |
| B202-5 فيشا الكبرى | 30.41132 | 30.944633 | google_geocode |
| B207-12 الشعراء | 31.403031 | 31.791813 | google_places_hint |
| B209-7 قريه الكلاحين | 25.953264 | 32.848386 | google_places_hint |
| B214-4 عرب الاطاوله | 26.540923 | 31.722396 | google_places_hint |
| B217-2 تله | 28.07145 | 30.729247 | google_places_hint |

All 22 proposals are now applied.

🔴 **The "wrong pin explains the out-of-territory reps" hypothesis FAILED verification (after batch 1).** Flags for
AB4 (B-167: 26/44 days, B-125: 21/45) and D16 (B-144: 12, B-107: 10) were IDENTICAL after the fix —
an area centre averages ALL its pins, so one correction barely moves it. Do not re-claim that story.
Open: 15 more proposed corrections (22 total ≥3 km) in the merged script's output
(`scripts/analyze-checkin-brick-groundtruth.mjs`, gitignored `scripts/output/`); re-run the
out-of-territory view only after applying more of them, else it accuses innocent reps.

Related: [[cron-job-org-is-the-real-production-scheduler]] · both CRM mapping punch-lists
(region→brick 0 rows, customer→brick 1 pending) were EMPTY on this date — filling the top-volume
region mappings upgrades all future GPS analysis from area-level to brick-level.
