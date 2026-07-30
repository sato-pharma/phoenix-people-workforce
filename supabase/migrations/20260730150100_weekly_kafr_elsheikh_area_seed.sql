-- Weekly Sales: attribute the Kafr El-Sheikh distributor branches to area D16 ("Kafr El-Sheikh 1").
--
-- OWNER RULING (2026-07-30, recorded because it is a judgement call, not a derivation): every
-- Kafr El-Sheikh branch is attributed to D16, the area owned by the CNS Alex-BHR District Manager.
--
-- Why it needed a ruling: the governorate is split across TWO areas — D16 (كفر الشيخ, دسوق, بلطيم,
-- بيلا, الحامول, سخا, …) and D17 (فوه, قلين, مطوباس, سيدى سالم, …) — while a distributor branch is a
-- depot serving both. There is no customer or brick on a weekly row to split them by, so no derivation
-- is possible; per the standing "ambiguous name resolves to nothing" rule the code leaves such branches
-- unmapped by default and this migration is the explicit override.
--
-- Accepted consequence, stated by the owner when ruling: D17 carries CNS sales (≈563 rollup rows) but
-- has NO district and NO rep for that line (it sits under SEAT-CNS-OTHERS as other_line_specific), so
-- those sales are credited to D16 and will appear in the Alex-BHR DM's weekly numbers. His weekly
-- Kafr El-Sheikh figure is therefore the whole governorate, which is wider than his D16 territory
-- alone. To reverse, set area_code back to NULL for the rows below and re-run the backfill.
--
-- Note the branch literally named "كفر الشيخ 2" (Kafr El-Sheikh 2) is included on purpose: it is the
-- D17-named depot, and the ruling above deliberately folds it into D16.
--
-- Matched on the natural key (distributor, raw branch, file type) rather than row ids, so this applies
-- identically in staging and production. The BEFORE trigger from the previous migration re-validates
-- that D16 sits inside each branch's mapped region (D1) and fills area_name.

update public.weekly_sales_branch_region_map
   set area_code = 'D16',
       updated_at = now()
 where region_code = 'D1'
   and not excluded
   and (distributor_code, raw_branch, source_file_type) in (
     ('EG',   '04020201',               'any'),   -- فرع كفر الشيخ
     ('EG',   '04020202',               'any'),   -- فرع دسوق
     ('IS',   '52',                     'any'),   -- Kafr El Sheikh Branch
     ('IS-S', '52',                     'any'),   -- Kafr El Sheikh Branch (stock feed)
     ('POS',  'Retail Kafr Elsheikh',   'any'),
     ('POS',  'ك.عملاء كفر الشيخ',       'any'),
     ('PS',   'Kafr El Sheikh Branch',  'stock'),
     ('PS',   'Retail Kafr Elsheikh_ك', 'stock'),
     ('PS',   'Retail Kafr Elsheikh_ك', 'sales'),
     ('PS',   'دسوق',                    'sales'),
     ('PS',   'دسوق',                    'stock'),
     ('PS',   'ك.عملاء كفر الشيخ_ك',      'sales'),
     ('PS',   'ك.عملاء كفر الشيخ_ك',      'stock'),
     ('PS',   'كفر الشيخ 2_ك',           'sales'),
     ('PS',   'كفر الشيخ 2_ك',           'stock'),
     ('PS',   'كفر الشيخ_ك',             'sales'),
     ('PS',   'كفر الشيخ_ك',             'stock')
   );

-- Stamp the already-imported history so the fix is visible without waiting for the next weekly upload.
-- Same join the schema migration uses; only rows whose branch now carries an area are touched.
update public.weekly_sales_rows r
   set area_code = m.area_code
  from public.weekly_sales_branch_region_map m
 where m.area_code is not null
   and not m.excluded
   and upper(btrim(m.distributor_code)) = upper(btrim(r.distributor_code))
   and upper(btrim(coalesce(m.raw_branch, ''))) in (
         upper(btrim(coalesce(r.branch_code, ''))),
         upper(btrim(coalesce(r.branch_name, '')))
       )
   and r.area_code is distinct from m.area_code;
