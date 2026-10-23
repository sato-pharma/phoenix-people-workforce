---
name: a-two-column-price-join-plans-as-a-merge-join-on-period-alone
description: Hoisting phx_factory_price into a CTE keyed on (product_code, period) is twice as slow written as the obvious two-column join — concatenate the key, and count the separator before you trust it.
metadata:
  type: project
---

Measured on production 2026-10-23 while hoisting the per-row `phx_factory_price` call out of
thirteen closing and reporting functions (PR #6344).

Written the obvious way — `left join period_price pp on pp.product_code = f.product_code and
pp.period = f.period` — the planner chose a **Merge Left Join on `period` ALONE** and threw the
product away in a join filter: `Rows Removed by Join Filter: 3,570,096`, **6,531 ms**. A single
concatenated key, `pp.pair = f.product_code || '|' || f.period`, gives it a hash join on the whole
key: **3,209 ms**. The `(product_code, period)::text` record form was tried too and was worse,
**4,546 ms**.

**The concatenation is only equivalent while no value can hold the separator, so count it.** On
production: zero `|` characters and zero NULLs in `product_code` or `period` in
`source_of_sales_fact_rollup` (295,418 rows), in `source_of_sales_customer_directory_rollup`
(262,293 rows) or in the `source_of_sales_products` master. The two join shapes were then compared
row by row over both whole relations — same lookup row reached, same key resolved, 557,711 rows,
0 differences.

**Why that matters beyond speed:** a whole-relation lemma like that composes. When the pair key
goes in AFTER the full-function `old::text = new::text` comparison, you do not have to re-run the
comparison — diff the live body against the new one, show every hunk is the hoist and nothing else
(no filter, select list, group by, branch or `proconfig` differs), and the lemma covers the whole
delta. That is what let the four late bodies ship at 13:45 Cairo without breaking
[[heavy-production-checks-wait-until-after-17-cairo]].

Related: [[verify-the-emitted-artifact-never-the-source]],
[[apply-sql-file-is-the-route-for-a-declined-production-data-write]].
