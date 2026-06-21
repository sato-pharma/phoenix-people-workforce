-- Data Health signal: marketing-request pharmacy -> brick/region mapping coverage.
-- Surfaces the unmapped-pharmacy gap that silently shows as "Unassigned" in the SMI ROI
-- report, BEFORE leadership sees it. Uses the SAME rollup-family-aware customer-map match as
-- phx_marketing_roi_customer_dashboard (a code under the rolled-up parent OR any child).
-- Read-only, service-role-only, carries the report-RPC 45s statement_timeout convention.
create or replace function public.phx_marketing_pharmacy_mapping_coverage()
returns table(total_targets integer, mapped_targets integer, total_requests integer, requests_with_unmapped integer)
language sql
stable
set search_path to 'public'
set statement_timeout to '45s'
as $function$
  with req_targets as (
    select distinct
      mrph.request_id,
      mpdc.normalized_pharmacy_code as customer_code,
      (select cmx.region_code
       from public.source_of_sales_customer_map cmx
       where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
         and cmx.active
         and (cmx.distributor_code = sd.distributor_code
              or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                         where rcm.parent_distributor_code = sd.distributor_code
                           and rcm.sos_distributor_code = cmx.distributor_code))
       order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
       limit 1) as region_code
    from public.marketing_requests mr
    join public.marketing_request_pharmacies mrph on mrph.request_id = mr.id
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join (select distinct marketing_normalized_name, parent_distributor_code from public.marketing_roi_distributor_rollup) ru
      on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code
    where mr.pay_date is not null
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
      and coalesce(mpdc.active, true)
  )
  select
    count(*)::integer as total_targets,
    count(*) filter (where region_code is not null)::integer as mapped_targets,
    count(distinct request_id)::integer as total_requests,
    count(distinct request_id) filter (where region_code is null)::integer as requests_with_unmapped
  from req_targets;
$function$;

comment on function public.phx_marketing_pharmacy_mapping_coverage() is
  'Data Health: marketing-request pharmacy -> brick/region mapping coverage (rollup-family-aware). total/mapped target pharmacies + requests with an unmapped pharmacy.';

revoke all on function public.phx_marketing_pharmacy_mapping_coverage() from public, anon, authenticated;
grant execute on function public.phx_marketing_pharmacy_mapping_coverage() to service_role;

notify pgrst, 'reload schema';
