-- phoenix_crm_add_pharmacy
--
-- WHAT THIS CHANGES:
--   One new function, phoenix_crm_add_pharmacy(p jsonb): the rep adds a pharmacy to his own list by its
--   NAME alone — no signboard photo, no location, no hours, no request and no approval. It lands on his
--   list at once as a `pending` Pharmacy customer (`origin` 'new'), which for a pharmacy means simply
--   "on Your list" (list-request-rules.ts `awaitsValidation` is false for every pharmacy), and Add
--   visit → Pharmacy visit offers it from that moment. A pharmacy already on his list under the same
--   name (case and spacing aside) is returned instead of a second row, under a per-territory lock, so a
--   double tap files one pharmacy. The caller has already matched the name by its Arabic key
--   (pharmacy-call-rules.ts `matchAddedPharmacy`) and refused one sitting in his Archive.
--
-- WHY:
--   Owner, 2026-10-03: "he can add to his list pharmacies without approval normally … in pharmacy visit
--   … all his pharmacies to be listed and he can also add a pharmacy without any validation or without
--   any approval". Until now the only way a pharmacy reached a rep's list was iReports360's import or
--   naming it on a doctor's visit; Pharmacy visit said "No pharmacy is on your list yet" and offered
--   nothing to do about it.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_add_pharmacy(jsonb);
--   The pharmacies it added stay on the reps' lists (and their visits stay), exactly as the ones a
--   doctor's visit added do. It replaces nothing, so nothing else needs restoring.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This adds one function and writes no rows.

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_add_pharmacy(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_name text := nullif(btrim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g')), '');
  v_from text := coalesce(p ->> 'from', 'list');
  v_existing public.phoenix_crm_customers;
  v_added public.phoenix_crm_customers;
begin
  if v_seat is null or v_line is null or v_actor is null or v_name is null
    or char_length(v_name) > 120
    or v_from not in ('list', 'visit') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- One add at a time per territory, so the check below and the insert after it cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));

  select c.* into v_existing
  from public.phoenix_crm_customers c
  where c.seat_id = v_seat
    and c.is_test = v_is_test
    and c.list_type = 'Pharmacy'
    and c.status in ('active', 'pending', 'outside')
    and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(v_name)
  order by (c.status = 'active') desc, c.id
  limit 1;

  if v_existing.id is not null then
    return jsonb_build_object('customer_id', v_existing.id, 'customer_name', v_existing.name, 'created', false);
  end if;

  insert into public.phoenix_crm_customers (
    seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note
  )
  values (
    v_seat, v_line, 'Pharmacy', v_name, 'new', 'pending', v_actor, v_is_test,
    case when v_from = 'visit' then 'Added by the rep on Pharmacy visit.' else 'Added by the rep on the List.' end
  )
  returning * into v_added;

  return jsonb_build_object('customer_id', v_added.id, 'customer_name', v_added.name, 'created', true);
end;
$$;

revoke execute on function public.phoenix_crm_add_pharmacy(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_pharmacy(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
