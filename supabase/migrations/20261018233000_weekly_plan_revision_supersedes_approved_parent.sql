-- 20261018233000_weekly_plan_revision_supersedes_approved_parent.sql
--
-- An employee can amend an APPROVED weekly or monthly plan again, and the approved plan is
-- replaced by the amendment when (and only when) the amendment is itself approved.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────────────────────────
--
-- updateEmployeePlan on an approved plan (final_approved / hr_acknowledged) inserts a NEW header
-- with parent_plan_id = the approved plan, same employee / kind / period, status 'draft', records a
-- `revise` decision, then calls phx_weekly_plan_replace_items(p_submit => true), which promotes the
-- new header to 'submitted'. employee_plan_headers_active_period_uidx
-- (20260725183742) holds every status except draft / cancelled / manager_rejected / ceo_rejected,
-- so the approved parent still counts and the promotion raises 23505. The form turned that into
-- "You already have an active plan for this period." — false: the plan it was colliding with was
-- the one being amended. Measured on production 2026-10-18: 24 revision headers, none ever
-- submitted; 23 are empty orphan drafts (a header and its `revise` decision, no items) because the
-- header and the decision commit before the item write fails.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────────────────────────
--
-- 1. employee_plan_headers_active_period_uidx keeps its job — one live plan per employee, kind and
--    period, which is what closed the B-122 duplicate-week gap — but a revision that is still
--    waiting for its decisions no longer counts against the plan it revises. The predicate now
--    reads: a live status AND (no parent OR already the plan of record). A pending revision has a
--    parent and is not yet final_approved / hr_acknowledged, so it is outside the index; the
--    moment it is approved it is inside it, and the parent has been cancelled by then (step 3).
--    Two UNRELATED headers for one period still collide, before and after any revision is approved.
--    This index only ever got narrower: every row that satisfied the old one satisfies the new one.
--
-- 2. employee_plan_headers_one_live_revision_uidx (new): at most ONE live revision per parent. A
--    second submit while the first is awaiting a decision (or has been returned to its author) is
--    refused by the database, and the app translates it into a true sentence. Drafts are exempt, as
--    in the index above.
--
-- 3. phx_weekly_plan_decide: when a decision moves a revision to final_approved, the SAME
--    transaction first cancels the plan it revises (only when that plan is still final_approved or
--    hr_acknowledged and belongs to the same employee, kind and period) and writes a `cancel`
--    decision row on it saying it was replaced. There is never a moment with two plans of record,
--    and the parent stays the plan of record — and the only one the calendars, the attendance
--    expectations and the adherence score read — until the revision is approved. A revision that is
--    rejected, returned or cancelled leaves its parent untouched. Everything else in the function
--    is unchanged from the definition 20260905183000 installed (live on production and staging with
--    identical md5(prosrc) before this file). HR acknowledgement is automatic after final
--    approval and runs on the revision as usual; the cancelled parent keeps its submitted_at, so
--    the no-weekly-plan deduction (which reads submitted_at, never status) is unchanged.
--
-- 4. One legacy row is normalised so the exemption in step 1 cannot be abused: a DRAFT revision
--    whose parent was never approved (cancelled / rejected) has its parent link cleared. From now
--    on parent_plan_id is set only on a revision of an APPROVED plan, and a revision of a dead plan
--    is an ordinary unlinked draft. Production holds exactly one such row (a 5-item draft, parent
--    cancelled, employee A-7, 2026-W33); staging holds one clone of it.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────────────────────────
--
-- The app code in the same PR needs no new database object (it selects the existing parent_plan_id
-- column), so either order is safe: code first gives the old behaviour with a truthful error and no
-- orphan; migration first lets a pending revision exist for the few minutes before the readers that
-- hide it are deployed. Prefer: merge, confirm the revision on /api/healthz, then apply here.
-- Staging first, as always. No row is deleted and no payroll, sales or attendance value changes.
-- The 23 orphan drafts are removed by a separate, guarded statement the owner runs on his word.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
--
--   begin;
--   drop index if exists public.employee_plan_headers_one_live_revision_uidx;
--   drop index if exists public.employee_plan_headers_active_period_uidx;
--   create unique index employee_plan_headers_active_period_uidx
--     on public.employee_plan_headers (employee_hr_id, plan_kind, period_key)
--     where status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected');
--   commit;
--
-- and re-apply phx_weekly_plan_decide from 20260905183000_district_manager_plans_never_write_a_ceo_row.sql.
-- The rollback of the index FAILS if a pending revision sits beside its approved parent by then;
-- cancel or reject that revision first. The cleared parent link of step 4 is not restored.

begin;

update public.employee_plan_headers child
   set parent_plan_id = null
 where child.parent_plan_id is not null
   and child.status = 'draft'
   and exists (
     select 1
       from public.employee_plan_headers parent
      where parent.id = child.parent_plan_id
        and parent.status in ('cancelled', 'manager_rejected', 'ceo_rejected')
   );

drop index if exists public.employee_plan_headers_active_period_uidx;
create unique index employee_plan_headers_active_period_uidx
  on public.employee_plan_headers (employee_hr_id, plan_kind, period_key)
  where status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected')
    and (parent_plan_id is null or status in ('final_approved', 'hr_acknowledged'));

drop index if exists public.employee_plan_headers_one_live_revision_uidx;
create unique index employee_plan_headers_one_live_revision_uidx
  on public.employee_plan_headers (parent_plan_id)
  where parent_plan_id is not null
    and status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected');

create or replace function public.phx_weekly_plan_decide(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text,
  p_action text,
  p_comment text,
  p_return_notes jsonb,
  p_bypass_ceo boolean default false
)
 returns table(new_status text, new_revision integer)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  current_status text;
  current_revision integer;
  header_parent_id uuid;
  header_employee_hr_id text;
  header_plan_kind text;
  header_period_key text;
  parent_status text;
  next_status text;
  now_ts timestamptz := now();
  note jsonb;
  matched_item record;
begin
  if p_action not in (
    'manager_approve', 'manager_reject', 'manager_return',
    'ceo_approve',     'ceo_reject',     'ceo_return'
  ) then
    raise exception 'weekly_plan_invalid_transition: phx_weekly_plan_decide does not accept action ''%''', p_action using errcode = 'P0001';
  end if;

  select status, revision, parent_plan_id, employee_hr_id, plan_kind, period_key
    into current_status, current_revision, header_parent_id, header_employee_hr_id, header_plan_kind, header_period_key
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  next_status := public.phx_weekly_plan_next_status(
    current_status,
    p_action,
    nullif(btrim(coalesce(p_comment, '')), '') is not null,
    p_bypass_ceo
  );

  if next_status = 'final_approved' and header_parent_id is not null then
    select status
      into parent_status
      from public.employee_plan_headers
      where id = header_parent_id
        and employee_hr_id = header_employee_hr_id
        and plan_kind = header_plan_kind
        and period_key = header_period_key
      for update;

    if parent_status in ('final_approved', 'hr_acknowledged') then
      update public.employee_plan_headers
        set status = 'cancelled',
            revision = revision + 1,
            updated_at = now_ts
        where id = header_parent_id;

      insert into public.employee_plan_decisions
        (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
        values
        (header_parent_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'cancel', parent_status, 'cancelled',
         'Replaced by the revised version of this plan, which has just been approved.');
    end if;
  end if;

  update public.employee_plan_headers
    set status = next_status,
        manager_decision_at      = case when p_action like 'manager%' then now_ts             else manager_decision_at end,
        manager_decision_by_hr_id = case when p_action like 'manager%' then p_actor_hr_id     else manager_decision_by_hr_id end,
        manager_decision_comment = case when p_action like 'manager%' then p_comment          else manager_decision_comment end,
        ceo_decision_at          = case when p_action like 'ceo%'     then now_ts             else ceo_decision_at end,
        ceo_decision_by_hr_id    = case when p_action like 'ceo%'     then p_actor_hr_id     else ceo_decision_by_hr_id end,
        ceo_decision_comment     = case when p_action like 'ceo%'     then p_comment          else ceo_decision_comment end,
        final_approved_at        = case when next_status = 'final_approved' then now_ts        else final_approved_at end,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, p_action, current_status, next_status, p_comment);

  if p_action in ('manager_return', 'ceo_return') and p_return_notes is not null then
    for note in select * from jsonb_array_elements(p_return_notes)
    loop
      select id, activity_date, activity_title, sort_order into matched_item
        from public.employee_plan_items
        where id = (note->>'itemId')::uuid
          and plan_id = p_plan_id;

      if matched_item.id is null then
        raise exception 'weekly_plan_invalid_transition: return-note item % does not belong to plan %', note->>'itemId', p_plan_id using errcode = 'P0001';
      end if;

      insert into public.employee_plan_item_return_notes
        (plan_id, item_id, actor_hr_id, actor_login_id, actor_role, action,
         activity_date, activity_title, sort_order, note)
        values
        (p_plan_id, matched_item.id, p_actor_hr_id, p_actor_login_id, p_actor_role, p_action,
         matched_item.activity_date, matched_item.activity_title, matched_item.sort_order, note->>'note');
    end loop;
  end if;

  return query select next_status, current_revision + 1;
end;
$function$;

revoke execute on function public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb, boolean) to service_role;

commit;
