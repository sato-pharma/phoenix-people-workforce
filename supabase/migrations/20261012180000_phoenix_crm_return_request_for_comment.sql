-- Phoenix CRM — SFE returns a list request to the rep for a comment (owner, 2026-10-12: "add an option for
-- the SFE to return for comment").
--
-- A request that SFE returns is NOT decided: it stays `pending`, but its `stage` becomes 'rep' — the rep
-- owes the next move. Every queue, counter and nudge reads `stage`, so a returned request drops out of
-- SFE's waiting list on its own and comes back the moment the rep answers. When he does, the request goes
-- STRAIGHT BACK to SFE (never through the district manager again), at the step it was returned from:
-- 'sfe' for a drop, an add or a bring-back, and no stage at all for a grade change (one step, stage null).
--
--   sfe ──return(note)──▶ rep ──answer(comment)──▶ sfe        (a grade change: null ▶ rep ▶ null)
--
-- Only the step SFE holds can be returned. Nothing here approves or refuses anything, and a request with
-- the rep can still be refused (by SFE, or declined by the Administrator) or withdrawn (by the rep).
--
-- Additive only: five nullable columns, the two stage constraints widened, one guard trigger and two
-- functions. No existing row changes, and no existing function body is touched.

begin;

set local lock_timeout = '5s';

-- ── 1. What the return and the answer leave on the row ──────────────────────────────────────────────

alter table public.phoenix_crm_list_requests
  add column if not exists return_note text,
  add column if not exists returned_by_hr_id text,
  add column if not exists returned_at timestamptz,
  add column if not exists rep_reply text,
  add column if not exists replied_at timestamptz;

alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_return_texts;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_return_texts check (
    (return_note is null or char_length(return_note) <= 500) and (rep_reply is null or char_length(rep_reply) <= 500)
  );

comment on column public.phoenix_crm_list_requests.return_note is
  'What SFE asked the rep to explain when he returned the request for a comment. Kept after the rep answers.';
comment on column public.phoenix_crm_list_requests.rep_reply is
  'The rep''s answer to the return. For a customer being dropped it is also added to `note`, so the Archive keeps the comment.';

-- ── 2. 'rep' is a stage: the request is with the rep ─────────────────────────────────────────────────

alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_stage;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_stage check (stage is null or stage in ('manager', 'sfe', 'rep'));

-- Any waiting request has a stage, except a grade change, which has none — unless it is with the rep.
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_stage_when_waiting;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_stage_when_waiting
  check ((status = 'pending' and (kind <> 'grade' or stage = 'rep')) = (stage is not null));

comment on column public.phoenix_crm_list_requests.stage is
  'Who decides next while the request waits: manager (the territory''s district manager), then sfe; rep while SFE has returned it for a comment. Null once decided, and null for a grade change, which is one step, unless it is with the rep.';

-- ── 3. A request with the rep can never be approved ──────────────────────────────────────────────────

-- The decide function is untouched. This guard sits under EVERY writer, so an approval cannot slip past
-- a request the rep still owes a comment on, whichever code path reaches the row. Refusing and
-- withdrawing are unaffected: they never set status 'approved'.
create or replace function public.phoenix_crm_list_requests_with_rep_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.stage = 'rep' and new.status = 'approved' then
    raise exception 'phoenix_crm:request_with_rep';
  end if;
  return new;
end;
$$;

create or replace trigger phoenix_crm_list_requests_with_rep_guard
  before update on public.phoenix_crm_list_requests
  for each row
  execute function public.phoenix_crm_list_requests_with_rep_guard();

-- ── 4. SFE returns a request for a comment ───────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_return_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_stage_in text := nullif(p ->> 'stage', '');
  v_seat text;
  v_request public.phoenix_crm_list_requests%rowtype;
begin
  if v_actor is null or v_request_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
  for update;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  if v_request.stage = 'rep' then
    raise exception 'phoenix_crm:already_returned';
  end if;
  -- Two people deciding at once: the step this screen showed has already moved on.
  if v_stage_in is not null and v_stage_in is distinct from v_request.stage then
    raise exception 'phoenix_crm:request_wrong_stage';
  end if;
  -- Only the step SFE holds can be returned: the second step of a drop, an add or a bring-back, or a
  -- grade change on a territory the app has put in SFE's hands. The district manager's own step is his.
  if v_request.stage = 'manager' then
    raise exception 'phoenix_crm:cannot_return';
  end if;

  update public.phoenix_crm_list_requests q
  set stage = 'rep',
      return_note = v_note,
      returned_by_hr_id = v_actor,
      returned_at = now(),
      rep_reply = null,
      replied_at = null
  where q.id = v_request.id
  returning q.* into v_request;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_request.customer_id, v_request.id, 'request_returned', v_actor, jsonb_build_object('kind', v_request.kind), v_is_test);

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'pending',
    'stage', 'rep',
    'returned_at', v_request.returned_at,
    'customer_id', v_request.customer_id,
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

-- ── 5. The rep answers, and the request goes straight back to SFE ────────────────────────────────────

create or replace function public.phoenix_crm_answer_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_reply text := nullif(regexp_replace(trim(coalesce(p ->> 'reply', '')), '\s+', ' ', 'g'), '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_back_to text;
  v_note text;
begin
  if v_seat is null or v_actor is null or v_request_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reply is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if char_length(v_reply) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.seat_id = v_seat
    and q.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  if v_request.stage is distinct from 'rep' then
    raise exception 'phoenix_crm:not_returned';
  end if;

  -- Back to the step it was returned from: a grade change has no stage, everything else is SFE's.
  v_back_to := case when v_request.kind = 'grade' then null else 'sfe' end;

  -- A drop carries its comment into the Archive (`dropped_note` is read off `note`). The reply is added
  -- to what the rep wrote first rather than replacing it, and stands alone only when the two together
  -- would not fit the 500 characters a note holds.
  v_note := v_request.note;
  if v_request.kind = 'drop' then
    v_note := case
      when v_request.note is null then v_reply
      when char_length(v_request.note || ' — ' || v_reply) <= 500 then v_request.note || ' — ' || v_reply
      else v_reply
    end;
  end if;

  update public.phoenix_crm_list_requests q
  set stage = v_back_to,
      rep_reply = v_reply,
      replied_at = now(),
      note = v_note
  where q.id = v_request.id
  returning q.* into v_request;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_request.customer_id, v_request.id, 'request_answered', v_actor, jsonb_build_object('kind', v_request.kind), v_is_test);

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'pending',
    'stage', v_request.stage,
    'customer_name', v_request.customer_name,
    'returned_by_hr_id', v_request.returned_by_hr_id,
    'requested_by_hr_id', v_request.requested_by_hr_id,
    'replied_at', v_request.replied_at
  );
end;
$$;

-- Taken from everyone and given to the service role alone, like every other Phoenix CRM function.
revoke execute on function public.phoenix_crm_return_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_return_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_answer_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_answer_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_list_requests_with_rep_guard() from public, anon, authenticated;
grant execute on function public.phoenix_crm_list_requests_with_rep_guard() to service_role;

notify pgrst, 'reload schema';

commit;
