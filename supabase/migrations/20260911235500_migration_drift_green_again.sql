-- The nightly Migration Drift Check has been red since 2026-09-08. Two causes, both records
-- disagreeing with a production database that is already correct. Neither is a schema gap and
-- neither is an exposure; this file closes both and writes the reasoning back.
--
-- ── CAUSE 1 · a ledger row production never got ────────────────────────────────────────────────
--
-- `20260905174500_cv_search_uses_an_index.sql` is on `main` and absent from production's
-- `supabase_migrations.schema_migrations` by version AND by name, so check-migrations-applied.ts
-- reports it as merged-but-unapplied. Measured on ozucdzovmcqvepbozvqf 2026-09-11, the objects it
-- creates ALL exist: the generated `search_tsv` column, the GIN index
-- `ats_candidate_cv_extractions_search_tsv_idx`, `ats_candidate_cv_extractions_candidate_id_idx`,
-- and `ats_search_candidate_cvs`.
--
-- They exist because the work reached production on 09-05 as four separate applies carrying their
-- own names — `cv_extraction_full_text_search`, `cv_search_ranked_candidate_ids`,
-- `cv_search_point_existing_at_the_index`, `cv_search_short_terms_are_words` — while the repository
-- consolidated the same work into one file under a name production never saw. Staging took the file
-- itself and has version 20260905174500 recorded, which is why only the production leg went red.
--
-- 🔴 DO NOT "FIX" THIS BY APPLYING THAT FILE. Production's live `ats_search_candidate_cvs` is the
-- LATER function, the one 20260905181500_cv_search_short_terms_are_words introduced, which appends
-- `:*` only when the trailing lexeme is 4 characters or longer. The missing file appends it
-- unconditionally. Applying it alone would put `rep` back to matching most of the candidate pool —
-- the exact regression 20260905181500 exists to undo — and its `drop column if exists search_tsv`
-- would rebuild the generated column and its GIN index on the way. Production is not behind this
-- file; it is past it. Recording it is the whole correct action.
--
-- ── CAUSE 2 · a pre-image table left in `public` ───────────────────────────────────────────────
--
-- `drive_mirror_preimage_20260908` is a 1,172-row rollback pre-image of the CV Drive mirror state,
-- taken by hand on 2026-09-08 (id, candidate_id, drive_mirror_file_id, drive_mirror_path,
-- drive_mirror_error, captured_at). No migration in this repository creates it and nothing in the
-- codebase reads it. check-schema-shape.ts raises `missing_primary_key` on it, which joined the
-- failure on 09-09, one night after cause 1.
--
-- Measured before the move: RLS off, 0 policies, and neither `anon` nor `authenticated` holds
-- SELECT — so this is placement, not exposure, and that protection rests on those grants staying
-- exactly as they are. The remedy is the one check-schema-shape.ts names in its own message and
-- docs/security/backup-table-placement.md prescribes, and it is explicitly NOT to give the table a
-- primary key: move it out of `public`, the only schema PostgREST serves. Same shape as
-- 20260805204502_move_adhoc_snapshots_out_of_public.
--
-- WHY MOVE RATHER THAN DROP. It is the only surviving record of what the 09-08 Drive work changed.
-- Moving keeps every row and ends the placement problem; dropping would throw away the undo.
-- Reversible in one statement: `alter table drive_backup_20260908.drive_mirror_preimage_20260908
-- set schema public;`.
--
-- ── RE-RUNNING, AND OTHER DATABASES ────────────────────────────────────────────────────────────
--
-- Both halves are guarded and idempotent. On staging and on a database rebuilt from this folder the
-- ledger insert finds the row already there and does nothing, and the move finds no table and does
-- nothing — `drive_backup_20260908` is simply created empty, the documented rebuild behaviour noted
-- in 20260805204502. The insert is also guarded on the `search_tsv` column actually existing, so it
-- can never record a migration that did not reach the database it runs against.

-- ── Cause 1 ────────────────────────────────────────────────────────────────────────────────────
insert into supabase_migrations.schema_migrations (version, name)
select '20260905174500', 'cv_search_uses_an_index'
where exists (
        select 1
        from pg_attribute a
        where a.attrelid = 'public.ats_candidate_cv_extractions'::regclass
          and a.attname = 'search_tsv'
          and not a.attisdropped
      )
  and not exists (
        select 1
        from supabase_migrations.schema_migrations m
        where m.version = '20260905174500'
           or coalesce(m.name, '') = 'cv_search_uses_an_index'
      );

-- ── Cause 2 ────────────────────────────────────────────────────────────────────────────────────
create schema if not exists drive_backup_20260908;
revoke all on schema drive_backup_20260908 from anon, authenticated;

comment on schema drive_backup_20260908 is
  'Rollback pre-images from the 2026-09-08 CV Drive mirror work. Out of `public` because that is '
  'the only schema PostgREST serves. Retire once that work has proven out — see '
  'docs/security/backup-table-placement.md.';

do $$
begin
  if to_regclass('public.drive_mirror_preimage_20260908') is not null then
    alter table public.drive_mirror_preimage_20260908 set schema drive_backup_20260908;
  end if;
end
$$;

-- Table privileges travel WITH a table through SET SCHEMA. Production holds none for these two
-- roles today, but restate it so the placement never depends on that having stayed true. Revoked
-- from the two NAMED roles and never from PUBLIC: a `revoke ... from public` against a default ACL
-- also strips service_role, which is the role the application itself connects as.
do $$
begin
  if to_regclass('drive_backup_20260908.drive_mirror_preimage_20260908') is not null then
    revoke all on drive_backup_20260908.drive_mirror_preimage_20260908 from anon, authenticated;
  end if;
end
$$;
