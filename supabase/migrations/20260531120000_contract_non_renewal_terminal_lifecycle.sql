-- DRAFT - WP-6 - DO NOT APPLY YET. Contract non-renewal terminal lifecycle traceability.
--
-- Purpose
--   When a contract renewal request reaches the terminal status "not_renewed"
--   the employee should be terminated and a vacancy opened via the canonical
--   resignation flow. This migration adds traceability columns + a wrapper RPC
--   that delegates to the existing phx_resign_employee_and_open_vacancy
--   function so non-renewal terminations are explicitly linked back to the
--   originating contract_renewal_requests row.
--
-- Safety
--   - Additive only: nullable column + index + new RPC. No backfill, no destructive
--     change, no enum value added (we reuse the existing "terminated" employment
--     status value).
--   - Grants are restricted to service_role; no grant to anon/authenticated/public.
--   - Application code is gated by WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED
--     which defaults to false. The migration can land before the flag is flipped.
--
-- Apply order (do NOT apply yet):
--   1. Review with reviewer + ops.
--   2. Apply on staging Supabase first.
--   3. Run smoke tests against staging.
--   4. Only then schedule production apply through the standard migration approval gate.

-- ------------------------------------------------------------
-- 1) Traceability column on employee_resignations
-- ------------------------------------------------------------
alter table public.employee_resignations
  add column if not exists contract_renewal_request_id uuid
  references public.contract_renewal_requests(id) on delete set null;

comment on column public.employee_resignations.contract_renewal_request_id is
  'WP-6: when populated, indicates this resignation was created by the contract non-renewal terminal lifecycle for the referenced contract_renewal_requests row.';

-- ------------------------------------------------------------
-- 2) Index to support reverse-lookup from a renewal request
-- ------------------------------------------------------------
create index if not exists employee_resignations_contract_renewal_idx
  on public.employee_resignations (contract_renewal_request_id);

-- ------------------------------------------------------------
-- 3) Wrapper RPC that delegates to the canonical resignation helper
--    Signature: phx_terminate_employee_for_non_renewal(uuid, text)
-- ------------------------------------------------------------
create or replace function public.phx_terminate_employee_for_non_renewal(
  p_contract_request_id uuid,
  p_actor_login_id text
)
returns table (
  resignation_id uuid,
  employee_hr_id text,
  vacancy_code text,
  contract_renewal_request_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.contract_renewal_requests%rowtype;
  v_effective_date date;
  v_submitted_date date := (now() at time zone 'utc')::date;
  v_vacancy_code text;
  v_reason text;
  v_workflow_notes text;
begin
  if p_contract_request_id is null then
    raise exception 'contract_request_id is required';
  end if;
  if coalesce(btrim(p_actor_login_id), '') = '' then
    raise exception 'actor_login_id is required';
  end if;

  -- Lock the renewal request row to avoid racing with concurrent workflow actions.
  select *
    into v_request
    from public.contract_renewal_requests
   where id = p_contract_request_id
   for update;

  if not found then
    raise exception 'contract_renewal_request % not found', p_contract_request_id;
  end if;

  if v_request.status is distinct from 'not_renewed' then
    raise exception 'contract_renewal_request % is not in not_renewed status (current: %)',
      p_contract_request_id, v_request.status;
  end if;

  v_effective_date := coalesce(
    v_request.proposed_end_date,
    v_request.current_renewal_date,
    v_request.requested_renewal_date,
    v_submitted_date
  );

  v_reason := format('Contract not renewed (request %s).', p_contract_request_id::text);
  v_workflow_notes := format(
    'Triggered by contract non-renewal.%scontract_renewal_request_id: %s',
    E'\n',
    p_contract_request_id::text
  );

  -- TODO (staging review): confirm the exact column / argument mapping for
  -- public.phx_resign_employee_and_open_vacancy on the live database. The
  -- existing service-layer call uses the following named arguments:
  --   p_actor, p_effective_date, p_employee_hr_id, p_employee_status,
  --   p_reason, p_submitted_by_hr_id, p_submitted_date, p_vacancy_code,
  --   p_workflow_notes
  -- The wrapper below delegates with the same names. The returned vacancy_code
  -- / resignation_id must be captured from the underlying function's result
  -- shape (verify before applying — adjust the SELECT INTO accordingly).
  perform public.phx_resign_employee_and_open_vacancy(
    p_actor := p_actor_login_id,
    p_effective_date := v_effective_date,
    p_employee_hr_id := v_request.employee_hr_id,
    p_employee_status := 'terminated',
    p_reason := v_reason,
    p_submitted_by_hr_id := p_actor_login_id,
    p_submitted_date := v_submitted_date,
    p_vacancy_code := null,
    p_workflow_notes := v_workflow_notes
  );

  -- Backfill the new traceability column for the resignation row that was just
  -- created by the delegated RPC. We match on the employee + reason marker so
  -- the link is established even if the underlying RPC does not yet expose
  -- the new resignation id directly.
  update public.employee_resignations
     set contract_renewal_request_id = p_contract_request_id
   where employee_hr_id = v_request.employee_hr_id
     and contract_renewal_request_id is null
     and (workflow_notes is not null and workflow_notes like '%' || p_contract_request_id::text || '%')
   returning id, employee_hr_id, vacancy_code, contract_renewal_request_id
        into resignation_id, employee_hr_id, vacancy_code, contract_renewal_request_id;

  return next;
end;
$$;

-- ------------------------------------------------------------
-- 4) Permissions: service_role only. No grants to anon / authenticated / public.
-- ------------------------------------------------------------
revoke all on function public.phx_terminate_employee_for_non_renewal(uuid, text) from public;
grant execute on function public.phx_terminate_employee_for_non_renewal(uuid, text) to service_role;

-- ------------------------------------------------------------
-- Rollback block (DO NOT APPLY automatically — execute manually if required).
-- ------------------------------------------------------------
/*
-- Rollback for WP-6 contract non-renewal terminal lifecycle (reverse-dependency order):
drop function if exists public.phx_terminate_employee_for_non_renewal(uuid, text);
drop index if exists public.employee_resignations_contract_renewal_idx;
alter table public.employee_resignations drop column if exists contract_renewal_request_id;
*/
