-- Recruitment / ATS — one bulk screening decision, in one transaction.
--
-- WHY. Screening is one person against ~22 CVs a day, and the backlog measured 2026-09-05 was 238
-- candidates still `new` after 14 days with 438 never opened by anybody. Clearing that one row at a
-- time is the bottleneck. The obvious client-side answer — loop over the selection and PATCH each
-- one — is the wrong one here for a reason this repository has already been bitten by: a Supabase
-- client request that times out at 15s STILL COMMITS, so a loop that dies halfway leaves some
-- candidates moved, some not, and the screen showing an error that makes it look like none were.
-- The recruiter then repeats the decision over rows that already have it.
--
-- So the whole decision is ONE statement in ONE function: every candidate moves or none does, and
-- every move gets its history row in the same transaction. A failure leaves the queue exactly as it
-- was, which is the only state a tired screener at 2am can reason about.
--
-- WHAT IT DOES NOT DO.
--
--   * It does NOT validate the status vocabulary. That is deliberate and consistent: `status` is
--     plain text with no CHECK by an existing decision (see src/lib/recruitment/candidate-status.ts
--     and the note in the single-candidate route), and the one authority is TypeScript at the API
--     boundary. Adding a second authority in SQL is how the two drift and a legitimate new status
--     starts failing with a 500 nobody can place.
--   * It is NOT `security definer`. It runs as its caller, which is the service-role client, so it
--     gains no privilege of its own. A definer function here would run as the table owner and
--     silently outrank any grant the app later relies on.
--   * It does NOT decide WHICH statuses may be set in bulk. `hired` must go through the offer chain
--     and `sent_to_manager` must actually notify somebody; both are refused in the service layer,
--     where that product rule is readable, rather than encoded here.
--
-- THE CAP IS BLAST RADIUS, NOT VOCABULARY. 200 is not a performance limit — it is the largest
-- mistake one press should be able to make. The service caps first so the caller gets a clean 400;
-- this one exists because the function is reachable without going through it.

create or replace function public.ats_bulk_set_candidate_status(
  p_candidate_ids uuid[],
  p_status text,
  p_note text,
  p_actor_hr_id text
)
returns table (candidate_id uuid, from_status text, to_status text)
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer := coalesce(cardinality(p_candidate_ids), 0);
begin
  -- An empty selection is a no-op, not an error: it is what a double-press on an already-cleared
  -- list looks like, and failing there would teach the recruiter to distrust a button that worked.
  if v_count = 0 then
    return;
  end if;

  if v_count > 200 then
    raise exception 'A bulk decision is capped at 200 candidates; this call passed %.', v_count
      using errcode = 'check_violation';
  end if;

  if p_status is null or btrim(p_status) = '' then
    raise exception 'A bulk decision needs a status.' using errcode = 'check_violation';
  end if;

  return query
  -- Every CTE below reads ONE snapshot, so `before` still holds the pre-update status even though
  -- `moved` overwrites it in the same statement. That is what makes the history row able to record
  -- where each candidate came FROM — an UPDATE ... RETURNING cannot, it returns only new values.
  with before as (
    select c.id, c.status as from_status
    from public.ats_candidates c
    where c.id = any(p_candidate_ids)
  ),
  moved as (
    update public.ats_candidates c
    set status = p_status,
        status_changed_at = v_now,
        status_changed_by_hr_id = p_actor_hr_id,
        -- An omitted note CLEARS the previous one, exactly as the single-candidate path does. The
        -- note describes the status it was written for, so carrying an old reason forward would be
        -- a lie; the reason itself survives on the event row below.
        status_note = p_note,
        updated_at = v_now
    from before b
    where c.id = b.id
    returning c.id
  ),
  -- A data-modifying CTE always runs to completion whether or not the outer query reads it, so the
  -- history cannot be skipped by anything the SELECT below does. It is joined to `moved` rather
  -- than to `before` so a row that somehow failed to update gets no history line claiming it did.
  logged as (
    insert into public.ats_candidate_status_events
      (candidate_id, from_status, to_status, note, actor_hr_id)
    select b.id, b.from_status, p_status, p_note, p_actor_hr_id
    from before b
    join moved m on m.id = b.id
    returning public.ats_candidate_status_events.candidate_id
  )
  select b.id, b.from_status, p_status
  from before b
  join logged l on l.candidate_id = b.id;
end;
$$;

comment on function public.ats_bulk_set_candidate_status(uuid[], text, text, text) is
  'One screening decision across many candidates, atomically: moves each candidate and writes its status-history row in the same transaction, returning one row per candidate actually moved with the status it came from. Capped at 200 per call as a blast-radius limit. Does not validate the status vocabulary (TypeScript is the single authority) and is not SECURITY DEFINER. Added 2026-09-05 to make clearing a 238-CV backlog one press instead of 238.';


-- ── UNDO ────────────────────────────────────────────────────────────────────────────────────────
--
-- A separate function, not a flag on the one above, because a revert is a genuinely different
-- operation: the bulk decision sets ONE status for every candidate, while a revert must put each
-- one back to its OWN previous status, which may differ row by row.
--
-- WHY IT IS NOT SIMPLY "BULK-DECIDE BACK". `bulkDecidableStatuses` allows only `shortlisted` and
-- `rejected`, and it is right to: deciding fifty CVs into `sent_to_manager` would mark them sent to
-- a manager nobody told. But a REVERT to `sent_to_manager` tells no such lie — that candidate really
-- was sent, and the notification really did happen; this only puts back the row as it stood ten
-- seconds ago. Routing undo through the decision rule would either block the commonest undo (back to
-- `new`, which is the whole backlog case) or force the decision rule open for a reason that does not
-- apply to it.
--
-- IT WRITES HISTORY LIKE ANY OTHER MOVE. An undo is not an erasure: the original decision stays on
-- the record and the reversal is added after it. Anyone auditing later sees that somebody decided
-- and then changed their mind within seconds, which is the truth and is more useful than a gap.
--
-- `status` is NOT NULL in this table (verified in production 2026-09-05: zero nulls, zero blanks,
-- and only the four real values — no legacy free text survives), so a restore always has a real
-- status to go back to and `ats_candidate_status_events.to_status NOT NULL` is never in the way.

create or replace function public.ats_revert_candidate_status(
  p_candidate_ids uuid[],
  p_statuses text[],
  p_notes text[],
  p_actor_hr_id text
)
returns table (candidate_id uuid, restored_to text)
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer := coalesce(cardinality(p_candidate_ids), 0);
begin
  if v_count = 0 then
    return;
  end if;

  if v_count > 200 then
    raise exception 'A revert is capped at 200 candidates; this call passed %.', v_count
      using errcode = 'check_violation';
  end if;

  -- The three arrays are positional. A length mismatch would silently pair a candidate with somebody
  -- else's status — the one failure here that would be invisible afterwards, because the result
  -- would look like a perfectly ordinary set of moves.
  if coalesce(cardinality(p_statuses), 0) <> v_count or coalesce(cardinality(p_notes), 0) <> v_count then
    raise exception 'A revert needs one status and one note per candidate; got % ids, % statuses, % notes.',
      v_count, coalesce(cardinality(p_statuses), 0), coalesce(cardinality(p_notes), 0)
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from unnest(p_statuses) as s where s is null or btrim(s) = '') then
    raise exception 'A revert cannot restore a blank status.' using errcode = 'check_violation';
  end if;

  return query
  with want as (
    select t.id, t.status, t.note
    from unnest(p_candidate_ids, p_statuses, p_notes) as t(id, status, note)
  ),
  before as (
    select c.id, c.status as from_status
    from public.ats_candidates c
    where c.id in (select w.id from want w)
  ),
  moved as (
    update public.ats_candidates c
    set status = w.status,
        status_note = w.note,
        status_changed_at = v_now,
        status_changed_by_hr_id = p_actor_hr_id,
        updated_at = v_now
    from want w
    where c.id = w.id
    returning c.id
  ),
  logged as (
    insert into public.ats_candidate_status_events
      (candidate_id, from_status, to_status, note, actor_hr_id)
    select b.id, b.from_status, w.status, w.note, p_actor_hr_id
    from before b
    join want w on w.id = b.id
    join moved m on m.id = b.id
    returning public.ats_candidate_status_events.candidate_id
  )
  select b.id, w.status
  from before b
  join want w on w.id = b.id
  join logged l on l.candidate_id = b.id;
end;
$$;

comment on function public.ats_revert_candidate_status(uuid[], text[], text[], text) is
  'Puts candidates back to their own previous status and note, atomically — the undo behind a screening decision. Positional arrays, one status and one note per id, refused on a length mismatch. Writes a history row per candidate rather than erasing the original decision, so the record shows the change of mind. Deliberately separate from ats_bulk_set_candidate_status because a revert restores a per-row status and is not bound by the bulk-decision vocabulary. Added 2026-09-05.';
