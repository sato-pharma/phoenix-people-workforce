-- scrub_password_hash_from_audit_old_values
--
-- WHAT THIS CHANGES: in public.audit_logs, an old_values whose password_hash holds anything but the
--   placeholder has that ONE value replaced by the text "[managed]" — the placeholder the app writes
--   from now on (withoutPasswordHash in src/lib/admin/access-control.ts) and the value 2 rows already
--   hold. Nothing else in a row changes: not its other keys, not new_values, not its timestamps, and no
--   row is added or removed. Measured on production 2026-11-19, about 02:35 Cairo: 7 rows carry the key,
--   5 of them a bcrypt hash (4 accounts), the other 2 already "[managed]"; new_values holds no hash.
--   audit_logs has no trigger, so no immutability guard is bypassed.
--
-- WHY: auditUserChange copied the account row, password_hash included, into old_values on an account
--   edit, so a bcrypt hash of a sign-in password sat in the audit log, where the Super Admin's ChatGPT
--   connector, its exports and every audit screen could read it. The code fix stops new copies; this
--   removes the ones already written.
--
-- ROLLBACK: none, by design. The removed values are copies of account password hashes as they stood at
--   each edit; each account's own hash in app_auth_users is untouched and nothing reads a hash from the
--   audit log. No pre-image is kept ON PURPOSE: a copy of the hashes is the very thing this removes.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

update public.audit_logs
set old_values = jsonb_set(old_values, '{password_hash}', to_jsonb('[managed]'::text))
where jsonb_typeof(old_values) = 'object'
  and old_values ? 'password_hash'
  and coalesce(old_values ->> 'password_hash', '') not in ('', '[managed]');

-- Proof inside the transaction: if any password_hash value other than the placeholder is left, nothing
-- above is kept.
do $$
begin
  if exists (
    select 1
    from public.audit_logs
    where jsonb_typeof(old_values) = 'object'
      and old_values ? 'password_hash'
      and coalesce(old_values ->> 'password_hash', '') not in ('', '[managed]')
  ) then
    raise exception 'audit_logs.old_values still holds a password_hash value after the scrub';
  end if;
end;
$$;

commit;
