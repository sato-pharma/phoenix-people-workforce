-- Admin function to reset (wipe) uploaded/transactional data for a module.
-- Deletes ONLY transactional data (upload batches, rows, request submissions).
-- Master/reference/configuration tables are untouched.
-- Only callable by service_role.

create or replace function public.phx_admin_reset_module_data(p_module text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_count  bigint;
begin
  if p_module not in ('sales', 'weekly', 'marketing', 'all') then
    raise exception 'Invalid module: %. Must be sales, weekly, marketing, or all.', p_module;
  end if;

  -- Source of Sales: uploaded batches and rows only
  if p_module in ('sales', 'all') then
    delete from source_of_sales_import_summaries;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'source_of_sales_import_summaries', 'deleted', v_count));

    delete from source_of_sales_import_rows;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'source_of_sales_import_rows', 'deleted', v_count));

    delete from source_of_sales_import_batches;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'source_of_sales_import_batches', 'deleted', v_count));
  end if;

  -- Weekly Sales: uploaded batches and rows only
  if p_module in ('weekly', 'all') then
    delete from weekly_sales_rows;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'weekly_sales_rows', 'deleted', v_count));

    delete from weekly_sales_batches;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'weekly_sales_batches', 'deleted', v_count));
  end if;

  -- Marketing Requests: all request submissions and their derived analytics
  if p_module in ('marketing', 'all') then
    delete from marketing_roi_customer_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_customer_facts', 'deleted', v_count));

    delete from marketing_roi_distributor_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_distributor_facts', 'deleted', v_count));

    delete from marketing_roi_region_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_region_facts', 'deleted', v_count));

    delete from marketing_roi_line_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_line_facts', 'deleted', v_count));

    delete from marketing_roi_product_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_product_facts', 'deleted', v_count));

    delete from marketing_roi_trend_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_trend_facts', 'deleted', v_count));

    delete from marketing_roi_request_facts;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_request_facts', 'deleted', v_count));

    delete from marketing_roi_refresh_runs;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_refresh_runs', 'deleted', v_count));

    delete from marketing_roi_export_audit;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_export_audit', 'deleted', v_count));

    delete from marketing_request_finance_requirements;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_request_finance_requirements', 'deleted', v_count));

    delete from marketing_request_approval_steps;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_request_approval_steps', 'deleted', v_count));

    delete from marketing_request_pharmacies;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_request_pharmacies', 'deleted', v_count));

    delete from marketing_request_products;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_request_products', 'deleted', v_count));

    delete from marketing_requests;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_array(jsonb_build_object('table', 'marketing_requests', 'deleted', v_count));
  end if;

  return v_result;
end;
$$;

-- Only service_role may call this function
revoke execute on function public.phx_admin_reset_module_data(text) from public, anon, authenticated;
grant  execute on function public.phx_admin_reset_module_data(text) to service_role;
