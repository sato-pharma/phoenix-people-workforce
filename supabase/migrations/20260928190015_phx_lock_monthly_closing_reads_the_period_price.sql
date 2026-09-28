-- phx_lock_monthly_closing_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_lock_monthly_closing` now takes its factory price from
--   public.phx_factory_price(product_code, period) instead of reading
--   source_of_sales_products.factory_price straight off the product master. Byte-identical to the
--   body on production apart from that one expression, and only where it VALUES a row.
--
-- WHY: owner instruction 2026-09-28, repricing Saginko — direct orders from that day, "the sales
--   and target of the retail to be adjusted from 1 October". The resolver falls back to the master
--   price when no override covers the period, so a product without an override row is valued
--   exactly as before and this file moves no number on its own. Rationale, the override table and
--   the resolver: 20260928184100_period_scoped_factory_prices.sql.
--
--   One function per file on purpose: several guards in tests/ resolve "the newest migration that
--   defines X" and then read that whole file, so a bundle of 31 functions makes one function's SQL
--   answer for another's.
--
-- ROLLBACK: re-apply the previous definition. The cheaper undo is to drop the override row —
--   delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   which restores the old valuation everywhere without touching a function.

begin;

create or replace function public.phx_lock_monthly_closing(p_line text, p_period text, p_actor text DEFAULT NULL::text)
 RETURNS monthly_closing_locks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_norm text := lower(btrim(coalesce(p_line, '')));
  v_row  public.monthly_closing_locks;
  v_units numeric;
  v_cells integer;
begin
  if v_norm = '' or btrim(coalesce(p_period, '')) = '' then
    raise exception 'A line and a period are required to lock a closing.';
  end if;

  select coalesce(sum(total_qty), 0), count(*)
    into v_units, v_cells
    from public.source_of_sales_fact_rollup
   where period = p_period and lower(btrim(coalesce(official_line, ''))) = v_norm;

  insert into public.monthly_closing_locks
    (line, normalized_line, period, locked_by, snapshot_units, snapshot_cells, snapshot_breakdown)
  values
    (btrim(p_line), v_norm, btrim(p_period), p_actor, v_units, v_cells,
     (select jsonb_agg(jsonb_build_object('a', f.area_code, 'p', f.product_code, 'd', f.is_direct,
                                          'u', f.total_qty,
                                          'v', case when coalesce(f.is_direct, false)
                                                    then coalesce(f.direct_value, 0)
                                                    else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0)
                                               end))
        from public.source_of_sales_fact_rollup f
        left join public.source_of_sales_products pr
          on upper(btrim(pr.product_code)) = upper(btrim(f.product_code))
       where f.period = p_period and lower(btrim(coalesce(f.official_line, ''))) = v_norm))
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.phx_lock_monthly_closing(text, text, text) from public, anon, authenticated;
grant execute on function public.phx_lock_monthly_closing(text, text, text) to service_role;

commit;
