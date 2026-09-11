-- ---------------------------------------------------------------------------
-- The payroll and deductions decision trails become append-only.
--
-- `automated_payroll_audit` (202 rows) and `deductions_audit` (1,566 rows) are the
-- only record of who decided what on a payroll month. Neither had a single
-- protective trigger, `authenticated` held DELETE, UPDATE and TRUNCATE on both,
-- and every foreign key was ON DELETE CASCADE — so deleting one payroll run or
-- one deduction candidate silently took its whole decision trail with it.
--
-- That stopped being merely an audit question when held settlements shipped.
-- `loadHeldBalances` reconstructs who is still owed a second instalment by
-- reading `automated_payroll_audit` rows whose action is 'published'. Losing
-- those rows does not lose a record of a payment — it loses the payment.
--
-- Three things are needed and a revoke is only one of them:
--   * a REVOKE does not bind the table OWNER, and ON DELETE CASCADE runs as the
--     owner, so `has_table_privilege` reports a table protected while the cascade
--     empties it;
--   * TRUNCATE fires no ROW triggers at all, so it needs its own STATEMENT-level
--     trigger;
--   * `session_replication_role = replica` disables an ordinary trigger, so each
--     one is ENABLE ALWAYS.
--
-- To correct a wrong decision, write a NEW row that supersedes it. Removing a row
-- is a schema change: drop the trigger deliberately, in its own migration, with
-- the owner told first.
-- ---------------------------------------------------------------------------

create or replace function public.phx_refuse_audit_trail_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'The % decision trail is append-only. % is refused.',
    tg_table_name, tg_op
    using hint =
      'These rows are the record behind real payments, and held settlements are '
      'reconstructed from them. Supersede a wrong decision with a NEW row. To '
      'remove one, drop this trigger deliberately in a migration.';
  return null;  -- unreachable; kept so the row-level signature stays honest
end;
$$;

comment on function public.phx_refuse_audit_trail_change() is
  'Refuses UPDATE, DELETE and TRUNCATE on an append-only decision trail. Binds the '
  'table owner, which a REVOKE does not.';

do $$
declare
  target text;
  targets text[] := array['automated_payroll_audit', 'deductions_audit'];
begin
  foreach target in array targets loop
    -- Row-level: UPDATE and DELETE, including a DELETE arriving through a cascade.
    execute format('drop trigger if exists %I on public.%I', target || '_no_update', target);
    execute format('drop trigger if exists %I on public.%I', target || '_no_delete', target);
    execute format('drop trigger if exists %I on public.%I', target || '_no_truncate', target);

    execute format(
      'create trigger %I before update on public.%I for each row '
      'execute function public.phx_refuse_audit_trail_change()',
      target || '_no_update', target);
    execute format(
      'create trigger %I before delete on public.%I for each row '
      'execute function public.phx_refuse_audit_trail_change()',
      target || '_no_delete', target);
    -- TRUNCATE fires no row triggers, so it needs a statement-level one of its own.
    execute format(
      'create trigger %I before truncate on public.%I for each statement '
      'execute function public.phx_refuse_audit_trail_change()',
      target || '_no_truncate', target);

    -- ENABLE ALWAYS, or `session_replication_role = replica` walks straight past them.
    execute format('alter table public.%I enable always trigger %I', target, target || '_no_update');
    execute format('alter table public.%I enable always trigger %I', target, target || '_no_delete');
    execute format('alter table public.%I enable always trigger %I', target, target || '_no_truncate');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Every cascade into an audit trail becomes a RESTRICT.
--
-- A cascade is the one delete path that never asks anybody's permission: it runs
-- as the OWNER, so no revoke sees it, and it leaves nothing behind to show that a
-- month's decisions ever existed. RESTRICT turns "the trail quietly went" into a
-- loud refusal on the parent row. Nothing in the application deletes a payroll
-- run, a deduction candidate or a publication, so this blocks no live path.
-- ---------------------------------------------------------------------------

do $$
declare
  fk record;
begin
  for fk in
    select c.conname, c.conrelid::regclass::text as tbl, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid in (
            'public.automated_payroll_audit'::regclass,
            'public.deductions_audit'::regclass)
      and c.contype = 'f'
      and c.confdeltype = 'c'   -- 'c' = ON DELETE CASCADE
  loop
    execute format('alter table %s drop constraint %I', fk.tbl, fk.conname);
    execute format('alter table %s add constraint %I %s',
                   fk.tbl, fk.conname,
                   replace(fk.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The grants and policies stop claiming a write that can no longer happen.
--
-- Belt to the trigger's braces, and it removes the misreading: a policy named
-- `_admin_delete` sitting on the table reads as a delete path somebody intended.
-- ---------------------------------------------------------------------------

do $$
declare
  pol record;
begin
  for pol in
    select p.polname, p.polrelid::regclass::text as tbl
    from pg_policy p
    where p.polrelid in (
            'public.automated_payroll_audit'::regclass,
            'public.deductions_audit'::regclass)
      and p.polcmd in ('w', 'd')   -- UPDATE, DELETE
  loop
    execute format('drop policy %I on %s', pol.polname, pol.tbl);
  end loop;
end $$;

revoke update, delete, truncate on table public.automated_payroll_audit from authenticated;
revoke update, delete, truncate on table public.deductions_audit       from authenticated;
revoke update, delete, truncate on table public.automated_payroll_audit from service_role;
revoke update, delete, truncate on table public.deductions_audit       from service_role;

comment on table public.automated_payroll_audit is
  'Append-only. Every payroll decision, and the source held settlements are '
  'reconstructed from. UPDATE, DELETE and TRUNCATE are refused by trigger.';
comment on table public.deductions_audit is
  'Append-only. Every deduction decision. UPDATE, DELETE and TRUNCATE are refused '
  'by trigger.';
