-- STAGING ONLY — bring staging back in line with production (Supabase audit, 18 November 2026).
--
-- WHAT. Five differences the audit found between the two projects, all on staging's side:
--   1. Role settings production has and staging lacks: a 15-second idle-in-transaction timeout on
--      anon, authenticated and authenticator, and temp-file logging over 10 MB on those three and
--      service_role. No migration sets these (they were set on production by hand), so the staging
--      migration job can never copy them.
--   2. Three storage.objects policies production has for service_role on the leave-attachments,
--      marketing-finance-evidence and outstation-evidence buckets. They came from archived
--      pre-baseline migrations that staging never ran.
--   3. Two private signature buckets production has (hr-form-signatures, spotlight-signatures),
--      PNG only, 1.5 MB. The HR one is also created on first use by src/lib/hiring-pack/hr-signature.ts;
--      the Spotlight one is only ever read (src/lib/spotlight/cheque-signature.ts), so on staging
--      the read failed on a missing bucket rather than a missing file.
--   4. Staging-only scratch in public — tables zz_search_fp (358 rows) and zz_search_probes (185 rows,
--      with its id sequence) and function zz_run_phase(text, integer). No repo code names them and
--      production has none of them. They are MOVED into search_backup_20261118, not dropped, so
--      nothing is lost and public matches production.
--
-- WHY. Staging is where a change is rehearsed before production; every difference here is a place
-- a rehearsal can pass on staging and fail on production, or the reverse.
--
-- HOW. node scripts/apply-sql-file.mjs supabase/scripts/staging-parity-2026-11-18.sql staging
-- (the script refuses to run when the staging variable names any project but staging). Never run
-- this against production: production already has 1–3 and none of 4.
--
-- ROLLBACK.
--   alter role anon reset idle_in_transaction_session_timeout;  (and the same for each setting)
--   drop policy <name> on storage.objects;  delete from storage.buckets where id in (...);
--   alter table search_backup_20261118.zz_search_fp set schema public;  (and the other two)

begin;

-- 1. Role settings, exactly as production carries them.
alter role anon set idle_in_transaction_session_timeout = '15s';
alter role anon set log_temp_files = 10240;
alter role authenticated set idle_in_transaction_session_timeout = '15s';
alter role authenticated set log_temp_files = 10240;
alter role authenticator set idle_in_transaction_session_timeout = '15s';
alter role authenticator set log_temp_files = 10240;
alter role service_role set log_temp_files = 10240;

-- 2. The three service_role storage policies.
drop policy if exists leave_attachments_service_role on storage.objects;
create policy leave_attachments_service_role on storage.objects
  for all to service_role
  using (bucket_id = 'leave-attachments')
  with check (bucket_id = 'leave-attachments');

drop policy if exists marketing_finance_evidence_service_role on storage.objects;
create policy marketing_finance_evidence_service_role on storage.objects
  for all to service_role
  using (bucket_id = 'marketing-finance-evidence')
  with check (bucket_id = 'marketing-finance-evidence');

drop policy if exists outstation_evidence_service_role on storage.objects;
create policy outstation_evidence_service_role on storage.objects
  for all to service_role
  using (bucket_id = 'outstation-evidence')
  with check (bucket_id = 'outstation-evidence');

-- 3. The two private signature buckets.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('hr-form-signatures', 'hr-form-signatures', false, 1500000, array['image/png']),
  ('spotlight-signatures', 'spotlight-signatures', false, 1500000, array['image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 4. Move the scratch out of public, into a dated schema nothing exposes.
create schema if not exists search_backup_20261118;
revoke all on schema search_backup_20261118 from public, anon, authenticated;

alter table if exists public.zz_search_fp set schema search_backup_20261118;
alter table if exists public.zz_search_probes set schema search_backup_20261118;
alter sequence if exists public.zz_search_probes_id_seq set schema search_backup_20261118;
alter function public.zz_run_phase(text, integer) set schema search_backup_20261118;
revoke all on function search_backup_20261118.zz_run_phase(text, integer) from public, anon, authenticated;

commit;
