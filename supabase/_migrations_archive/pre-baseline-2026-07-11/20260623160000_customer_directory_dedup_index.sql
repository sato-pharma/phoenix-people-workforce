-- perf: add composite index to support the DISTINCT ON (client_code, distributor_code)
-- ORDER BY latest_row_created_at DESC pattern used in phx_customer_directory and phx_exec_customers.
-- Without this index, PostgreSQL must sort the entire filtered dataset for each DISTINCT ON query.
-- With this index, it reads the first row per (client_code, distributor_code) group directly
-- from the index — eliminating the sort entirely (~4.8% of total DB time).

create index if not exists sos_customer_directory_rollup_dedup_idx
  on public.source_of_sales_customer_directory_rollup
  (client_code, distributor_code, latest_row_created_at desc);
