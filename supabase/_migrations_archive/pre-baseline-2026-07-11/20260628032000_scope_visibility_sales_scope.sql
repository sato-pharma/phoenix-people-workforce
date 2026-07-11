-- Add sales_scope_override column to app_auth_users
--
-- sales_scope_override: text — when set, overrides the role-default sales access scope
--   for this user. Valid values mirror SalesScopeLevel: COMPANY, LINE, HIERARCHY, TEAM,
--   SELF, NONE. When null the role default applies.

alter table public.app_auth_users
  add column if not exists sales_scope_override text null;

comment on column public.app_auth_users.sales_scope_override is
  'Admin-assigned sales scope override (COMPANY | LINE | HIERARCHY | TEAM | SELF | NONE). When set, overrides the role-default sales access scope for this user.';
