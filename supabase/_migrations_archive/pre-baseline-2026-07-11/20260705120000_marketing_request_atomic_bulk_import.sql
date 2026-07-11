-- ============================================================================
-- import_marketing_request_atomic: insert one bulk-imported marketing request
-- and all of its children (products, pharmacies, approval steps) inside a single
-- transaction, so a row either fully commits or fully rolls back.
--
-- Why: executeBulkImport (src/lib/marketing-requests/bulk-import.ts) used to do
-- four separate PostgREST inserts per row and, on a mid-row failure, a
-- "best-effort" delete of the parent (whose error was swallowed). That could
-- leave partial data if the cleanup delete itself failed. A plpgsql function is
-- atomic: any exception rolls back every statement in this call, so no partial
-- request can survive. The JS still computes value_share / expected_roi_value /
-- ROI figures and marshals the fully-resolved rows in as JSONB — this function
-- only performs the transactional insert.
--
-- Column notes (verified against live prod schema 2026-07-04):
--   * marketing_requests.required_roi_value and .roi_coverage_ratio are
--     GENERATED ALWAYS — intentionally NOT listed (the DB computes them; listing
--     them would raise "cannot insert a non-DEFAULT value").
--   * marketing_request_products.expected_value is GENERATED ALWAYS — not listed.
--   * The pharmacy insert lists exactly the columns the prior JS set
--     (request_id, distributor_code_id, tracking_status). pharmacy_id is NOT NULL
--     with no default and the JS never supplied it, so a non-empty pharmacy set
--     fails the row today; under this function that same row now fails ATOMICALLY
--     (no orphaned parent/products), which is strictly safer. Fixing the pharmacy
--     path itself is a separate concern, out of scope for this atomicity change.
--
-- Service-role only, mirroring getSupabaseAdmin() usage; the caller already gates
-- on Super Admin (canAccessSystemAdministratorWorkspace) before invoking.
-- ============================================================================

create or replace function public.import_marketing_request_atomic(
  p_request jsonb,
  p_products jsonb default '[]'::jsonb,
  p_pharmacies jsonb default '[]'::jsonb,
  p_steps jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
begin
  insert into marketing_requests (
    request_code, requester_hr_id, customer_id, request_type_id, other_request_type,
    request_date, pay_date, roi_duration_months, estimated_cost, expected_roi_value,
    roi_status, notes, status, submitted_at, approved_at, created_by_hr_id, updated_by_hr_id
  )
  select
    r.request_code, r.requester_hr_id, r.customer_id, r.request_type_id, r.other_request_type,
    r.request_date, r.pay_date,
    coalesce(r.roi_duration_months, 1), coalesce(r.estimated_cost, 0), coalesce(r.expected_roi_value, 0),
    coalesce(nullif(r.roi_status, ''), 'not_calculated'), r.notes,
    coalesce(nullif(r.status, ''), 'draft'),
    r.submitted_at, r.approved_at, r.created_by_hr_id, r.updated_by_hr_id
  from jsonb_to_record(p_request) as r(
    request_code text, requester_hr_id text, customer_id uuid, request_type_id bigint, other_request_type text,
    request_date date, pay_date date, roi_duration_months integer, estimated_cost numeric, expected_roi_value numeric,
    roi_status text, notes text, status text, submitted_at timestamptz, approved_at timestamptz,
    created_by_hr_id text, updated_by_hr_id text
  )
  returning id into v_request_id;

  if jsonb_array_length(coalesce(p_products, '[]'::jsonb)) > 0 then
    insert into marketing_request_products (
      request_id, product_id, product_name_snapshot, factory_price_snapshot, forecast_quantity, value_share
    )
    select
      v_request_id, p.product_id, p.product_name_snapshot,
      coalesce(p.factory_price_snapshot, 0), coalesce(p.forecast_quantity, 0), coalesce(p.value_share, 0)
    from jsonb_to_recordset(p_products) as p(
      product_id bigint, product_name_snapshot text, factory_price_snapshot numeric,
      forecast_quantity numeric, value_share numeric
    );
  end if;

  if jsonb_array_length(coalesce(p_pharmacies, '[]'::jsonb)) > 0 then
    insert into marketing_request_pharmacies (
      request_id, distributor_code_id, tracking_status
    )
    select
      v_request_id, ph.distributor_code_id,
      coalesce(nullif(ph.tracking_status, ''), 'pending_validation')
    from jsonb_to_recordset(p_pharmacies) as ph(
      distributor_code_id uuid, tracking_status text
    );
  end if;

  if jsonb_array_length(coalesce(p_steps, '[]'::jsonb)) > 0 then
    insert into marketing_request_approval_steps (
      request_id, workflow_step_id, sequence, step_code, step_name, assigned_role,
      status, decision_at, decision_by_hr_id, decision_note
    )
    select
      v_request_id, s.workflow_step_id, s.sequence, s.step_code, s.step_name, s.assigned_role,
      coalesce(nullif(s.status, ''), 'pending'), s.decision_at, s.decision_by_hr_id, s.decision_note
    from jsonb_to_recordset(p_steps) as s(
      workflow_step_id bigint, sequence integer, step_code text, step_name text, assigned_role text,
      status text, decision_at timestamptz, decision_by_hr_id text, decision_note text
    );
  end if;

  return v_request_id;
end;
$$;

revoke all on function public.import_marketing_request_atomic(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.import_marketing_request_atomic(jsonb, jsonb, jsonb, jsonb) to service_role;

comment on function public.import_marketing_request_atomic(jsonb, jsonb, jsonb, jsonb) is
  'Atomically inserts one bulk-imported marketing request plus its products, pharmacies, and approval steps in a single transaction (all-or-nothing per row). Called by executeBulkImport via the service-role client. Generated columns (required_roi_value, roi_coverage_ratio, expected_value) are intentionally not written.';
