-- Head Office is a confidential product line (see src/lib/sales/access-scope.ts
-- canViewHeadOfficeLine / isHeadOfficeLine): visible only to CEO / Super Admin, everywhere else.
-- analytics.dim_products (the default, non-privileged product dimension view — used by every role
-- except CEO/Super Admin, which instead reads dim_products_all) already excludes the 3 restricted
-- product codes (normalized case/whitespace-insensitively as of 20260719153000_phx_analytics_
-- confidential_normalize_product_code.sql, which this migration builds on) but never excluded the
-- Head Office line itself, so every OTHER Head-Office-tagged product (name, family, factory price)
-- was visible via this view to any consumer — the Analytics dashboards' filter dropdowns (SFE
-- Manager has COMPANY sales scope) and any direct reader granted SELECT on this view
-- (analytics_readonly, metabase, service_role).
--
-- dim_products_all is intentionally left untouched — it is the CEO/Super-Admin "all products"
-- view (application code only ever selects it for canViewRestrictedProducts(role) === true) and is
-- supposed to keep including the confidential set, exactly like it already does for LA003/LA004/SS001.
--
-- Matches isHeadOfficeLine's case/whitespace-insensitive key set (head office / headoffice /
-- office / hq) rather than an exact-string match, so legacy-cased rows are caught too, normalized
-- the same COALESCE(..., ''::text) way as the product_code exclusion right next to it.
--
-- Pure hardening: adding an exclusion can only ever EXCLUDE more rows, never include fewer.

CREATE OR REPLACE VIEW analytics.dim_products AS
 SELECT product_code,
    product_name,
    family,
    family_code,
    line,
    factory_price,
    active
   FROM public.source_of_sales_products
  WHERE ((upper(btrim(COALESCE(product_code, ''::text))) <> ALL (ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text]))
     AND (active = true)
     AND (lower(btrim(COALESCE(line, ''::text))) <> ALL (ARRAY['head office'::text, 'headoffice'::text, 'office'::text, 'hq'::text])));
