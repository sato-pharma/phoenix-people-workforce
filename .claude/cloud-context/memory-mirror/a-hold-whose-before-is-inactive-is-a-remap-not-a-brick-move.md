---
name: a-hold-whose-before-is-inactive-is-a-remap-not-a-brick-move
description: "A map-change hold whose `before_json.active` is false is a RE-MAP of an unmapped row, not a brick move — and whether answering it moves money is read from where the import rows already sit, never from the two brick names."
metadata:
  node_type: memory
  type: project
---

Read `before_json->>'active'` and `after_json->>'active'` before reading the bricks. Measured on
production 2026-10-10 on the last two holds the Mapping Guard ever raised, 3610 and 3611 (raised
02:20:42 Cairo, `db_role postgres`, `app_actor null`, both "overwrites a mapping decision of yours").

- Both had **`before.active = false`, `after.active = true`** — the 02:00:02 unmap of 30 customers
  had just deactivated the rows, and a direct database session then tried to re-activate them at the
  September sheet's brick. The guard read that as overwriting the unmap decision. A hold like this is
  the unmap being undone, not a rep-to-rep move.
- 🔴 **The money test is where the IMPORT ROWS already sit, not the brick names.** 3610
  (ممتاز محمد الجندى, `IS-S / 359809`) wanted أبو المطامير / Behira 2 → دمنهور شبراخيت / Behira 1,
  and September's Anti Infective row (**1,111.50 EGP**) was *already* credited to دمنهور شبراخيت;
  3611 (الاندلس, `IS-S / 345505`) wanted شبرا الخيمه → روض الفرج, **both Cairo West**, with
  September's 111.15 EGP already on روض الفرج. So approving either moves **zero** reported money —
  the map row was the only thing lagging. A summary that quotes the brick names alone makes the same
  pair look like two cross-area money moves.
- The neighbour test confirmed 3610 independently: **19 of 23** active map rows naming قرية سنطيس sit
  in Behira 1 (17 of them in دمنهور شبراخيت itself) and **33 of 33** sheet-address import rows naming
  it are in Behira 1 — one row anywhere sits in Behira 2. See
  [[a-villages-town-is-read-from-its-neighbours-bricks]].
- `sos_map_change_holds` has **no `distributor_code`/`customer_code` columns** — the pair lives in
  `entity_key` as `'<distributor> / <customer>'`, and `row_id` is the map row.
- With the guard triggers dropped, executing a ruling on one of these is a plain `update` that
  nothing holds; the lock must then be stamped by hand —
  [[a-third-brick-ruling-does-not-go-through-the-guard-rpc]].

**After approving one, the leftover contradictions are the OLD periods, and they are the customer
having moved rather than the map being wrong.** Executed 2026-10-10 at 02:54 Cairo on his ruling
"approve 3610 and 3611" (both `ok:true`, `locked:true`, `brickMove:null`, lock sources
`owner-ruling-2026-10-10-hold3610/3611`, confidence 100, and **zero pending holds left in the
system**). The contradiction count for the two customers then read **2 rows / 1,241.20 EGP** — both
**January**: ممتاز's 1,018.90 Head Office on أبو المطامير and الاندلس's 222.30 Anti Infective on
شبرا الخيمه. Neither moves a reported figure (Head Office reports nowhere, and شبرا الخيمه → روض الفرج
stays inside Cairo West), and January is not published. Tonight's five reconciles were cases where
the MAP was wrong; this is a customer the sheet re-filed between January and September, so
re-pointing January would rewrite its history to today's map — a separate ruling, not a tidy-up.
