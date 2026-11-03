-- phoenix_crm_rep_offplan_exception_admin
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_rep_exception_set(seats, rep, action, from, until, actor) is the one write behind the Super Admin's
--      Rep Exceptions page. 'open' ends the rep's open dated rows and writes one row per seat for the new dates, so a
--      change of dates leaves the old window behind as history. 'close' ends the rep's open dated rows. Rows are never
--      removed. The door is not touched: phoenix_crm_offplan_rep_exempt already reads these rows.
--   2. A unique index holds one open dated row per seat and rep, so a double press can never leave two windows.
--
-- WHY (owner, 2026-11-03: "build a module for admin only to open or close this feature by a toggle or be able to
--   control duration for any rep if needed exception"). Aya Mamdouh's and Nora Kamal's first months were each written
--   by hand. The page covers any rep, for any dates, and still only lifts the 2 a day and 8 a week.
--
-- WHAT STAYS: no setting moves, no visit is rewritten, approval stays district manager then SFE, the venue's own daily
--   number stays, and a visit already stamped offplan_exempt keeps its stamp when a window is closed or shortened.
--
-- The rep's spelling comes from employees, because the door compares rep_hr_id with the visit's rep_hr_id exactly and
--   the page's key is upper-cased.
--
-- ROLLBACK
--   drop function public.phoenix_crm_rep_exception_set(text[], text, text, date, date, text);
--   drop index public.phoenix_crm_offplan_exemptions_one_open_rep_window;
--   Rows the page wrote stay valid and keep working at the door; end one with ended_at.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds one function and one index and changes no row.

begin;
set local lock_timeout = '5s';

create unique index if not exists phoenix_crm_offplan_exemptions_one_open_rep_window
  on public.phoenix_crm_offplan_exemptions (seat_id, rep_hr_id)
  where ended_at is null and rep_hr_id is not null;

create or replace function public.phoenix_crm_rep_exception_set(
  p_seats text[],
  p_rep text,
  p_action text,
  p_from date,
  p_until date,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_rep text;
begin
  select e.hr_id into v_rep
  from public.employees e
  where upper(btrim(e.hr_id)) = upper(btrim(p_rep))
  limit 1;
  if v_rep is null then
    raise exception 'phoenix_crm:rep_exception_no_rep';
  end if;

  if p_action not in ('open', 'close') then
    raise exception 'phoenix_crm:rep_exception_action';
  end if;

  -- Written with explicit IS NULL, so a missing date can never pass a comparison.
  if p_action = 'open' and (
    p_from is null
    or p_until is null
    or p_from > p_until
    or p_until < (now() at time zone 'Africa/Cairo')::date
  ) then
    raise exception 'phoenix_crm:rep_exception_dates';
  end if;

  if p_action = 'open' and coalesce(array_length(p_seats, 1), 0) = 0 then
    raise exception 'phoenix_crm:rep_exception_no_rep';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('phoenix_crm_rep_exception:' || v_rep, 0));

  update public.phoenix_crm_offplan_exemptions e
  set ended_at = now(), ended_by_hr_id = p_actor
  where e.rep_hr_id = v_rep
    and e.ended_at is null;

  if p_action = 'open' then
    insert into public.phoenix_crm_offplan_exemptions (seat_id, rep_hr_id, valid_from, valid_until, label, note, granted_by_hr_id)
    select distinct seat.id, v_rep, p_from, p_until, 'Rep exception', 'Set on the Rep Exceptions page.', p_actor
    from unnest(p_seats) as seat(id);
  end if;
end;
$$;

revoke execute on function public.phoenix_crm_rep_exception_set(text[], text, text, date, date, text) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_exception_set(text[], text, text, date, date, text) to service_role;

notify pgrst, 'reload schema';

commit;
