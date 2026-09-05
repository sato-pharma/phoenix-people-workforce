-- A factory-price edit that restates a settled closing now writes down that it did.
--
-- Last gap of the SoS audit finding at
-- `supabase/migrations/20260801120000_sos_rollup_and_closing_sql_truth.sql:186`. PR #3199 taught
-- the drift check to see VALUE; PR #3208 made publishing take a baseline. Both are DETECTORS — you
-- learn the number moved only when you go and ask. This records the act itself, as it happens.
--
-- ── WHY THIS DOES NOT EXTEND THE CLOSING LOCK, WHICH IS THE OBVIOUS FIX ──────────────────────
-- `phx_reject_write_to_locked_closing` guards 5 sales/rollup tables and not
-- `source_of_sales_products`, so the price sits outside the lock. Confirmed 2026-09-05 by editing
-- a price against a locked closing on staging with no objection.
--
-- Extending that guard here would be WRONG, for two independent reasons.
--
--   1. IT WOULD REFUSE THE OWNER'S OWN PRICE CORRECTIONS. He ruled on 2026-08-14 that every closed
--      month is valued at Phoenix's CURRENT factory price — "our factory price / our known policy"
--      — and rejected both matching the manual sheet's value and adding period-scoped prices. The
--      2026-08-11 Saginko realignment (126.72 -> 111.15) deliberately "stands for all months", and
--      on 2026-09-04 he corrected Royafloxacin RO001 to 60.70 for exactly that reason. All three
--      published closings are locked right now, so a hard block would have refused that edit. The
--      restatement is the POLICY. Only its invisibility was ever the defect.
--   2. IT CANNOT BE THAT GUARD ANYWAY. `phx_reject_write_to_locked_closing` is a statement-level
--      trigger parameterised by a PERIOD column and a LINE column (tg_argv), which it joins to
--      monthly_closing_locks. A product row has neither — a price is not scoped to a period — so
--      the mechanism has nothing to match on.
--
-- It also follows the house rule for this kind of judgement: the system FLAGS, it never
-- auto-rejects. Same shape as the expense flag, and as the period-drift guard, which raises a
-- WARNING rather than aborting an import.
--
-- ── What it records ─────────────────────────────────────────────────────────────────────────
-- One `sales_audit_logs` row per SETTLED (line, period) the price move restates — settled meaning
-- actively locked or published, i.e. a month someone has been told is final. Measured on
-- production 2026-09-05: 3 such combinations exist (Anti Infective / CNS / Pedia 2026-07, locked
-- and published), and the worst-hit product touches exactly 1, so this cannot flood the operations
-- activity feed that reads this table.
--
-- The metadata also carries the ALL-PERIODS total, so an edit whose visible effect is one closed
-- month but whose real reach is eight is not quietly reported as small. RO001's 2026-09-04 move
-- was precisely that shape: eight periods, 1,017.10 EGP, of which only July was published.
--
-- DIRECT ROWS ARE EXCLUDED, and that is a correctness point rather than a filter. A direct order's
-- value is the value Finance booked (`direct_value`), never units x factory price — the owner's
-- rule, "direct orders take the units as they are and the value as they are from the source". A
-- factory-price move does not restate them at all, so counting them would invent an impact.
--
-- The audit can never break the edit. The whole argument above is that the correction must remain
-- possible, so a failure to record it raises a WARNING and the price change still commits.

CREATE OR REPLACE FUNCTION public.phx_record_factory_price_restatement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  begin
    with moved as (
      -- Only a real change to factory_price. Other columns on this table move for other reasons.
      select n.product_code,
             n.product_name,
             o.factory_price as old_price,
             n.factory_price as new_price
      from new_rows n
      join old_rows o on o.product_code = n.product_code
      where coalesce(n.factory_price, 0) is distinct from coalesce(o.factory_price, 0)
    ),
    impact as (
      select m.product_code, m.product_name, m.old_price, m.new_price,
             f.official_line, f.period,
             sum(f.effective_units) as units
      from moved m
      join public.source_of_sales_fact_rollup f
        on upper(btrim(f.product_code)) = upper(btrim(m.product_code))
      where not coalesce(f.is_direct, false)   -- a direct row's value is its source value
      group by 1, 2, 3, 4, 5, 6
      having sum(f.effective_units) <> 0
    ),
    totals as (
      -- Reach across EVERY period, settled or not, so a wide edit cannot report as a narrow one.
      select product_code,
             sum(units * (coalesce(new_price, 0) - coalesce(old_price, 0))) as all_periods_value_delta,
             count(*) as all_periods_cells
      from impact
      group by 1
    )
    insert into public.sales_audit_logs (action, actor_username, line, period, metadata)
    select 'factory_price_restated_settled_closing',
           current_user,
           i.official_line,
           i.period,
           jsonb_build_object(
             'product_code', i.product_code,
             'product_name', i.product_name,
             'old_factory_price', i.old_price,
             'new_factory_price', i.new_price,
             'units', round(i.units, 6),
             'value_delta', round(i.units * (coalesce(i.new_price, 0) - coalesce(i.old_price, 0)), 2),
             'closing_locked', exists (
               select 1 from public.monthly_closing_locks l
                where l.period = i.period
                  and l.normalized_line = lower(btrim(i.official_line))
                  and l.unlocked_at is null),
             'closing_published', exists (
               select 1 from public.monthly_closing_publications p
                where p.period = i.period
                  and p.normalized_line = lower(btrim(i.official_line))),
             'all_periods_value_delta', round(t.all_periods_value_delta, 2),
             'all_periods_cells', t.all_periods_cells,
             'note', 'Re-valuation at the current factory price is policy, not a fault. '
                     || 'This row records that a settled month changed value.'
           )
    from impact i
    join totals t on t.product_code = i.product_code
    where exists (
            select 1 from public.monthly_closing_locks l
             where l.period = i.period
               and l.normalized_line = lower(btrim(i.official_line))
               and l.unlocked_at is null)
       or exists (
            select 1 from public.monthly_closing_publications p
             where p.period = i.period
               and p.normalized_line = lower(btrim(i.official_line)));
  exception
    when others then
      -- The correction must stay possible: never turn a failed audit into a failed price fix.
      raise warning 'Could not record the factory-price restatement audit: % (%)', sqlerrm, sqlstate;
  end;

  return null;
end;
$function$;

revoke execute on function public.phx_record_factory_price_restatement() from public, anon, authenticated;
grant  execute on function public.phx_record_factory_price_restatement() to service_role;

-- Statement-level with transition tables, like phx_reject_write_to_locked_closing: one pass for a
-- bulk price upload rather than one per row.
drop trigger if exists trg_record_factory_price_restatement on public.source_of_sales_products;
create trigger trg_record_factory_price_restatement
after update on public.source_of_sales_products
referencing old table as old_rows new table as new_rows
for each statement execute function public.phx_record_factory_price_restatement();

comment on function public.phx_record_factory_price_restatement() is
  'AFTER UPDATE on source_of_sales_products: when factory_price moves, writes one sales_audit_logs '
  'row per actively-locked or published (line, period) it restates, with the all-periods total in '
  'metadata. Records, never refuses - re-valuation at the current price is the owner''s policy '
  '(2026-08-14); only its invisibility was the defect. Added 2026-09-05.';
