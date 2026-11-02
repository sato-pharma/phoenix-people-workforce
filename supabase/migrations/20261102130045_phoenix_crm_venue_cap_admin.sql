-- Phoenix CRM — the Super Admin's own controls over one rep's polyclinics: no cap at all, or a higher daily number.
--
-- WHAT
--   1. phoenix_crm_offplan_exemptions.shared_place_id: a row may name one exact venue, not only a name key. Its two
--      CHECKs are widened to allow it. ended_by_hr_id records who ended a row. Rows stay when ended, so history stays.
--   2. phoenix_crm_shared_places.daily_cap (with who and when): one venue's own daily number, above the company one.
--   3. The door's three readers learn the exact venue: phoenix_crm_offplan_exempt, phoenix_crm_offplan_exempt_customers
--      and phoenix_crm_venue_cap_lifted. A row naming a venue reaches exactly what a name key row reaches.
--   4. phoenix_crm_shared_place_day_cap(): the number it holds is greatest(setting, the venue's daily_cap).
--   5. phoenix_crm_venue_cap_board(seats) and phoenix_crm_venue_cap_set(...): the page's one read and one write, so
--      "is this venue lifted" is answered by the door's own match and a switch is one transaction.
--
-- WHY (owner, 2026-11-02: "This module I filter by the medical rep. Then after I filter by the medical rep, all his
--   polyclinics appear. ... When I open the toggle, then no cap for this rep in this polyclinic. And also have the
--   option to, for example, instead of making the cap 3, make it 5, make it 7 ... I can remove the cap for a rep in the
--   chosen polyclinic, or I can increase the ceiling of the cap.")
--   Only the CAPS move. The approval chain is untouched; the settings are untouched; every row and every number is
--   per seat, so no other rep is reached; one visit per customer per day, the plan's AM/PM day caps and the hold on an
--   unvalidated customer stay. A raised number moves the venue's daily number only: the rep's out-of-plan 2 a day and
--   8 a week still apply there. A row that exists today is not changed by this migration.
--
-- ROLLBACK
--   update public.phoenix_crm_offplan_exemptions set ended_at = now()
--    where shared_place_id is not null and ended_at is null;                          -- the soft way, the switches
--   update public.phoenix_crm_shared_places
--      set daily_cap = null, daily_cap_set_by_hr_id = null, daily_cap_set_at = null;  -- the soft way, the numbers
--   (the hard way: restore the four function bodies from 20261031170001 and 20261017150000, then
--    drop function public.phoenix_crm_venue_cap_set(text[], uuid, text, integer, text);
--    drop function public.phoenix_crm_venue_cap_board(text[]);
--    restore the two CHECKs, and drop the columns added below.)
--   Nothing existing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_offplan_exemptions
  add column if not exists shared_place_id uuid,
  add column if not exists ended_by_hr_id text;

comment on column public.phoenix_crm_offplan_exemptions.shared_place_id is
  'Owner, 2026-11-02: the one venue this row names, set from the Super Admin''s Polyclinic Caps page. Reaches what a venue_name_key row reaches, without matching any other venue. No foreign key, like customer_id: a row for a venue that is gone is inert.';
comment on column public.phoenix_crm_offplan_exemptions.ended_by_hr_id is
  'Who ended the row from the Polyclinic Caps page. Null on a row ended by a migration or by hand.';

alter table public.phoenix_crm_offplan_exemptions
  drop constraint if exists phoenix_crm_offplan_exemptions_has_target;
alter table public.phoenix_crm_offplan_exemptions
  add constraint phoenix_crm_offplan_exemptions_has_target
  check (customer_id is not null or venue_name_key is not null or rep_hr_id is not null or shared_place_id is not null);

alter table public.phoenix_crm_offplan_exemptions
  drop constraint if exists phoenix_crm_offplan_exemptions_rep_window;
alter table public.phoenix_crm_offplan_exemptions
  add constraint phoenix_crm_offplan_exemptions_rep_window
  check (
    rep_hr_id is null
    or (
      valid_from is not null
      and valid_until is not null
      and valid_from <= valid_until
      and customer_id is null
      and venue_name_key is null
      and shared_place_id is null
    )
  );

-- One active row of each sort per venue, so two clicks can never stack two rows that one switch must then end.
create unique index if not exists phoenix_crm_offplan_exemptions_one_per_venue
  on public.phoenix_crm_offplan_exemptions (shared_place_id, lifts_venue_cap)
  where ended_at is null and shared_place_id is not null;

alter table public.phoenix_crm_shared_places
  add column if not exists daily_cap integer,
  add column if not exists daily_cap_set_by_hr_id text,
  add column if not exists daily_cap_set_at timestamptz;

alter table public.phoenix_crm_shared_places
  drop constraint if exists phoenix_crm_shared_places_daily_cap_range;
alter table public.phoenix_crm_shared_places
  add constraint phoenix_crm_shared_places_daily_cap_range
  check (daily_cap is null or (daily_cap >= 1 and daily_cap <= 20));

comment on column public.phoenix_crm_shared_places.daily_cap is
  'Owner, 2026-11-02: this venue''s own daily number. The door and the plan hold greatest(shared_place_daily_cap, daily_cap), so a raised venue never falls below the company number. Null is the company number.';

create or replace function public.phoenix_crm_offplan_exempt(p_seat text, p_customer uuid, p_place uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.phoenix_crm_offplan_exemptions e
    where e.seat_id = p_seat
      and e.ended_at is null
      and (
        (e.customer_id is not null and e.customer_id = p_customer)
        or (
          (e.venue_name_key is not null or e.shared_place_id is not null)
          and p_place is not null
          and exists (
            select 1
            from public.phoenix_crm_places pl
            join public.phoenix_crm_shared_places sp on sp.id = pl.shared_place_id
            where pl.id = p_place
              and sp.seat_id = p_seat
              and (
                e.shared_place_id = sp.id
                or public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%'
              )
          )
        )
      )
  );
$$;

revoke execute on function public.phoenix_crm_offplan_exempt(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_exempt(text, uuid, uuid) to service_role;

create or replace function public.phoenix_crm_offplan_exempt_customers(p_seat text)
returns table (customer_id uuid, label text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct c.id, e.label
  from public.phoenix_crm_offplan_exemptions e
  join public.phoenix_crm_customers c on c.seat_id = e.seat_id
  where e.seat_id = p_seat
    and e.ended_at is null
    and (
      (e.customer_id is not null and c.id = e.customer_id)
      or (
        (e.venue_name_key is not null or e.shared_place_id is not null)
        and exists (
          select 1
          from public.phoenix_crm_places pl
          join public.phoenix_crm_shared_places sp on sp.id = pl.shared_place_id
          where pl.customer_id = c.id
            and sp.seat_id = e.seat_id
            and (
              e.shared_place_id = sp.id
              or public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%'
            )
        )
      )
    );
$$;

revoke execute on function public.phoenix_crm_offplan_exempt_customers(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_offplan_exempt_customers(text) to service_role;

create or replace function public.phoenix_crm_venue_cap_lifted(p_seat text)
returns table (shared_place_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct sp.id
  from public.phoenix_crm_offplan_exemptions e
  join public.phoenix_crm_shared_places sp on sp.seat_id = e.seat_id
  where e.seat_id = p_seat
    and e.ended_at is null
    and e.lifts_venue_cap
    and (
      e.shared_place_id = sp.id
      or (
        e.venue_name_key is not null
        and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%'
      )
    );
$$;

revoke execute on function public.phoenix_crm_venue_cap_lifted(text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_venue_cap_lifted(text) to service_role;

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
  -- A venue the owner raised (2026-11-02) holds its own number, and never less than the company's.
  select sp.daily_cap into v_own from public.phoenix_crm_shared_places sp where sp.id = v_shared;
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

-- The page's read: every live venue of the seats, each answered by the same match the door uses.
create or replace function public.phoenix_crm_venue_cap_board(p_seats text[])
returns table (
  shared_place_id uuid,
  seat_id text,
  name text,
  kind text,
  status text,
  seated integer,
  daily_cap integer,
  daily_cap_set_by_hr_id text,
  daily_cap_set_at timestamptz,
  lifted boolean,
  lifted_by_hr_id text,
  lifted_at timestamptz,
  unplanned_free boolean
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select sp.id,
         sp.seat_id,
         sp.name,
         sp.kind,
         sp.status,
         (
           select count(*)::integer
           from public.phoenix_crm_places pl
           where pl.shared_place_id = sp.id and pl.retired_at is null and not pl.is_test
         ),
         sp.daily_cap,
         sp.daily_cap_set_by_hr_id,
         sp.daily_cap_set_at,
         lift.id is not null,
         lift.granted_by_hr_id,
         lift.created_at,
         partial.id is not null
  from public.phoenix_crm_shared_places sp
  left join lateral (
    select e.id, e.granted_by_hr_id, e.created_at
    from public.phoenix_crm_offplan_exemptions e
    where e.seat_id = sp.seat_id
      and e.ended_at is null
      and e.lifts_venue_cap
      and (
        e.shared_place_id = sp.id
        or (e.venue_name_key is not null and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%')
      )
    order by e.created_at desc
    limit 1
  ) lift on true
  left join lateral (
    select e.id
    from public.phoenix_crm_offplan_exemptions e
    where e.seat_id = sp.seat_id
      and e.ended_at is null
      and not e.lifts_venue_cap
      and (
        e.shared_place_id = sp.id
        or (e.venue_name_key is not null and public.phoenix_crm_fold_name(sp.name) like '%' || e.venue_name_key || '%')
      )
    limit 1
  ) partial on true
  where sp.seat_id = any(p_seats)
    and sp.retired_at is null
    and not sp.is_test
  order by sp.name, sp.id;
$$;

revoke execute on function public.phoenix_crm_venue_cap_board(text[]) from public, anon, authenticated;
grant execute on function public.phoenix_crm_venue_cap_board(text[]) to service_role;

-- The page's write, in one transaction under the venue's lock.
--   lift       a row naming this venue, unless the door already answers it lifted.
--   unlift     ends every lifting row that reaches this venue. A name key row that also reaches ANOTHER live venue of
--              the seat first gives that venue a row of its own, so switching one off never switches a second off.
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
      insert into public.phoenix_crm_offplan_exemptions
        (seat_id, label, shared_place_id, note, granted_by_hr_id, lifts_venue_cap)
      values
        (v_place.seat_id, v_place.name, v_place.id, 'Switched on from the Polyclinic Caps page.', p_actor, true);
    end if;

  elsif p_action in ('unlift', 'end_partial') then
    v_flag := p_action = 'unlift';
    for v_row in
      select e.id, e.venue_name_key
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
        insert into public.phoenix_crm_offplan_exemptions
          (seat_id, label, shared_place_id, note, granted_by_hr_id, lifts_venue_cap)
        select other.seat_id, other.name, other.id, 'Kept when a row that also named this venue was ended.', p_actor, v_flag
        from public.phoenix_crm_shared_places other
        where other.seat_id = v_place.seat_id
          and other.id <> v_place.id
          and other.retired_at is null
          and not other.is_test
          and public.phoenix_crm_fold_name(other.name) like '%' || v_row.venue_name_key || '%'
          and not exists (
            select 1 from public.phoenix_crm_offplan_exemptions kept
            where kept.shared_place_id = other.id and kept.lifts_venue_cap = v_flag and kept.ended_at is null
          );
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
