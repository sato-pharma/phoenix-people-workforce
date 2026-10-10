---
name: the-organogram-is-the-au-v-views-never-v-active-organogram
description: "🔒 OWNER RULE 2026-10-10 — \"drop the v-organo\": `v_active_organogram` is never the organogram. It shows only what is active TODAY, so an area whose seat is vacant now vanishes from it entirely and a question about a PAST month gets the answer \"nobody\" — it reported 48 areas with no Down town while Down town's CNS rep seat was occupied for all of September. The real organogram, and what the closing itself reads, is the `au_v_*` family: `au_v_line_area_map_all` for the area and `au_v_seat_occupancy_all` for who held the seat and WHEN."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
---

**His words, 2026-10-10 about 01:25 Cairo:** *"eu organogram fucken drop the v-organo"* — after I
told him the active organogram had no area called Down town and asked him who owned it.

## The error, exactly

`v_active_organogram` lists 48 area names and **"Down town" is not among them**, so I reported that
no one is reviewed on the area. Wrong, and wrong in the dangerous direction: Down town's CNS rep seat
`SEAT-CNS-REP-CA5` was held by a real person from **2026-08-02 to 2026-10-04** — the whole of
September — and went vacant only on 4 October. The view is an **as-of-today ACTIVE** projection, so a
seat that is vacant now erases its area from the answer, and no error, no null and no empty string
marks the omission. **It therefore cannot answer any question about a past month**, which is most
closing questions.

## What to read instead

| View | What it answers |
| --- | --- |
| `au_v_line_area_map_all` | per (line, area): `area_state`, `carries_target`, `dm_seat_id`, `rep_seat_id`, `operational_region_code`, `effective_from/to` |
| `au_v_seat_occupancy_all` | per seat: `occupant_hr_id` **with `effective_from`/`effective_to`** — this is the one that answers "who held it in September" |
| `au_v_org_tree`, `au_v_regions`, `au_v_direct_region_allocation` | the tree, the regions, direct allocation |

These are what `src/lib/sales/closing-organogram-regions.ts` and `closing-performance-review.ts`
query; nothing in `src/` reads an organogram TABLE, because there is none — `v_active_organogram` is
the only object in `public` whose name contains "organogram", which is exactly why a session reaches
for it.

## Down town (CA5) as the worked example

* **CNS:** `area_state` `vacant_will_hire`, `carries_target` **true**, DM seat `SEAT-CNS-DM-GZ`,
  rep seat `SEAT-CNS-REP-CA5`, `operational_region_code` **GZ** — which is why the closing prints
  Down town under **Giza** although `source_of_sales_areas` says region `CA`. Do not "fix" that.
* **Its September rep:** Adel Eid Abdelrahman Mohamed Srour, Medical Representative, seat held
  2026-08-02 → 2026-10-04, now **resigned**. His District Sales Manager is Sameh Shabaan El Hoseiny
  El Hoseiny (seat `SEAT-CNS-DM-GZ` since 2026-01-12), so the area still rolls into Sameh's Giza
  district even with the seat empty.
* **Anti Infective and Pedia for CA5** are `other_line_specific` with `carries_target` **false**,
  `staffed_in_line_code` `cns` — so only CNS carries a target there.

Related: [[down-town-is-where-the-office-book-parks]], [[b-10-is-the-owner-himself]],
[[sos-monthly-closing-is-the-only-sales-truth]].
