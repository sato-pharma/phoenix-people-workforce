-- A District Manager weekly plan never carries a real CEO decision, so it must never write one.
-- Owner's decision, 2026-09-05: the DM plan pipeline is three stages, not four —
-- "dsm submit, nsm respond, hr ack automated". There is no CEO stage to fake.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────────────────────────
--
-- decideEmployeePlan (src/lib/weekly-planning/service.ts) already blocks a human CEO from
-- deciding a District Manager plan directly. But when the plan's manager (a National Sales
-- Manager) approves it, the app cascades into a SECOND rpcDecidePlan call with
-- action = 'ceo_approve', still stamped with that same manager's own actor_hr_id/actor_role,
-- to satisfy phx_weekly_plan_next_status's requirement that 'ceo_approve' only fires from
-- 'manager_approved'. Measured on production 2026-09-05: 50 employee_plan_decisions rows for
-- District Sales Manager plans carry action='ceo_approve' attributed to a National Sales
-- Manager (or, via a second bypass in acknowledgeEmployeePlan, a Super Admin) — never the CEO.
-- Anyone auditing "who approved this plan at the CEO stage" reads the wrong person's name
-- against a CEO action that never happened. It also writes ceo_decision_at/_by_hr_id/_comment
-- on the header to that same non-CEO identity.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────────────────────────
--
-- phx_weekly_plan_next_status gains a fourth parameter, bypass_ceo (default false, so behaviour
-- is unchanged unless a caller opts in). On a 'manager_approve' with bypass_ceo = true the
-- transition goes straight from 'submitted' to 'final_approved' in that ONE decision, instead of
-- resting at 'manager_approved' and requiring a second, separately-attributed 'ceo_approve' to
-- complete it. phx_weekly_plan_decide gains a matching p_bypass_ceo pass-through.
--
-- With the bypass, the header UPDATE inside phx_weekly_plan_decide never matches p_action
-- like 'ceo%' for a DM plan, so ceo_decision_at/ceo_decision_by_hr_id/ceo_decision_comment
-- stay NULL — correctly, since no CEO decided. Exactly one employee_plan_decisions row is
-- written, action='manager_approve' under the real approver, and final_approved_at is set
-- because next_status = 'final_approved'. autoAcknowledgeFinalApprovedPlan (unchanged) still
-- fires on final_approved regardless of how it was reached, so "hr ack automated" is unchanged.
--
-- ── SIGNATURE CHANGE — DROP THEN CREATE, NOT create-or-replace ───────────────────────────────────
--
-- Adding a defaulted parameter does NOT replace a function in Postgres; it creates a distinct
-- overload keyed on the new argument list, leaving the old 3-arg / 8-arg versions in place and
-- making a call by the old arity AMBIGUOUS against the defaulted new one. So each old signature
-- is dropped and the new one created. Both functions are plpgsql, whose bodies carry no
-- dependency tracking, so neither drop is blocked by the other; verified on production
-- 2026-09-05 that no view, matview, index, generated column, or constraint depends on either.
-- This migration MUST be applied to production BEFORE the app code that passes p_bypass_ceo
-- ships, or the RPC call finds no matching function and the decision page 500s.
--
-- Existing rows: the 50 already-written ceo_approve rows are left untouched, by owner's explicit
-- instruction — this migration changes only what is computed and written from here forward.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
--
-- Drop the 4-arg / 9-arg functions and re-create the original 3-arg / 8-arg bodies verbatim from
-- supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql. No data migration
-- is needed either way; no existing row is touched by this file.

drop function if exists public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb);
drop function if exists public.phx_weekly_plan_next_status(text, text, boolean);

create function public.phx_weekly_plan_next_status(
  current_status text,
  action text,
  has_comment boolean,
  bypass_ceo boolean default false
)
 returns text
 language plpgsql
 immutable
 set search_path to 'public', 'pg_temp'
as $function$
declare
  to_status text;
  requires_comment boolean := false;
begin
  case action
    when 'submit' then
      if current_status not in ('draft', 'manager_returned', 'ceo_returned') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'submitted';

    when 'request_edit' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'edit_requested';

    when 'approve_edit_request' then
      if current_status <> 'edit_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'draft';

    when 'reject_edit_request' then
      if current_status <> 'edit_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'submitted';

    when 'request_visit_details' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'details_requested';

    when 'submit_visit_details' then
      if current_status <> 'details_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'submitted';

    when 'manager_approve' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      -- District Manager plans have no CEO stage: this single decision is the plan's only real
      -- approval, so it jumps straight to final_approved instead of resting at manager_approved
      -- awaiting a second, fabricated ceo_approve row.
      to_status := case when bypass_ceo then 'final_approved' else 'manager_approved' end;

    when 'manager_reject' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'manager_rejected';

    when 'manager_return' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'manager_returned';

    when 'ceo_approve' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'final_approved';

    when 'ceo_reject' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'ceo_rejected';

    when 'ceo_return' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'ceo_returned';

    when 'hr_acknowledge' then
      if current_status not in ('final_approved', 'hr_acknowledged') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'hr_acknowledged';

    when 'cancel' then
      if current_status not in ('draft', 'submitted', 'edit_requested', 'details_requested', 'manager_returned', 'ceo_returned') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'cancelled';

    else
      raise exception 'weekly_plan_invalid_transition: unknown action ''%''', action using errcode = 'P0001';
  end case;

  if requires_comment and not has_comment then
    raise exception 'weekly_plan_invalid_transition: action ''%'' requires a comment', action using errcode = 'P0001';
  end if;

  return to_status;
end;
$function$;

create function public.phx_weekly_plan_decide(
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

  select status, revision into current_status, current_revision
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

  -- Item-level return notes only fire on the two return actions.
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

grant execute on function public.phx_weekly_plan_next_status(text, text, boolean, boolean) to service_role;
grant execute on function public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb, boolean) to service_role;
