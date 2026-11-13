-- report_it_dashboard_access_audited
--
-- WHAT THIS CHANGES: adds public.phx_report_it_set_dashboard_access(hr_id, grant, actor, metadata),
--   which gives or removes one person's "read every safety report" access AND writes the
--   report_it_audit_logs row for it in the same transaction. Executable by service_role only.
-- WHY: the read-all list is managed from a screen now (audit S01, REC-051 / F-MKT-009). A grant
--   and its audit row must land together or not at all — a grant with no row is exactly the
--   untraceable change this exists to end.
-- ROLLBACK: drop function public.phx_report_it_set_dashboard_access(text, boolean, text, jsonb);
--   Nothing else changes; no row is written by this migration.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_report_it_set_dashboard_access(
  p_hr_id text,
  p_grant boolean,
  p_actor_hr_id text,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_hr_id text := nullif(btrim(p_hr_id), '');
  v_changed boolean := false;
begin
  if v_hr_id is null then
    raise exception 'Validation: an employee is required.' using errcode = '22023';
  end if;
  if nullif(btrim(p_actor_hr_id), '') is null then
    raise exception 'Validation: the person making the change is required.' using errcode = '22023';
  end if;

  if p_grant then
    insert into public.report_it_dashboard_access (hr_id, granted_by)
    values (v_hr_id, p_actor_hr_id)
    on conflict (hr_id) do nothing;
    v_changed := found;
  else
    delete from public.report_it_dashboard_access where hr_id = v_hr_id;
    v_changed := found;
  end if;

  -- Only a real change is logged: pressing grant twice changed nothing about who can read.
  if v_changed then
    insert into public.report_it_audit_logs (report_id, actor_hr_id, action, metadata)
    values (
      null,
      p_actor_hr_id,
      case when p_grant then 'dashboard_access_granted' else 'dashboard_access_revoked' end,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('hrId', v_hr_id)
    );
  end if;

  return v_changed;
end;
$$;

revoke execute on function public.phx_report_it_set_dashboard_access(text, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_report_it_set_dashboard_access(text, boolean, text, jsonb) to service_role;

commit;
