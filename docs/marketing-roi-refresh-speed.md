# The hourly Marketing ROI rebuild: 5.4 seconds of disk reads for a list nothing reads

Measured 16 October 2026 in the slowness audit, fixed the same evening by migration
`20261016223000_marketing_roi_refresh_skips_through_periods.sql`. The rule is in
`.claude/rules/marketing.md`; the pin is `tests/marketing-roi-refresh-period-skip.test.ts`.

## What was slow

`public.phx_refresh_marketing_roi_facts()` — the bare call that the hourly pg_cron job
`phoenix-marketing-roi-refresh` (`20 * * * *`), the admin refresh and the normalizer make — averaged
**9.4 s over 58 calls (5.3–13.9 s)** in `pg_stat_statements`, the last slow database job the audit
had not yet answered.

## Where the time went

The bare-call branch begins by listing the distinct valid invoice periods:

```sql
select coalesce(array_agg(distinct invoice_period order by invoice_period), '{}') into v_affected_periods
from source_of_sales_import_rows where validation_state = 'valid';
```

That is an index-only scan of the partial index `sos_smi_valid_period_line_region_idx` — **~405,715
entries, 13,867 pages, about 108 MB** — to return eleven strings. Warm it costs 205 ms. The hourly tick
does not find it warm: one real call on production took **5,394 ms and read 14,106 blocks from disk**.

Everything the function exists to do is cheap. On a read-only copy of its CTE chain: the exact
attribution join (`exact_hits`) about 21 ms, the direct-order join (`direct_hits`) about 5 ms, and the
fact tables hold 3–64 rows each. The array is only **written** to
`marketing_roi_refresh_runs.affected_periods` (and into each fact row's `source_periods`); nothing in
the rebuild reads it, so the whole cost was bookkeeping.

`marketing_roi_refresh_runs.finished_at - started_at` is always zero (both are `now()` inside one
transaction), so that log cannot give a duration. `pg_stat_statements` (`track = top`) is the only place
the time shows.

## The change

One statement, inside the `p_batch_id is null` branch, becomes a recursive loose scan on the same index:
one probe per period (`order by invoice_period limit 1`, then `invoice_period > <last>`), **12 probes
(eleven periods and the one that finds the end), 53 buffer hits, 0.68 ms**. A valid row with a NULL period (none exist today) is still reported, as
one trailing NULL, because `array_agg(distinct … order by …)` sorts NULL last. The batch-triggered
branch already reads one batch through its own index and is untouched, as is everything after the
array: the advisory lock, the run rows, the deletes and the rebuild.

The rest of the function is byte-identical to `20261009150000_marketing_roi_facts_awaiting_data.sql`
(the file whose body production held); `SECURITY DEFINER`, `search_path = public`,
`statement_timeout = 60s` and the grant to `service_role` alone are unchanged.

## Proof the answer did not change

| | Before | After |
| --- | --- | --- |
| Production, one bare call | 5,394 ms, 14,106 blocks read from disk | **368 ms**, 189 blocks read |
| Production, the eight `marketing_roi_*_facts` tables | row counts 36 / 17 / 8 / 30 / 16 / 64 / 20 / 3 | identical counts and identical content |
| Production, run's `affected_periods` | 11 periods, `2026-01` … `2026-11` | identical |
| Staging, one bare call (warm) | 241 ms | 115 ms |
| Staging, the eight fact tables and `affected_periods` | 8 periods, `2026-01` … `2026-08` | identical |

"Identical content" means the md5 of each table's rows, rendered as JSON without `id`,
`refresh_run_id` and `calculated_at`, ordered — taken before and after on each project, with a fresh
rebuild by the old function immediately before the new one's.

The two forms were also compared in a throwaway temp table on staging across seven shapes — no rows,
only NULL periods, NULL mixed with real periods, an empty string, one period repeated, invalid rows
only, and invalid rows mixed with valid — and returned the same array every time.

## How it was applied

The Supabase MCP answered `{"status":"declined"}` on this SQL — the function body contains the rebuild's
own `delete from marketing_roi_*` statements, which the classifier reads as the statement being run. It
was applied with `scripts/apply-sql-file.mjs` (the standing route, `docs/migrations.md`), staging first,
then production with `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com`. That route writes no
ledger row, so the file has an evidenced entry in `ACKNOWLEDGED_EXCEPTIONS`
(`scripts/lib/migration-inventory.ts`): `md5(pg_proc.prosrc)` is `c8d100c116c188021443fa91f0b32c90` over
30,659 characters on both projects, equal to the file's own body.

Applying and testing it added two `admin_manual` rows to `marketing_roi_refresh_runs` on production (the
audit's timing run, then the new function's first run). They are real rebuilds, the same work the hourly
job does, and the fact tables ended identical to before.

## Rollback

Re-apply `20261009150000_marketing_roi_facts_awaiting_data.sql`. Its body digests
`e0219a05d76db904f1e324561b969782` (LF-normalised); production stored it with CRLF
(`bad8ea66782c00ccc6e12d1ce7755875`, 29,721 characters).

## What to check later

`pg_stat_statements` for the statement `select public.phx_refresh_marketing_roi_facts()` should show a
mean far below the old 9.4 s once the calls made since this change outnumber the old ones — the
cumulative counters still carry the earlier calls, so compare against the baseline capture of
16 October 2026 (20:44 Cairo) rather than the raw mean.
