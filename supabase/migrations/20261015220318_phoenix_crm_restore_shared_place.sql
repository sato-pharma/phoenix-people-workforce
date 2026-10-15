-- phoenix_crm_restore_shared_place
--
-- WHAT THIS CHANGES:
--   ONE new function, `public.phoenix_crm_restore_shared_place(p jsonb)` — the undo of a venue
--   rejection. Nothing existing is altered: no table, column, constraint, policy, index or other
--   function is touched, and no row is rewritten by the migration itself.
--
-- WHY:
--   Owner, 2026-10-15: "make me able to approve validation after rejection."
--
--   A rejected PLACE could already be taken back (`phoenix_crm_restore_validation`, 2026-10-03). A
--   rejected VENUE could not, anywhere, by anybody — and a venue rejection is the heaviest decision
--   on the Place checks page: it retires the building, retires every customer seated in it, and sends
--   each of them back to To validate to be captured again at the door. Measured on production the day
--   this was written: 35 retired venues, none of them with a way back, and `loadSharedPlaceBoard`
--   reads `status in ('active','held')` — so a rejected one is not even on the screen to decide.
--   One mis-click on a building with a dozen doctors behind it cost a dozen re-captures.
--
--   This is the mirror of the approve branch of `phoenix_crm_decide_shared_place`, not a new policy:
--   the venue comes back ACTIVE, the places that rejection retired come back ACTIVE, and each of
--   those customers is confirmed under exactly the three holds approving a held venue already keeps
--   (no timetable on file, a timetable read as `other_name`/`no_schedule`, or his own location still
--   waiting on a validation review). `unjudged` never holds, here as everywhere.
--
--   🔴 WHICH PLACES COME BACK IS DECIDED BY `retired_at`, NOT BY THE SEATING. A venue's rejection
--   retires the venue and its seated places inside ONE transaction, where `now()` is constant — so
--   every place it retired carries exactly the venue's own `retired_at`, to the microsecond. Matching
--   on that timestamp restores precisely what that rejection took and leaves alone a place retired
--   before it for its own reason (a refused validation of his own, a move), which a bare
--   `shared_place_id = <venue> and status = 'retired'` would wrongly resurrect.
--
-- ROLLBACK:
--   `drop function if exists public.phoenix_crm_restore_shared_place(jsonb);` — nothing depends on it
--   but this module's own service. A restore already taken is ordinary module data (an active venue,
--   active seated places, confirmed customers and their events) and is undone on the page itself by
--   rejecting the venue again.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This
-- file adds one function and writes no data.

begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_restore_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  -- Optional, as every admin note on this page is since 2026-10-15 ("admin comment is optional").
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_retired_at timestamptz;
  v_seated record;
  v_places integer := 0;
  v_validated jsonb := '[]'::jsonb;
  v_still_waiting jsonb := '[]'::jsonb;
begin
  if v_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_venue.seat_id));
  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id for update;

  -- Only a REJECTED venue can be taken back, and only while it is still in the state the rejection
  -- left it in — the same pair of tests `phoenix_crm_restore_validation` makes about a place.
  if v_venue.status <> 'retired' or v_venue.retired_at is null then
    raise exception 'phoenix_crm:shared_place_not_retired';
  end if;
  v_retired_at := v_venue.retired_at;

  update public.phoenix_crm_shared_places
  set status = 'active',
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      refusal_reason = null,
      retired_at = null,
      retired_by_hr_id = null,
      updated_at = now()
  where id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_venue.seat_id, 'shared_place_restored', v_actor,
    jsonb_build_object(
      'shared_place_id', v_id, 'shared_place_name', v_venue.name, 'note', v_note,
      'rejected_by_hr_id', v_venue.retired_by_hr_id, 'rejected_at', v_retired_at,
      'rejection_note', v_venue.decision_note, 'refusal_reason', v_venue.refusal_reason
    ),
    v_venue.is_test
  );

  -- Exactly the places that rejection retired — see the header on why this is `retired_at`.
  for v_seated in
    select pl.id as place_id, pl.customer_id, pl.label, pl.schedule_check, pl.is_test,
           c.name as customer_name, c.status as customer_status
    from public.phoenix_crm_places pl
    join public.phoenix_crm_customers c on c.id = pl.customer_id
    where pl.shared_place_id = v_id
      and pl.status = 'retired'
      and pl.retired_at = v_retired_at
    order by pl.created_at
  loop
    update public.phoenix_crm_places pl
    set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
    where pl.id = v_seated.place_id;
    v_places := v_places + 1;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'place_restored', v_actor,
      jsonb_build_object(
        'reason', v_note, 'label', v_seated.label, 'why', 'shared_place_restored',
        'shared_place_id', v_id, 'rejected_at', v_retired_at
      ),
      v_seated.is_test
    );

    -- 🔴 THE SAME THREE HOLDS APPROVING A HELD VENUE KEEPS (owner, 2026-10-14): a building with no
    -- timetable on file, a timetable read as another name or as no schedule, and a customer whose own
    -- location is waiting on a validation review all STAY pending. That rule is lifted verbatim from
    -- the approve branch, never widened — bringing the building back must not confirm a doctor the
    -- building itself cannot answer for.
    if v_seated.customer_status = 'pending' then
      if v_venue.schedule_photo_path is null
        or (v_seated.schedule_check ->> 'verdict') in ('other_name', 'no_schedule')
        or exists (
          select 1 from public.phoenix_crm_validation_reviews r
          where r.customer_id = v_seated.customer_id and r.status = 'pending'
        ) then
        v_still_waiting := v_still_waiting || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name
        ));
        continue;
      end if;

      update public.phoenix_crm_customers c
      set status = 'active', validated_at = now(), validated_by_hr_id = v_actor,
          status_changed_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'customer_validated', v_actor,
          jsonb_build_object('why', 'shared_place_restored', 'shared_place_id', v_id, 'shared_place_name', v_venue.name),
          v_seated.is_test
        );
        v_validated := v_validated || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name, 'place_id', v_seated.place_id
        ));
      end if;
    end if;
  end loop;

  -- 🔴 THE WAIT IS CLEARED FOR WHOEVER IS BACK IN USE, AND KEPT FOR WHOEVER IS NOT. `reopened_at` is
  -- what puts a customer first in his rep's To validate order; a customer this restore confirmed has
  -- nothing left to capture, so leaving the stamp on would hold him at the top of a list he is no
  -- longer on. A customer still pending keeps it, because he really is still waiting.
  update public.phoenix_crm_customers c
  set reopened_at = null, updated_at = now()
  where c.status = 'active'
    and c.reopened_at is not null
    and exists (
      select 1 from public.phoenix_crm_places pl
      where pl.customer_id = c.id and pl.shared_place_id = v_id and pl.status = 'active'
    );

  return jsonb_build_object(
    'shared_place_id', v_id,
    'name', v_venue.name,
    'seat_id', v_venue.seat_id,
    'is_test', v_venue.is_test,
    'status', 'active',
    'places_restored', v_places,
    'validated', v_validated,
    'still_waiting', v_still_waiting
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_shared_place(jsonb) to service_role;

-- THE LEDGER ROW IS NOT WRITTEN HERE, DELIBERATELY. This module's own guard
-- (`assertMigrationHygiene`, tests/phoenix-crm-boundary.test.ts) refuses a Phoenix CRM migration
-- that writes `supabase_migrations.schema_migrations` — the module writes its own tables only —
-- and it is right: a file that stamps its own version can record a migration against a database
-- it only half reached. `apply_migration` writes that row itself; applied with
-- `scripts/apply-sql-file.mjs`, which writes none, the row is inserted in a separate statement
-- AFTER `pg_proc` has been read back and proves the function is there.

notify pgrst, 'reload schema';

commit;
