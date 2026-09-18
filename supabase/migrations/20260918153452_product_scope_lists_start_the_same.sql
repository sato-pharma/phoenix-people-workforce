-- WHAT: Adds to each person's existing Weekly Sales product list every product their Scope &
--       Visibility list already holds, so the two lists start the same. It only adds. It removes
--       nothing, changes no Scope & Visibility list, and starts no new weekly list for anyone.
--
-- WHY:  From this change a save on either product-scope screen writes both lists (owner, 2026-09-18:
--       "make both product-scope screens save the same list"; src/lib/sales/product-scope-list.ts).
--       On production one person's two lists differ: the Marketing Manager's Scope & Visibility list
--       holds 23 products, because the owner added Tebofortin Intens (TE006) and Tebofortin Max
--       (TE007) on 2026-08-12, and his weekly list holds the other 21. Without this, the first save
--       of his weekly list would cut his Scope & Visibility list to 21, and the monthly closing
--       download would stop tying with no error (app/api/sales/monthly-closing/export/route.ts, "WATCH
--       THIS ONE FOR THE MARKETING MANAGER"). Weekly Sales has no rows for either product, so no weekly
--       figure moves.
--
--       The weekly list is keyed by canonicalHrIdKey (src/lib/hr-id.ts): trimmed, lower-cased, and
--       the one legacy alias AAA -> AA applied.
--
-- ROLLBACK: delete from public.weekly_sales_product_scope where created_by = 'product-scope-align-2026-09-18';

insert into public.weekly_sales_product_scope (hr_id, product_code, created_by)
select distinct
  keyed.hr_key,
  upper(btrim(code)),
  'product-scope-align-2026-09-18'
from (
  select
    case lower(btrim(u.hr_id)) when 'aaa' then 'aa' else lower(btrim(u.hr_id)) end as hr_key,
    u.product_scope_override
  from public.app_auth_users u
  where u.is_active
    and nullif(btrim(u.hr_id), '') is not null
    and u.product_scope_override is not null
) keyed
cross join lateral unnest(keyed.product_scope_override) as code
where nullif(btrim(code), '') is not null
  and exists (select 1 from public.weekly_sales_product_scope w where w.hr_id = keyed.hr_key)
on conflict (hr_id, product_code) do nothing;
