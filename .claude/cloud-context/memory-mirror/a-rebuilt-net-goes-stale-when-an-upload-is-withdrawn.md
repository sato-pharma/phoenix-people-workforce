---
name: a-rebuilt-net-goes-stale-when-an-upload-is-withdrawn
description: "A store-split net rebuilt minutes after a book lands is stale the moment that book is withdrawn, and NOTHING re-runs it — it is keyed without a batch_id, so no cascade touches it and no timer refreshes it; September 2026 was withdrawn twice on 2026-10-09 and the second one left 492 frozen cells against 449 live (179,956.14 EGP of area movement by valuation) until his \"rebuild the September net now\" at 21:31 Cairo. A publication row with unpublished_at set still counts as a row — count LIVE ones."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T18:35:41.000Z
---

**2026-09's net was written three times in twenty minutes on 2026-10-09, and each count is a
different fact:**

| Cairo | rows | Pedia | Anti Infective | CNS | why |
| --- | --- | --- | --- | --- | --- |
| 19:35 | **423** | 87 | 47 | 289 | applied from the PRIMARY at `077e838dd` — no twelve stems, no طاى جروب, no `تامين` ([[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]]) |
| 19:40:31 | **492** | 130 | 53 | 309 | current code, **and the EPDA-BULK book that landed at 19:40:22** |
| 19:56 | **449** | 87 | 53 | 309 | current code after that book was withdrawn at ~19:47 |

**Why:** the EPDA-BULK September batch (`c3e732e2`, 52 rows / 9,723 units / 1,082,980.26 EGP) was
uploaded at 19:40:22 and gone from `source_of_sales_import_batches` by 19:47, with **nothing in
`sales_audit_logs` or `system_audit_logs` recording the removal** — the owner pulling the book over a
unit discrepancy. Nine seconds of overlap was enough for a rebuild to freeze its IVYRONC Pedia
spread: **43 Pedia cells and 140,339.41 EGP of area movement** (Qalubeya −58,524.63, Cairo East 2
+57,605.58, Dakahlia 1 +54,248.67, Qena 1 +23,925.94), CNS and Anti Infective untouched because the
spread is Pedia-only.

**How to apply:** a net count is only ever true of one base — **say which books were in when you
quote it**, and re-read the batch list before trusting a number minutes old. The staleness is
invisible to the units-based publication drift check (every line's total units agree, by
construction) and is harmless while the period has **no live publication row**, because
`isFrozenStoreSplitPeriod` then returns false and every read recomputes live; the exposure is the
moment he publishes. `check-store-split-drift.ts` is what exposes it — "frozen 492 cells vs live
449" — and it must run from a tree on `origin/main`. Related:
[[publishing-one-line-freezes-the-whole-periods-store-split-net]],
[[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]],
[[epda-bulk-is-allocated-like-office-on-pedia-from-september-2026]].

🔴 **AND THE REBUILDS ARE NOT SESSIONS — THE IMPORT PATH MAINTAINS THE NET ITSELF, ~15 SECONDS AFTER
EVERY UPLOAD, WITH PRODUCTION'S OWN CODE.** Measured the same night: the net was stamped 19:40:31
(EP-BK landed 19:40:22) and again 20:11:06 (the Office/Marcyrl book landed 20:10:51), and
`au.monthly_attribution_rollup_meta` for 2026-09 carries the same 20:11:06 — the rollup re-stamps with
it. So a manual `backfill-attribution-store-split.ts --apply` is **not** how a landed book reaches the
net, and the owner's "rebuild when the Office book lands" is satisfied by the upload itself; the one
gap the pipeline cannot close is a **WITHDRAWN** batch, which leaves the last import's net frozen in
place with nothing re-running (19:47 → 19:56 on 2026-10-09, 140,339.41 EGP of Pedia). Check
`check-store-split-drift.ts` after a withdrawal, not after a landing. Tonight's three manual applies
were each overwritten by the next import within minutes.

🔴 **IT HAPPENED A SECOND TIME THE SAME NIGHT, AN ORDER OF MAGNITUDE BIGGER, AND THE REASON NOTHING
CASCADES IS THE KEY.** `au.monthly_store_split_net` is keyed `(period, line_code, area_code,
product_code)` and carries **no `batch_id` at all**, so deleting a batch can never reach it. The
re-uploaded EPDA-BULK book (20:02, batch `282d836b`) was withdrawn at about 21:2x Cairo over its
cleared `is_bonus` column, and the 492 cells stamped **21:00:21** — written by the customer-map
re-resolution, not by a session — stayed behind holding that book's units: **56 cells across 46
line x area pairs, 492 frozen against 449 live**, worst pairs all Pedia (D11 -75,607.17,
CA4 +68,882.42, D21 +64,422.54, UE7 +28,162.77, UE5 -21,227.98 = Sohag 1).

- 🔴 **THE EGP IS A VALUATION, NOT MONEY IN THE TABLE.** The net holds `net_qty` and
  `net_effective_units` only — no value column — so "179,956.14 EGP ends up on a different area" is
  those cells priced, and must be said that way to him.
- 🔴 **NOTHING REFRESHES IT ON A TIMER.** `refreshAttributionStoreSplit` is reached only from the
  import, the normalizer mapping and customer-map paths, and `source-of-sales-rollup-rebuild` — no
  cron, no Actions workflow. So "an upload fixes it by itself" is true, and "it will fix itself" is
  NOT: with no further upload the staleness is permanent.
- 🔴 **THE APP'S OWN WITHDRAWAL LEAVES THE SAME HOLE.** `deleteSourceOfSalesUploadBatch` checks the
  period lock, deletes the batch and writes an audit row — and does not refresh the net. This is the
  normal consequence of any withdrawal through the UI, not an artefact of doing it in SQL.

**Repaired on his word** — *"rebuild the September net now"*, 2026-10-09: pre-image copied to
`public.msn_202609_backup_20261009` (492 rows), dry run first, then
`backfill-attribution-store-split.ts --apply 2026-09` wrote **449 rows at 21:31:39 Cairo** with
`sum(net_qty)` and `sum(net_effective_units)` both exactly 0, then
**`au.f_refresh_monthly_attribution('2026-09')` — the single-period re-stamp, deliberately NOT
`f_rebuild_monthly_attribution_all()`**, which the script suggests but which rebuilds every period
and is a separate operator decision. Post-proof from the drift script: *"no drift. 449 frozen cells
match the rule."*

🔴 **AND DO NOT TEST "IS IT PUBLISHED" BY COUNTING `monthly_closing_publications` ROWS.** 2026-09
holds **one** row — Anti Infective, published 2026-10-05 — with `unpublished_at` set to 18:12 Cairo
on 2026-10-09 by `b-10`. A row count therefore says "published" about a period that is not, which
would have read `phx_write_monthly_store_split_net`'s silent 0-row refusal into a month where the
write was in fact free to proceed. Count rows whose `unpublished_at IS NULL`, which is the same test
the write function makes. [[publishing-one-line-freezes-the-whole-periods-store-split-net]]

🔴 **A BRICK RELOCATION IS THE THIRD PATH THAT LEAVES THE NET STALE, AND IT IS THE ONE WITH NO
SELF-REPAIR.** Verified in the tree at `69354b489`: `app/api/sales/database-mapping/bricks/[key]/relocate`,
`src/lib/sales/master-data/brick-moves.ts` and `import-service.ts` contain **no reference to the
store split or attribution at all**. The only writers of the net are
`attribution-store-split-refresh.ts`, `closing-bulk-allocation.ts`, `monthly-distributor-import.ts`,
the normalizer's `customer-map.ts` / `mapping.ts` / `service.ts`,
`source-of-sales-rollup-rebuild.ts` and the backfill script — a relocate reaches none of them. So
moving a brick between areas moves the units and leaves the net describing the old geography, with
nothing queued to fix it. That is why the owner's standing order on 2026-10-09 was *"rebuild the
September net after the Sohag bricks"*: it is not belt-and-braces, it is the only repair.

**The three Sohag bricks, by their real identity** (as of 2026-10-09 they were still UNAPPLIED —
`updated_at` 2026-07-28, and `source_of_sales_brick_move_files` held 0 moves in six hours):

| brick_id | brick_name | block | area now | he intends |
| --- | --- | --- | --- | --- |
| `B213-1` | مدينة سوهاج (Sohag City) | B213 | `UE5` Sohag1 | → Sohag2 |
| `B213-3` | بلصفورة (Balasfora) | B213 | `UE5` Sohag1 | → Sohag2 |
| `B214-2` | العسيرات (El Osairat) | B214 | `UE6` Sohag2 | → Sohag1 |

- 🔴 **SEARCHING FOR THEM BY LATIN NAME FINDS NOTHING.** `brick_name` is Arabic, so
  `ilike '%sohag%'`, `'%osairat%'` and `'%balasfora%'` each return 0 rows across
  `source_of_sales_bricks`, `source_of_sales_blocks` and `geo_bricks` — which reads as "these bricks
  do not exist" and makes a peer's correct ids look wrong. Query by `brick_id`, or by `block_code`.
- 🔴 **`area_code IS DISTINCT FROM source_area_code` IS NOT A MOVED TEST.** `source_area_code` is
  NULL on every one of these rows, so that expression returns **true for all seven bricks in B213
  and B214** — a clean false positive. Compare `area_code` against the intended target instead.

🔴 **AND THE NET CAN BE REWRITTEN WITH NO AUDIT TRAIL.** After the 21:31:39 apply the net was
rewritten again at **21:34:23**, three minutes later, with **no upload after 20:10:51**, nothing in
`sales_audit_logs` between 21:25 and 21:45, and `au.f_refresh_monthly_attribution` proven not to
touch the net (`pg_get_functiondef` holds no reference to `monthly_store_split_net`). Row count
stayed 449 and a re-measure from a certified tree read *"no drift. 449 frozen cells match the
rule."* So an unattributable rewrite is survivable — but never assume the stamp you read is the one
you wrote, and re-measure rather than reasoning from your own apply time.


🔴 **AND THE FOURTH PATH IS A CODE CHANGE TO THE RULE ITSELF — THE ONE NOTHING IN THE PIPELINE CAN
EVEN NOTICE.** Re-read on 2026-10-09 at ~22:45 Cairo from a tree holding `origin/main` 6f3debd85,
after PR 5702 ("September's Office split recalculates like October") merged and after a peer session
released the six Sohag customer-map holds: **492 stored cells against 732 the rule now says, 490
cells across 49 line x area pairs, 938,579.63 EGP landing on a different area**, sum of differences
−0.00 and every line's unit total agreeing — so the units-based publication drift check is blind to
all of it by construction. Worst pairs CA5 −482,704.23 / CA3 +418,126.96 / CA4 +157,348.48 /
CA6 +50,884.35 (the Office recalculation) and UE5 −236,479.96 / UE6 +220,361.45 (the Sohag moves),
D11 −118,520.20.

- 🔴 **A MERGE CAN STALE THE NET, AND NOTHING FIRES BECAUSE THE *RULE* CHANGED — BUT THE NEXT RE-MAP
  OR UPLOAD DOES REPAIR IT, because every writer recomputes the WHOLE period from production's
  current code.** Measured 2026-10-09: the 492-cell net left stale by PR 5702 at 22:45 was rewritten
  to **732 cells at 23:17:22 Cairo** by a customer-map re-resolve (no upload after 21:46:35), the
  attribution rollup re-stamped 23:17:23, and `check-store-split-drift.ts 2026-09` from a tree at
  `origin/main` 6bd222830 read *"no drift. 732 frozen cells match the rule."* So after a rule PR
  **MEASURE before rebuilding** — his "rebuild September's store split" was already satisfied, and a
  manual `--apply` would have rewritten 732 production rows to identical values. What stays true: with
  NO further data path firing the staleness is permanent, so the drift script is still the only alarm.
  The eight writers are all data paths; none of them fires because the *rule* changed. So after any PR that
  moves the split or the Office respread, `check-store-split-drift.ts <period>` is the only thing
  that will say so — and it must run from a tree carrying that PR, or it compares the stored net
  against the OLD rule and reports a clean month.
- **Harmless until he publishes, by exactly the same mechanism as the withdrawal case:** 2026-09 held
  0 LIVE publication rows (the one Anti Infective row carries `unpublished_at` 16:12 Cairo), so
  `isFrozenStoreSplitPeriod` is false and every closing read recomputes live. The exposure is the
  publish, which freezes whatever is stored.

**Repaired again on his word — *"rebuild the September net now"*, 2026-10-10 ~01:05 Cairo.** Pre-image
of the 479 live rows to `public.msn_202609_backup_20261010`, dry run, then
`backfill-attribution-store-split.ts --apply 2026-09` wrote **732 rows at 01:07:42** with
`sum(net_qty)` and `sum(net_effective_units)` exactly 0, then
`au.f_refresh_monthly_attribution('2026-09')`, which re-stamped
`au.monthly_attribution_rollup_meta` at 01:07:46. Post-check: *"no drift. 732 frozen cells match the
rule."* Cells by line: **cns 549 / pedia 130 / anti_infective 53**.

- 🔴 **492 WAS ALREADY TWO GENERATIONS STALE WHEN TWO SESSIONS WERE QUOTING IT.** The row count read
  492 at 22:45, **479 at 00:02:25** (written by something neither session did) and 732 after the
  rebuild. A net count is a reading, not a fact: re-read `count(*)` and
  `max(computed_at) at time zone 'Africa/Cairo'` in the same breath as quoting one.
- 🔴 **`computed_at` IS A `timestamptz`, SO `at time zone 'UTC' at time zone 'Africa/Cairo'` READS
  THREE HOURS EARLY** — it strips the zone and then re-interprets the naive value as Cairo. It
  printed `18:02:25` for a row written at `00:02:25`, which reads as "nothing has touched this since
  the evening". One conversion only: `max(computed_at) at time zone 'Africa/Cairo'`.
- **The column is `computed_at`, never `updated_at`** — and in this MCP a multi-statement call is one
  transaction, so a `create table … as select` followed by a select naming a wrong column rolls the
  BACKUP back too and prints only the column error. Take the pre-image in its own call and prove it
  with its own count.
