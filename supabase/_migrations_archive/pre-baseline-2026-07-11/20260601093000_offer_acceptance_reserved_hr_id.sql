create schema if not exists private;
alter table public.job_offers
  add column if not exists reserved_employee_hr_id text null;
create unique index if not exists job_offers_reserved_employee_hr_id_uidx
  on public.job_offers (upper(reserved_employee_hr_id))
  where reserved_employee_hr_id is not null;
drop function if exists public.phx_reserve_offer_employee_hr_id(uuid);
create or replace function private.phx_reserve_offer_employee_hr_id_v2(
  p_offer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_offer public.job_offers%rowtype;
  v_prefix text := 'PH';
  v_line_name text;
  v_line_code text;
  v_candidate integer;
  v_employee_hr_id text;
  v_attempt integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('phx_offer_hr_id_generation'));

  select *
    into v_offer
  from public.job_offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  v_employee_hr_id := nullif(trim(coalesce(v_offer.reserved_employee_hr_id, v_offer.employee_hr_id, '')), '');

  if v_employee_hr_id is not null then
    return jsonb_build_object(
      'employee_hr_id', v_employee_hr_id,
      'offer_id', v_offer.id
    );
  end if;

  if v_offer.status not in ('sent', 'accepted') then
    raise exception 'Only sent or accepted offers can reserve an employee HR ID.';
  end if;

  if v_offer.line_id is not null then
    select coalesce(name, ''), coalesce(code, '')
      into v_line_name, v_line_code
    from public.lines
    where id = v_offer.line_id;

    if position('anti' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'AI';
    elsif position('pedia' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'PD';
    elsif position('cns' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'CN';
    elsif position('office' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'OF';
    end if;
  end if;

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 10 then
      raise exception 'Failed to reserve a unique HR_ID for prefix %.', v_prefix;
    end if;

    select coalesce(max(candidate), 0) + 1
      into v_candidate
    from (
      select nullif(substring(upper(hr_id) from ('^' || v_prefix || '-([0-9]+)$')), '')::integer as candidate
      from public.employees
      where upper(hr_id) like v_prefix || '-%'
      union all
      select nullif(substring(upper(reserved_employee_hr_id) from ('^' || v_prefix || '-([0-9]+)$')), '')::integer as candidate
      from public.job_offers
      where reserved_employee_hr_id is not null
        and upper(reserved_employee_hr_id) like v_prefix || '-%'
      union all
      select nullif(substring(upper(employee_hr_id) from ('^' || v_prefix || '-([0-9]+)$')), '')::integer as candidate
      from public.job_offers
      where employee_hr_id is not null
        and upper(employee_hr_id) like v_prefix || '-%'
    ) ids
    where candidate is not null;

    v_employee_hr_id := v_prefix || '-' || lpad(v_candidate::text, 4, '0');

    begin
      update public.job_offers
      set reserved_employee_hr_id = v_employee_hr_id,
          updated_at = now()
      where id = v_offer.id;
      exit;
    exception
      when unique_violation then
        v_employee_hr_id := null;
    end;
  end loop;

  insert into public.job_offer_audit_logs (
    offer_id, action, actor_type, actor_reference, details
  ) values (
    v_offer.id,
    'employee_hr_id_reserved',
    'system',
    null,
    jsonb_build_object('employeeHrId', v_employee_hr_id)
  );

  return jsonb_build_object(
    'employee_hr_id', v_employee_hr_id,
    'offer_id', v_offer.id
  );
end;
$$;
create or replace function public.phx_reserve_offer_employee_hr_id(
  p_offer_id uuid
)
returns jsonb
language sql
security invoker
set search_path = public, private
as $$
  select private.phx_reserve_offer_employee_hr_id_v2(p_offer_id);
$$;
revoke all on function private.phx_reserve_offer_employee_hr_id_v2(uuid)
  from public, anon, authenticated;
grant execute on function private.phx_reserve_offer_employee_hr_id_v2(uuid)
  to service_role;
revoke all on function public.phx_reserve_offer_employee_hr_id(uuid)
  from public, anon, authenticated;
grant execute on function public.phx_reserve_offer_employee_hr_id(uuid)
  to service_role;
