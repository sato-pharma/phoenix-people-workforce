---
name: weekly-batch-header-drifts-from-its-own-rows
description: "weekly_sales_batches stores totals as columns written once at upload — healing a row later moves the row and never the header, and computeThisWeekOnly de-cumulates against that stale header"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6b612b65-4e36-471e-997c-1c2d24313b24
  modified: 2026-08-15T11:44:38.689Z
---

`weekly_sales_batches.total_sales_value` / `warning_rows` / `failed_rows` / `importable_rows` are
**stored columns written once at insert** ([service.ts:294]), not a view over the rows. Any later
mutation of `weekly_sales_rows` therefore silently desynchronises them.

**This is not cosmetic.** `computeThisWeekOnly` ([service.ts:117]) de-cumulates every later week of a
cycle against the PRIOR batch's stored `total_sales_value`, so a stale header distorts the
"this week only" figure on the upload screen for the rest of the cycle.

## Value drift — cause PROVEN, fixed 2026-08-15

`healUnresolvedWeeklyRows` rewrote `sales_value` on stored rows and never touched the header. Four
June Overseas batches understated sales:

| Week | Understated by |
| --- | --- |
| 2026-06-06 · 2026-06-13 | 4,592.70 each |
| 2026-06-20 · 2026-06-27 | 4,738.50 each |

One row did it: PS item `32328` → **Dopaminect 1mg** (`DO002`, 36.45). The alias was created
**2026-07-21**, a month after those June uploads, so healing priced the row long after the header was
written. The arithmetic matches to the cent — 126 × 36.45 = 4,592.70 and 130 × 36.45 = 4,738.50.

**Fixed both ways — LIVE on prod 2026-08-15 (#2156, squash `b3e0dc2c`), do NOT undo:**
`healUnresolvedWeeklyRows` now accumulates a per-batch delta and applies it to the header
(`accumulateBatchHeaderDelta`, exported and unit-tested — both assertions break-tested), and the four
June headers were re-derived from their rows. **Value drift is now 0 across all 51 batches.**

## Count drift — cause NOT explained, do not repeat the reasoning as fact

28 further batches carried `warning_rows` > 0 against **0** actual warning rows. I made the headers
agree with their rows, but healing does **not** explain it and I could not find what does:

- **No row anywhere is non-valid.** All 38,490 `weekly_sales_rows` are `validation_state='valid'`
  with zero `validation_issues`. If warning rows were ever persisted, an un-healed batch should still
  hold some.
- **IS week of 2026-08-12** (header claimed 42) was created 10:01 UTC, while the last IS alias change
  was 08:47 UTC — healing cannot reach rows that did not exist yet. Both `created_at` and
  `updated_at` are bumped by every alias write path, including bulk import ([product-aliases.ts:458]).
- Header and rows come from the **same** parse object ([service.ts:217]), so they cannot legitimately
  disagree at insert.

Most likely an earlier session bulk-updated `weekly_sales_rows` to clear warnings. Unverified.

**Old `warning_rows` values, for reversal** (every one had `failed_rows` 0 and `importable_rows` =
`total_rows`, so only this column changed): PS 06-06 `1`, PS 06-13 `1`, PS 06-20 `259`,
PS 06-27 `261`, IS 08-12 `42`, POS 08-11 `3`, IS 08-09 `89`, IS-S 08-08 `5`, PS 08-08 `7`,
IS-S 07-31 `6`, PS 07-25 `8`, IS-S 07-25 `6`, POS 07-21 `1`, IS-S 07-18 `6`, PS 07-18 `9`,
IS 07-16 `44`, IS 07-13 `43`, PS 07-11 `9`, IS-S 07-11 `6`, IS-S 06-27 `6`, IS 06-21 `42`,
IS-S 06-20 `6`, IS 06-14 `42`, IS-S 06-13 `6`, PS 05-30 `10`, IS-S 05-30 `7`, IS-S 05-23 `9`,
PS 05-23 `11`, IS-S 05-16 `9`, PS 05-16 `10`, PS 05-09 `10`, IS-S 05-09 `9`.

**How to apply:** never trust a weekly batch header as a summary of its rows without checking — and
if you mutate stored weekly rows by hand, move the header in the same statement
([[weekly-ignore-aliases-can-contradict-monthly-sos]], [[never-silent-drop-count-and-flag-instead]]).
