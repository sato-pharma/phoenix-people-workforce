-- Lock notification_backup_20261023 the way every other backup schema is locked.
--
-- WHAT
--   20261023082524_repair_stranded_in_app_notifications.sql made this schema and its three pre-image
--   tables (deliveries_no_hr_id, events_widened, user_states_added) with a bare `create schema` — no
--   revoke on the schema, and row security OFF on all three tables. Every other backup schema made
--   that week (20261023023133, 20261023023603, 20261023043213) revokes the schema from public, anon
--   and authenticated in the same statement block. This brings it into line: the schema and its
--   tables are revoked from public, anon and authenticated, and row security is switched on, so the
--   pre-images stay readable by the owner and the service role only.
--
-- WHY (audit 2026-10-26, point 8)
--   Measured on production and staging on 2026-10-26: the schema and its three tables are owned by
--   postgres with a NULL ACL, and neither browser role holds USAGE on the schema — so nothing is
--   reachable TODAY. But the only thing keeping it shut is that nobody granted anything; one later
--   `grant usage on schema ...` or a default-privilege change would have exposed the recipient HR ids
--   in deliveries_no_hr_id with row security off. The pre-images are the rollback for the 23 Oct
--   repair, so they are kept, not dropped.
--
--   scripts/check-migrations.mjs rule 6 now refuses a migration that creates a schema without
--   revoking it from anon and authenticated in the same file, so this cannot recur silently.
--
-- WHAT THIS DOES NOT CHANGE
--   No row is read, moved or deleted, and nothing is dropped. The owner and service_role (BYPASSRLS)
--   keep full access, so the rollback statements in 20261023082524 still work. The advisor's
--   rls_enabled_no_policy count rises by 3 (these tables now have row security on and no policy —
--   the intended deny-all shape); scripts/advisor-baseline.json carries the new accepted number.
--
-- RE-APPLY / OTHER DATABASES
--   Every revoke of a privilege not held is a no-op and enabling row security twice is a no-op, so
--   this is safe to run again. A database without the schema, or without one of the tables, skips it
--   with a notice. The block ends by re-reading the catalog and RAISES if a browser role can still
--   use the schema or touch any relation in it, or if row security is off on any of its tables.
--
-- ROLLBACK
--   alter table notification_backup_20261023.<table> disable row level security;  (per table)
--   The revokes need no rollback: the browser roles held nothing before.

do $$
declare
  v_table text;
  v_role text;
  v_rel record;
begin
  set local lock_timeout = '5s';

  if to_regnamespace('notification_backup_20261023') is null then
    raise notice 'schema notification_backup_20261023 does not exist here - skipped';
    return;
  end if;

  revoke all on schema notification_backup_20261023 from public, anon, authenticated;

  foreach v_table in array array['deliveries_no_hr_id', 'events_widened', 'user_states_added'] loop
    if to_regclass(format('notification_backup_20261023.%I', v_table)) is null then
      raise notice 'notification_backup_20261023.% does not exist here - skipped', v_table;
      continue;
    end if;
    execute format('revoke all on table notification_backup_20261023.%I from public, anon, authenticated', v_table);
    execute format('alter table notification_backup_20261023.%I enable row level security', v_table);
  end loop;

  foreach v_role in array array['anon', 'authenticated'] loop
    if has_schema_privilege(v_role, 'notification_backup_20261023', 'USAGE')
       or has_schema_privilege(v_role, 'notification_backup_20261023', 'CREATE') then
      raise exception 'refusing: % can still use schema notification_backup_20261023', v_role;
    end if;
  end loop;

  for v_rel in
    select c.oid, c.oid::regclass::text as name, c.relkind, c.relrowsecurity
    from pg_class c
    where c.relnamespace = 'notification_backup_20261023'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_table_privilege(v_role, v_rel.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'refusing: % still holds a privilege on %', v_role, v_rel.name;
      end if;
    end loop;
    if v_rel.relkind in ('r', 'p') and not v_rel.relrowsecurity then
      raise exception 'refusing: row level security is OFF on %', v_rel.name;
    end if;
  end loop;

  raise notice 'notification_backup_20261023 is revoked from the browser roles and its tables have row security on';
end
$$;
