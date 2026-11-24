-- phoenix_crm_super_admin_never_blocked
--
-- WHAT THIS CHANGES: replaces ONE function, public.phoenix_crm_restore_validation(jsonb) ("Approve it after all"
--   on a refused place). No table, column, constraint, index or data changes. The body 20261114062049 wrote
--   (md5 856f77c5… on production, read from pg_proc on 24 Nov 2026) with these changes, for a SUPER ADMIN only:
--     * a place in a RETIRED building: the building is brought back first, through
--       phoenix_crm_restore_shared_place itself (exactly the building's own "Approve it after all"), then the
--       place is approved;
--     * a DROPPED customer: put back on the list (status pending, his drop reason cleared) and then validated —
--       unless he was merged into another entry for the same doctor (phoenix_crm_customer_merged_away), where the
--       approval is recorded and the kept entry stays the one in use;
--     * the door CAPTURED AGAIN since (another active place of his in the same building or within 150 m): the
--       approval is recorded and the place in use stands — the old place is not brought back beside it, so no
--       customer gets two active places at one door (the 15 twins of 14 Nov 2026);
--     * a place NO LONGER RETIRED (brought back with its building, or in use again): the approval is recorded on it.
--   The result gains building_restored, customer_restored, kept_place_in_use, merged_away and
--   restored_after_rejection. Who rejected it and when are read BEFORE anything is cleared, so the review's
--   `google` payload and the events keep the real refusal even when the building's return reopened the review.
--   Anyone who is not a Super Admin meets exactly the refusals of before, in the same order (the service already
--   refuses them all before this function: canRestoreValidation).
-- WHY: owner, 24 Nov 2026, after meeting restore_building_retired twice on Qusiya at 11:23 Cairo: "never block
--   admin from appproving rejecting re approving or rejecdting never ever ever never". It replaces his 14 Nov
--   "Stop and say why" for the Super Admin.
-- ROLLBACK: re-run the phoenix_crm_restore_validation block of 20261114062049_phoenix_crm_validation_left_items.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one function body is replaced, no row is written.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_restore_validation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- The Super Admin's own spelling of the customer's name (owner, 2026-11-10: "Both"). The service has
  -- already refused everybody else and checked the three names; null means "keep the name as it stands".
  v_corrected text := nullif(left(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), 200), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_renamed boolean := false;
  -- 2026-11-14 (left items): the building the place is seated in, and whether the approval waits for it.
  v_building_status text;
  v_waiting boolean := false;
  -- 2026-11-24 (owner: "never block admin"): what was cleared for the Super Admin, and the refusal as it was.
  v_super boolean;
  v_rejected_by text;
  v_rejected_at timestamptz;
  v_rejection_note text;
  v_building_restored boolean := false;
  v_customer_restored boolean := false;
  v_kept_place_in_use boolean := false;
  v_merged_away boolean := false;
  v_door_captured_again boolean;
begin
  -- 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It used to raise
  -- bad_input on a null note; the four events and the review row this writes all accept one, and
  -- `who` and `when` are on the record whether or not he writes a word about it.
  if v_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  if v_review.status <> 'rejected' then
    raise exception 'phoenix_crm:review_not_rejected';
  end if;
  v_rejected_by := v_review.decided_by_hr_id;
  v_rejected_at := v_review.decided_at;
  v_rejection_note := v_review.decision_note;
  v_super := public.phoenix_crm_is_super_admin(v_actor);

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  -- The same door, captured again since: another active place of this customer in the same building, or
  -- within 150 m of this one (the line the Google check draws round a door).
  v_door_captured_again := exists (
    select 1 from public.phoenix_crm_places o
    where o.customer_id = v_place.customer_id
      and o.id <> v_place.id
      and o.status = 'active'
      and (
        (v_place.shared_place_id is not null and o.shared_place_id = v_place.shared_place_id)
        or (
          v_place.lat is not null and v_place.lon is not null and o.lat is not null and o.lon is not null
          and 6371000 * 2 * asin(least(1, sqrt(
            power(sin(radians(o.lat - v_place.lat) / 2), 2)
            + cos(radians(v_place.lat)) * cos(radians(o.lat)) * power(sin(radians(o.lon - v_place.lon) / 2), 2)
          ))) <= 150
        )
      )
  );

  if not v_super then
    -- The place must still be in the state the rejection left it in. A moved or already-active place is
    -- a different story and is not undone here.
    if v_place.status <> 'retired' then
      raise exception 'phoenix_crm:place_not_retired';
    end if;

    -- "APPROVE IT AFTER ALL" STOPS AND SAYS WHY (owner, 14 Nov 2026: "Stop and say why") — for everyone but
    -- the Super Admin, who is never blocked (24 Nov 2026, below).
    if v_customer.status = 'dropped' then
      raise exception 'phoenix_crm:restore_customer_dropped';
    end if;
    if v_place.shared_place_id is not null and exists (
      select 1 from public.phoenix_crm_shared_places sp
      where sp.id = v_place.shared_place_id and sp.status = 'retired'
    ) then
      raise exception 'phoenix_crm:restore_building_retired';
    end if;
    if v_door_captured_again then
      raise exception 'phoenix_crm:restore_door_captured_again';
    end if;
  else
    -- 🔴 THE SUPER ADMIN IS NEVER BLOCKED (owner, 24 Nov 2026: "never block admin from appproving rejecting re
    -- approving or rejecdting never ever ever never"). Each of the three things the 14 Nov rule refused by name
    -- is CLEARED here, in this transaction, and then he approves.
    --
    -- 1. A retired building is brought back first, through its own take-back, so its seats, its reopened
    --    reviews and its events are exactly those of pressing "Approve it after all" on the building.
    if v_place.shared_place_id is not null and exists (
      select 1 from public.phoenix_crm_shared_places sp
      where sp.id = v_place.shared_place_id and sp.status = 'retired'
    ) then
      perform public.phoenix_crm_restore_shared_place(jsonb_build_object(
        'shared_place_id', v_place.shared_place_id, 'actor_hr_id', v_actor, 'note', v_note
      ));
      v_building_restored := true;
      -- It may have brought this place back too (retired at the building's own moment) and reopened this review.
      select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
      select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;
    end if;

    -- 2. A dropped customer goes back on the list — never a merged-away twin, which the kept entry answers for.
    if v_customer.status = 'dropped' then
      if public.phoenix_crm_customer_merged_away(v_customer.id) then
        v_merged_away := true;
      else
        update public.phoenix_crm_customers c
        set status = 'pending', dropped_reason = null, dropped_note = null, status_changed_at = now(), updated_at = now()
        where c.id = v_customer.id;
        insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
        values (
          v_review.seat_id, v_customer.id, 'customer_restored', v_actor,
          jsonb_build_object('why', 'validation_restored', 'review_id', v_id, 'dropped_reason', v_customer.dropped_reason),
          v_review.is_test
        );
        select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer.id;
        v_customer_restored := true;
      end if;
    end if;

    -- 3. The door captured again since: the place in use stands and the old one stays where it is, so the
    --    customer never has two active places at one door. The approval is still his and still recorded.
    v_kept_place_in_use := v_place.status = 'retired' and v_door_captured_again;
  end if;

  -- The corrected name first, so everything below reads the customer as he now is. The rep's own rename:
  -- the name key, the contact's name row and the history move exactly as when he saves a name himself, and
  -- a second customer of the same name is the administrator's to judge, never a refusal.
  if v_corrected is not null and v_corrected is distinct from v_customer.name and v_customer.status <> 'dropped' then
    perform public.phoenix_crm_rename_customer(jsonb_build_object(
      'seat_id', v_customer.seat_id,
      'actor_hr_id', v_actor,
      'is_test', v_customer.is_test,
      'customer_id', v_customer.id,
      'name', v_corrected,
      'speciality', v_customer.speciality,
      'allow_same_name', true
    ));
    -- A full name still waiting on "PM full names to check" is answered by the name he just wrote.
    update public.phoenix_crm_customers c
    set full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id and c.full_name_held is not null;
    select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer.id;
    v_renamed := true;
  end if;

  -- The place comes back only when it is still retired, nothing stands at its door and the customer is not a
  -- merged-away twin.
  if v_place.status = 'retired' and not v_kept_place_in_use and not v_merged_away then
    update public.phoenix_crm_places pl
    set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
    where pl.id = v_place.id;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_place.id, 'place_restored', v_actor,
      jsonb_build_object('reason', v_note, 'label', v_place.label, 'why', 'validation_restored', 'review_id', v_id,
        'rejected_by_hr_id', v_rejected_by, 'rejection_note', v_rejection_note),
      v_review.is_test
    );
  end if;

  -- The rejection sent him back to To validate when this was his only place; the restore undoes that,
  -- in the REP's own name — he validated it, and a reversal does not take that away from him.
  -- 🔴 2026-11-14 (left items): the same wait as phoenix_crm_decide_validation_review. A place brought back
  -- into a building still being checked validates nobody until the building is approved; the review is
  -- approved all the same, and the building's approval reads it. The building's row is share-locked, so a
  -- decision on the building made at the same moment is seen whole or not at all.
  select sp.status into v_building_status
  from public.phoenix_crm_shared_places sp
  where sp.id = v_place.shared_place_id
  for share;
  v_waiting := v_customer.status = 'pending' and v_place.shared_place_id is not null and coalesce(v_building_status, '') = 'held';

  if v_customer.status = 'pending' and not v_waiting then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_review.created_by_hr_id,
        -- A validated customer carries no stamp of an old refusal (validation audit, 14 Nov 2026).
        reopened_at = null,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    v_validated := true;
  end if;

  -- One review row per place (the UNIQUE index), so this is an UPDATE. What it was before is kept in
  -- `google`, beside the events, rather than being thrown away.
  update public.phoenix_crm_validation_reviews r
  set status = 'approved',
      decided_by_hr_id = v_actor,
      decided_at = now(),
      decision_note = v_note,
      google = coalesce(r.google, '{}'::jsonb) || jsonb_build_object(
        'restored', true,
        'rejected_by_hr_id', v_rejected_by,
        'rejected_at', v_rejected_at,
        'rejection_note', v_rejection_note
      )
  where r.id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'validation_review_approved', v_actor,
    jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'why', 'restored_after_rejection',
      'renamed', v_renamed, 'waiting_for_building', v_waiting,
      'building_restored', v_building_restored, 'customer_restored', v_customer_restored,
      'kept_place_in_use', v_kept_place_in_use, 'merged_away', v_merged_away),
    v_review.is_test
  );

  return jsonb_build_object(
    'review_id', v_id,
    'status', 'approved',
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'place_id', v_place.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'waiting_for_building', v_waiting,
    'renamed', v_renamed,
    'restored_after_rejection', true,
    'building_restored', v_building_restored,
    'customer_restored', v_customer_restored,
    'kept_place_in_use', v_kept_place_in_use,
    'merged_away', v_merged_away
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_validation(jsonb) to service_role;

commit;
