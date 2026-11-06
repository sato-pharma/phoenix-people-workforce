# The 1,000-row ceiling

Owner, 7 Nov 2026: "audit any 1000 row cap anywhere and remove this trap cap, and never risk data being unread because of this cap."

## What the trap is

PostgREST stops a response at its `max-rows` setting and says nothing: no error, no marker in the body.
The Supabase default is 1,000. A read over a table that holds more loses every row past the cut, and the
page that built on it looks complete.

## Where the ceiling really is

| Place | Ceiling | How it is known |
| --- | --- | --- |
| Production API (`ozucdzovmcqvepbozvqf`) | **None.** One unpaged `select=id` on `source_of_sales_customer_map` returned 105,103 rows, and on `phoenix_crm_visits` 79,792 | Read-only probe, 7 Nov 2026. Earlier probes agree: 52,614 rows on 2026-08-18, 143,671 on 2026-10-22 |
| Staging API | 1,000 (`206`, `content-range: 0-999/66109`) | One read-only probe on 7 Nov 2026, before the owner ruled staging out of this work. Nothing on staging was changed |
| `supabase/config.toml` `max_rows = 1000` | Local stack only, which nobody runs | `tests/phoenix-crm-wave2-reports.test.ts` pins it; leave it |
| Production database functions, views, materialized views | No `limit 1000` in any of them | `pg_proc.prosrc`, `pg_views`, `pg_matviews`, 7 Nov 2026 |

The production setting lives in the Supabase dashboard, not in this repository, and a restored or recreated
project comes back with the default. So the code must not depend on it being unset.

## What was removed

Production being uncapped did not save the reads that capped themselves: a `.limit(1000)`, a
`ROW_LIMIT = 1000`, a `maxRows: 1_000`. Those cut a read on an uncapped server too. Every one that read
real rows was moved onto the shared pagers in `src/lib/supabase/paginated.ts` (`fetchAllRows`,
`fetchAllRowsKeyset`) or `rpcAll`, which end only on a short page.

## What now stands guard

1. **The ratchet** — `tests/row-cap-ratchet.test.ts` refuses a new hard 1,000 in `src/` or `app/`
   (`.limit(1000)`, `.range(0, 999)`, `limit: 1000`, `maxRows: 1000`, a `ROW`/`LIMIT`/`CAP`/`CEILING`
   constant set to 1000). A line that is not a read is allowed only when it is written into `EXEMPT` with
   its reason, keyed by file and exact line, so editing it sends it back to be judged. A string
   `.slice(0, 1000)` is not covered: text truncation is everywhere and indistinguishable from a row cut by
   pattern.
2. **The tripwire** — `src/lib/supabase/row-cap-watch.ts`, called from the shared client's `fetch` in
   `src/lib/supabase/server.ts`. A GET that sent no `limit`, `offset` or `Range` and came back
   `Content-Range: 0-999/…` logs `PostgREST read ended at the 1,000-row ceiling`
   (`event: supabase_row_ceiling`, the table name only, once per table per ten minutes). `proven: true`
   means the server itself reported more rows than it sent; `proven: false` (`/*`) may be a table that holds
   exactly 1,000. It reads headers only and never throws.

## How to probe the live ceiling

Read-only, production only, no key printed: one `GET /rest/v1/<big table>?select=id` with the service key
and `Prefer: count=exact`, then compare `returned` with the total in `content-range`. A `206` with
`0-999/<N>` is a cap; a `200` with `0-<N-1>/<N>` is none.

## Rules that follow

- Never write a hard 1,000. A read that can exceed it pages with a unique tiebreak and ends on a short page.
- A deliberate budget (`maxRows` with `whenFull: "stop"`) is allowed only when it says aloud that the data
  is partial, and never at 1,000.
- A new full-table read uses `fetchAllRowsKeyset` when the table is written while it is read.
