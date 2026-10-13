---
name: qena-city-is-qena-2-on-every-line
description: "A governorate's city is ONE brick in ONE area — مدينة قنا is one brick in Qena 2 (his ruling 13 Oct 2026), the way مدينة سوهاج is one brick in Sohag 1; Qena 1 is exactly nine bricks and holds no city brick"
metadata:
  node_type: memory
  type: project
  originSessionId: 0be92338-9743-4b23-ba29-cd28bd8597f5
  modified: 2026-10-13T00:48:19.942Z
---

🔴 **A GOVERNORATE'S CITY IS ONE BRICK IN ONE AREA — NEVER A CITY BRICK IN EACH HALF.**
Owner, 13 Oct 2026: *"madinet qena brick in the area qena 2 … exactly like sohag city a brick in
sohag 1"*, after an earlier *"madinet qena nafsha kolha tethsb l qena 2"*. The house shape he is
pointing at, live on production: **مدينة سوهاج** is one brick (`B213-1`, 1,538 shops) in **Sohag 1**
and Sohag 2 has no city brick at all; **مدينة أسيوط** is one brick (`B181-1`, 1,440 shops) in
**Assuit 2** and Assuit 1 has none. So Qena is **one `مدينة قنا` brick in Qena 2**.

His authoritative split for **Anti Infective and Pedia**:

- **Qena 1 (9, no city brick):** أبو طشت · نجع حمادى · الأشراف · فرشوط · دشنا · القناويه · اولاد عمرو · الطوابيه · قريه الكلاحين
- **Qena 2 (11 + the city):** مدينة قنا · قوص · الطويرات · الصالحية · نقادة · قفط · كامولا · الزينى · العشى · الدير · أبنود

**Why:** Qena city had been split across BOTH areas as two bricks — `B209-1` مدينة قنا (813 shops,
Qena 1) and `B209B-1` مدينة قنا - قنا 2 (312 shops, Qena 2) — which is what
[[qena-1-and-2-both-cover-qena-city]] recorded and what no address rule could reconcile. Pedia and
Anti Infective already behaved as he describes (over nine months `B209-1` carried **zero** Pedia and
**zero** real Anti Infective units against **11,096.89** CNS units), and CNS's single Qena rep holds
both areas on `SEAT-CNS-REP-UE7`, so no rep's money ever depended on the split.

**How to apply:** done 13 Oct 2026 in two steps, both on production. First `sos_relocate_brick`
moved `B209-1` into block `B209B`, minting **`B209B-4` مدينة قنا** in UE8 and leaving `B209-1` as the
husk مدينة قنا - Qena 1. Then `B209B-1` was folded into `B209B-4` **by hand**, because there is **no
merge path in the codebase** — nothing sets `superseded_by_brick_id` to an existing brick, and the
only precedent was hand-written SQL in schema `sos_merge_undo_20260728`. The fold is five writes in
one transaction: re-point `source_of_sales_customer_map`, re-point
`source_of_sales_territory_aliases` (`target_type = 'brick'`), re-stamp
`source_of_sales_import_rows`, set the retired brick's `effective_to` and `superseded_by_brick_id`,
and **insert a row per touched batch into `source_of_sales_brick_move_files`** so the rollups get
rebuilt — see [[a-brick-move-leaves-its-rollup-files-pending-with-nothing-draining-them]], without
which the fold never reaches a single screen.

End state: **`B209B-4` مدينة قنا, Qena 2**, with `B209-1` and `B209B-1` both dated out `2026-10-12`,
holding zero mapped shops, and superseding into it. Its shop count is **not a fixed number** — read
it live (1,098 at 13 Oct 03:42 Cairo against 813+312 = 1,125 at the fold), because the address-first
mapping work moves individual shops between neighbouring bricks continuously.

🔴 **THE TWO RETIRED CITY BRICKS STAY EXACTLY AS THEY ARE** — owner, 13 Oct 2026, asked whether to
tidy them: *"leave the two Qena city bricks as they are"*. They are dated history and the audit trail
of the fold: never deleted, never re-pointed, never reactivated, and never re-created as a live city
brick in Qena 1. A session that finds two `مدينة قنا` rows in the brick master is looking at that
history, not at a defect.

🔴 Never recreate a Qena-city brick in Qena 1, and never read the brick
master alone when asked for a line's territory — the per-line truth is the seat map
(`au.f_line_area_map_asof`) plus which bricks actually carry that line's sales.
