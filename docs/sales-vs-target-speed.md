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

This behaviour existed before this change, and this change does not touch it. Serving a published
month from its frozen totals instead would be the owner's decision, not a speed fix. The fix below
only makes the live path faster.

Measured after the apply, on 16 Oct 2026 at 19:2x Cairo, the live recompute and the frozen rollup were
**identical** for all three months on every line: 0 rows differed. For example, September CNS was
11,885,444.55 both ways. So today the live path recomputes figures that are already stored.

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

## Two edges left on purpose

- **A month over 1,000 rows pays twice.** PostgREST caps a response at 1,000 rows, so `rpcAll`
  (`src/lib/supabase/server.ts`) fetches the remainder with a second call, and that call runs the
  function again. September 2026 returns 978 rows. If a month crosses 1,000, its read time doubles.
- **The freshness stamp costs about 35 ms a page.** `phx_sales_vs_target_cache_token` ran 2,422 times
  at a 53 ms mean (35 ms warm). Of that, 16 ms is hashing the 4,615 `au.monthly_targets` rows and
  9 ms is the configuration fingerprint. Making it near-free means trigger-kept version counters on
  eight tables. That changes how freshness is tracked, so it is not a speed-only rewrite and was left
  out.

## Applied

- Staging (`cifwmndunmlxjhyjugxa`): 16 Oct 2026, ledger version `20261016161005`. Staging's previous
  body was `20260929191509` with its comments intact (md5 `bfb3e89b…`); production's was the same file
  with comments stripped (md5 `8eec7403…`).
- Production (`ozucdzovmcqvepbozvqf`): applied on 16 Oct 2026 at 19:21 Cairo, ledger version
  `20261016162121`.
  - `md5(prosrc)` is `b69a9e6269cdbd91d43e6d342562dab8`, the file's body as-is (LF).
  - The ACL is unchanged: `postgres` and `service_role` only.
  - The whole output was fingerprinted immediately before and after the apply, and both fingerprints
    are identical:

    | Output | Rows | md5 |
    |---|---|---|
    | `phx_sales_vs_target_range('2026-01','2026-11')` | 9,000 | `5ec33c5254f831dae091746de305d83e` |
    | `au.f_monthly_attribution`, 2026-01 to 2026-11 | 8,029 | `e2bc486a521651a801c28c410ee3e1b8` |

## The page's own call, before and after (production)

| Call | Before (warm) | After (median of 7) |
|---|---|---|
| `phx_sales_vs_target_range('2026-07','2026-07')` | 390 ms | 147 ms |
| `phx_sales_vs_target_range('2026-08','2026-08')` | 396 ms | 145 ms |
| `phx_sales_vs_target_range('2026-09','2026-09')` | 409 ms | 167 ms |
| `phx_sales_vs_target_range('2026-10','2026-10')` | 30 ms | 27 ms |
| `phx_sales_vs_target_range('2026-07','2026-10')` | 1,287–1,345 ms | 481 ms |

The app asks for one month per call (`src/lib/sales/vs-target.ts`), so a page showing July to October
pays the sum of the single months: about 1.2 s before and about 0.49 s after.
