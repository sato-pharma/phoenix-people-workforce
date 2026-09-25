---
name: crm-contact-100000-is-a-catch-all-not-a-doctor
description: "CRM contact_crm_id 100000 is a catch-all record that ~90+ reps check into across 500+ addresses and 415 km — exclude it from every check-in, coverage or territory figure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4270e050-2e27-40cc-b434-84336bd82518
  modified: 2026-08-28T16:34:52.823Z
---

**Verified in PRODUCTION 2026-08-28.** `contact_crm_id = 100000`, named
`وائل عبد عبد المنعم`, is **not a doctor**. Measured over 2026-01-04 → 2026-08-26 in
`ireports360_checkins`:

| | |
| --- | --- |
| Check-ins | **604** |
| Distinct reps | **99** (of 130 reps that have any check-in at all) |
| Distinct addresses | **511** |
| Max spread | **415 km** |

No real physician is visited by three quarters of the field force at 511 addresses spanning the
length of Egypt. It is a catch-all / fallback record reps select when the real contact is missing.
The id itself is the tell — a round `100000` where every genuine contact sits in the 90,000s.

**Why:** it silently poisons anything aggregated per contact. It was the single worst "doctor" on
every dispersion measure, ranking above every real outlier and averaging 2.77 reps per contact
against ~1.05 for the rest. Any coverage, frequency, territory or GPS-variance figure that groups by
`contact_crm_id` will carry it unless excluded.

**How to apply:** add `and contact_crm_id <> 100000` to check-in analytics, or exclude it at the
source. If it is retired in the CRM, **deactivate it, never delete** — the same FK-cascade rule as
[[nursery-venues-were-saved-as-pharmacies-with-invented-codes]]. Related:
[[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]] (the feed is partial, so never score a
rep on it) and [[crm-speciality-has-one-authority-dont-build-a-second]] (19.7% of CRM "doctors" are
not doctors at all).

**The geography itself is sound once this row is out.** All 109,436 GPS check-ins fall inside Egypt —
no null island, no wrong hemisphere. Of the 12,830 doctors visited more than once, **9,014 (70%) sit
at one place**, 1,140 have two or more real locations (hospital shift plus private clinic), and 2,676
are one real place plus one-off strays. **Judge a doctor's location by where its check-ins cluster,
never by the widest gap** — one stray point 390 km away made a 17-visit Sohag hospital read as a
372 km spread.
