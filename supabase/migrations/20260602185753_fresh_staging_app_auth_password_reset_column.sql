-- Fresh staging app auth compatibility.
-- The login and password-setup flows read this flag through the service-role
-- Data API, so it must exist in the canonical migration chain.

begin;

alter table if exists public.app_auth_users
  add column if not exists force_password_reset boolean not null default false;

grant select, insert, update, delete on table public.app_auth_users to service_role;

notify pgrst, 'reload schema';

commit;
