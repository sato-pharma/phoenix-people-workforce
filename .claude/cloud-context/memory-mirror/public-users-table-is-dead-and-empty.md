---
name: public-users-table-is-dead-and-empty
description: "public.users still exists in production but holds ZERO rows — querying it to check whether someone has a Phoenix login returns \"no account\" for every employee in the company."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-08-19T10:56:35.129Z
---

`public.users` is a dead legacy table in the production Supabase project (`ozucdzovmcqvepbozvqf`).
It still has its full column list (`hr_id`, `employee_hr_id`, `email`, `username`, `password_hash`,
`is_active`, `last_login_at`, …) so a query against it succeeds — and returns **nothing**, because
it contains **0 rows**.

Live account truth, measured 2026-08-19:

| Table | Rows |
| --- | --- |
| `public.users` | **0** |
| `auth.users` | 155 |
| `public.user_access_profiles` | 154 |

To check whether someone can log in and act, join `user_access_profiles` (by `hr_id`) to
`auth.users` (by `auth_user_id`) and read `phoenix_role`, `is_active`, `login_id`, and
`auth.users.last_sign_in_at`. `phoenix_role` is the value `access.role` resolves to in app code —
e.g. B-74 is `District Manager`, A-12 is `National Sales Manager`.

**Why:** this silently inverts an answer instead of erroring. Checking whether NSM Ali Mohamed Ali
Elsayed (A-12) could approve a vacation step, `select … from users where hr_id='A-12'` returned
`[]` — which reads as "he has no Phoenix account". The control question ("do the OTHER two NSMs
have logins?") returned 0 for all three, which is what exposed the table as dead rather than the
people as unprovisioned. Ali had in fact signed in the previous afternoon.

**How to apply:** never conclude "this person has no account" from `public.users`. Query
`user_access_profiles` + `auth.users`. And when a permissions/account query returns an unexpected
empty or zero, run the same question against a known-good control row before reporting it — a
whole-table zero is a broken query far more often than a real finding. Related:
[[access-profile-sync-gap-and-ai0007-fix-2026-08-15]], [[changing-a-user-role-needs-four-writes]],
[[account-creation-defaults-role-to-employee]], [[n-live-tup-is-stale-use-real-count]].
