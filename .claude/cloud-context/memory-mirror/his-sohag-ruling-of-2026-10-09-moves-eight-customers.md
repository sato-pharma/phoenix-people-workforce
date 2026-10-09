---
name: his-sohag-ruling-of-2026-10-09-moves-eight-customers
description: "His 2026-10-09 ruling moved all 8 Sohag 1 customers that sold in September into Sohag 2 bricks (1,571.02 EGP of CNS), and the same night the other 45 candidates too (move the other 45 candidates to their towns too) — 44 matched uniquely plus one ambiguous address decided to المنشأه; of each cohort a large share is SILENTLY HELD by sos_map_guard_customer when the old source was sheet-verified or an owner ruling (holds 3575-3580, then 3581-3599), and a map move is only half the job — the already-imported rows need applyHistoricalReconciliation."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T19:39:54.580Z
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

🔴 **RELEASED 2026-10-09 at 22:04 Cairo, and a session may do that once he has typed the ruling.**
He answered twice — "the six holds are released, reconcile them" — while all six still read `pending`
in the database, so the click never landed; the sanctioned path is
`sos_map_guard_decide_and_move_sales(id, 'approved', <his words>)`, the same RPC the screen calls,
and all six returned `ok:true` with `brickMove:null`. The convention `decided_by` carries is a QUOTE
of his words, not a person: the 2026-09-11 باب الشعريه release reads
`owner 2026-09-11: "bab el sheria DOWNTOWN" — supersedes the earlier sheet-verified …`. What a
session must never do is write the permit itself.

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
`public.sohag8_map_backup_20261009`. The three BRICK moves that were also in front of him are
**ruled out — "leave all three bricks where they are", 2026-10-09, and they were never his in the
first place**: [[the-three-sohag-brick-moves-were-never-his-and-stay-unmoved]]. They are a
different mechanism entirely —
[[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]] for why nothing re-runs the Office
spread, and the relocate path has no store-split writer at all.

🔴 **AND THE SAME NIGHT HE EXTENDED IT TO THE WHOLE SHEET: "move the other 45 candidates to their
towns too".** The 45 are the candidate rows with no September sales in a tracked line (the sheet has
53 rows; 8 sold, and they are the table above). Applied 2026-10-09: **44 matched a single map row**
on address + distributor + current brick + name, and all 44 landed on their town brick in UE6 —
جرجا `B165-3` 22 · البلينا `B214-M1` 7 · عرب الاطاوله `B214-4` 5 · المنشأه `B165-1` 5 ·
العسيرات `B214-2` 3 · برديس `B165-2` 2. **25 went straight through and 19 were parked by
`sos_map_guard_customer`** exactly as the eight were — holds **3581–3599**, released with the same
`sos_map_guard_decide_and_move_sales` quoting his words, all `ok:true`.

**The 45th had an ambiguous address and was decided, not parked:** PS/0001543348
عادل عبداللاه الجديدة ن, address `العسيرات مركز المنشاه`, names both towns. It went to
المنشأه `B165-1` because the address names المنشاه as the markaz — and the choice moves no number at
all: both candidate bricks are Sohag 2 under the same rep, and the customer has **zero import rows
in the system**. One word from him flips it to العسيرات `B214-2`.

Pre-images: `public.sohag44_map_backup_20261009` (44 rows, all UE5) and
`public.sohag45th_map_backup_20261009`. The cohort's already-imported rows were re-pointed by the
reconcile — Jan–Jun 2026 and one September row moved to UE6, **2026-07 (6 rows) and 2026-08 (1 row)
stayed UE5 because those months are locked**, and the one September row is **Head Office**, not CNS:
[[a-candidate-sheets-september-sales-column-hides-head-office]]. September CNS by area was unchanged
at UE5 847,786.09 / UE6 267,555.00.

🔴 **THEN THE TEN HE HAD KEPT IN THE CITY: "move the ten kept in مدينة سوهاج to their towns too"**
(2026-10-09, after he was told tonight's move of كيرلس صفوت left ten of the eleven behind). Those ten
map rows are the remainder of `owner-ruling-sohag-city-vs-markaz-2026-08-10` (28 rows in all) still on
`B213-1`. **Five were moved, five were NOT** — their town is not in their address, and the town is
read from the neighbours' bricks, never guessed:
[[a-villages-town-is-read-from-its-neighbours-bricks]].

| Moved | Town brick | Why |
| --- | --- | --- |
| الاسعاف - الشيخ مرزوق, PS/0001501827 | البلينا `B214-M1` | الشيخ مرزوق reads البلينا 13 of 17 |
| على رشوان - بنى حميل, PS/0001551084 | البلينا `B214-M1` | بنى حميل reads البلينا 22 of 24 |
| محمد بدار الجديدة, PS/0001552029 | البلينا `B214-M1` | address truncated at `…مجلس المدينة البل` |
| حمادة هاشم الجديدة, IS/416418 | دار السلام -سوهاج `B166-1` | `برمانة اولاد سالم بحرى دارالسلام` |
| عصمت حمدون, IS/431822 | دار السلام -سوهاج `B166-1` | `اولاد خليفة دارالسلام سوهاج` |

**And he answered the three that had no town in their address, in-chat multiple choice — اسعد الكبري → جرجا `B165-3` (he OVERRODE the recommendation to keep it, so the street evidence loses to his ruling), مدحت مجدى → جرجا, and محمد الجديده STAYS in مدينة سوهاج** (holds 3605–3607, released with his answers). The three were: اسعد الكبري (IS and IS-S, `ش الجرجاوية الشرقي` — a city
STREET, 2,974.73 EGP of September CNS, the biggest single sum in the whole cohort), محمد الجديده
(IS and IS-S, `ميدان الشهداء` — no signal) and مدحت مجدى-المساعيد (جرجا 8 against العسيرات 4).

All five moves were **held by the guard** — their old source was his own August ruling — holds
**3600–3604**, released with his words. Proven: September CNS **UE5 847,786.09 → 847,320.34**
(687 → 684 rows), **UE6 267,555.00 → 268,020.75** (428 → 431), exactly the 465.75 EGP those three
September rows carry. The reconcile corrected **14 rows across 7 batches — every unlocked row and
only those**: July's eight rows were untouched (July CNS, Pedia and Anti Infective have been locked
since 2 October, August since 4 October), and the four July rows already reading UE6 were there
before tonight. Pre-image: `public.sohag_city_kept10_backup_20261009` (all ten rows, all on
`B213-1`/UE5).

**Where the night ended: 61 map rows moved, and 5,011.50 EGP of September CNS with them.**
September CNS at the import-row layer went **849,357.10 → 844,345.61** for Sohag 1 (UE5) and
**265,983.99 → 270,995.47** for Sohag 2 (UE6) — the eight 1,571.02, the 45 candidates nothing (their
only September row is Head Office), the five city-kept 465.75 and اسعد الكبري 2,974.73. Zero rows of
any tracked line now disagree with the map for September, and the store-split net was rebuilt whole
at 23:17 Cairo (732 cells). اسعد الكبري's 49 unlocked rows re-pointed across 7 batches with no
timeout; its July (7 rows) and August (4) stay in مدينة سوهاج because those months are locked, as do
its IS-S pair, and مدحت مجدى's two July rows needed nothing — the distributor had already filed them
in جرجا while the map said the city. 🔴 **The September Office spread is now 5,011.50 EGP more stale
than when the night started** — only the Office commit on the Monthly Closing screen re-runs it:
[[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]].
