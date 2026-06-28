-- Scope & Visibility per-user overrides
--
-- line_scope_override: text[] — when set, the user can see employees/data on these
--   specific product lines instead of the role-default single line. Used for cases
--   like a PM responsible for products on two different lines.
--
-- product_scope_override: text[] — when set, sales and marketing-request visibility
--   is further restricted to only records that involve these product codes. Used when
--   a PM is responsible for specific products, not an entire line.

alter table public.app_auth_users
  add column if not exists line_scope_override   text[]  null,
  add column if not exists product_scope_override text[]  null;

comment on column public.app_auth_users.line_scope_override is
  'Admin-assigned product-line override (e.g. [''Pedia'', ''Anti infective'']). When set, overrides the role-default single-lineName lookup for probation / organogram / vacancies / marketing-request visibility.';

comment on column public.app_auth_users.product_scope_override is
  'Admin-assigned product-code override (e.g. [''CNS001'', ''PEDIA002'']). When set, restricts sales and marketing-request visibility to only records involving these product codes.';
