-- phoenix_crm_restore_validation_corrected_name
--
-- WHAT THIS CHANGES: replaces public.phoenix_crm_restore_validation(jsonb) with the same function plus one
--   optional input, `name`: when it is sent, the customer is renamed to it (through
--   phoenix_crm_rename_customer, the rep's own rename, so the name key and the history move as they always
--   do) in the same transaction that brings the place back, and any full name still held for him is
--   cleared, because the administrator has just written the name himself. Without `name` it behaves exactly
--   as before. A dropped customer is never renamed (the rename refuses one), exactly as
--   phoenix_crm_decide_full_name skips it. Nothing is written by this file.
-- WHY: owner, 2026-11-10 — "make the administrator able to approve a rejected validation from the SFE in
--   place checks but the SFE cannot; the administrator is never blocked". A clinic doctor written with one
--   or two names greyed "Approve it after all" out; asked what should happen, he answered "Both": his
--   approval goes through as it stands, and beside it an optional Edit name corrects the name and approves
--   in one step. Who may take a rejection back (the Super Admin alone) and who may send `name` are decided
--   in the service (src/lib/phoenix-crm/server/validation-reviews.ts), which refuses everybody else before
--   this is called; the function stays service_role-only.
-- ROLLBACK: re-run the phoenix_crm_restore_validation block of
--   supabase/migrations/20261015212903_phoenix_crm_reject_after_approve_and_optional_note.sql (the body this
--   replaces, md5 of prosrc 5d674338e76adfaa0154fdbf1cc73e6e on production before this file), after
--   reverting the code that sends `name`.
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
  -- The Super Admin's own spelling of the customer's name (owner, 2026-11-10: "Both"). The service has
  -- already refused everybody else and checked the three names; null means "keep the name as it stands".
  v_corrected text := nullif(left(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), 200), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_renamed boolean := false;
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

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  -- The place must still be in the state the rejection left it in. A moved or already-active place is
  -- a different story and is not undone here.
  if v_place.status <> 'retired' then
    raise exception 'phoenix_crm:place_not_retired';
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

  -- One review row per place (the UNIQUE index), so this is an UPDATE. What it was before is kept in
  -- `google`, beside the events, rather than being thrown away.
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
    jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'why', 'restored_after_rejection',
      'renamed', v_renamed),
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
    'renamed', v_renamed
  );
end;
$$;

revoke execute on function public.phoenix_crm_restore_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_validation(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
