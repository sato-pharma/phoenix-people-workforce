-- Finish the job 20260809130000 started: sequences, plus a verify block that refuses to
-- report success while the hole is open.
--
-- WHY THIS IS A SEPARATE FILE RATHER THAN AN EDIT TO 20260809130000.
-- That migration is ALREADY APPLIED to production. The ledger records it as version
-- 20260809091234 / name `public_default_privileges_revoke_anon` (the apply-time server
-- clock, which drifts from the filename when a migration is applied through the MCP).
-- scripts/check-migrations-applied.ts matches on version OR name, so that file now counts
-- as applied forever. Anything added to it would never run. Hence a new file.
--
-- WHAT 20260809130000 ACHIEVED, measured on production ozucdzovmcqvepbozvqf today:
--   postgres / public / TABLES     -> {postgres, service_role}          CLOSED
--   postgres / public / FUNCTIONS  -> {postgres, service_role}          CLOSED (by 20260719170000)
--
-- WHAT IT LEFT OPEN, measured at the same moment:
--   postgres / public / SEQUENCES  -> anon = SELECT,UPDATE,USAGE
--                                     authenticated = SELECT,UPDATE,USAGE
--
-- A sequence holds no customer data, so this is a smaller hole than the table one — but
-- UPDATE on a sequence lets an anonymous caller reset or burn a table's id generator, and
-- USAGE lets them consume values. It is the same defect (a schema-wide default nobody
-- asked for) and it closes the same way.
--
-- THE DEEPER REASON THIS FILE EXISTS: 20260809130000 has no verification step. Its revokes
-- raise nothing when they match zero grants, so a silent no-op and a real fix produce an
-- identical log. It closed tables and missed sequences, and nothing said so. The $verify$
-- block below re-reads the catalog and raises, so this class of half-fix cannot recur.
-- Same shape as the $verify$ block in 20260806010000_share_links_rls_parity.sql.
--
-- SCOPE / BLAST RADIUS. ALTER DEFAULT PRIVILEGES is a template consulted only at CREATE
-- time. It cannot and does not alter any existing object. Proof from this same database:
-- the FUNCTIONS default has had no anon entry since 2026-07-19, yet functions created
-- before then still carry anon EXECUTE today. Every existing table, sequence and function
-- keeps exactly the grants it has now.
--
-- PUBLIC IS NEVER NAMED AS A REVOKE TARGET. On a default ACL, `revoke ... from public`
-- strips service_role (see the warning in 20260805204502_move_adhoc_snapshots_out_of_public.sql).
-- anon and authenticated are always named explicitly.
--
-- Rollback:
--   alter default privileges for role postgres in schema public
--     grant all on sequences to anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon;

alter default privileges for role postgres in schema public
  revoke all on sequences from authenticated;

-- Best-effort for the other grantor, mirroring 20260809130000's structure. Expected to
-- fail: a pg_default_acl row can only be altered by a member of the role that owns it,
-- and the runner is `postgres`, which is neither a member of supabase_admin nor a
-- superuser. 20260719170000 attempted the same sweep for FUNCTIONS three weeks ago and
-- that entry is still open today — that is the proof, not a prediction. The verify block
-- reports the residual as a warning.
do $mig$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from authenticated';
exception
  when insufficient_privilege then
    raise notice 'supabase_admin sequence defaults left unchanged (no membership in that role); the postgres default was still revoked';
  when undefined_object then
    raise notice 'role supabase_admin not present; nothing to revoke for it';
end
$mig$;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- VERIFY — covers what 20260809130000 did as well as what this file does, so the pair is
-- checked as a whole rather than each half trusting the other.
-- ─────────────────────────────────────────────────────────────────────────────────────
do $verify$
declare
  v_leaks text;
begin
  -- (A) THE SECURITY INVARIANT. No browser-facing grantee may remain in the `postgres`
  --     default ACL for tables, sequences or functions. PUBLIC (grantee 0) counts: anon
  --     and authenticated are members of PUBLIC, so a PUBLIC entry reaches them.
  select string_agg(format('%s -> %s (%s)', obj, grantee, privs), '; ' order by obj, grantee)
    into v_leaks
  from (
    select case d.defaclobjtype when 'r' then 'TABLES'
                                when 'S' then 'SEQUENCES'
                                else 'FUNCTIONS' end as obj,
           coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') as grantee,
           string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclrole = to_regrole('postgres')
      and d.defaclobjtype in ('r', 'S', 'f')
      and (a.grantee = 0
           or a.grantee = to_regrole('anon')
           or a.grantee = to_regrole('authenticated'))
    group by 1, 2
  ) s;

  if v_leaks is not null then
    raise exception
      'default privileges in schema public still grant browser-facing roles: %. Every object '
      'created after this point would be born reachable with the public anon key.', v_leaks;
  end if;

  -- (B) THE AVAILABILITY INVARIANT, deliberately conditional.
  --     The app connects as service_role for essentially everything. If a revoke ever took
  --     service_role with it, every FUTURE table would be invisible to the application —
  --     silently, at the next `create table`.
  --     It must NOT assert an absolute grant count: staging (cifwmndunmlxjhyjugxa) was
  --     measured today with NO default ACL rows at all in `public`, where Postgres's
  --     built-in owner-only default applies and there is nothing to preserve. A hard count
  --     would make this migration unappliable there and on any rebuilt environment.
  --     So: only if an explicit TABLES row exists must service_role still be inside it.
  if exists (
       select 1 from pg_default_acl d
       join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'public' and d.defaclrole = to_regrole('postgres')
         and d.defaclobjtype = 'r'
     )
     and not exists (
       select 1 from pg_default_acl d
       join pg_namespace n on n.oid = d.defaclnamespace
       cross join lateral aclexplode(d.defaclacl) a
       where n.nspname = 'public' and d.defaclrole = to_regrole('postgres')
         and d.defaclobjtype = 'r'
         and a.grantee = to_regrole('service_role')
         and a.privilege_type = 'SELECT'
     )
  then
    raise exception
      'service_role lost its default SELECT on new tables in schema public — every table created '
      'from now on would be unreachable by the application. Restore with: alter default privileges '
      'in schema public grant all on tables to service_role;';
  end if;

  -- (C) The residual this migration provably cannot close, surfaced as a WARNING.
  --     supabase_admin keeps its own default ACL granting anon/authenticated on TABLES,
  --     SEQUENCES and FUNCTIONS. Raising here would make the file permanently unappliable,
  --     so it stays a warning. That row only fires for objects CREATED BY supabase_admin
  --     in public — in practice `create extension ... with schema public`. Install
  --     extensions into `extensions`, where the other three already live.
  --     scripts/check-schema-shape.ts reports this daily so it stays visible rather than
  --     remembered.
  if exists (
    select 1
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclrole = to_regrole('supabase_admin')
      and d.defaclobjtype in ('r', 'S', 'f')
      and (a.grantee = 0 or a.grantee = to_regrole('anon') or a.grantee = to_regrole('authenticated'))
  ) then
    raise warning
      'supabase_admin still grants anon/authenticated by default in schema public. Not fixable '
      'from this connection (altering a pg_default_acl row needs membership in the owning role, '
      'and the runner is %). It only fires for objects created BY supabase_admin in public — in '
      'practice `create extension ... with schema public`. Install extensions into `extensions`.',
      current_user;
  end if;
end
$verify$;
