-- Required ROI now scales with the campaign length:
--   required_roi_value = estimated_cost * 10 * duration_in_months (min 1)
--   roi_coverage_ratio = expected_roi_value / required_roi_value
--
-- required_roi_value and roi_coverage_ratio are GENERATED columns; Postgres requires drop + re-add
-- to change a generation expression. The covering index INCLUDEs both columns, so drop it first and
-- recreate it afterwards. (marketing_requests has 0 rows in production, so the recompute is instant.)

drop index if exists public.marketing_requests_mroi_status_pay_date_idx;

alter table public.marketing_requests drop column if exists roi_coverage_ratio;
alter table public.marketing_requests drop column if exists required_roi_value;

alter table public.marketing_requests
  add column required_roi_value numeric(20, 2)
  generated always as ((estimated_cost * 10 * greatest(roi_duration_months, 1))) stored;

alter table public.marketing_requests
  add column roi_coverage_ratio numeric(20, 4)
  generated always as (
    case
      when estimated_cost > 0 then expected_roi_value / (estimated_cost * 10 * greatest(roi_duration_months, 1))
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
