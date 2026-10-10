---
name: a-code-split-gives-the-new-code-to-the-unlocked-pharmacy
description: "When splitting a shared distributor code, the NEW `-2` code goes to the pharmacy whose rows are all in unlocked lines — then the whole split applies with no closing unlocked and no reported money moved"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
  modified: 2026-10-09T21:55:02.061Z
---

Splitting EP-PHS `22198955` looked blocked: one of its two pharmacies (ثابت محمد لافى - المرج) had
its only row in **Anti Infective, July 2026** — a published closing with an active lock — and
`phx_reject_write_to_locked_closing` sits on `source_of_sales_import_rows` as well as on the four
rollup tables, matched on (period, official_line). Re-coding that row would have been refused.

**The way through is to choose which pharmacy gets the new code by WHERE ITS ROWS ARE, not by which
name looks more like the owner of the code.** Zefta's five rows were all **Head Office**, which has no
lock line at all, so giving Zefta `22198955-2` meant every row that had to be touched was unlocked.
El Marg kept the bare code, its locked Anti Infective row was never written to, and **no closing
figure moved** — its brick was already `B12-10` / `CA4`, which is El Marg's own brick.

**Why:** the alternative (bare code to the pharmacy the map happens to point at today, as with
`22199672`) can put the re-code on the locked side and strand the whole split behind an unlock that
is the owner's click. The map row's current brick is not evidence of which pharmacy owns the code —
for `22198955` it had pointed at El Marg in July and at Zefta since 2026-09-10.

**How to apply, in this order:**
1. Back up the map row, the import rows and all five rollup layers into one `*_split_backup_<date>`
   table as `(src, payload jsonb)`.
2. INSERT the `-2` map row (the guard applies inserts), then re-code that pharmacy's import rows,
   fixing brick/area/region on the ones stamped with the other pharmacy's brick.
3. Only then UPDATE the bare code's map row to the remaining pharmacy's brick. It is **held silently**
   by `sos_map_guard_customer` (an empty `returning`, not an error) — find it in
   `sos_map_change_holds` and release with `sos_map_guard_decide_and_move_sales(id,'approved','B-10',true)`.
   🔴 The 4th argument is `p_lock` (stamp the mapping owner-locked), **not** "move sales": an approval
   ALWAYS calls `sos_move_brick_sales_after_hold`, which returns null unless the old brick's
   `superseded_by_brick_id` equals the new one — so for a split it moves nothing (`brickMove: null`).
   The approval applies brick/area but **not** the name: set `customer_name`/`address` in a second
   update, which the guard lets through because neither brick nor area changes.
4. The batch rebuild is still refused (it deletes the whole batch, which holds locked lines), so
   correct the rollups with targeted updates on the **unlocked** line only — directory, fact, channel
   (`client_key` too) and presence — then prove it by re-aggregating the import rows and comparing
   code, period, line, name, brick, area, region, units and row count side by side.

Result for `22198955`: `22198955` = ثابت محمد لافى - المرج, 2 units Saginko / 222.30 EGP, July Anti
Infective, Cairo East 2, untouched; `22198955-2` = رضا البسيونى -زفتى, 3 units July + 2 units August
Head Office, Gharbia 2 (Mahalla). Related:
[[epda-pharmacies-22199672-was-split-into-two-pharmacies]],
[[shared-distributor-codes-are-165-not-two]],
[[a-locked-closing-blocks-a-rollup-rebuild-on-an-unlocked-line]].
