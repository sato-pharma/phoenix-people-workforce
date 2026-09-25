---
name: admin-hr-cannot-be-recreated-hr-id-must-be-null
description: "Restoring the admin-HR canary login fails with a foreign-key error unless hr_id is NULL — production has no employees row for it, staging does"
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-22T12:53:49.216Z
---

`public.app_auth_users.hr_id` carries
`FOREIGN KEY (hr_id) REFERENCES employees(hr_id) ON UPDATE CASCADE ON DELETE SET NULL`.

**Production has NO `employees` row for `admin-HR` or `PHX-1`. Staging has TWO** (`ADMIN-HR` and
`PHX-1`, both "Phoenix System Administrator", both active). So the staging `app_auth_users` row can
name `hr_id = 'PHX-1'` and production can never copy it — the insert dies with
`violates foreign key constraint "app_auth_users_hr_id_fkey"`. Verified 2026-08-22.

**The fix is `hr_id = NULL`.** The column is nullable and a FK always permits NULL. Nothing is lost:
`mapAuthUserRow` derives `hrId: row.hr_id?.trim() || row.login_id.trim()`
(`src/lib/auth/credentials.ts:111`), so the session still carries `admin-HR`.

**CORRECTED 2026-08-28 -- "the session still carries `admin-HR`" is WRONG for an active session,
and believing it cost a production bug.** `mapAuthUserRow` does apply that fallback, but
`resolveAccessContext` -- which builds the context every request actually runs on -- does NOT:

```ts
const access = createAccessContext({ hrId: row.hr_id, loginId: row.login_id, role, source: "session" });
```

It passes the column through RAW. So for this one account `access.hrId` is **null on every
request**, while `access.loginId` is `admin-HR`. Measured against production: saving a personal
navigation layout returned **HTTP 500 "Cannot save a navigation layout without an hr_id"**, from an
active Super Admin, on the one screen whose entire purpose is saving. Read looked fine (a null key
degrades to "no layout"), so the feature presented as silently inert rather than as an error --
three sessions of browser debugging went past it.

**The general trap: any NEW feature that keys storage on `access.hrId` is broken for this account
and no other.** Production has exactly **1** account with a null `hr_id` out of 159, and it is an
active Super Admin -- so the failure is invisible in every role sweep, and lands on the owner
personally. Before keying anything on `access.hrId`, ask whether a null is possible and what it
should fall back to. Where the key names nothing but a preferences row, `access.loginId` is the
right fallback (see `layoutOwnerKey`, `src/lib/navigation/personal-layout.ts`). Where it identifies
a PERSON -- payroll, attribution, permissions -- there is no safe fallback and `hr_id` is the only
correct key; a login-id fallback there would attribute work to a row that is not an employee. `findActiveAuthUserRow`
tries `login_id ilike <identifier>` **before** the hr_id branch, and the canary submits `admin-HR`,
so the hr_id branch is never reached. `isLinkedEmployeeTerminal(null)` returns false, so no gate
fires. Note production had **zero** other accounts with a NULL `hr_id` — this one is the exception.

**Do NOT satisfy the FK by creating an `employees` row.** That injects a synthetic person into a live
payroll/headcount platform.

**RESTORED 2026-08-22 15:52 Cairo** — `login_id='admin-HR'`, `hr_id=NULL`, Super Admin, active,
`force_password_reset=false`, `$2b$` 60-char hash. Production went 156 → 157 accounts, `n_tup_ins`
18 → 19, and its `auth.users` row is unbanned. Production now has **2** active Super Admins (`B-10`
and this one).

**Why it went missing:** the 2026-08-19 orphan-auth sweep (documented at `scripts/repo-doctor.mjs:48`)
deleted the row and banned the `auth.users` login. `admin-HR` was afterwards added to
`AUTH_ORPHAN_ALLOWLIST` but never restored. **The delete left no `audit_logs` trace** — the 19 Aug
02:00–06:00 window holds only notification rows — so it was done directly against the database, not
through the app. The ban was lifted 2026-08-22; the missing row is the remaining blocker.

**Two diagnostic lessons that cost hours here:**
- Checking triggers is not checking constraints. `app_auth_users` has **zero triggers**, which I read
  as "nothing can reject a write" — the FK did.
- A script that reads its Supabase URL as `process.env.X || envFile.X` must **print which source won
  and the resolved project ref**, and must re-read the row on a **fresh connection** plus compare
  row counts. A same-client read-back proves the insert was accepted, not that it persisted.

Related: [[windows-env-var-shadows-every-env-local-key]] · [[local-env-already-points-at-production]] ·
[[how-to-attribute-a-production-write]]
