-- Phoenix CRM — the Polyclinic Caps page: a number stays on its own seat, and a switch is a round trip.
--
-- WHAT
--   1. phoenix_crm_shared_place_day_cap(): the venue's own number is read only for the seat that owns the venue.
--      A customer moved to another seat keeps a place in the old seat's venue, and that visit must hold the company
--      number, as the moved rep's plan already does (loadVenueCaps is per seat).
--   2. phoenix_crm_venue_cap_set(), lift: switching back on brings back the account the last switch-off ended with it,
--      so off then on leaves the hospital's own account where it was.
--   3. phoenix_crm_venue_cap_set(), unlift and end_partial: an account on a name key row reaching a second venue moves
--      to that venue's row, unless the account sits in the venue being switched off. A retired venue reached by the
--      key keeps its row too: it is inert until the venue is restored, and then it answers as it did before.
--
-- WHY (risk review before merge, 2026-11-02; owner's words, same day: "make sure it's perfectly working")
--   Nothing here widens the page's reach. No row is touched by this migration.
--
-- ROLLBACK
--   Restore the two function bodies from 20261102130045_phoenix_crm_venue_cap_admin.sql.
--   That file's own header needs two corrections: its soft way leaves the name key rows the page ended, so a venue
--   lifted before the page reads off until they are reopened; and its hard way must first delete the rows naming only
--   a venue, or restoring the old has_target CHECK fails.

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_shared_place_day_cap()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_shared uuid;
  v_cap integer;
  v_own integer;
  v_placed integer;
begin
  if new.place_id is null then
    return new;
  end if;
  select pl.shared_place_id into v_shared from public.phoenix_crm_places pl where pl.id = new.place_id;
  if v_shared is null then
    return new;
  end if;

  -- An out-of-plan visit under a named exception is not held to the venue's daily number.
  if new.unplanned_kind = 'out_of_plan'
     and public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id) then
    return new;
  end if;

  -- A venue the owner lifted outright (2026-10-31): no daily number there, planned or not.
  if exists (select 1 from public.phoenix_crm_venue_cap_lifted(new.seat_id) l where l.shared_place_id = v_shared) then
    return new;
  end if;

  select s.shared_place_daily_cap into v_cap from public.phoenix_crm_settings s where s.id = 1;
  -- A venue the owner raised (2026-11-02) holds its own number for its own seat, and never less than the company's.
  select sp.daily_cap into v_own from public.phoenix_crm_shared_places sp where sp.id = v_shared and sp.seat_id = new.seat_id;
  v_cap := greatest(coalesce(v_cap, 3), coalesce(v_own, 0));

  select count(*) into v_placed
  from public.phoenix_crm_visits v
  join public.phoenix_crm_places pl on pl.id = v.place_id
  where pl.shared_place_id = v_shared
    and v.visit_date = new.visit_date
    and v.is_test = new.is_test
    and not v.offplan_exempt;

  if v_placed >= v_cap then
    raise exception 'phoenix_crm:shared_place_day_full';
  end if;
  return new;
end;
$$;

revoke execute on function public.phoenix_crm_shared_place_day_cap() from public, anon, authenticated;
grant execute on function public.phoenix_crm_shared_place_day_cap() to service_role;

-- The page's write, in one transaction under the venue's lock.
--   lift       a row naming this venue, unless the door already answers it lifted. It carries the account the last
--              switch-off of this venue ended, so off then on is a round trip.
--   unlift     ends every lifting row that reaches this venue. A name key row that also reaches ANOTHER venue of the
--              seat first gives that venue a row of its own, so switching one off never switches a second off, and
--              hands it the row's account unless the account sits in this venue.
--   end_partial  the same, for rows that free unplanned visits only (the Air Force hospital's sort).
--   raise      sets the venue's own number; it must stand above the company number.
--   standard   clears it.
create or replace function public.phoenix_crm_venue_cap_set(p_seats text[], p_shared_place uuid, p_action text, p_cap integer, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_place public.phoenix_crm_shared_places%rowtype;
  v_setting integer;
  v_fold text;
  v_flag boolean;
  v_row record;
  v_other record;
  v_account uuid;
begin
  if p_shared_place is null
     or coalesce(trim(p_actor), '') = ''
     or coalesce(p_action, '') not in ('lift', 'unlift', 'end_partial', 'raise', 'standard') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select * into v_place
  from public.phoenix_crm_shared_places sp
  where sp.id = p_shared_place
    and sp.seat_id = any(p_seats)
    and sp.retired_at is null
    and not sp.is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:venue_not_on_seat';
  end if;
  v_fold := public.phoenix_crm_fold_name(v_place.name);

  if p_action = 'lift' then
    if not exists (select 1 from public.phoenix_crm_venue_cap_lifted(v_place.seat_id) l where l.shared_place_id = v_place.id) then
      select e.customer_id into v_account
      from public.phoenix_crm_offplan_exemptions e
      where e.seat_id = v_place.seat_id
        and e.lifts_venue_cap
        and e.customer_id is not null
        and e.ended_at is not null
        and e.ended_by_hr_id is not null
        and (
          e.shared_place_id = v_place.id
          or (e.venue_name_key is not null and v_fold like '%' || e.venue_name_key || '%')
        )
      order by e.ended_at desc
      limit 1;

      insert into public.phoenix_crm_offplan_exemptions
        (seat_id, label, shared_place_id, customer_id, note, granted_by_hr_id, lifts_venue_cap)
      values
        (v_place.seat_id, v_place.name, v_place.id, v_account, 'Switched on from the Polyclinic Caps page.', p_actor, true);
    end if;

  elsif p_action in ('unlift', 'end_partial') then
    v_flag := p_action = 'unlift';
    for v_row in
      select e.id, e.venue_name_key, e.customer_id
      from public.phoenix_crm_offplan_exemptions e
      where e.seat_id = v_place.seat_id
        and e.ended_at is null
        and e.lifts_venue_cap = v_flag
        and (
          e.shared_place_id = v_place.id
          or (e.venue_name_key is not null and v_fold like '%' || e.venue_name_key || '%')
        )
      for update of e
    loop
      if v_row.venue_name_key is not null then
        v_account := v_row.customer_id;
        if exists (
          select 1 from public.phoenix_crm_places pl
          where pl.customer_id = v_account and pl.shared_place_id = v_place.id and pl.retired_at is null
        ) then
          v_account := null;
        end if;

        -- A live venue first, so the account lands on a venue that is in use.
        for v_other in
          select other.id, other.seat_id, other.name
          from public.phoenix_crm_shared_places other
          where other.seat_id = v_place.seat_id
            and other.id <> v_place.id
            and not other.is_test
            and public.phoenix_crm_fold_name(other.name) like '%' || v_row.venue_name_key || '%'
          order by (other.retired_at is null) desc, other.name, other.id
        loop
          update public.phoenix_crm_offplan_exemptions kept
             set customer_id = coalesce(kept.customer_id, v_account)
           where kept.shared_place_id = v_other.id and kept.lifts_venue_cap = v_flag and kept.ended_at is null;
          if not found then
            insert into public.phoenix_crm_offplan_exemptions
              (seat_id, label, shared_place_id, customer_id, note, granted_by_hr_id, lifts_venue_cap)
            values
              (v_other.seat_id, v_other.name, v_other.id, v_account, 'Kept when a row that also named this venue was ended.', p_actor, v_flag);
          end if;
          v_account := null;
        end loop;
      end if;
      update public.phoenix_crm_offplan_exemptions
         set ended_at = now(), ended_by_hr_id = p_actor
       where id = v_row.id;
    end loop;

  elsif p_action = 'raise' then
    select s.shared_place_daily_cap into v_setting from public.phoenix_crm_settings s where s.id = 1;
    if p_cap is null or p_cap <= coalesce(v_setting, 3) or p_cap > 20 then
      raise exception 'phoenix_crm:venue_cap_out_of_range';
    end if;
    update public.phoenix_crm_shared_places
       set daily_cap = p_cap, daily_cap_set_by_hr_id = p_actor, daily_cap_set_at = now()
     where id = v_place.id;

  else
    update public.phoenix_crm_shared_places
       set daily_cap = null, daily_cap_set_by_hr_id = null, daily_cap_set_at = null
     where id = v_place.id;
  end if;

  return jsonb_build_object('sharedPlaceId', v_place.id, 'seatId', v_place.seat_id, 'action', p_action);
end;
$$;

revoke execute on function public.phoenix_crm_venue_cap_set(text[], uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_venue_cap_set(text[], uuid, text, integer, text) to service_role;

notify pgrst, 'reload schema';

commit;
