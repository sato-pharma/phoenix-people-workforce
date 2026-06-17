-- Make product aliases PER-DISTRIBUTOR (matching the customer→brick map model). Until now
-- source_of_sales_product_aliases held one global "alias -> product" list with a global unique on
-- normalized_alias. Distributors share product names ("Tebofortin Forte" appears for Chimipharm,
-- Ramco, MEC…), so a single global table forces one owner per alias and can't represent each
-- distributor's own raw codes/names. This scopes aliases by distributor.
--
-- Coupling note: the matching engine (resolvers.resolveProduct / crosswalks.loadCrosswalks) and the
-- alias writers (mapping.saveMappings onConflict) switch to the per-distributor key in the SAME
-- deploy as this migration. Apply this migration together with that code deploy.

alter table public.source_of_sales_product_aliases
  add column if not exists distributor_code text;

-- Every existing alias was learned from the Overseas/PS "customer sales" bootstrap (numeric Mat.
-- Codes), so attribute them to PS — nothing is lost, and PS uploads keep resolving exactly as before.
update public.source_of_sales_product_aliases
  set distributor_code = 'PS'
  where distributor_code is null;

-- Swap the global "one alias -> one product" unique for a per-distributor one, so each distributor can
-- map its own raw string to the right product without colliding with another distributor's.
drop index if exists source_of_sales_product_aliases_normalized_alias_key;
create unique index if not exists source_of_sales_product_aliases_distributor_alias_key
  on public.source_of_sales_product_aliases (distributor_code, normalized_alias);

create index if not exists source_of_sales_product_aliases_distributor_idx
  on public.source_of_sales_product_aliases (distributor_code);
