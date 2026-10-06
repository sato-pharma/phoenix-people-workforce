-- The doctor-list refusal says "their team", not "his team".
--
-- WHAT THIS CHANGES. One sentence inside public.crm_contact_list_change_apply. Nothing else: the body
-- below is 20261004120000's, byte for byte, with the raise message's "his team" read as "their team".
-- No table, column, grant, policy or signature is touched, and the function's ACL survives a
-- `create or replace` (verified on production 2026-10-06: postgres=X, service_role=X, prosecdef false).
--
-- WHY. Nothing this app shows anybody assumes its subject is a man — the owner's rule of 2026-10-05,
-- after the field activity report called a District Sales Manager "he" in six places, and pinned by
-- tests/neutral-wording.test.ts. That guard reads TypeScript, so it could not see this sentence, and
-- the sentence reaches the screen: an apply refusal comes back through isApplyRefusal() as a conflict
-- message the editor reads. It was UNREACHABLE only because contact-lists/service.ts refused every
-- change first on the global cutover date — the gate removed in this same pull request. So the moment
-- the SFE Manager can drop a doctor, this is the first sentence a wrong pick shows them.
--
-- ROLLBACK: re-apply 20261004120000's own function block, which differs only in that word.

-- No transaction wrapper and no lock_timeout, exactly as 20261004120000 and 20260914020000 are: a
-- `create or replace function` is one statement, Supabase applies a migration in its own transaction,
-- and `set local` outside one is a silent no-op. (The begin/commit shape is the phoenix_crm module's
-- own rule, enforced by tests/phoenix-crm-boundary.test.ts, and these crm_ migrations are not in it.)
create or replace function public.crm_contact_list_change_apply(
  p_change_id uuid,
  p_decided_by text,
  p_note text default null::text
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_cutover date := (select c.cutover_date from public.crm_cutover c where c.id);
  v_change public.crm_contact_list_changes%rowtype;
  v_rep_crm_id bigint;
  v_contact bigint;
  v_agent_crm_id bigint;
  v_removed integer := 0;
  v_closed integer := 0;
  v_current_grade text;
  v_phoenix_owns boolean;
begin
  select * into v_change from public.crm_contact_list_changes where id = p_change_id for update;
  if not found then
    raise exception 'That change was not found.' using errcode = 'P0001';
  end if;
  if v_change.status <> 'pending' then
    raise exception 'This change has already been decided or withdrawn.' using errcode = 'P0001';
  end if;

  select case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end
    into v_rep_crm_id
    from public.employees e
   where e.hr_id = v_change.rep_hr_id;

  -- THE SWITCH. This rep's list is Phoenix's either because his own team has started (the live rule) or
  -- because the global cutover date has passed (kept so a future global cutover still works). Before
  -- 2026-10-04 only the second existed, and with the date NULL it refused every change ever requested.
  v_phoenix_owns := exists (
    select 1
      from public.phoenix_crm_started_team_reps() s
     where v_today >= s.counted_from
       and (s.counted_until is null or v_today < s.counted_until)
       and (s.hr_key = lower(btrim(v_change.rep_hr_id))
            or (v_rep_crm_id is not null and s.agent_crm_id = v_rep_crm_id))
  ) or (v_cutover is not null and v_today >= v_cutover);

  if not v_phoenix_owns then
    raise exception 'Doctor lists for this rep still come from iReports360 — their team has not started in Phoenix CRM yet.'
      using errcode = 'P0001';
  end if;

  if p_decided_by is distinct from (case when v_change.direct then v_change.requested_by else v_change.manager_hr_id end) then
    raise exception 'Only the manager this change was sent to can approve it.' using errcode = 'P0001';
  end if;

  v_contact := v_change.contact_crm_id;

  if v_change.action = 'add' then
    if v_contact is null then
      v_contact := nextval('public.crm_contacts_phoenix_id_seq');
      insert into public.crm_contacts (contact_crm_id, name, speciality, address, source, first_seen_on)
      values (v_contact, btrim(v_change.new_contact_name), btrim(v_change.new_contact_speciality),
              nullif(btrim(v_change.new_contact_address), ''), 'phoenix', v_today);
    elsif exists (
      select 1
        from public.crm_contact_assignments a
       where a.effective_to is null
         and a.contact_crm_id = v_contact
         and a.list_type = v_change.list_type
         and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
              or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
    ) then
      raise exception 'That doctor is already on this list.' using errcode = 'P0001';
    end if;

    v_agent_crm_id := case
      when v_rep_crm_id is not null and not exists (
        select 1
          from public.crm_contact_assignments o
         where o.effective_to is null
           and o.contact_crm_id = v_contact
           and o.agent_crm_id = v_rep_crm_id
           and o.list_type = v_change.list_type
      ) then v_rep_crm_id
    end;

    insert into public.crm_contact_assignments (
      contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
    ) values (
      v_contact, v_agent_crm_id, v_change.rep_hr_id, v_change.list_type, v_change.grade, v_today, v_today, 'phoenix'
    );
  else
    select a.grade, a.agent_crm_id
      into v_current_grade, v_agent_crm_id
      from public.crm_contact_assignments a
     where a.effective_to is null
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
     order by a.id
     limit 1
     for update;
    if not found then
      raise exception 'That doctor is not on this list any more.' using errcode = 'P0001';
    end if;
    if v_change.action = 'regrade' and v_current_grade is not distinct from v_change.grade then
      raise exception 'That doctor already has this grade.' using errcode = 'P0001';
    end if;

    delete from public.crm_contact_assignments a
     where a.effective_to is null
       and a.effective_from >= v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_removed = row_count;

    update public.crm_contact_assignments a
       set effective_to = v_today - 1,
           updated_at = now()
     where a.effective_to is null
       and a.effective_from < v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_closed = row_count;

    if v_change.action = 'regrade' then
      insert into public.crm_contact_assignments (
        contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
      ) values (
        v_contact, coalesce(v_agent_crm_id, v_rep_crm_id), v_change.rep_hr_id, v_change.list_type, v_change.grade,
        v_today, v_today, 'phoenix'
      );
    end if;
  end if;

  update public.crm_contact_list_changes
     set status = 'approved',
         decided_by = p_decided_by,
         decided_at = now(),
         decision_note = nullif(btrim(p_note), ''),
         applied_at = now(),
         applied_contact_crm_id = v_contact,
         updated_at = now()
   where id = p_change_id;

  insert into public.crm_contact_list_change_events (change_id, event, actor_hr_id, detail)
  values (
    p_change_id,
    case when v_change.direct then 'applied_directly' else 'approved' end,
    p_decided_by,
    jsonb_build_object('contactCrmId', v_contact, 'discarded', v_removed, 'closed', v_closed)
  );

  return jsonb_build_object('contactCrmId', v_contact, 'action', v_change.action, 'discarded', v_removed, 'closed', v_closed);
end;
$function$;
