---
name: his-sohag-ruling-of-2026-10-09-moves-eight-customers
description: "His 2026-10-09 ruling moved all 8 Sohag 1 customers that sold in September into Sohag 2 bricks (1,571.02 EGP of CNS) — 2 applied straight away, 6 SILENTLY HELD by `sos_map_guard_customer` because their source was `sheet-verified` or an owner ruling, waiting on his approve at `/sales/mapping-guard`; and a map move is only half the job, the already-imported rows need `applyHistoricalReconciliation`."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T18:58:59.783Z
---

Asked as in-chat multiple choice on 2026-10-09 (four questions, grouped by town), he ruled **move all
eight** — including the two he was told were arguable, where he overrode the recommendation and chose
"Move both to Sohag 2" for عرب الأطاولة. The eight are every Sohag 1 customer in the 53-row candidate
sheet that actually sold in September, worth **1,571.02 EGP of September CNS**, 0.3% of the 156-point
Sohag 1 vs Sohag 2 achievement gap:

| Customer | Target brick | September CNS |
| --- | --- | --- |
| (no name on the map row), IS/381902 | B165-3 جرجا | 779.63 |
| حسام الدين, IS/423750 | B165-3 جرجا | 81.00 |
| عبدالمحسن عبدالحميد فراج الجديده, IS/407405 | B165-3 جرجا | 74.93 |
| محمود طنطاوى, IS/435654 | B165-3 جرجا | 60.75 |
| حنان دهشور - م.ناصر, PS/0001584379 | B214-4 عرب الاطاوله | 248.68 |
| مستشفي سان بيشوي, IS/373415 | B214-4 عرب الاطاوله | 162.00 |
| كيرلس صفوت الجديدة, PS/0001571525 | B214-M1 البلينا | 111.38 |
| مرفت قدري, IS/355152 | B165-1 المنشأه | 52.65 |

🔴 **SIX OF THE EIGHT WERE HELD, AND THE UPDATE SAID NOTHING — 8 rows in, 2 rows returned.**
`sos_map_guard_customer` parks any brick/area move whose OLD `source` matches `^(owner-|final-new-)`
or equals `sheet-verified` into `public.sos_map_change_holds` with the reason *"overwrites a mapping
decision of yours"*, returns NULL, and the statement reports fewer rows with no error. Holds
**3575–3580**, all at 21:49:33 Cairo. The two that went through were the ones whose source was
ordinary (`closing-sheet-backfill-2026-08-27`, `admin-import`). Only `/sales/mapping-guard` releases
them — and `sos_map_guard_decide(hold_id, 'approved', actor)` **applies the stored `after_json`
itself**, so his approve completes the map move with no re-write from a session. Never mint a permit.

🔴 **A MAP MOVE IS HALF THE JOB: the rows already imported keep the brick they were given.** The
repair is `applyHistoricalReconciliation` (`src/lib/sales/normalizer/customer-map.ts`), the same
`sos_reconcile_import_rows_from_customer_map` RPC the Mapping Database screen calls, and it refreshes
the affected batches' rollups — the store-split net included, which is why this path needs no manual
net apply, unlike a brick relocate. Measured on the two applied moves: September CNS **UE5
849,357.10 → 848,946.41, UE6 265,983.99 → 266,394.67**, exactly the 410.68 those two carry.

**It is period-agnostic and only a LOCK stops it, which is safe here only by accident of history.**
The RPC re-points every unlocked row of that customer, every line and every month. 2026-07 and
2026-08 are locked and were skipped (proven: those rows are still UE5). 2026-01..2026-06 are NOT
locked — but `monthly_closing_publications` holds **no row before 2026-07**, so re-pointing them
restates nothing that was ever announced. It moved 22 rows for PS/0001584379 across April, May, June
and September. Check that lock-versus-publication question again before reconciling a customer with
pre-July history; the script header's "a published or locked month is safe" conflates the two.

**His own earlier ruling on this exact question went BOTH ways, so tonight's is a per-customer
override, not a reversal.** `owner-ruling-sohag-city-vs-markaz-2026-08-10` covers 28 customer-map
rows: 17 placed in Sohag 2 markaz bricks (جرجا 5, البلينا 5, العسيرات 4, برديس 2, المنشأه 1) and
**11 deliberately kept in B213-1 مدينة سوهاج**. كيرلس صفوت الجديدة is one of those 11 and is the one
he has now moved; the other 10 stay as he left them in August unless he says otherwise.

See [[an-owner-ruling-only-binds-at-confidence-100]] — these rows are written at confidence 100 with
`mapped_by = 'B-10'` and source `owner-ruling-sohag-1-vs-sohag-2-2026-10-09`, or the monthly self-heal
would overwrite them. Pre-image of all eight rows:
`public.sohag8_map_backup_20261009`. The three BRICK moves he is separately considering are a
different mechanism entirely —
[[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]] for why nothing re-runs the Office
spread, and the relocate path has no store-split writer at all.
