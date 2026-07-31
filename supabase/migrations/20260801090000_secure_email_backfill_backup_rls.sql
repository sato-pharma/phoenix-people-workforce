-- Close a live exposure found by the new schema-shape monitor on 2026-08-01 — the
-- first real finding it produced, before anyone was looking for it.
--
-- public.email_backfill_backup_20260730 is the rollback record for the 2026-07-30
-- email backfill: login_id, hr_id, old_email, new_email for 107 accounts. It was
-- created with the Supabase default grants to anon/authenticated and RLS was never
-- enabled, so the PUBLIC anon key could read all 107 rows. That matters more than
-- "a list of email addresses" sounds: this app authenticates with HR_ID + password,
-- so the table handed out the complete username list for the login system.
--
-- Enabling RLS with NO policies makes it deny-all for anon/authenticated, while
-- service_role (rolbypassrls = true, verified on both projects) keeps full access —
-- so nothing server-side changes. Verified after applying: acting as `anon`, rows
-- visible went 107 -> 0, and all 107 rows remain stored.
--
-- DELIBERATELY NOT DROPPING THE TABLE. It is two days old and is the only way to
-- reverse or audit an email change affecting 107 login accounts; dropping it is
-- irreversible and buys nothing that enabling RLS does not. Drop it once the
-- backfill is confidently settled — at which point the matching entry in
-- scripts/check-schema-shape.ts NO_PRIMARY_KEY_ALLOWED should go with it.
--
-- Guarded so it is a clean no-op anywhere the table does not exist (staging never
-- had it), which also keeps this migration safe to replay on a rebuilt environment.

do $$
begin
  if to_regclass('public.email_backfill_backup_20260730') is not null then
    execute 'alter table public.email_backfill_backup_20260730 enable row level security';
    raise notice 'RLS enabled on email_backfill_backup_20260730';
  else
    raise notice 'email_backfill_backup_20260730 not present — nothing to do';
  end if;
end
$$;
