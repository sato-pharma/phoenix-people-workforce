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

