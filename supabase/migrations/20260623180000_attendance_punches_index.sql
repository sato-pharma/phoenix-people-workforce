-- perf: add index on attendance_raw_punches(ingested_at desc) to support
-- the "SELECT ingested_at ORDER BY ingested_at DESC LIMIT 1" query pattern
-- used to find the latest punch timestamp.
-- Without this index, PostgreSQL sorts the full table for every call.
-- With this index, it fetches a single row from the index head in microseconds.

create index if not exists attendance_raw_punches_ingested_at_idx
  on public.attendance_raw_punches (ingested_at desc);
