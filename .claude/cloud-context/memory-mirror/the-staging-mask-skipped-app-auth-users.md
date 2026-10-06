---
name: the-staging-mask-skipped-app-auth-users
description: "staging's mask rewrites employees.full_name but NOT app_auth_users.name/email, so the same person reads masked on the portal and REAL on every admin user screen — 159 of 163 logins carried the real legal name on 2026-10-06"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T03:37:42.148Z
---

The staging mask (run 5-6 Oct 2026, before the *Inside Phoenix* LinkedIn filming) covered
`employees` and missed **`app_auth_users`**, which is what the admin user-management screens read.

Measured on staging `cifwmndunmlxjhyjugxa`, 2026-10-06, BEFORE the fix:

- **163** login rows; **159** carried the real employee's full legal name; **117** carried a
  real-looking email address.
- `A-1` rendered **Nour Hassan** from `employees.full_name` and the real person's four-part legal
  name from `app_auth_users.name` — one account, two tables, one of them unmasked.

Fixed by copying `employees.full_name` over `app_auth_users.name` and rebuilding `email` from the
masked name (160 rows; verified 0 unmasked names and 0 odd emails after). Pre-image in
`zz_mask_preimage_app_auth_users_20261006`. The 3 rows with no employee record were already safe
(2 repro rows, the `admin-HR` service account — see
[[admin-hr-null-super-admin-is-the-health-check-service-account]]).

**Why:** a mask verified on the table one screen reads proves nothing about the table the next
screen reads. The portal looked perfectly masked the whole time; the exposure lived one join away,
on precisely the screen the admin video was going to film.

**How to apply:** before filming, screenshotting or sharing ANY staging screen, check the tables
*that screen* queries, not the ones the last check covered. `app_auth_users.name` and `.email` are
the two columns the mask script still does not touch — re-check them after any staging refresh from
production, because a refresh restores the real values. Related:
[[the-mask-script-keeps-the-owners-own-name]] is deliberate and is not this bug.

Also measured the same day: all six filming accounts already hold a valid `$2b$` hash in **both**
stores (`app_auth_users.password_hash` and `auth.users.encrypted_password`) — they are not
passwordless, the password is simply unknown, so the job is a RESET not a creation. `AI-0011`
carries `force_password_reset = true`, which would put a change-password wall in the first frame of
video 2.
