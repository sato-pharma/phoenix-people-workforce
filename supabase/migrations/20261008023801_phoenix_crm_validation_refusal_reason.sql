-- phoenix_crm_validation_refusal_reason
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_validation_reviews gains `refusal_reason text` + a CHECK holding exactly the six
--      keys in src/lib/phoenix-crm/validation-feedback.ts — what is wrong with the PHOTO, which is the
--      one thing the rep is ever told.
--   2. phoenix_crm_customers gains `reopened_at timestamptz` + a partial index, so "this customer is
--      waiting to be captured again, and has been for 40 hours" is a query instead of an inference.
--   3. phoenix_crm_decide_validation_review is patched — FOUR surgical edits and nothing else moves:
--      the reason is parsed, the reason is stored, `reopened_at` is stamped on the reject path, and the
--      returned jsonb widens with `rep_hr_id`, `customer_name` and `refusal_reason` so the service can
--      notify the rep without a second read. The body was taken from pg_proc.prosrc at md5
--      c1b8d643471aef711e5f21b3fde9687a (5,654 bytes) and is otherwise byte-for-byte that body.
--   No new function, no policy, no grant change — the restated grant pair below is exactly the ACL the
--   function already carries (postgres=X, service_role=X), restated per house convention because
--   `create or replace` is where an ACL has been lost before.
--
-- WHY:
--   Of the 24 validations a Super Admin has refused since the module went live on 03 Oct 2026, the
--   mandatory free-text note is the single character `-` in 22 of them, and nothing anywhere carried a
--   word of it to the rep. His list went quiet and he re-walked nothing: 0 of the 22 still-pending
--   reopened customers has been validated again, average wait 40.8 hours, oldest 76.7 hours. The owner,
--   2026-10-08: tell the rep why, from a fixed pick-list, worded about his own photo and never naming a
--   person. `refusal_reason` is where that choice is kept. It is a COLUMN and not a key inside the
--   `google` jsonb because refuse_validated_place upserts that column wholesale, and no CHECK can see
--   inside a jsonb — so a key there would be both overwritable and unconstrained.
--
--   `reopened_at` is the age, and the age is the whole point. locationCheck = 'not_confirmed' already
--   proves the FACT, and phoenix_crm_list_events already holds the moment — but that table is
--   append-only and read through PostgREST, so deriving the age would cost a paged read per seat on
--   every list, planner and visit-form open. One timestamptz on the row the loader already selects
--   costs nothing. 🔴 It deliberately covers what the function's own v_reopened flag MISSES: the
--   reopen guard only fires for a customer who was `active`, so a HELD FIRST validation that is then
--   rejected leaves him `pending` all along and v_reopened false — and he is just as much "validate
--   again". The stamp reads the TABLE's status after the reopen block, not the snapshot taken before it.
--   Nothing in SQL ever clears it: the loader nulls it for a non-pending customer, the same one-liner
--   locationCheck already uses, so the historical stamp survives and six SQL writers do not each need
--   a clearing clause one of them would forget.
--
--   🔴 A NULL reason is ACCEPTED HERE AND REQUIRED BY THE APPLICATION — a deliberate correction to the
--   plan, which had this function raise phoenix_crm:bad_input without one. This migration is applied
--   to production BEFORE the code that sends the reason merges (it has to be: a PostgREST select is one
--   string, so `reopened_at` named by code that ships before the column exists fails the rep's whole
--   list with 42703). Requiring it in SQL would therefore break the Super Admin's own Reject button for
--   the hours in between, for no safety gained: service_role is the only grantee, this repo's
--   decideValidationReview and refuseValidatedPlace are its only callers, both now refuse without a
--   reason in words he can read, and the column CHECK still guarantees no junk value is ever stored.
--
-- ROLLBACK:
--   alter table public.phoenix_crm_validation_reviews drop column if exists refusal_reason;
--     -- DATA COST: every reason a Super Admin has chosen is destroyed, and there is no second copy —
--     -- the free-text decision_note survives, but it is the note he writes for the record, not the
--     -- sentence the rep was shown. Not recoverable; each one would have to be chosen again by hand.
--   alter table public.phoenix_crm_customers drop column if exists reopened_at;
--     -- DATA COST: the age of every waiting re-capture is destroyed. Recoverable in part from
--     -- phoenix_crm_list_events' customer_pending / validation_review_rejected rows, which are
--     -- append-only — but only for a customer the reopen guard fired for, which is the subset this
--     -- column exists to widen.
--   drop index if exists phoenix_crm_customers_reopened_waiting_idx;
--   -- The function cannot be rolled back by a DROP: restore it from pg_proc.prosrc md5
--   -- c1b8d643471aef711e5f21b3fde9687a, which is the body this migration started from.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This adds
-- two nullable columns and one partial index, rewrites not one existing row, and replaces one function
-- body with the same body plus four additive statements.

begin;
set local lock_timeout = '5s';

-- 1 ─ What the rep is told about his own photo ───────────────────────────────────────────────────

alter table public.phoenix_crm_validation_reviews
  add column if not exists refusal_reason text;

alter table public.phoenix_crm_validation_reviews
  drop constraint if exists phoenix_crm_validation_reviews_refusal_reason;
-- 🔴 This list is the TypeScript union VALIDATION_REFUSAL_REASON_KEYS, literally. A test compares the
-- two, so adding a reason in one place and not the other fails the required `validate` job.
alter table public.phoenix_crm_validation_reviews
  add constraint phoenix_crm_validation_reviews_refusal_reason
  check (refusal_reason is null or refusal_reason in (
    'no_signboard', 'wrong_name', 'too_dark', 'not_at_door', 'photo_of_paper', 'point_off'
  ));

comment on column public.phoenix_crm_validation_reviews.refusal_reason is
  'What is wrong with the PHOTO, chosen by the Super Admin from the closed list in src/lib/phoenix-crm/validation-feedback.ts, and the one thing the rep is ever told. Null on a review decided before 08 Oct 2026, and on every approval. The free-text decision_note beside it is NEVER shown to the rep.';

-- 2 ─ Waiting to be captured again, and for how long ─────────────────────────────────────────────

alter table public.phoenix_crm_customers
  add column if not exists reopened_at timestamptz;

create index if not exists phoenix_crm_customers_reopened_waiting_idx
  on public.phoenix_crm_customers (seat_id, is_test)
  where reopened_at is not null and status = 'pending';

comment on column public.phoenix_crm_customers.reopened_at is
  'When this customer last went back to To validate because his place was refused. Stamped by phoenix_crm_decide_validation_review on the reject path for ANY customer left pending by it — including a held first validation, which the v_reopened flag misses. Never cleared in SQL: the loader nulls it for a customer who is not pending, so the historical stamp survives for the board.';

-- 3 ─ The decision, carrying the reason ──────────────────────────────────────────────────────────

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
  -- EDIT 1 of 4 (2026-10-08) — what the rep is told about his own photo. Accepted null here and
  -- REQUIRED by the service; the column CHECK is what guarantees the value is one of the six.
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
  if v_review.status <> 'pending' then
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
        -- EDIT 2 of 4 (2026-10-08).
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

    -- EDIT 3 of 4 (2026-10-08) — he is waiting to capture this place again, from now.
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
    -- EDIT 4 of 4 (2026-10-08) — so the service notifies the rep without a second read. rep_hr_id is
    -- the rep who VALIDATED, never the person deciding: he is the one whose photo this is.
    'rep_hr_id', v_review.created_by_hr_id,
    'customer_name', v_customer.name,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$function$;

revoke execute on function public.phoenix_crm_decide_validation_review(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_validation_review(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
