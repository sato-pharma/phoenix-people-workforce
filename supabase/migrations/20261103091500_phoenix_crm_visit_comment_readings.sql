-- phoenix_crm_visit_comment_readings
--
-- WHAT THIS CHANGES:
--   * phoenix_crm_visit_comment_readings — one row per visit whose comment has been read: what it says about
--     missing stock and a price complaint (each with the rep's own quote), and any follow-up the rep wrote.
--     A comment that says none of these still gets a row, so it is not read again.
--   * phoenix_crm_comment_reading_queue(p_limit) — the newest real visits with a comment and no reading.
--   * A trigger on phoenix_crm_visits that deletes a visit's reading when its comment or detail comment
--     changes, so it is read again and an old quote never sits beside new words. It changes no visit.
-- WHY: the owner, 2026-11-03 ("build 3") — reps write a comment on nearly every visit and few open the optional
--   steps, so what they heard stayed in sentences no report reads. Service role only: a rep's follow-up is read
--   on that rep's own notes and nowhere above them.
-- ROLLBACK (additive only; nothing existing changes, so this loses only readings, which can be read again):
--   drop trigger phoenix_crm_visits_comment_changed on public.phoenix_crm_visits;
--   drop function public.phoenix_crm_comment_changed();
--   drop function public.phoenix_crm_comment_reading_queue(integer);
--   drop table public.phoenix_crm_visit_comment_readings;
-- VERIFY:
--   select relname, relrowsecurity from pg_class where relname = 'phoenix_crm_visit_comment_readings';
--   select tgname, tgenabled from pg_trigger where tgname = 'phoenix_crm_visits_comment_changed';
--   select count(*) from public.phoenix_crm_comment_reading_queue(5);

begin;

set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_visit_comment_readings (
  visit_id uuid primary key references public.phoenix_crm_visits (id) on delete cascade,
  seat_id text not null,
  visit_date date not null,
  stock jsonb not null default '[]'::jsonb,
  price jsonb not null default '[]'::jsonb,
  follow_up text,
  heard boolean generated always as (jsonb_array_length(stock) > 0 or jsonb_array_length(price) > 0) stored,
  model text not null,
  read_at timestamptz not null default now()
);

comment on table public.phoenix_crm_visit_comment_readings is
  'What a visit comment says about stock, price and a follow-up. Never a counted figure: no KPI, rank, payroll or coaching figure reads it.';

create index if not exists phoenix_crm_visit_comment_readings_heard_idx
  on public.phoenix_crm_visit_comment_readings (seat_id, visit_date) where heard;
create index if not exists phoenix_crm_visit_comment_readings_follow_up_idx
  on public.phoenix_crm_visit_comment_readings (seat_id, visit_date) where follow_up is not null;

-- Locked to the service role in the same four statements every other table in this module states.
alter table public.phoenix_crm_visit_comment_readings enable row level security;
create policy phoenix_crm_visit_comment_readings_service_role
  on public.phoenix_crm_visit_comment_readings for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_comment_readings from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_comment_readings to service_role;

-- A bounded window, so an empty queue costs a walk over recent visits and never over all of them.
create or replace function public.phoenix_crm_comment_reading_queue(p_limit integer)
returns table (id uuid, seat_id text, visit_date date, comment text, detail_comment text, products text[])
language sql
stable
security definer
set search_path to 'public'
as $$
  select v.id, v.seat_id, v.visit_date, v.comment, v.detail_comment, v.products
  from public.phoenix_crm_visits v
  where v.visit_date >= (now() at time zone 'Africa/Cairo')::date - 120
    and v.is_test = false
    and v.imported_from_ireports360_at is null
    and (nullif(btrim(v.comment), '') is not null or nullif(btrim(v.detail_comment), '') is not null)
    and not exists (select 1 from public.phoenix_crm_visit_comment_readings r where r.visit_id = v.id)
  order by v.visit_date desc, v.captured_at desc
  limit greatest(p_limit, 0);
$$;

revoke execute on function public.phoenix_crm_comment_reading_queue(integer) from public, anon, authenticated;
grant execute on function public.phoenix_crm_comment_reading_queue(integer) to service_role;

create or replace function public.phoenix_crm_comment_changed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  delete from public.phoenix_crm_visit_comment_readings where visit_id = new.id;
  return null;
end;
$$;

revoke execute on function public.phoenix_crm_comment_changed() from public, anon, authenticated;
grant execute on function public.phoenix_crm_comment_changed() to service_role;

create or replace trigger phoenix_crm_visits_comment_changed
  after update of comment, detail_comment on public.phoenix_crm_visits
  for each row
  when (old.comment is distinct from new.comment or old.detail_comment is distinct from new.detail_comment)
  execute function public.phoenix_crm_comment_changed();

notify pgrst, 'reload schema';

commit;
