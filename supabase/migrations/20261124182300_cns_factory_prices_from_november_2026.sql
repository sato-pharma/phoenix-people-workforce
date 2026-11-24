-- cns_factory_prices_from_november_2026
--
-- WHAT THIS CHANGES:
--   New x-factory prices for 15 CNS products, from period 2026-11 onward:
--     1. one row each in public.source_of_sales_product_price_history (effective_period '2026-11').
--        phx_factory_price(code, period) reads it, so the monthly closing, attribution and
--        achievement, Sales vs Target, the SoS dashboards, weekly sales, the customer and territory
--        surfaces, Market awareness tracking and the Marketing ROI all value November 2026 and later
--        at the new price. October 2026 and every earlier month keep the price they have today —
--        no published month moves.
--     2. public.marketing_products.factory_price for the same 15 codes, so a marketing request
--        created from now on snapshots the new price into factory_price_snapshot. Requests that
--        already exist keep their own snapshot; none of the 15 products is on a request created in
--        November (read on production 2026-11-24 before this ran: 0 links).
--
--   source_of_sales_products.factory_price is deliberately NOT edited: the closing values every
--   month with no override at the master price, so a flat edit would restate every published month
--   (the Saginko precedent, 20260928184100_period_scoped_factory_prices.sql).
--
-- WHY:
--   Owner instruction, 2026-11-24 (Cairo): "change the xfactor for this products in marketing
--   requests sales closing and everywhere starting from november 2026", with the price list.
--   The two retired codes TE006 "Tebofortin Intens" and TE007 "Tebofortin Max" carry no sales rows
--   and are not on his list, so they are left alone.
--
--   November 2026 targets are not loaded yet (au.monthly_targets has none for these codes on
--   2026-11-24); the target authoring path prices through the period price, so they will be
--   authored at the new prices.
--
-- ROLLBACK:
--   delete from public.source_of_sales_product_price_history
--    where effective_period = '2026-11'
--      and product_code in ('CO001','CO002','CO003','CO004','DO001','DO002','DO003',
--                           'RI001','RI002','RI003','TE001','TE002','TE003','TE004','TE005');
--   and restore marketing_products.factory_price to the old values recorded in each override
--   row's note.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive: 15 inserted rows and 15 price edits on the marketing product list.

begin;

insert into public.source_of_sales_product_price_history
  (product_code, effective_period, factory_price, note, created_by)
values
  ('CO004', '2026-11',  30.0000000, 'Owner instruction 2026-11-24: Conviban 100 mg x-factory from 2026-11 (was 33.75).', 'B-10'),
  ('CO003', '2026-11',  23.3999451, 'Owner instruction 2026-11-24: Conviban 25 mg x-factory from 2026-11 (was 26.325).', 'B-10'),
  ('CO002', '2026-11',  31.5000000, 'Owner instruction 2026-11-24: Conviban 25mg/ml Syp x-factory from 2026-11 (was 35.4375).', 'B-10'),
  ('CO001', '2026-11',  30.6000000, 'Owner instruction 2026-11-24: Conviban 50 mg x-factory from 2026-11 (was 34.425).', 'B-10'),
  ('DO003', '2026-11',  48.0000000, 'Owner instruction 2026-11-24: Dolabactin x-factory from 2026-11 (was 54).', 'B-10'),
  ('DO002', '2026-11',  32.4000000, 'Owner instruction 2026-11-24: Dopaminect 1mg x-factory from 2026-11 (was 36.45).', 'B-10'),
  ('DO001', '2026-11',  35.7100000, 'Owner instruction 2026-11-24: Dopaminict 1mg UPA x-factory from 2026-11 (was 35.70).', 'B-10'),
  ('RI002', '2026-11',  30.5999537, 'Owner instruction 2026-11-24: Rispadex 3 mg x-factory from 2026-11 (was 34.425).', 'B-10'),
  ('RI001', '2026-11',  30.6901198, 'Owner instruction 2026-11-24: Rispadex 3 mg UPA x-factory from 2026-11 (was 35.70).', 'B-10'),
  ('RI003', '2026-11',  19.8000000, 'Owner instruction 2026-11-24: Rispadex 1mg Syp x-factory from 2026-11 (was 22.275).', 'B-10'),
  ('TE005', '2026-11', 165.7911746, 'Owner instruction 2026-11-24: Tebofortin 120 mg Intens x-factory from 2026-11 (was 124.342105).', 'B-10'),
  ('TE004', '2026-11', 201.5496084, 'Owner instruction 2026-11-24: Tebofortin 240 mg max x-factory from 2026-11 (was 150.90).', 'B-10'),
  ('TE001', '2026-11',  70.9758513, 'Owner instruction 2026-11-24: Tebofotin drops x-factory from 2026-11 (was 60.75).', 'B-10'),
  ('TE003', '2026-11',  94.2699378, 'Owner instruction 2026-11-24: Tebofortine 40 mg x-factory from 2026-11 (was 81).', 'B-10'),
  ('TE002', '2026-11', 130.0320449, 'Owner instruction 2026-11-24: Tebofortine Forte 80 x-factory from 2026-11 (was 111.375).', 'B-10')
on conflict (product_code, effective_period) do update
  set factory_price = excluded.factory_price,
      note          = excluded.note;

-- The marketing product list snapshots its price onto each new request; numeric(?,4) there.
update public.marketing_products m
   set factory_price = h.factory_price
  from public.source_of_sales_product_price_history h
 where h.effective_period = '2026-11'
   and h.product_code = m.product_code
   and m.product_code in ('CO001','CO002','CO003','CO004','DO001','DO002','DO003',
                          'RI001','RI002','RI003','TE001','TE002','TE003','TE004','TE005');

commit;
