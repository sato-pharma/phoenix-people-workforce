---
name: anti-infective-september-has-six-target-free-areas
description: "Six Anti Infective areas carry_target in September with no target row — Heliopolis and Helwan-Maadi LOST one they had in July and August, Haram-Faisal and Nasr City never had one in any month, and Suez+Ismailia share ONE seat (SEAT-AIF-REP-OT2) so they want one target between them, not two."
metadata:
  node_type: memory
  type: project
  originSessionId: 9828b8ae-f17d-4189-8df8-a7baee24cd4f
  modified: 2026-10-10T12:36:18.248Z
---

Measured on production 2026-10-10 while auditing September CNS and Anti Infective.

`au.monthly_targets` for `2026-09` holds 33 Anti Infective areas / 1,595,663.90 EGP. Six areas that
`public.au_v_line_area_map_all` marks `carries_target: true` on 2026-09-01 have **no row at all**:

| Area | Code | Jul | Aug | Sep | Seat on 2026-09 | Sep invoiced |
| --- | --- | --- | --- | --- | --- | --- |
| Helwan-Maadi | GZ5 | 48,656.25 | 48,634.50 | — | vacant since 13 Jul | 3,376.30 |
| Heliopolis | CA1 | 31,860.00 | 37,405.00 | — | vacant since 13 Jul | 1,505.65 |
| Haram - Faisal | GZ4 | — | — | — | vacant since 13 Jul | 4,721.15 |
| Nasr City | CA2 | — | — | — | **Farah Mossad Al-Sheikh from 27 Sep** | 3,809.85 |
| Suez | OT2 | — | — | — | SEAT-AIF-REP-OT2, vacant | 333.45 |
| Ismailia | OT9 | — | — | — | **the same** SEAT-AIF-REP-OT2 | 60.70 |

Three separate causes, and they are not one fix:

- **Helwan-Maadi and Heliopolis are a real regression** — they carried a target in both PUBLISHED
  months and lost it in September. The Aug→Sep diff is +5 areas (Dokki-Mohandseen-Bolak, Qalubeya,
  Sharkia 2, Cairo West, Fayoum) and −2 (these two), so the September upload replaced rather than
  extended.
- **Haram-Faisal and Nasr City have never had a target** — July and August were published that way,
  so September is not where this started. Nasr City is the only one of the six with a person in the
  seat (last 4 days of September).
- **Suez and Ismailia became target-carrying on 2026-09-01** with the Delta (3) move, and the map
  gives both the SAME `rep_seat_id` — one rep covers both areas, so they want ONE target between
  them. Loading two is the wrong shape.

Both Pedia gaps (Qena 2, Beni Suef) have the same shape as the Suez/Ismailia pair: areas that turned
target-carrying on 2026-09-01 under the 2026-09-09 organogram approval and never got a target.
See [[sos-monthly-closing-is-the-only-sales-truth]] — a partial or missing target inflates an
achievement exactly like a partial window does.

**Why:** publishing September freezes it; a target loaded afterwards does not restate a published
month without a republish, and the two areas that lost a target were fine in both published months.

**How to apply:** before reporting an Anti Infective or Pedia September achievement, say which of
these areas divide into no target; the fix is his own entry on the Targets screen, never a write from
chat. Check `carries_target` against `au.monthly_targets` for the period, never area counts — the
count held at 30→30→33 while two areas silently dropped out.
