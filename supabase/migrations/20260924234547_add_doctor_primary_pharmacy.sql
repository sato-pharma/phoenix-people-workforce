-- add_doctor_primary_pharmacy
--
-- WHAT THIS CHANGES:
--   One additive column on public.phoenix_crm_customers:
--     * primary_pharmacy_name text — the pharmacy the rep pinned as this doctor's primary, chosen
--       from the pharmacies feedback was already taken from (phoenix_crm_visits.pharmacy_name).
--   And a new function public.phoenix_crm_set_primary_pharmacy(jsonb) that sets or clears it. The
--   doctor's own list row, its status and everything else are untouched; the only new write is this
--   one column, plus an audit row in phoenix_crm_list_events.
-- WHY:
--   Owner, 2026-09-24: after the visit form began recording which pharmacy the rep took feedback
--   from (migration 20260924231210), the doctor↔pharmacy link is built from those visits — an
--   auto-derived list of the pharmacies per doctor, plus the rep can pin ONE as primary. The pinned
--   name is a free-text pharmacy name (there is no pharmacy entity); passing null or an empty string
--   clears the pin. Kept nullable so every existing doctor is simply "no primary yet".
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_set_primary_pharmacy(jsonb);
--   alter table public.phoenix_crm_customers drop column if exists primary_pharmacy_name;
--   Dropping the column discards any pins captured meanwhile — additive, so leaving it is harmless
--   if the code is reverted.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one ADD COLUMN (nullable, no back-fill) and one new function.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_customers
  add column if not exists primary_pharmacy_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_customers_primary_pharmacy_name') then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_primary_pharmacy_name
      check (primary_pharmacy_name is null or char_length(primary_pharmacy_name) <= 120);
  end if;
end$$;

-- Sets or clears the doctor's primary pharmacy. Mirrors phoenix_crm_rename_customer: the customer is
-- resolved and locked by seat + is_test, a dropped customer is refused, and the change is audited.
-- A null or blank pharmacy_name clears the pin.
create or replace function public.phoenix_crm_set_primary_pharmacy(p jsonb)
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
  v_pharmacy text := nullif(regexp_replace(trim(coalesce(p ->> 'pharmacy_name', '')), '\s+', ' ', 'g'), '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_before text;
begin
  if v_seat is null or v_actor is null or v_customer_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_pharmacy is not null and char_length(v_pharmacy) > 120 then
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

  v_before := v_customer.primary_pharmacy_name;

  update public.phoenix_crm_customers c
  set primary_pharmacy_name = v_pharmacy,
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, 'customer_primary_pharmacy_set', v_actor,
    jsonb_build_object('from', v_before, 'to', v_customer.primary_pharmacy_name),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'primary_pharmacy_name', v_customer.primary_pharmacy_name
  );
end;
$$;

revoke execute on function public.phoenix_crm_set_primary_pharmacy(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_primary_pharmacy(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
