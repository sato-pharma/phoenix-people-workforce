-- Six Phoenix CRM foreign keys that no index leads with (Phoenix CRM performance audit, 2026-10-16).
--
-- Read live from pg_constraint and pg_index on production that afternoon: every other foreign key on a
-- phoenix_crm_* table already has an index whose leading columns are the key.
--
-- (a) VISITS BY PLACE. `phoenix_crm_visits.place_id` is read through PostgREST as
--     `place_id = any($1)` — 1,227 calls since the 14 Oct statistics reset, 5.0 ms mean — and with no
--     index each one scans every visit on the table. The table holds about 2,200 visits after two weeks
--     of one team and grows by about 150 a field day as teams start, so that scan only gets longer.
--
-- (b) THE OTHER FIVE: `phoenix_crm_plan_items.place_id` (about 6,400 rows) and `customer_id` on
--     `phoenix_crm_unplanned_visits`, `phoenix_crm_place_recommendations`, `phoenix_crm_place_notes` and
--     `phoenix_crm_visit_asks`. Postgres checks a foreign key from the PARENT's side too: deleting or
--     merging a customer, or retiring a place, has to find every child row naming it, and without an
--     index that is a scan of the child table per parent row. The customer merge deletes customers, so
--     each of these is paid on every merge.
--
-- Deliberately NOT dropped: `phoenix_crm_touch_trail_session_idx` (102 MB, 0 scans since the reset).
-- Its zero is only that nobody has opened a single session on the Super Admin's trail reader since the
-- reset — that reader filters the 400 MB table by `session_id` (`server/touch-trail-reader.ts`), so
-- dropping the index would turn every opened session into a full read of it.
--
-- No figure changes: an index changes how a row is found, never which rows a query returns.
--
-- CREATED CONCURRENTLY ON PRODUCTION FIRST, by hand, so the write lock a plain CREATE INDEX takes never
-- landed on a rep saving a visit. CONCURRENTLY cannot run inside a transaction and migrations do, so the
-- statements below are the plain form guarded by IF NOT EXISTS: a no-op where the index is already
-- there, and correct for staging and for any database rebuilt from migrations.

create index if not exists phoenix_crm_visits_place_idx
  on public.phoenix_crm_visits (place_id);

create index if not exists phoenix_crm_plan_items_place_idx
  on public.phoenix_crm_plan_items (place_id);

create index if not exists phoenix_crm_unplanned_visits_customer_idx
  on public.phoenix_crm_unplanned_visits (customer_id);

create index if not exists phoenix_crm_place_recommendations_customer_idx
  on public.phoenix_crm_place_recommendations (customer_id);

create index if not exists phoenix_crm_place_notes_customer_idx
  on public.phoenix_crm_place_notes (customer_id);

-- Not `phoenix_crm_visit_asks_customer_idx`: that name is already taken by (seat_id, customer_id,
-- is_test, created_at), which leads with the seat and so cannot serve the key — and IF NOT EXISTS would
-- have skipped this statement on the name alone, leaving the key unindexed while the file read as done.
create index if not exists phoenix_crm_visit_asks_customer_fk_idx
  on public.phoenix_crm_visit_asks (customer_id);
