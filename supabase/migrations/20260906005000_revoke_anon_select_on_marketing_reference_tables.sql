-- Take `anon` off the last 6 public tables that granted it anything: the marketing reference lists.
--
-- These were the remainder after 20260906004000 cleared every table where `anon` held DELETE.
-- They are a milder case and were deliberately split out of that migration rather than folded in
-- silently: SELECT only, no INSERT, no UPDATE, no DELETE, no TRUNCATE, on small reference lists
-- (23 products, 21 distributors, 8 control settings, 8 workflow steps, 6 request types,
-- 3 review-routing rows). The owner asked for them on 2026-09-06.
--
-- Same dead-weight shape, verified against pg_policy on production. Each table carries exactly ONE
-- policy -- marketing_<name>_authenticated_read -- which is SELECT-only, applies to
-- `authenticated`, and filters on `active = true` (or `admin_only = false` for control settings).
-- There is no `anon` policy on any of them, and `anon` has rolbypassrls = false, so RLS already
-- yields `anon` nothing. This removes the grant sitting underneath that.
--
-- Checked specifically because this app HAS a public surface: app/share/territory/[token]/page.tsx
-- is reachable unauthenticated, and it reads none of these tables. More generally there is no
-- browser Supabase client in the repository, and getSupabaseUserClient() -- the only anon-key
-- table client -- has exactly one caller, getSupabaseRlsClient() in src/lib/supabase/rls-server.ts,
-- which hydrates a session onto it so it acts as `authenticated`, never as `anon`.
--
-- `authenticated` is left alone: its grant is what those six read policies are written against.
--
-- Reversible by re-granting. Idempotent.

revoke all on table public.marketing_control_settings from anon;
revoke all on table public.marketing_distributors     from anon;
revoke all on table public.marketing_products         from anon;
revoke all on table public.marketing_request_types    from anon;
revoke all on table public.marketing_review_routing   from anon;
revoke all on table public.marketing_workflow_steps   from anon;

-- Post-conditions: anon must hold NOTHING on any public table, and authenticated must keep the
-- SELECT its six read policies depend on.
do $$
declare
  v_anon_any int;
  v_authed_marketing int;
begin
  select count(*) into v_anon_any
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, 'SELECT');

  if v_anon_any <> 0 then
    raise exception 'expected 0 public tables leaving anon with SELECT, found %', v_anon_any;
  end if;

  select count(*) into v_authed_marketing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('marketing_control_settings','marketing_distributors','marketing_products',
                      'marketing_request_types','marketing_review_routing','marketing_workflow_steps')
    and has_table_privilege('authenticated', c.oid, 'SELECT');

  if v_authed_marketing <> 6 then
    raise exception 'authenticated must retain SELECT on all 6 marketing reference tables, found %', v_authed_marketing;
  end if;
end $$;
