---
name: pos-pharmacy-codes-are-zero-padded
description: "POS is the only distributor that zero-pads customer codes to 10 digits (61% of the marketing reference DB); compact_pharmacy_code is LIVE on prod 2026-08-16, do not undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69f8029e-430e-4d8b-af70-339c26aa837e
  modified: 2026-08-16T05:24:08.380Z
---

**POS — and ONLY POS — exports its customer codes zero-padded to 10 digits.** Measured on
production 2026-08-16 over `marketing_pharmacy_code_references` (45,414 rows):

| Distributor | rows | zero-padded |
| --- | ---: | ---: |
| POS (id 19) | 27,612 | **27,611** |
| Ibn sina (17) | 13,249 | 0 |
| EGD (14) | 1,807 | 0 |
| everyone else | 2,746 | 0 |

So pharmacy 1503246 is stored as `0001503246`, and Customer Validation's vendor-code check —
exact string equality after only trim+lowercase — reported it "not in the Phoenix database". For
the largest distributor the badge could effectively never say "tracked". Same padding in the SoS
master map (`source_of_sales_customer_map`, distributor_code `PS`) and in the raw POS
"customer sales" xlsx exports.

**LIVE on prod 2026-08-16 (migration `20260816050358`, PR #2173) — do NOT undo:** generated stored
column `compact_pharmacy_code` (leading zeros stripped, **purely numeric codes only**) plus index
`marketing_pharmacy_code_refs_compact_lookup_idx (distributor_id, compact_pharmacy_code)`.
Verified live: column generated, index valid 1424 kB, 0 empty keys, index scan 6 buffers / 0.180 ms.

**Why it is safe and must stay that way:** stripping zeros collapses NOTHING inside a distributor —
0 collision groups across all 45,414 rows (35 keys repeat *across* distributors, which cannot bite
because every lookup is scoped by `distributor_id`). Re-check that count before widening the rule.

**Two traps for anyone touching this:**

1. **The resolver is TWO-PASS on purpose.** Exact first, zero-stripped only where exact found
   nothing. Never collapse it to a single compact pass — exact-first is what guarantees no code
   that matches today can change verdict, and `ambiguous` on a future collision instead of a guess.
   Do NOT re-add a `compactCode === normalizedCode` early-return: that skips pass 2 in exactly the
   reported case (the rep types the short form, the STORED row is the padded one). That bug was in
   the first version of the fix and the regression test caught it.
2. **What gets STORED must be the code the sales data carries, not what the rep typed.** ROI
   attribution joins `normalized_pharmacy_code` with exact string equality (migration
   `20260808231742`, line 159), so fixing only the lookup makes the badge read "tracked" while ROI
   reads zero forever. Both write paths (`createMarketingValidationRecord` and
   `roi-sheet-writer.ts`) store `reference.canonicalCode`; the rep's own entry stays in
   `distributor_pharmacy_code`. ROI math itself is unchanged.

`compact_pharmacy_code` (SQL) and `compactNumericCode` (TS) must agree or the indexed lookup
silently returns nothing — `tests/marketing-pharmacy-code-compact.test.ts` pins both.

NOT affected: the direct-orders match path — its customer code comes from the trigram suggestion
picker and is passed through verbatim, never typed.

**The already-saved backlog was REPAIRED on 2026-08-18 — owner-approved, do not redo.** The note
here used to say 2 of 293 rows were left untouched because rewriting stored links was the owner's
data decision, not a side effect of a search fix. He made that call on 2026-08-18: by then the
backlog had grown to **5 rows** (codes 1533787 x2, 1503246, 1507381, 1560637 — all POS), each
rewritten to its padded canonical code with `reference_status=matched`, `reference_match_count=1`
and the real `reference_id`, and the now-false "sales cannot be tracked" sentence stripped from the
5 links while the desk/on-behalf note on 3 of them was preserved. Verified after: 0 stale rows, 0
links still claiming untracked, 285 matched / 20 unmatched, all 5 joining the reference table by the
exact equality ROI uses. Rollback SQL was written to the session scratchpad only, NOT to a
`zz_backup_` table (those are anon-readable). **Any row still reading `not_found` today is a
genuine gap — the code is absent from the reference database entirely — not padding drift.**

Related: [[sos-bricks-are-the-authority-for-branch-to-area]],
[[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]],
[[every-db-round-trip-crosses-the-atlantic]]
