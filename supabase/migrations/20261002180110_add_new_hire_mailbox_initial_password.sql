-- add_new_hire_mailbox_initial_password
--
-- WHAT THIS CHANGES: three nullable columns on public.new_hire_mailbox_tasks — the SEALED initial
-- mailbox password the joiner robot set, plus when it was set and by whom.
--
-- WHY: the robot creates a new hire's Turbify mailbox and sets its password to the company pattern,
-- and the System Administrator has to read that password back to hand it to the new joiner. So it
-- is recoverable by design — sealed with secret-box (`sealSecret`), never a hash — and read through
-- one server route gated to `systemAdministratorRoles`.
--
-- It is stored PER TASK rather than on `employees` for two reasons. The owner can change the company
-- pattern whenever he likes, so a mailbox created earlier keeps the password it was actually given,
-- and reading today's variable against an older mailbox would hand him a password that does not open
-- it. And `employees` is written by the import and employee-save paths, one of which has blanked
-- salary fields before, and is copied wholesale into the organogram and employee-master workbooks —
-- a credential on that row could be wiped by one and exported by the other.
--
-- NOT exposed to any browser role: no grant is added, so only the service-role client reads it, the
-- same way every other path in this app reads this table. RLS is untouched for the same reason.
--
-- ROLLBACK:
--   alter table public.new_hire_mailbox_tasks
--     drop column if exists sealed_initial_password,
--     drop column if exists initial_password_set_at,
--     drop column if exists initial_password_set_by_hr_id;
-- Dropping them destroys the stored passwords, which cannot be recovered from anywhere else — the
-- company pattern in Railway is today's value, not what an older mailbox was given. Adding the
-- columns is itself non-destructive: no existing row or column is touched.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.new_hire_mailbox_tasks
  add column if not exists sealed_initial_password text,
  add column if not exists initial_password_set_at timestamptz,
  add column if not exists initial_password_set_by_hr_id text;

comment on column public.new_hire_mailbox_tasks.sealed_initial_password is
  'Sealed (secret-box) initial mailbox password the joiner robot set. Recoverable by design so the '
  'System Administrator can hand it to the new joiner; read only through the Super-Admin-gated route. '
  'Never a hash, never logged, and never exported.';

comment on column public.new_hire_mailbox_tasks.initial_password_set_at is
  'When the joiner robot set the mailbox password.';

comment on column public.new_hire_mailbox_tasks.initial_password_set_by_hr_id is
  'Actor that set it — system:turbify-joiner-robot for a robot run, an HR id when a person did it.';

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20261002180110 was minted to sort after every migration already on main.
