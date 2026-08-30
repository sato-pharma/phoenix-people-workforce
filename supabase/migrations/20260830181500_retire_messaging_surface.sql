-- C10 · Retire the abandoned in-app messaging subsystem (dead, empty tables).
--
-- Background
--   threads / thread_members / messages are a built-then-abandoned in-app
--   messaging feature. Verified against production 2026-08-30:
--     * all three tables are EMPTY (0 rows);
--     * self-contained — the only FKs are messages.thread_id -> threads and
--       thread_members.thread_id -> threads; no live table references them;
--     * no reader/writer/route anywhere in src/ or app/ (scoped grep: no match);
--     * no trigger, no dependent view/matview;
--     * no function in public references them (the realtime.send* functions
--       target realtime.messages, a different table in the realtime schema);
--     * RLS is enabled with policies (threads 1, thread_members 3, messages 1),
--       which move intact with each table.
--   All whole-repo references are DDL only (the baseline migration, a grants
--   restore script, an unused-index review) that read fixed files and do NOT
--   query the live DB, so nothing breaks when these objects leave public.
--
-- What this does
--   RENAMES the dead tables into an archive schema via ALTER ... SET SCHEMA
--   (each moves WITH its indexes, constraints, RLS policies and grants intact,
--   and off the PostgREST-exposed public surface). The children (messages,
--   thread_members) move first, then the parent (threads); ALTER ... SET SCHEMA
--   keeps the intra-move FKs valid by OID regardless of order. Fully reversible
--   -- see the ROLLBACK block at the foot. Direct twin of C7 (...140000),
--   C8 (...150000) and C9 (...160000).

create schema if not exists messaging_backup_20260830;

comment on schema messaging_backup_20260830 is
  'Retired 2026-08-30 (C10): the abandoned in-app messaging subsystem '
  '(threads + thread_members + messages), all empty and referenced by no '
  'application code. Reversible via ALTER ... SET SCHEMA public.';

-- Children first (they carry the FKs to threads), then the parent.
alter table public.messages        set schema messaging_backup_20260830;
alter table public.thread_members  set schema messaging_backup_20260830;
alter table public.threads         set schema messaging_backup_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter table messaging_backup_20260830.threads        set schema public;
--   alter table messaging_backup_20260830.thread_members set schema public;
--   alter table messaging_backup_20260830.messages       set schema public;
--   drop schema messaging_backup_20260830;  -- only after the objects are moved back
-- ─────────────────────────────────────────────────────────────────────────────
