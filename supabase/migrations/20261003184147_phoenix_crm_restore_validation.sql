-- phoenix_crm_restore_validation
--
-- WHAT THIS CHANGES:
--   Adds public.phoenix_crm_restore_validation(jsonb) — the Super Admin's undo of a REJECTED place
--   check. It brings the retired place back (status active, retired_at/retired_by cleared), validates
--   the customer again in the REP's own name when the rejection had sent him back to To validate, and
--   turns that place's review row from `rejected` to `approved`. No table or column changes.
--
-- WHY:
--   Owner, 2026-10-03: "add the option to approve after reject". A rejection could only be undone by
--   hand in SQL, and a wrong one costs the rep a second trip to the door for a place he had already
--   captured correctly. The rep's own list reads his customer's review row, so the "Validate again"
--   line clears by itself with no word about a person (golden rule #1).
--
--   🔴 The review row is UPDATED, not duplicated: `phoenix_crm_validation_reviews_place_idx` is UNIQUE
--   on place_id, so a place has exactly one review row for all time. The first draft of this function
--   inserted a second one and died on 23505 against real data — caught by running it on production
--   inside a transaction that was deliberately rolled back, which no source-pinned test could see.
--   The history is not lost: `phoenix_crm_list_events` keeps validation_review_rejected, place_retired,
--   place_restored and validation_review_approved, each with its actor, its note and its time.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_restore_validation(jsonb);
--   A restore already performed is undone by refusing the place again on the same page — the data it
--   writes is ordinary module data (an active place, a validated customer, an approved review row and
--   two events), none of it destructive and none of it dropped here.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

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
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
begin
  -- A reversal of a decision says why, like the refusal it undoes.
  if v_id is null or v_actor is null or v_note is null or char_length(v_note) > 500 then
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

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  -- The place must still be in the state the rejection left it in. A moved or already-active place is
  -- a different story and is not undone here.
  if v_place.status <> 'retired' then
    raise exception 'phoenix_crm:place_not_retired';
  end if;

  update public.phoenix_crm_places pl
  set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
  where pl.id = v_place.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'place_restored', v_actor,
    jsonb_build_object('reason', v_note, 'label', v_place.label, 'why', 'validation_restored', 'review_id', v_id,
      'rejected_by_hr_id', v_review.decided_by_hr_id, 'rejection_note', v_review.decision_note),
    v_review.is_test
  );

  -- The rejection sent him back to To validate when this was his only place; the restore undoes that,
  -- in the REP's own name — he validated it, and a reversal does not take that away from him.
  if v_customer.status = 'pending' then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_review.created_by_hr_id,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    v_validated := true;
  end if;

  -- One review row per place (the UNIQUE index above), so this is an UPDATE. What it was before is
  -- kept in `google`, beside the events, rather than being thrown away.
  update public.phoenix_crm_validation_reviews r
  set status = 'approved',
      decided_by_hr_id = v_actor,
      decided_at = now(),
      decision_note = v_note,
      google = coalesce(r.google, '{}'::jsonb) || jsonb_build_object(
        'restored', true,
        'rejected_by_hr_id', v_review.decided_by_hr_id,
        'rejected_at', v_review.decided_at,
        'rejection_note', v_review.decision_note
      )
  where r.id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'validation_review_approved', v_actor,
    jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'why', 'restored_after_rejection'),
    v_review.is_test
  );

  return jsonb_build_object(
    'review_id', v_id,
    'status', 'approved',
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'place_id', v_place.id,
    'is_test', v_review.is_test,
    'validated', v_validated
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_validation(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
