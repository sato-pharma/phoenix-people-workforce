-- Touch Trail: read a day's taps in row order without scanning the whole table.
--
-- `readTrailRows` (src/lib/phoenix-crm/server/touch-trail-reader.ts) pages one day as
-- `visit_day = $1 AND id > $cursor ORDER BY id LIMIT 1000`, up to 40 pages. The only day index is
-- (visit_day, seat_id), so the planner walked the primary key in id order and filtered every row by
-- day: each page scanned the table from the cursor on. On 19 Oct 2026 23:31 Cairo the page timed
-- out (57014) for that day's 108,419 taps — System Audit APP-C2E4684A. Measured 23 Oct 2026: the
-- table holds 1,815,600 rows / 729 MB and a working day adds 180,000.
--
-- (visit_day, id) answers each page as one index range: the day's rows, already in id order,
-- starting at the cursor.
--
-- PRODUCTION gets this with CREATE INDEX CONCURRENTLY, run on its own, so the write lock a plain
-- CREATE INDEX takes never lands on a table every rep's tablet writes to. CONCURRENTLY cannot run
-- inside a transaction and migrations do, so the statement below is the plain form guarded by IF NOT
-- EXISTS: a no-op once production has the index, and correct for staging and any rebuilt database.
create index if not exists phoenix_crm_touch_trail_day_id_idx
  on public.phoenix_crm_touch_trail (visit_day, id);
