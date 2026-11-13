-- phoenix_backup_reader_role
--
-- WHAT THIS CHANGES: a database role, `phoenix_backup_reader`, that may READ every table and nothing else.
--   The nightly database backup (infra/code-backup/db-backup.sh, on the Railway service
--   `phoenix-code-backup`) connects as it and runs pg_dump. No table, row or grant of any other role changes.
--
-- WHY (integration audit, 13 Nov 2026, ISS-009 and INT-096; the owner's choice the same day: the dump goes to
--   the Drive the code backup already uses): production has no point-in-time recovery, and its seven daily
--   backups are held by the same provider as the database. An own copy needs a login that can read the whole
--   database. Nothing on Railway held one: the app talks to the database through the REST keys.
--
-- WHY THESE RIGHTS AND NO FEWER:
--   pg_read_all_data  SELECT on every table, view and sequence, and USAGE on every schema, in one grant that
--                     also covers tables created later. A per-table grant would miss tomorrow's table, and
--                     pg_dump stops the night at the first table it may not read.
--   bypassrls         pg_dump refuses to dump a table whose row security would hide rows from it. Without
--                     this the dump fails on the first protected table.
--   It can write nothing: no INSERT, UPDATE, DELETE or DDL is granted, it owns nothing, and its sessions
--   start read-only. That last setting is a seat belt, not the lock: the missing grants are the lock.
--
-- THE PASSWORD IS NOT HERE. The role is created NOLOGIN, as `release_gate_writer` was. The session that
--   wires the backup sets the login and a SCRAM-SHA-256 verifier (computed on the laptop, so no plain
--   password reaches the database or its logs) on PRODUCTION only, and writes the connection URL straight
--   into the Railway variable DB_BACKUP_DATABASE_URL without printing it. Staging gets the role (so the
--   schema matches) but never a login.
--
-- 🔴 TREAT ITS URL LIKE THE SERVICE-ROLE KEY: it reads payroll, the sign-in table and every backup schema.
--   It lives on one Railway service and nowhere else. To rotate it: infra/code-backup/README.md.
--
-- ROLLBACK: revoke pg_read_all_data from phoenix_backup_reader; drop role phoenix_backup_reader;
--   and remove DB_BACKUP_DATABASE_URL from the Railway service. The nightly code backup is not affected.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'phoenix_backup_reader') then
    create role phoenix_backup_reader nologin inherit nocreatedb nocreaterole noreplication bypassrls connection limit 4;
  end if;
end
$$;

grant pg_read_all_data to phoenix_backup_reader;

-- A dump of the whole database runs for minutes: the role-level timeouts that protect the app's own
-- short requests would cut it off half way. pg_dump sets the first itself; the counting session needs both.
alter role phoenix_backup_reader set statement_timeout = 0;
alter role phoenix_backup_reader set idle_in_transaction_session_timeout = 0;
alter role phoenix_backup_reader set default_transaction_read_only = on;

comment on role phoenix_backup_reader is
  'The nightly database backup''s login (infra/code-backup/db-backup.sh): reads every table, writes nothing. Login and password are set on production only, by hand, never in a migration.';
