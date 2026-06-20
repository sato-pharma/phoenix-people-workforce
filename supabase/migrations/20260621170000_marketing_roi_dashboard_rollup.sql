-- Apply the ROI-only distributor rollup to the executive dashboard RPC, so the page total
-- and the territory/distributor breakdowns reflect the rolled-up channels (e.g. Ibn Sina +
-- Ibn Sina-Sato => IS), matching the per-request RPC. Transform the LIVE function in place
-- (only the two distributor-join CTEs change) to avoid transcription error. ANALYZE the
-- rollup table so the planner keeps a good plan (without stats the rollup join times out).
--
-- Verified read-only beforehand: approved total 106,234.61 -> 168,863.36; distributor
-- breakdown shows parent codes only (PS, IS, ...); no false matches.

analyze public.marketing_roi_distributor_rollup;

do $$
declare def text;
begin
  select pg_get_functiondef('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)'::regprocedure) into def;

  -- R1: req_targets_all -> one canonical PARENT distributor per pharmacy (for allocations/breakdowns)
  def := replace(def,
    '    join public.source_of_sales_distributors sd on sd.normalized_distributor_name = md.normalized_name',
    '    join (select distinct marketing_normalized_name, parent_distributor_code from public.marketing_roi_distributor_rollup) ru on ru.marketing_normalized_name = md.normalized_name' || chr(10) ||
    '    join public.source_of_sales_distributors sd on sd.distributor_code = ru.parent_distributor_code');

  -- R2: exact_hits -> match sales rows of ANY family code rolling up to the target parent
  def := replace(def,
    '    join public.source_of_sales_import_rows r' || chr(10) || '      on r.distributor_code = tp.distributor_code',
    '    join public.marketing_roi_distributor_rollup rr on rr.parent_distributor_code = tp.distributor_code' || chr(10) ||
    '    join public.source_of_sales_import_rows r' || chr(10) || '      on r.distributor_code = rr.sos_distributor_code');

  -- R3: exact_hits -> group/report under the PARENT distributor code (not the split code)
  def := replace(def,
    '      r.distributor_code,' || chr(10) || '      coalesce(sd.distributor_name, r.distributor_code) as distributor_name,',
    '      tp.distributor_code,' || chr(10) || '      coalesce(sd.distributor_name, tp.distributor_code) as distributor_name,');

  -- R4: exact_hits distributor-name lookup keyed on the parent
  def := replace(def,
    '    left join public.source_of_sales_distributors sd on sd.distributor_code = r.distributor_code',
    '    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.distributor_code');

  execute def;
end $$;
