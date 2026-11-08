-- phoenix_crm_full_name_corrected
--
-- WHAT THIS CHANGES: replaces public.phoenix_crm_decide_full_name(jsonb) with the same function plus one
--   optional input, `name`: on approve, the customer is renamed to that name instead of the one the rep
--   wrote, and the list event keeps the rep's name beside it (`rep_full_name`, `corrected`). Without
--   `name` it behaves exactly as before; `name` with reject is refused as bad input. Nothing is written
--   by this file.
-- WHY: owner, 2026-11-08 — on Place checks' "PM full names to check", the admin, and not the SFE Manager,
--   corrects the name a rep wrote or adds the missing third name before approving it. Who may send `name`
--   is decided in the service (src/lib/phoenix-crm/server/full-name-reviews.ts), which refuses everybody
--   but the Super Admin before this is called.
-- ROLLBACK: re-run the phoenix_crm_decide_full_name block of
--   supabase/migrations/20261107045402_phoenix_crm_doctor_full_name.sql (the body this replaces, md5 of
--   prosrc 8c2b2e5b62338e834001061e06781751 on production before this file), after reverting the code that
--   sends `name`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

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
  -- The Super Admin's own spelling of the name (owner, 2026-11-08), honoured on approve only. The service
  -- has already refused everybody else and checked the three names; null means "the rep's name as held".
  v_corrected text := nullif(left(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), 200), '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_held text;
  v_saved text;
begin
  if v_actor is null or v_customer_id is null or v_decision not in ('approve', 'reject') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_corrected is not null and v_decision <> 'approve' then
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
  v_saved := coalesce(v_corrected, v_held);

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
        'name', v_saved,
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
    -- A corrected name keeps what the rep wrote beside it, so the history shows both.
    jsonb_build_object('name', v_customer.name, 'full_name', v_saved)
      || case when v_corrected is not null and v_corrected is distinct from v_held
           then jsonb_build_object('rep_full_name', v_held, 'corrected', true) else '{}'::jsonb end,
    v_customer.is_test
  );

  return jsonb_build_object('customer_id', v_customer.id, 'decision', v_decision, 'full_name', v_saved);
end;
$$;

revoke execute on function public.phoenix_crm_decide_full_name(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_full_name(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
