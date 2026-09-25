---
name: weekly-dashboard-keyset-pagination-applied-2026-08-14
description: "loadWeeklyDashboard pages weekly_sales_rows by KEYSET (id > lastId), not count-exact+OFFSET; applied to prod #2107, do not redo/undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-13T22:42:49.222Z
---

`loadWeeklyDashboard` in [service.ts](src/lib/sales/weekly/service.ts) pulls the whole batch
window into memory to aggregate, paging `weekly_sales_rows` 1,000 rows at a time. **Shipped
2026-08-14 (PR #2107, merge `b84e5f4c`, verified live on Railway) — do NOT redo or undo.**

**Was:** `count:exact` on page 0 then remaining pages by OFFSET, fetched concurrently via `asyncPool`.
With a large batch window (allWeeks / product-scope) there is NO index yielding `batch_id = ANY(...)`
in `id` order, so `ORDER BY id` forced a full `weekly_sales_rows_batch_idx` scan of ALL matching rows
+ a ~10.8MB quicksort **on every page** (~81ms), repeated ~36×/load. Measured: this one statement was
6.8M ms / 80,623 calls / 84.5ms mean = **12.4% of ALL prod DB time, 84% of weekly_sales_rows' time**.

**Now:** keyset — `WHERE id > lastId ORDER BY id LIMIT pageSize`. PK index resumes where the last page
ended, stops after pageSize matches: **2.35ms/page vs 81.5ms (35×)**. `count:exact` dropped (only drove
OFFSET math). `asyncPool` import removed (this was its only consumer; the util + its tests stay).

**Precondition the correctness rests on:** `weekly_sales_rows.id` is the PK and unique (35,951 rows =
35,951 distinct ids, 0 nulls on prod), and the fetch is ordered by `id ASC`. Keyset partitions the
id-ordered sequence into contiguous gap-free pages whose union is the identical multiset OFFSET
returned — so aggregates are unchanged (prod full-window invariant: value 272,111,991.10, qty
1,593,024.27, net 1,591,770.02, stock 4,563,006). **If id ever stops being unique/monotonic for this
read, keyset would skip/dupe — revisit then.** Pinned by `tests/weekly-sales-pagination.test.ts`
(keyset simulation + source pin failing if `count:exact`/OFFSET paging returns).

Third of three same-session perf fixes: [[sales-vs-target-cost-is-inside-au-monthly-attribution]]
(attribution #2101) and vacation report memoisation (#2105) were the other two.
