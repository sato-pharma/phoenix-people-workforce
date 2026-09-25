---
name: auth-metadata-role-key-is-phoenix-role-not-role
description: "auth.users metadata stores the role under 'phoenix_role', not 'role' — and a migration that writes the wrong key ALSO verifies itself green against that same wrong key"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 10c9e0cd-506e-4881-977d-63fca5e0190c
  modified: 2026-08-28T06:07:07.444Z
---

In `auth.users`, both `raw_app_meta_data` and `raw_user_meta_data` store the Phoenix role under
**`phoenix_role`**, never `role`. Verified live on production (`ozucdzovmcqvepbozvqf`) 2026-08-28 —
a real document reads:

```
{"line": "Office", "hr_id": "A-16", "login_id": "A-16", "is_active": true,
 "access_scope": "SELF", "phoenix_role": "Talent Acquisition", "coarse_access_role": "employee"}
```

**The failure mode is self-concealing, which is why this is worth a file.** A migration written as
`jsonb_set(raw_app_meta_data, '{role}', ...) where raw_app_meta_data ->> 'role' = '<old>'` does
nothing at all: no row matches, the real `phoenix_role` keeps the old value, and no error is
raised. Then the verification block — asking `->> 'role'` because that is what the write used —
counts **0** and reports a clean pass. **A check that reads the same wrong field as the write it is
checking cannot fail.** Caught in `20260828140000_hr_role_keys_replace_talent_acquisition.sql`
before it was applied, only because the pre-write inventory was re-run against live production and
returned 0 where an earlier note had said 1.

**So verify jsonb writes against the whole document, not a key name:**
`where raw_app_meta_data::text like '%<old value>%'`. A substring sweep cannot be fooled by looking
in the wrong place, and it costs nothing on a table this size.

Related: `coarse_access_role` is a separate, lower-resolution key (`employee`, `hr`, …) and is not
the same field. `is_active` also appears in the metadata but is **not** what enforces deactivation —
that is `ban_duration` on the auth user plus `app_auth_users.is_active`, see
[[deactivated-accounts-are-mostly-not-banned-at-the-auth-layer]].
