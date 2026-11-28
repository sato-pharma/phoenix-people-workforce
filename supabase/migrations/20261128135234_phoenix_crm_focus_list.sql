-- phoenix_crm_focus_list
--
-- WHAT THIS CHANGES: one new table, public.phoenix_crm_focus_customers, and one new read function,
--   public.phoenix_crm_focus_visits(uuid[], boolean, date, date). Nothing existing is altered.
--   * a row is one PM customer put on his territory's Focus list: by its rep (who must write why) or by a
--     manager of the territory. While returned_at is null he is ON the list; a return closes the row and it
--     stays as history. At most one open row per customer (partial unique index).
--   * a rep's push waits for the territory's manager (review_status 'waiting') until he presses Keep
--     ('kept') or Return (returned_at). A manager's own push is 'kept' at once.
--   * the function hands the Focus tracking board two things for the customers asked about: every countable
--     visit inside the chosen From–To period (counted per week in TypeScript), and each customer's latest
--     visit ever, with the place it was saved at.
-- WHY: owner, 2026-11-28 — "every medical rep in Phoenix CRM: a tab called Focus list … the medical rep must
--   say why … grouped by grade, grouped by brick … the district manager has focus list tracking … filter on
--   the rep … return him to normal list or keep him … track the frequency of visits … when the last time,
--   where … a manager can also choose from the rep list and push him to the focus list."
-- ROLLBACK: drop function public.phoenix_crm_focus_visits(uuid[], boolean, date, date);
--           drop table public.phoenix_crm_focus_customers;
--   (loses only the Focus list rows themselves; no other table reads or references them.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: it creates, it writes no row.

begin;

create table if not exists public.phoenix_crm_focus_customers (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text,
  customer_id uuid not null references public.phoenix_crm_customers (id) on delete cascade,
  reason text not null,
  reason_pick text,
  pushed_by_hr_id text not null,
  pushed_as text not null,
  pushed_at timestamptz not null default now(),
  review_status text not null default 'waiting',
  reviewed_by_hr_id text,
  reviewed_at timestamptz,
  returned_at timestamptz,
  returned_by_hr_id text,
  returned_as text,
  return_note text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_focus_customers_reason_written check (char_length(btrim(reason)) between 3 and 500),
  constraint phoenix_crm_focus_customers_reason_pick_known check (
    reason_pick is null
    or reason_pick in ('high_potential', 'competitor_prescriber', 'key_opinion_leader', 'growing_prescriber', 'new_prescriber', 'other')
  ),
  constraint phoenix_crm_focus_customers_pushed_as_known check (pushed_as in ('rep', 'manager')),
  constraint phoenix_crm_focus_customers_review_known check (review_status in ('waiting', 'kept')),
  constraint phoenix_crm_focus_customers_kept_is_stamped check (
    review_status = 'waiting' or (reviewed_by_hr_id is not null and reviewed_at is not null)
  ),
  constraint phoenix_crm_focus_customers_return_is_stamped check (
    returned_at is null or (returned_by_hr_id is not null and returned_as in ('rep', 'manager'))
  ),
  constraint phoenix_crm_focus_customers_return_note_short check (return_note is null or char_length(return_note) <= 500)
);

comment on table public.phoenix_crm_focus_customers is
  'Phoenix CRM Focus list (owner, 2026-11-28): a PM customer a rep or a manager of his territory put on the territory''s Focus list, with the written reason. Open while returned_at is null; a return closes the row and keeps it as history.';

-- One open Focus row per customer; the history of closed rows is unlimited.
create unique index if not exists phoenix_crm_focus_customers_open_customer_idx
  on public.phoenix_crm_focus_customers (customer_id)
  where returned_at is null;

-- Every foreign key leads an index (F-DB-006): customer_id is covered by this one for closed rows too.
create index if not exists phoenix_crm_focus_customers_customer_idx
  on public.phoenix_crm_focus_customers (customer_id);

-- The two reads: one territory's open list, and a manager's territories at once.
create index if not exists phoenix_crm_focus_customers_open_seat_idx
  on public.phoenix_crm_focus_customers (seat_id, is_test)
  where returned_at is null;

alter table public.phoenix_crm_focus_customers enable row level security;

-- The browser roles write no public table (database-migrations): every read and write goes through the
-- service role, behind the app's own territory gates.
revoke all on table public.phoenix_crm_focus_customers from public, anon, authenticated;
grant select, insert, update on table public.phoenix_crm_focus_customers to service_role;

create or replace function public.phoenix_crm_focus_visits(
  p_customer_ids uuid[],
  p_is_test boolean,
  p_from date,
  p_to date
)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
  with period as (
    select v.customer_id, v.visit_date, v.kind
    from public.phoenix_crm_countable_visits v
    where v.customer_id = any (p_customer_ids)
      and v.is_test = p_is_test
      and v.archived_at is null
      and v.visit_date between p_from and p_to
  ),
  latest as (
    select distinct on (v.customer_id)
           v.customer_id, v.visit_date, v.captured_at, v.kind, v.rep_hr_id, v.manager_hr_id, v.place_id,
           v.imported_from_ireports360_at is not null as imported
    from public.phoenix_crm_countable_visits_with_history v
    where v.customer_id = any (p_customer_ids)
      and v.is_test = p_is_test
      and v.archived_at is null
    order by v.customer_id, v.visit_date desc, v.captured_at desc nulls last, v.id desc
  )
  select jsonb_build_object(
    'period', coalesce((
      select jsonb_agg(jsonb_build_object('customer_id', p.customer_id, 'visit_date', p.visit_date, 'kind', p.kind)
                       order by p.customer_id, p.visit_date)
      from period p
    ), '[]'::jsonb),
    'latest', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', l.customer_id, 'visit_date', l.visit_date, 'captured_at', l.captured_at, 'kind', l.kind,
        'rep_hr_id', l.rep_hr_id, 'manager_hr_id', l.manager_hr_id, 'imported', l.imported,
        'place_label', pl.label, 'place_address', pl.address, 'brick_name', pl.brick_name
      ) order by l.customer_id)
      from latest l
      left join public.phoenix_crm_places pl on pl.id = l.place_id
    ), '[]'::jsonb)
  );
$$;

comment on function public.phoenix_crm_focus_visits(uuid[], boolean, date, date) is
  'Phoenix CRM Focus list tracking (2026-11-28): the countable visits to these customers inside [p_from, p_to], and each one''s latest visit ever with its place.';

revoke execute on function public.phoenix_crm_focus_visits(uuid[], boolean, date, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_focus_visits(uuid[], boolean, date, date) to service_role;

commit;
