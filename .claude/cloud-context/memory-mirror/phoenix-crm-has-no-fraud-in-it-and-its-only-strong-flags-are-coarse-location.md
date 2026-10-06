---
name: phoenix-crm-has-no-fraud-in-it-and-its-only-strong-flags-are-coarse-location
description: "Asked \"are the reps frauding?\", the production answer for 3–5 Oct 2026 is NO and it is measured — 98.4% of measurable visits saved within 300 m of the rep's own door (avg 29 m), top consecutive-visit speed 12.3 km/h across 36 rep-days, 0 duplicate photos of 241 — and the integrity board's ONLY strong hits are 3 coarse-location rows on one honest rep"
metadata:
  node_type: memory
  type: project
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-10-05T19:06:32.265Z
---

Measured on production 2026-10-05 across every day the module has been live (3–5 Oct 2026, 415
visits, 13 reps). Four independent tests, all negative:

- **Position.** `location_flag` is `ok` on **315 of 320 measurable visits (98.4%)**, average **29 m**
  from the place the rep himself fixed; 5 `far` all carry an accuracy radius averaging 804 m (the GPS
  was bad, not the rep). The remaining 93 are `no_place` — pharmacies, which have no place by design.
- **Travel.** Top average speed between two consecutive visits, over all 36 rep-days: **12.3 km/h**.
  No impossible travel anywhere. Day distances 273 m – 34 km of real movement.
- **Photos.** 241 place photographs, **0** duplicate SHA-256 and **0** duplicate perceptual hash.
- **Text.** 4 repeated comments of 332; median comment 75 characters.

🔴 **The integrity board's entire output is FOUR rows, all one rep — Yasmeen Samy Shawky Mahdy,
3 Oct — `constant_accuracy` + `coordinate_replay` at accuracy 2,000 m. That is Android's
*approximate location* permission, not a spoof**: it returns the same tower centroid with the same
radius every call, which is indistinguishable from a replay. Same phone and same morning as the four
Benha hospitals pinned on one point, and the same phone that then took 9 accuracy refusals on 4 Oct.
So the detector's first production output is a FALSE POSITIVE on an honest rep — the exact failure
`phoenix-crm-boards.md` warns about. Read a `coordinate_replay` + `constant_accuracy` pair with a
large accuracy radius as a coarse-location permission until something else says otherwise.

**The three doors that carry no external check** (structure, not evidence of anything): doctors —
305 of 355 validated customers, fixed by the rep's own photo and two GPS readings and nothing else;
hospitals — the Google listing check reaches only 47 validated, 10 ever reviewed; pharmacies — no
validation, no place, no comparison, by the owner's ruling. **Exposure on the pharmacy door is
currently zero and measurably so:** of 82 pharmacy visits, 65 were auto-created from a pharmacy named
on a doctor's visit (inheriting its verified GPS) and 17 were the Super Admin's own 3 Oct backfill —
**no rep has used the standalone Pharmacy visit button even once.**

Account: `docs/phoenix-crm-field-audit-2026-10-05.md`. Related:
[[phoenix-crms-folded-fields-are-empty-and-five-modules-run-on-them]].
