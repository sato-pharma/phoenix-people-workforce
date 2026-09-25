---
name: gps-checkins-are-a-partial-feed-never-score-a-rep-on-them
description: "ireports360_checkins is a PARTIAL feed — the busiest reps can have hundreds of visits and zero check-ins, so any GPS-only coverage score silently reports them as 0%"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8a99af29-4b9c-4077-ab94-dcfe54196eb5
  modified: 2026-09-21T05:06:49.569Z
---

**Verified in PRODUCTION 2026-08-21.** `ireports360_checkins` is the only CRM record carrying GPS
(105,413 of 105,414 rows have lat/lon, 2026-01-01 → 2026-08-20), which makes it tempting as the
basis for brick coverage. **It is not a complete record of field activity.** 98 reps have check-ins;
138 have visits.

July 2026 — four reps with heavy field activity and **zero** check-ins that month:

| Rep | Visits in July | Check-ins in July | Check-ins ever |
| --- | --- | --- | --- |
| Engy Said Mohamed Elsayed | 378 | **0** | 180 |
| Mostafa Mahmoud Mohamed Ali Elbadry | 248 | **0** | 194 |
| Nosiba Salah Hussenin Moussa | 131 | **0** | 232 |
| Ahmed Nabil Basim Abdelaziz Youssef Mohamed | 119 | **0** | 601 visits ever |

All four have a `crm_id` and a healthy visit feed — the check-in feed simply stops for them. A
GPS-only board would have shown the most active reps in the company at **0% coverage**, and the
number would have looked like a finding rather than a bug. Related but distinct:
[[employees-crm-id-null-does-not-mean-no-crm-activity]].

**The GPS itself is good where it exists** — 694 of 697 active bricks have a `brick_centroid` row in
`geo_locations`, and snapping a check-in to the nearest centroid puts **89% within 2km** and 99.6%
within 15km (July 2026: 15,209 / 1,443 / 384 / 62 across ≤2 / 2-5 / 5-15 / >15 km). Nearest-centroid
still pulls to a neighbouring village in sparse areas — Assiut's top pick was بنى عديسات, not
مدينة أسيوط — so it is evidence, never an answer.

**Why:** it is accurate enough to *suggest* a mapping and to give an interim picture, and nowhere
near complete enough to *judge a person*. Scoring someone's coverage on it is an unfair-appraisal
risk on live HR data.

**How to apply:** use check-in GPS to pre-fill and cross-check the region→brick mapping
([[crm-visits-join-to-bricks-both-maps-now-filled]]), and to give an interim read. Always exclude
reps with no check-ins that period from any denominator, and label the board as GPS-based until the
302 region mappings land. Then switch the board to the visit→region→brick path and keep GPS only as
the disagreement check.

**OWNER RULING A1, 2026-09-21 — the call rate follows this too** ("use A1 no GPS feed for reps
without check-ins"). On the Reps List Call rate tab, a rep with real regular visits and ZERO check-ins
in the window reads **"No GPS feed"** (proved rates blank, not 0%) and is left out of the team tiles
(`hasNoGpsFeed` in `src/lib/crm/call-rate.ts`). Narrow on purpose: a LIVE feed that proves nothing
keeps its real 0%; campaign-only or no-visit reps keep their zero; from the CRM cutover
("submitted" basis) nobody is marked. 1–21 Sep 2026 on production: 17 such accounts.

**Extended to the KPIs board the same day** ("apply A1 to the KPIs board too", PR #4174): `KpiRepRow.noGpsFeed`
from the same `hasNoGpsFeed`, a "No GPS feed" flag/filter, podiums skip him, and `sumKpiTeamTotals`
drops his calls AND his working days from the call-rate sums together — the head count, coverage and
frequency KEEP him (they never read GPS). The rep's own portal home tile says it too. Any new board
that scores proved calls must reuse `hasNoGpsFeed`, never a second copy of the rule.

**The same audit's other rulings (B2, C1, D2) are in [[reps-list-rulings-b2-c1-d2-leavers-keep-whole-month]]**
— leavers keep the whole month, resigned reps drop out, Reps List scores through yesterday. Never
re-raise B or D.
