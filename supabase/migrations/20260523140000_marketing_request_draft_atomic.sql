create or replace function public.phx_create_marketing_request_draft_atomic(p_request jsonb)
returns public.marketing_requests
language plpgsql
as $$
declare
  inserted public.marketing_requests;
begin
  with input as (
    select *
    from jsonb_to_record(p_request) as x(
      area_id bigint,
      created_by_hr_id text,
      customer_contact_id uuid,
      customer_id uuid,
      estimated_cost numeric,
      expected_roi_value numeric,
      line_id bigint,
      manager_hr_id text,
      notes text,
      other_request_type text,
      pay_date date,
      request_code text,
      request_date date,
      request_type_id bigint,
      requester_hr_id text,
      roi_duration_months integer,
      roi_status text,
      status text,
      updated_by_hr_id text
    )
  )
  insert into public.marketing_requests (
    area_id,
    created_by_hr_id,
    customer_contact_id,
    customer_id,
    estimated_cost,
    expected_roi_value,
    line_id,
    manager_hr_id,
    notes,
    other_request_type,
    pay_date,
    request_code,
    request_date,
    request_type_id,
    requester_hr_id,
    roi_duration_months,
    roi_status,
    status,
    updated_by_hr_id
  )
  select
    area_id,
    created_by_hr_id,
    customer_contact_id,
    customer_id,
    estimated_cost,
    expected_roi_value,
    line_id,
    manager_hr_id,
    notes,
    other_request_type,
    pay_date,
    request_code,
    request_date,
    request_type_id,
    requester_hr_id,
    roi_duration_months,
    roi_status,
    status,
    updated_by_hr_id
  from input
  returning *
  into inserted;

  insert into public.marketing_request_finance_requirements (request_id)
  values (inserted.id);

  return inserted;
end;
$$;

revoke execute on function public.phx_create_marketing_request_draft_atomic(jsonb) from public, anon, authenticated;
