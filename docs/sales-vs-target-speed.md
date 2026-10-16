# Sales vs Target: why published months were slow, and the fix

Measured on production (`ozucdzovmcqvepbozvqf`) on 16 October 2026. Migration:
`supabase/migrations/20261016193000_monthly_attribution_groups_fact_rows_first.sql`. Test:
`tests/monthly-attribution-groups-fact-rows-first.test.ts`.

## The call chain

```
phx_sales_vs_target_range(from, to)        one call per month from the app (vs-target.ts)
  -> au.f_sales_vs_target_range            loops the months
    -> au.f_monthly_achievement(period)
         rollup fingerprint matches today's configuration -> read au.monthly_attribution_rollup (fast)
         otherwise -> au.f_monthly_achievement_live -> au.f_monthly_attribution (slow)
```

## Why July, August and September were always slow

`au.f_refresh_monthly_attribution` refuses a published month, so its rollup is frozen. The rollup
records the configuration fingerprint it was built under. Any later configuration change (an area
move, a store-split rebuild) changes today's fingerprint, and from then on the frozen month never
matches again: `au.f_monthly_achievement` recomputes it live on every read.

On 16 October all three published months were on that path:

| Month | Rollup fingerprint matches | Published | `au.f_monthly_achievement` |
|---|---|---|---|
| 2026-06 | yes | no | 44 ms |
| 2026-07 | no | yes | live |
| 2026-08 | no | yes | live |
| 2026-09 | no | yes | 378 ms |

Those are exactly the months Sales vs Target, Targets and the Business Review show, so almost every
read of those pages paid the live path three times.

This is not a defect in the freeze. The live path returns today's computation for a published month,
and that is what these pages show today. The fix below keeps it that way and only makes the live path
faster.

## Where the time went

`au.f_monthly_attribution('2026-09')` took 338 ms of the 378 ms. Of that, 255 ms was its `priced`
step:
- 31,990 fact rows were read for the month;
- each one went through `upper(btrim(...))` for the product code (three times: the exclusion filter,
  the folded code and the price join) and `lower(btrim(...))` for the line name.

Those rows fall into only 1,079 distinct raw (line, region, area, product, direct) combinations, and
every one of those text functions depends on the raw keys alone.

## The fix

A new `fact_raw` step sums `total_qty`, `effective_units` and `direct_value` per raw key combination
first. The cleanup then runs on about 1,100 groups instead of about 32,000 rows. Nothing else in the
function changed.

Why no figure can move:
1. All three amounts are `numeric` with scale 6, so sums and products are exact: a sum of group sums
   equals the sum of the rows, digit for digit, scale included.
2. Every key a later step joins or groups on is a function of the five raw keys.
3. Every later use of these rows is a sum. A count, average, minimum, maximum or distinct would see
   fewer rows; the body has none, and the test refuses one.

## The proof, before applying

The new body ran as a temporary function on production and was compared with the live function:
- all eleven months, 2026-01 to 2026-11;
- every row cast to text (all sixteen columns, so a decimal-scale difference would also count),
  compared with `except all` in both directions.

| Check | Live function | New body |
|---|---|---|
| Rows | 8,029 | 8,029 |
| Rows without a twin on the other side | 0 | 0 |
| Value total | 103,780,161.54034000048… | 103,780,161.54034000048… |
| Units total | 1,264,299.820002000002… | 1,264,299.820002000002… |

## Speed, per month, warm (same session, second run of each)

| Month | Before | After |
|---|---|---|
| 2026-01 | 334 ms | 120 ms |
| 2026-02 | 318 ms | 104 ms |
| 2026-03 | 300 ms | 112 ms |
| 2026-04 | 312 ms | 109 ms |
| 2026-05 | 316 ms | 110 ms |
| 2026-06 | 440 ms | 160 ms |
| 2026-07 | 303 ms | 110 ms |
| 2026-08 | 337 ms | 123 ms |
| 2026-09 | 494 ms | 191 ms |
| 2026-10 | 25 ms | 19 ms |
| 2026-11 | 20 ms | 25 ms |

What remains in the ~110 ms is mostly the exact-decimal summing of the ~32,000 rows (about 32 ms) and
the fixed seat and price lookups. Going lower means a stored, maintained copy of the published months'
live result, which is a change in how freshness works, not a speed-only rewrite.

## Applied

- Staging (`cifwmndunmlxjhyjugxa`): 16 Oct 2026, ledger version `20261016161005`. Staging's previous
  body was `20260929191509` with its comments intact (md5 `bfb3e89b…`); production's was the same file
  with comments stripped (md5 `8eec7403…`).
- Production: see the PR.
