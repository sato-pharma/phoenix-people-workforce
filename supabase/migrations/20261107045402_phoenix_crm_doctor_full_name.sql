-- phoenix_crm_doctor_full_name
--
-- WHAT THIS CHANGES: seven nullable columns on public.phoenix_crm_customers that hold a doctor's full
--   name while it waits for the Super Admin (full_name_held*) and the last one he refused
--   (full_name_refused_*), and two functions: phoenix_crm_hold_full_name (the rep's save, when the name
--   matches his signboard 40-59%) and phoenix_crm_decide_full_name (the Super Admin's approve or reject).
-- WHY: owner, 2026-11-07 — a clinic doctor's name is first, middle and last; a doctor a rep added with
--   one or two names is blocked from the plan and Add visit until the full name is written; the full
--   name is held against his signboard: 60%+ saved, under 40% refused, in between the Super Admin
--   decides (src/lib/phoenix-crm/doctor-name-rules.ts).
-- ROLLBACK: drop function public.phoenix_crm_decide_full_name(jsonb);
--           drop function public.phoenix_crm_hold_full_name(jsonb);
--           alter table public.phoenix_crm_customers drop column full_name_held, drop column full_name_held_at,
--             drop column full_name_held_by_hr_id, drop column full_name_held_score, drop column full_name_held_board,
--             drop column full_name_refused_at, drop column full_name_refused_name;
--           (a held name is lost with its column; nothing else is.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Additive only: no row is changed by this file.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_customers
  add column if not exists full_name_held text,
  add column if not exists full_name_held_at timestamptz,
  add column if not exists full_name_held_by_hr_id text,
  add column if not exists full_name_held_score smallint,
  add column if not exists full_name_held_board jsonb,
  add column if not exists full_name_refused_at timestamptz,
  add column if not exists full_name_refused_name text;

comment on column public.phoenix_crm_customers.full_name_held is
  'A doctor''s full name the rep wrote that matched his signboard 40-59% (or had no board read on a validated doctor): it waits for the Super Admin. While set, the doctor is not blocked. doctor-name-rules.ts';
comment on column public.phoenix_crm_customers.full_name_refused_name is
  'The last full name the Super Admin refused, with full_name_refused_at. Display only.';

create index if not exists phoenix_crm_customers_full_name_held_idx
  on public.phoenix_crm_customers (full_name_held_at)
  where full_name_held is not null;

create or replace function public.phoenix_crm_hold_full_name(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_name text := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_score smallint := nullif(p ->> 'score', '')::smallint;
  v_board jsonb := coalesce(p -> 'board_names', '[]'::jsonb);
  v_customer public.phoenix_crm_customers%rowtype;
begin
  if v_seat is null or v_actor is null or v_customer_id is null or v_name is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

  update public.phoenix_crm_customers c
  set full_name_held = left(v_name, 200),
      full_name_held_at = now(),
      full_name_held_by_hr_id = v_actor,
      full_name_held_score = v_score,
      full_name_held_board = v_board,
      updated_at = now()
  where c.id = v_customer.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, 'full_name_held', v_actor,
    jsonb_build_object('name', v_customer.name, 'full_name', left(v_name, 200), 'score', v_score, 'board_names', v_board),
    v_is_test
  );

  return jsonb_build_object('customer_id', v_customer.id, 'held', true);
end;
$$;

create or replace function public.phoenix_crm_decide_full_name(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_decision text := lower(nullif(trim(coalesce(p ->> 'decision', '')), ''));
  v_customer public.phoenix_crm_customers%rowtype;
  v_held text;
begin
  if v_actor is null or v_customer_id is null or v_decision not in ('approve', 'reject') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer_id;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_customer.seat_id));

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer_id for update;
  v_held := v_customer.full_name_held;
  if v_held is null then
    raise exception 'phoenix_crm:full_name_not_held';
  end if;

  if v_decision = 'approve' then
    if v_customer.status <> 'dropped' then
      -- The rep's own rename, so the name key, the contact's name row and the history move exactly as
      -- when he saves a name himself. The decider has looked at both names: a second customer of the
      -- same name is his to judge, not a refusal.
      perform public.phoenix_crm_rename_customer(jsonb_build_object(
        'seat_id', v_customer.seat_id,
        'actor_hr_id', v_actor,
        'is_test', v_customer.is_test,
        'customer_id', v_customer.id,
        'name', v_held,
        'speciality', v_customer.speciality,
        'allow_same_name', true
      ));
    end if;
    update public.phoenix_crm_customers c
    set full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id;
  else
    update public.phoenix_crm_customers c
    set full_name_refused_at = now(),
        full_name_refused_name = v_held,
        full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id;
  end if;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_customer.seat_id, v_customer.id,
    case when v_decision = 'approve' then 'full_name_approved' else 'full_name_refused' end,
    v_actor,
    jsonb_build_object('name', v_customer.name, 'full_name', v_held),
    v_customer.is_test
  );

  return jsonb_build_object('customer_id', v_customer.id, 'decision', v_decision, 'full_name', v_held);
end;
$$;

revoke execute on function public.phoenix_crm_hold_full_name(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_decide_full_name(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_hold_full_name(jsonb) to service_role;
grant execute on function public.phoenix_crm_decide_full_name(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
