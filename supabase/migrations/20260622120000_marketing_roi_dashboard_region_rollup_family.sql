-- Sales & Marketing Intelligence ROI dashboard: make the customer-map region lookup
-- ROLLUP-FAMILY-AWARE. The report rolls each marketing distributor up to its PARENT SoS
-- distributor (e.g. IS), then looked up source_of_sales_customer_map under that parent only.
-- But ~10 target pharmacies are mapped under a CHILD code (IS-S / EP-S) of the same rollup
-- family, so the lookup missed them -> region "Unassigned" even though a real brick/region
-- exists one level down. Fix: match the customer code under the parent OR any child that
-- rolls up to it, picking ONE row (parent-preferred) so nothing is duplicated.
--
-- This stays 100% brick-authoritative (it only uses real mapped bricks; never the requester).
-- Verified read-only on prod ozucdzovmcqvepbozvqf: 12 target rows / 6 requests recover their
-- real region; ZERO currently-assigned targets change region; 361 target rows unchanged; 36
-- multi-family-match cases keep their parent mapping (parent-preferred order).
--
-- In-place transform of the live definition (mirrors 20260621230000) so it stays in lock-step
-- with whatever base migration installed the function; only the one customer-map join changes.
-- Guarded: aborts (no change) if the base join text isn't found. Idempotent.
do $migrate$
declare def text;
begin
  select pg_get_functiondef(
    'public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)'::regprocedure
  ) into def;

  def := replace(def,
$old$    left join public.source_of_sales_customer_map cm
      on cm.distributor_code = sd.distributor_code
     and lower(btrim(regexp_replace(coalesce(cm.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
     and cm.active$old$,
$new$    left join lateral (
      select cmx.brick_id, cmx.region_code, cmx.area_code
      from public.source_of_sales_customer_map cmx
      where lower(btrim(regexp_replace(coalesce(cmx.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
        and cmx.active
        and (cmx.distributor_code = sd.distributor_code
             or exists (select 1 from public.marketing_roi_distributor_rollup rcm
                        where rcm.parent_distributor_code = sd.distributor_code
                          and rcm.sos_distributor_code = cmx.distributor_code))
      order by (cmx.distributor_code = sd.distributor_code) desc, cmx.region_code nulls last
      limit 1
    ) cm on true$new$
  );

  if position('marketing_roi_distributor_rollup rcm' in def) = 0 then
    raise exception 'region rollup-family transform did not apply (base cm-join not found); aborting with no change';
  end if;

  execute def;
end $migrate$;

notify pgrst, 'reload schema';
