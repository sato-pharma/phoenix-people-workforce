-- Required ROI is now a flat multiple of cost: estimated_cost × 10.
-- Campaign duration no longer scales the target (reverting the per-duration formula added in
-- 20260619140000). The generated columns are dropped and re-added with the simpler expression.
-- The covering index is dropped first (it INCLUDEs both columns) and recreated after.

drop index if exists public.marketing_requests_mroi_status_pay_date_idx;

alter table public.marketing_requests drop column if exists roi_coverage_ratio;
alter table public.marketing_requests drop column if exists required_roi_value;

alter table public.marketing_requests
  add column required_roi_value numeric(20, 2)
  generated always as ((estimated_cost * 10)) stored;

alter table public.marketing_requests
  add column roi_coverage_ratio numeric(20, 4)
  generated always as (
    case
      when estimated_cost > 0 then expected_roi_value / (estimated_cost * 10)
      when expected_roi_value > 0 then 1
      else 0
    end
  ) stored;

create index if not exists marketing_requests_mroi_status_pay_date_idx
  on public.marketing_requests using btree (status, pay_date)
  include (
    id, request_code, customer_id, line_id, estimated_cost,
    required_roi_value, expected_roi_value, roi_duration_months, roi_coverage_ratio
  )
  where pay_date is not null;
