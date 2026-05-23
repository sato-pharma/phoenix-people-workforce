-- Outstation offline sync race-condition guard.
--
-- Without a DB-level constraint, two concurrent sync retries from a mobile
-- client can both pass the application-level dedup check and both insert,
-- creating duplicate trip records. A partial unique index on the natural key
-- of an offline capture (employee + trip dates) makes the second insert fail
-- with a unique-violation that the service layer can handle gracefully.

create unique index if not exists outstation_offline_sync_unique
  on public.outstation_expense_requests (employee_hr_id, trip_start_date, trip_end_date)
  where offline_captured = true;

-- View: any duplicate offline requests that already exist (should be empty
-- after this migration runs, surfaces pre-existing duplicates if any).
create or replace view public.v_duplicate_offline_outstation_requests as
  select
    employee_hr_id,
    trip_start_date,
    trip_end_date,
    count(*) as duplicate_count,
    array_agg(id order by created_at) as request_ids
  from public.outstation_expense_requests
  where offline_captured = true
  group by employee_hr_id, trip_start_date, trip_end_date
  having count(*) > 1;

revoke all on public.v_duplicate_offline_outstation_requests from anon, authenticated;
grant select on public.v_duplicate_offline_outstation_requests to service_role;

notify pgrst, 'reload schema';
