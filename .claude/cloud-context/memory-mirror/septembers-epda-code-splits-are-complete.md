---
name: septembers-epda-code-splits-are-complete
description: "September 2026 now has ZERO tracked-line sales credited to the wrong pharmacy — 15 EPDA codes split into new `-2`/`-3` codes on 2026-10-10, 24 rows re-coded, and the whole batch rollup chain rebuilt in 29s because September is unlocked AND unpublished"
metadata:
  node_type: memory
  type: project
---

His instruction, 2026-10-10 ~01:20 Cairo: *"split the 12 EPDA codes with September Pedia sales"*.
Delivered, plus three more the first test could not see (below). Backup:
`epda_sep_split_backup_20261010` on production — map rows, every period's import rows for the codes,
and all six batch layers of `cf39e412-e961-40b8-a657-3d8df051cb7b`.

**15 new codes, 24 September rows re-coded**, all in that one EP-PHS batch: `22198125-2` 6 أكتوبر ·
`22198277-2` اوسيم · `22198743-2` الباجور · `22199004-2` بهتيم · `22199104-2` بيجام and
`22199104-3` ابو سليمان (one code, THREE pharmacies) · `22199171-2` تلا · `22199245-2` كرموز ·
`22199283-2` الفلكى · `22199376-2` قويسنا · `22199592-2` محرم بك · `22199626-2` طنطا ·
`22198291-2` سيدى بشر · `22199563-2` مصطفى كامل · `22199700-2` العامرية. Moved: **938.25 EGP of
Pedia (26 units)** across nine areas and **8,673.48 EGP of Head Office**, which no closing, weekly
or achievement reads. `22198079` could NOT be split — its second shop sold only in a locked April.

🔴 **THE FULL BATCH REBUILD IS AVAILABLE ONLY WHEN NO LINE OF THAT MONTH IS LOCKED, AND SEPTEMBER
WAS BOTH UNLOCKED AND UNPUBLISHED** (read live: no active `monthly_closing_locks` row; Anti
Infective published 2026-10-05 then unpublished 2026-10-09 16:12; CNS and Pedia never published). So
`refreshBatchRollups` could run whole instead of the targeted rollup surgery
[[a-code-split-gives-the-new-code-to-the-unlocked-pharmacy]] needed in July — **26.3s and 29.4s,
first attempt both times, for a 1,388-row batch**, run as a scratchpad script against
`@/lib/sales/normalizer/customer-map` with `--env-file-if-exists=.env.local`. Its chain has a TS step
(`writeStoreSplitNetForBatch`), so pure SQL cannot reproduce it.

**The proof that it is right is the invariant plus the ledger.** Batch totals identical either side —
4,585 units, 1,388 rows, channel value 944,224.425, summaries 4,721,122.125 — while the per-area
deltas summed to zero on each line and matched the 24 rows one for one; fact, directory and channel
rollups showed **zero mismatches** against a re-aggregation of the import rows. Channel/presence rows
651→654 and distributor-product 34→36 are the arithmetic of 14 new (code, line) keys against 11 that
emptied, and of Pedia newly appearing in AB3 and GZ7.

🔴 **THE WITHIN-MONTH TWO-NAMES TEST HAS A BLIND SPOT: A MONTH WHERE ONLY THE INTRUDER SOLD SHOWS ONE
NAME.** It is how the first sweep said "12" when September held 15. The test that actually finds them
compares each row's folded `client_name` to its ACTIVE map row's folded `customer_name` — that found
`22198291`, `22199563` and `22199700` (121.50 EGP of Pedia) hiding behind a single September name
each. Run that one, never the name-count, before calling a month clean.

**Where it stands now.** September: **0 tracked-line rows disagreeing with the map** (150 rows /
82,824.66 EGP across 92 codes remain on **Head Office only**, which reports nowhere). Still mis-credited
and waiting on his unlock, because their months are locked and published: Feb 4,431.15 · Mar 2,160.00 ·
Apr 1,032.30 · Jun 603.45 · Jul 1,572.30 · Aug 1,620.00 = **11,419.20 EGP over 27 rows**. Related:
[[a-shared-codes-address-is-looked-up-by-code]], [[shared-distributor-codes-are-165-not-two]],
[[epda-pharmacies-22199672-was-split-into-two-pharmacies]],
[[a-locked-closing-blocks-a-rollup-rebuild-on-an-unlocked-line]].
