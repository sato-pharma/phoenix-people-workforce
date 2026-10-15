-- phoenix_crm_reject_after_approve_and_optional_note
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_decide_validation_review — ONE surgical edit and nothing else moves: the status
--      guard, which raised `phoenix_crm:review_decided` for any review that was not `pending`, now
--      lets a REJECT through on an `approved` one. Every other re-decision still raises it: approving
--      an approved review, and anything at all on a rejected one (that reversal is
--      phoenix_crm_restore_validation, which owns its own rules). The body is otherwise byte-for-byte
--      the one migration 20261008023801 installed, including its four 2026-10-08 edits.
--   2. phoenix_crm_restore_validation — the free-text note is no longer required. `v_note is null` is
--      dropped from the bad_input guard; everything the function then writes already accepted a null
--      note (decision_note is nullable, and both events carry `reason` as a jsonb value). The rest of
--      the body is byte-for-byte the one migration 20261003184147 installed.
--   No table, column, constraint, policy or index changes. The restated grant pairs below are exactly
--   the ACL both functions already carry (postgres=X, service_role=X), restated per house convention
--   because `create or replace` is where an ACL has been lost before.
--
-- WHY:
--   Owner, 2026-10-15, naming the page: "/admin/field-crm/validation-reviews make admin able to reject
--   validation even if approved before and admin comment is optional."
--
--   An approval was final in one direction only. A rejection could be taken back ("add the option to
--   approve after reject", 2026-10-03), but an approval given in error had no undo on the row it was
--   given on: the Decided section showed an `Approved` pill and nothing else, and the only way back
--   was to find the same place again in "Validations the system did not question" and refuse it there
--   — which upserts the review row's `google` column wholesale and so DESTROYS the evidence the system
--   held it on (the listings, the signboard text, the names it read). Routing the undo through the
--   decision the page already makes keeps that evidence, keeps one audit shape, and makes the two
--   reversals symmetrical: approve ⇄ reject, each on the place's one review row.
--
--   The note: of the 24 refusals in the module's first five days, 22 carried the single character `-`.
--   A field that is required and never read is a field that gets a dash — the reason the REP is told
--   (refusal_reason, a closed list) stays required, because that one is the point.
--
-- ROLLBACK:
--   Both functions are restored by re-applying the migration each body came from — 20261008023801 for
--   phoenix_crm_decide_validation_review, 20261003184147 for phoenix_crm_restore_validation. No data
--   is written, rewritten or destroyed here, so there is nothing to recover: this replaces two
--   function bodies and nothing else. A rejection already taken on a previously approved review is
--   ordinary module data (a rejected review row, a retired place, a customer back under To validate,
--   four events) and is undone on the page itself by approving it after all.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- 1 ─ Rejecting a place that was approved before ─────────────────────────────────────────────────

create or replace function public.phoenix_crm_decide_validation_review(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- what the rep is told about his own photo (2026-10-08). Accepted null here and REQUIRED by the
  -- service; the column CHECK is what guarantees the value is one of the eight.
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_reopened boolean := false;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  -- 🔴 THE ONE EDIT OF THIS MIGRATION (owner, 2026-10-15: "make admin able to reject validation even
  -- if approved before"). A REJECT of an APPROVED review is the undo of that approval and runs the
  -- reject branch below exactly as a held review's rejection does — the place is retired, the
  -- customer goes back to To validate when it was his only one, reopened_at is stamped and the rep is
  -- told what is wrong with his photo. Everything else still raises review_decided: approving an
  -- approved review changes nothing, and a rejected one is reversed by
  -- phoenix_crm_restore_validation, which checks the place is still retired before it brings it back.
  if not (v_review.status = 'approved' and v_decision = 'reject') and v_review.status <> 'pending' then
    raise exception 'phoenix_crm:review_decided';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  if v_decision = 'approve' then
    update public.phoenix_crm_validation_reviews
    set status = 'approved', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note
    where id = v_id;

    if v_review.kind = 'validation' and v_customer.status = 'pending' and v_place.status = 'active' then
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

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_review.seat_id
          and q.is_test = v_review.is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and (
            q.customer_id = v_customer.id
            or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
          )
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_review.seat_id, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_review.is_test
      from withdrawn w;
    end if;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_approved', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated), v_review.is_test
    );
  else
    update public.phoenix_crm_validation_reviews
    set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note,
        refusal_reason = v_reason
    where id = v_id;

    if v_place.status = 'active' then
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_place.id;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_review.seat_id, v_customer.id, v_place.id, 'place_retired', v_actor,
        jsonb_build_object('reason', coalesce(v_note, 'The location could not be confirmed against Google Maps.'), 'label', v_place.label,
          'lat', v_place.lat, 'lon', v_place.lon, 'why', 'validation_rejected'),
        v_review.is_test
      );
    end if;

    if v_customer.status = 'active' and not exists (
      select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active'
    ) then
      update public.phoenix_crm_customers c
      set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
      where c.id = v_customer.id;
      v_reopened := true;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
      values (v_review.seat_id, v_customer.id, 'customer_pending', v_actor,
        jsonb_build_object('reference_contact_crm_id', v_customer.reference_contact_crm_id, 'why', 'validation_rejected'), v_review.is_test);
    end if;

    -- he is waiting to capture this place again, from now (2026-10-08).
    -- 🔴 c.status is read from the TABLE, deliberately, so it sees the reopen above; and this fires
    -- for a customer who was ALREADY pending (a held first validation), which v_reopened never does.
    update public.phoenix_crm_customers c
    set reopened_at = now(), updated_at = now()
    where c.id = v_customer.id and c.status = 'pending';

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_rejected', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'reopened', v_reopened, 'refusal_reason', v_reason), v_review.is_test
    );
  end if;

  return jsonb_build_object(
    'review_id', v_id,
    'status', case when v_decision = 'approve' then 'approved' else 'rejected' end,
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'reopened', v_reopened,
    -- so the service notifies the rep without a second read. rep_hr_id is the rep who VALIDATED,
    -- never the person deciding: he is the one whose photo this is.
    'rep_hr_id', v_review.created_by_hr_id,
    'customer_name', v_customer.name,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$function$;

revoke execute on function public.phoenix_crm_decide_validation_review(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_validation_review(jsonb) to service_role;

-- 2 ─ Taking a rejection back, with the note optional ────────────────────────────────────────────

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

-- ── The ledger row ──────────────────────────────────────────────────────────────────────────────
-- This file is applied through `scripts/apply-sql-file.mjs` (the standing route when the MCP
-- declines), which writes NO ledger row at all — so the row is written here, with the FILE's own
-- version, which is what `supabase db push` and the staging workflow match on. It is guarded on the
-- widened guard being live in `pg_proc`, so it can never record a migration that did not reach the
-- database it runs against, and on the row not already existing, so re-applying this file is a
-- no-op. Both functions are `create or replace`, so the whole file is idempotent either way.
insert into supabase_migrations.schema_migrations (version, name)
select '20261015212903', 'phoenix_crm_reject_after_approve_and_optional_note'
where exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'phoenix_crm_decide_validation_review'
          and position('and v_review.status <> ''pending'' then' in p.prosrc) > 0
          and position('v_review.status = ''approved'' and v_decision = ''reject''' in p.prosrc) > 0
      )
  and not exists (
        select 1
        from supabase_migrations.schema_migrations m
        where m.version = '20261015212903'
           or coalesce(m.name, '') = 'phoenix_crm_reject_after_approve_and_optional_note'
      );

notify pgrst, 'reload schema';

commit;
