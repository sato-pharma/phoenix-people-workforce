# Inspection personas — the explorer's staging-only logins

The visual explorer (`scripts/phoenix-inspect/`) signs in to **staging** as these seven logins. They
were created on 14 November 2026 on the owner's choice "Staging logins". **None exists in production,
and none may ever be created there**: `explore.mjs` refuses the production host as a target, and the
fence refuses it by any method.

This file names roles and purposes only. It never names the staff member a login mirrors (the repository
is public); read that from staging itself when you need it (query below).

## The logins

| Login | Role | Kind | Board it opens | Why it exists |
| --- | --- | --- | --- | --- |
| `INSPECT-CEO` | CEO | admin login on the staging CEO's record | `/admin/kpis` | The whole-company admin view, walked in full: every tab, every report, all three widths |
| `INSPECT-SFE` | SFE Manager | admin login on the staging SFE Manager's record | `/admin/kpis` | The admin board as its daily owner sees it (landing state) |
| `INSPECT-HRR` | HR Resourcing | admin login on the staging Talent Acquisition record (no other login there) | `/hr/admin/kpis` | The HR portal's copy of the board (landing state) |
| `TEST-INSPECT-NSM` | National Sales Manager | test account mirroring a staging National Sales Manager | `/employee-portals/kpis` | The portal board for a whole line (landing state) |
| `TEST-INSPECT-DM` | District Manager | test account mirroring the staging District Manager with the most August visits in his team | `/employee-portals/kpis` | The portal board walked in full: every report, every width |
| `TEST-INSPECT-REP` | Medical Rep | test account mirroring a staging rep with a full August | `/employee-portals/kpis` | The rep's own board (landing state) |
| `TEST-INSPECT-EMP` | Employee | test account mirroring a plain staging employee | none — must be refused | The denied path: no KPIs entry in the rail, and the board's address answers "not available" |

- **Test accounts** (`TEST-…`) are rows with `is_test_persona = true`, `hr_id` empty and
  `test_persona_of_hr_id` set, built exactly as `createTestAccount` builds one
  (`src/lib/admin/test-accounts.ts`): the mirror's role, line and scopes copied, and the server-side
  dry-run fence that turns a test account's **write requests** (POST, PUT, PATCH, DELETE) into no-ops.
  **It does not cover GET**: `READ_METHODS` in `src/lib/auth/test-dry-run-rules.ts` skips GET, HEAD and
  OPTIONS, so a page that writes while it renders writes for real, for a test account too. Against
  those, the explorer's own path list (`NEVER_TOUCH_PATHS` in `lib/fence.mjs`) is the only guard. The
  KPIs board has no such page.
- **Admin logins** (`INSPECT-…`) carry the role on the person's own `hr_id`, because a test account may
  only mirror a portal role. They have no dry-run fence of their own; the explorer's browser fence
  (GET only) is what keeps them read-only.
- **No Super Admin login.** Super Admin sign-in now asks for an authenticator code (the second sign-in
  step, `src/lib/auth/second-step.ts`), and the explorer does not bypass account security. The CEO view
  has the same whole-company reach on this board.
- Every row has `force_password_reset = false` (otherwise sign-in is sent to `/password-setup`) and
  `session_version = 1`.

## Where the passwords are

**Since 14 Nov 2026 (about 20:15 Cairo) the passwords live on the owner's MAIN laptop**, in
`%USERPROFILE%\.phoenix-inspect\staging-personas.json`, outside every repository folder. They were first
made on the spare laptop; when the spare dropped off the network mid-run (its address answered nothing,
not even ARP) the browser runs moved to the main laptop, `make-persona-secrets.mjs --rotate` made seven
new passwords there, and only their bcrypt hashes (cost 12, the app's own) were written to staging's
`app_auth_users.password_hash` (7 rows, all active, all `$2…$12$`). **The spare's copy is now stale and
signs in nowhere** — a run started on the spare must first copy this file there, or rotate again.
No password is in Git, a chat, a log or a screenshot.

`node scripts/phoenix-inspect/make-persona-secrets.mjs` prints fresh hashes of the same passwords;
`--rotate` makes new ones (then write the new hashes to staging, or the explorer is locked out).

## See who each login mirrors (staging)

```sql
-- project cifwmndunmlxjhyjugxa (STAGING) only
select login_id, role, coalesce(hr_id, test_persona_of_hr_id) as works_as, is_active
from app_auth_users
where login_id like 'INSPECT-%' or login_id like 'TEST-INSPECT-%'
order by login_id;
```

## Switch them off

Deactivate (keeps the rows, stops every sign-in at once):

```sql
-- project cifwmndunmlxjhyjugxa (STAGING) only
update app_auth_users set is_active = false, session_version = session_version + 1, updated_at = now()
where login_id like 'INSPECT-%' or login_id like 'TEST-INSPECT-%';
```

`session_version + 1` ends any session already open. To bring them back, set `is_active = true` again.
Removing the rows altogether is a delete on a people table and waits for the owner's word.
