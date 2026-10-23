-- release_gate_writer_login
--
-- WHAT THIS CHANGES: a database role, `release_gate_writer`, whose only rights are to read and add rows in
--   public.release_gates. ci.yml's `release-gate` job connects as it (secret RELEASE_GATE_DATABASE_URL)
--   instead of holding the full production service-role key.
--
-- WHY (technical audit, 2026-10-23, P6-02; owner's choice "Narrow login" the same morning): to write ONE row
--   per merge, CI held the production master key, which can read and change every table. A leaked CI log or
--   a compromised action would have had all of it. This login can add a "this commit passed" row and read
--   rows back, nothing else: no other table is granted, it cannot update or delete, and RLS admits it to
--   this table only through the policy below.
--
-- THE PASSWORD IS NOT HERE. The role is created NOLOGIN. The session that wires it sets the login and a
--   SCRAM-SHA-256 verifier (computed on the laptop, so no plain password reaches the database or its logs)
--   on PRODUCTION only, and writes the connection URL straight into the GitHub secret without printing it.
--   Staging gets the role (so the schema matches) but never a login.
--
-- ROLLBACK: drop policy phx_release_gates_writer on public.release_gates;
--   revoke all on public.release_gates from release_gate_writer; revoke usage on schema public from
--   release_gate_writer; drop role release_gate_writer; then point ci.yml back at the service key.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'release_gate_writer') then
    create role release_gate_writer nologin noinherit nocreatedb nocreaterole connection limit 5;
  end if;
end
$$;

grant usage on schema public to release_gate_writer;
grant select, insert on public.release_gates to release_gate_writer;

drop policy if exists phx_release_gates_writer on public.release_gates;
create policy phx_release_gates_writer
  on public.release_gates
  for all
  to release_gate_writer
  using (true)
  with check (true);

comment on role release_gate_writer is
  'CI''s release-gate login (ci.yml release-gate job): select and insert on public.release_gates only. Login and password are set on production only, by hand, never in a migration.';
