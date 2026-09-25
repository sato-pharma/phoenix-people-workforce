---
name: sos-per-line-region-columns-are-geographic-not-routing
description: "The CNS/PD/AF Region Code columns in the SoS master workbook are a flat geographic VLOOKUP — they must never overwrite au.line_area_map.operational_region_code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 369dd08d-4bde-4f2a-a45a-5ed8b561c2d9
  modified: 2026-07-28T01:12:58.539Z
---

`Master of Master.xlsx` (2026-07-28) added three columns — `CNS Region Code`,
`PD Region Code`, `AF Region Code` — on top of the same 627 bricks / 121 blocks /
48 areas already live. **The geography was byte-identical to `FINAL NEW (5).xlsx`,
so there was nothing to apply.** Its 513 trailing rows are VLOOKUP residue from
pasting 627 rows over a 1,140-row export (1140 − 627 = 513); every one has an empty
Brick ID/Name/Block/Area and `#N/A` in all three region columns. Not a delete list.

## Why the region columns must NOT be loaded into `au.line_area_map`

17 of the (line, area) pairs disagree with live `operational_region_code`. Broken down:

| count | cause | verdict |
|---|---|---|
| 9 | file collapses `UE-1`/`UE-2` → `UE` | file is **coarser**; Anti-Infective really does split Upper Egypt into two sub-regions (`SEAT-AIF-ADM-UE-1`, `SEAT-AIF-DM-UE-2`) |
| 6 | file gives a real region where live says `OT` | file is **wrong**; live rows have `area_state='other_line_specific'`, `other_type='line_specific'`, `dm_seat_id='SEAT-{AIF,CNS,PED}-OTHERS'`, `carries_target=false` — that line does not staff the area |
| 2 | genuine | needs an owner ruling |

The workbook's lookup only knows "which region does this area sit in geographically".
It has no concept of **line-specific staffing**, which is exactly what
`operational_region_code` encodes. Loading it would break Others routing for 6 areas
and flatten the AIF sub-region split. See [[sos-others-region-split-2026-07-27]] and
[[au-schema-is-the-org-sos-linkage]].

The 6 line-specific-Others rows: `CA5` pedia, `D11` anti_infective, `D17` ×3 (all lines),
`UE8` cns. The 2 genuine: `GZ5` Helwan-Maadi pedia (live `CA` / Ahmed Mohamed Nagy vs
file `GZ`), `GZ7` October-Zayed cns (live `GZ`, occupied by Samir Saad Samir Habib Rizk,
vs file `OT`).

18 real bricks carry `#N/A` in all three region columns — all of them in the new
`OT4`–`OT10` areas, because the lookup source predates the 2026-07-27 Others split.

## The real bug the file surfaced

`au.line_area_map` had **143 rows where 48 active areas × 3 lines = 144**.
**`UE8` (Qena 2) has no `pedia` row at all** — no DM seat, no rep seat, not even the
Others pseudo-DM. Pedia booked **415 fact rows / 2,510 units there Jan–May 2026** and
none of it attaches to anyone.

Root cause: Pedia rep seats exist for `UE1`–`UE7` only; `au.seats` has nothing for
pedia + `UE8`. CNS covers the same area via `SEAT-CNS-OTHERS`; Anti-Infective has a
real rep (Ghada Mohamed Abdelwahab Ismaiel on `SEAT-AIF-REP-UE8`).

**Coverage check worth re-running after any area change** — it is cheap and catches
this class of bug:

```sql
with a as (select area_code from source_of_sales_areas where active),
     l as (select distinct line_code from au.line_area_map)
select a.area_code, l.line_code from a cross join l
except select area_code, line_code from au.line_area_map;
```

(`OT3` still has 3 rows and is intentionally retired-but-kept, so it shows as an orphan
in the reverse direction — that is expected, not a fault.)

## ⚠️ SOURCE OF TRUTH = `C:\Users\satoh\Downloads\Master of Master.xlsx` (owner, 2026-07-28)

Every other spreadsheet the owner pasted (`MAPPING.xlsx`, `Areas Database\*`, `Phoenix Sales DB\*`,
`Phoenix_Customer_Remap_VERIFIED.xlsx`, the line-closing books) is **fallback only** — useful to
recover a customer's name/address when `source_of_sales_customer_map` is blank, and nothing more.
Geography — bricks, blocks, areas, and **block names** — comes from `Master of Master.xlsx` alone.

Consequence: do NOT prefer database `source_of_sales_blocks.description` over the workbook's
block name, even when the DB value came from the 668-brick reallocation. That reasoning was
overruled. Block names are *place lists* that feed the address matcher, so a wrong one invents
matches — e.g. DB had `B160 = منشأة القناطر – المناشي – المنصورية` while the master says
`المناشى – تكلا – برقاش`, which was matching every customer in المنصورية onto B160.
Correcting all 15 substituted block names moved 269 customer rows (224 lost a false brick).

**Also: `Phoenix_Customer_Remap_VERIFIED.xlsx` is NOT ground truth.** It targets the old
668-brick master and only 34.8% of its targets survive. Accuracy comparisons against it are a
*relative* signal between buckets, never an absolute accuracy figure.

## Block names in the DB are a 3-way mix (found 2026-07-28)

77 of 121 block names in `source_of_sales_blocks.description` differ from the owner's
workbook, and **there is no single winner** — resolve per provenance, never bulk-overwrite:

- **50** — DB still holds the old generic label from `Vlookup-Masterrr.xlsx`
  (`"Alex East"`, `"Sharkia 2"`); the workbook has the real Arabic street names. **File wins.**
- **15** — DB name was set by `manual:668-brick-reallocation-2026-07-24` /
  `manual:14-uncovered-bricks-resolution-2026-07-24`; block membership genuinely changed
  and the workbook predates it. **DB wins.**
- **12** — named `Others` in the file by explicit owner instruction (the OT blocks). **Keep `Others`.**

Two traps a naive "manual source wins" rule falls into: `B100`/`B101` have a manual source but
a *generic* DB name (`Sharkia 2`), and `B176`'s DB name carries a working label
(`طنوب – Behira 1 Outlier`). Gate on "both names are real Arabic place names with no Latin
artifact", not on source alone.

**The 2026-07-27 master apply set `description` only on newly-inserted blocks — it never
refreshed existing ones.** That is why the drift exists. Refreshing those 50 in the DB is
still open.

## Table names — easy to get wrong

`public.source_of_sales_customer_map` and `public.source_of_sales_fact_rollup`
(not `customer_map` / `fact_rollup`). `au.occupancy_history` (not `au.seat_occupancy`);
its occupant column is `occupant_hr_id`. `employees.full_name` (not `employee_name`).
`au.line_area_map` has **no** `area_name` column — join `source_of_sales_areas`.
