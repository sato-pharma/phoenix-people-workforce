# Staging recovery — 2026-07-31

Two separate faults, found the same day. The second is much worse than the first
and supersedes most of the original plan.

Production (`ozucdzovmcqvepbozvqf`) is **unaffected by both** and needs nothing
from this runbook. Verified repeatedly throughout.

---

## Fault 1 — the grant wipe (2026-07-30) — RESOLVED, then deliberately reversed

Every grant in staging's `public` schema was removed on 2026-07-30, leaving the
database unreachable by every application role.

| Time (UTC) | Event |
| --- | --- |
| 2026-07-30 07:33:44 | Migration Drift Check succeeds — staging healthy |
| 2026-07-30 08:10:04 | Last successful write to staging `public.audit_logs` |
| 2026-07-30 08:13:34 | Drift Check fails: `permission denied for schema public` |
| 2026-07-31 ~18:10 | Grants restored from production's matrix — verified `308 / 149 / 96` |
| 2026-07-31 ~18:45 | `anon` + `authenticated` **re-revoked** — see Fault 2 |

No migration in this repo performs that revoke; production has the identical
migration set and stayed healthy. It was an out-of-band change against staging.

`supabase/scripts/staging_public_grants_restore_20260731.sql` remains in the repo as the
record of what production's matrix looked like, and it worked exactly as
designed. **Do not re-run it against the current staging project** — see below.

---

## Fault 2 — staging is a schema skeleton (since 2026-07-11) — OPEN

While applying the missing migrations, `sos_block_grouping` failed:

```
ERROR: 42830: there is no unique constraint matching given keys
       for referenced table "source_of_sales_bricks"
```

Staging has no primary key on that table, although the repo's own baseline
defines one at `20260711135352_phoenix_production_schema_baseline.sql:25328`.
That turned out not to be isolated:

| | Staging | Production |
| --- | --- | --- |
| Tables | 284 | 285 |
| CHECK constraints | 492 | 492 ✅ |
| Primary keys | **105** | 282 |
| Unique constraints | **33** | 98 |
| **Foreign keys** | **0** | 278 |
| Indexes | **138** | 1096 |
| **User triggers** | **0** | 33 |
| **RLS policies** | **0** | 359 |
| **Tables with RLS enabled** | **0 of 284** | 284 of 285 |

CHECK constraints match *exactly* while everything else is missing. CHECKs are
inline in `CREATE TABLE`; primary keys, unique constraints, foreign keys,
indexes, triggers and policies all arrive later, in a dump's **post-data**
section. The signature is a restore where only the pre-data section ran.

This dates to the **2026-07-11 rebuild**, not the grant wipe. AGENTS.md
describes that project as "a 1:1 clone of production". It has never been one.

### What this invalidates

Every RLS check, role-alignment run and permission test executed against staging
since 2026-07-11 has been vacuous — there were no policies to enforce and RLS
was switched off on every table. Referential-integrity behaviour (cascades,
restricts, orphan prevention) has never been exercised either, because staging
has no foreign keys at all. Query plans are also unrepresentative: 138 indexes
against production's 1096.

Treat every staging "pass" since 2026-07-11 as unproven, not as evidence.

### Why `anon` and `authenticated` were re-revoked

Production's table grants are safe *because* 359 RLS policies bound them.
Staging has none, so the same grants are unbounded. The staging anon key is
hardcoded in `ci.yml` on the explicit justification that it is "RLS-protected" —
which is true on production and false here.

So on 2026-07-31, immediately after the restore, `anon` and `authenticated` were
revoked again (schema `USAGE`, all table/sequence privileges, all function
`EXECUTE`). `service_role` was deliberately kept: it is a secret, never reaches a
browser, and CI, the drift check and the app's server paths all need it.

Verified after: `service_role` 308 tables + drift RPC intact; `authenticated` 0;
`anon` 0 tables and 0 functions. The drift check ran green afterwards
(`127 local migrations, 567 recorded`), proving the `service_role` path survived.

**Net effect: staging is closed to browser-facing roles and usable only by
server-side/service_role code, until Fault 2 is fixed.**

---

## Migration status

| Version | Migration | Status |
| --- | --- | --- |
| `20260728103222` | `backfill_marketing_pharmacy_code_references` | ✅ Applied 2026-07-31 (recorded `20260731183551`). 0 rows changed — staging already had 271 `matched` / 16 `not_found`, zero `pending`. |
| `20260728190000` | `sos_block_grouping` | ✅ Applied 2026-07-31, **on the second attempt**. The first attempt failed on its foreign key and rolled back cleanly without being recorded, because staging had no primary key on `source_of_sales_bricks` — that failure is what exposed Fault 2. Once the post-data restore supplied the missing primary keys, it applied without error. |

Both are therefore recorded, which is why the Migration Drift Check passes
(`568 recorded`). If you are reading this mid-incident and the second row still
says blocked, the post-data restore below had not run yet.

A third file, `20260728000000_refresh_visits_effective_view`, was briefly
suspected but is one of the 18 `ACKNOWLEDGED_EXCEPTIONS` in
`check-migrations-applied.ts` — already applied 2026-07-27 under the drifted name
`reconcile_visits_effective_view_vstar`. Run the drift check rather than
reimplementing its matching: the exceptions list and the 48h commit-time grace
window are part of its logic.

---

## The fix: repaired IN PLACE, 2026-07-31 — ✅ DONE

No new project. The existing staging project was repaired by replaying
production's post-data section into it.

### What was run

```bash
# 1. Extract post-data from production. --no-acl is ESSENTIAL: without it the
#    dump carries GRANT statements that would silently undo the anon/authenticated
#    revoke described above. Verified afterwards: 0 GRANT/REVOKE in the output.
pg_dump "$PROD_URL" --schema=public --section=post-data \
        --no-owner --no-acl --no-publications --no-subscriptions -f prod_postdata.sql

# 2. Apply to staging, not stopping on error -- objects staging already had are
#    expected to fail as "already exists".
psql "$STAGING_POOLER_URL" -v ON_ERROR_STOP=0 -f prod_postdata.sql
```

**Connection gotcha that will bite the next person:** the
`PHOENIX_STAGING_DATABASE_URL` in `.env.staging.rls.local` points at
`db.cifwmndunmlxjhyjugxa.supabase.co`, which is now **IPv6-only** — `nslookup`
resolves it but `getent`/`psql` cannot, giving
`could not translate host name ... Name or service not known`. Use the pooler
instead, and note staging is on the **`aws-0`** cluster while production is on
`aws-1`:

```
postgres.cifwmndunmlxjhyjugxa@aws-0-eu-central-1.pooler.supabase.com:5432
```

### Result — 143 errors, 141 of them expected

| Error | Count | Verdict |
| --- | --- | --- |
| `multiple primary keys ... not allowed` | 105 | benign — matches the 105 PKs staging already had |
| `relation ... already exists` | 33 | benign — matches the 33 uniques it already had |
| `constraint ... already exists` | 3 | benign |
| `violates foreign key constraint` | **2** | **genuine — see below** |

`ENABLE ROW LEVEL SECURITY` is a **pre-data** property, so it is NOT in a
post-data dump. Restoring policies without it leaves all 359 inert. It was
applied separately: RLS enabled on all 284 tables, plus `FORCE` on the same 26
production forces.

Safe because `service_role` has `rolbypassrls = true` on both projects — verified
before enabling, so CI, the drift check and every server-side path were unaffected.

### Verified end state

| | Staging after | Production | |
| --- | --- | --- | --- |
| CHECK constraints | 492 | 492 | ✅ |
| Primary keys | 282 | 282 | ✅ |
| Unique constraints | 98 | 98 | ✅ |
| Foreign keys | **276** | 278 | ⚠️ 2 short |
| Indexes | 1096 | 1096 | ✅ |
| RLS policies | 359 | 359 | ✅ |
| Tables with RLS enabled | 284 | 284 | ✅ |
| Tables with FORCE RLS | 26 | 26 | ✅ |
| User triggers | 33 | 33 | ✅ |
| `service_role` readable tables | 308 | 309 | ✅ (staging has 1 fewer relation) |
| `anon` / `authenticated` readable | 0 / 0 | — | ✅ still revoked, deliberately |

Both previously-missing migrations are now applied, and the **Migration Drift
Check passed** — `127 local migrations, 568 recorded on cifwmndunmlxjhyjugxa —
OK, every migration outside the grace window is accounted for`. First green run
since 2026-07-30.

### The 2 foreign keys that could not be created

```
app_auth_users_auth_user_id_fkey       -> auth.users(id)
user_access_profiles_auth_user_id_fkey -> auth.users(id)
```

Not a schema problem — a **data** problem that having no foreign keys had hidden:

| | staging |
| --- | --- |
| `auth.users` rows | **12** |
| `public.app_auth_users` rows | 144 — **all 144 orphaned** |
| `public.user_access_profiles` rows | 143 — **all 143 orphaned** |

Staging's `public` data was cloned but its GoTrue `auth.users` was never populated
to match, so essentially every application account points at an auth identity that
does not exist there.

**This does NOT break staging logins.** An earlier revision of this runbook claimed
it did; that was wrong and is corrected here, because acting on it would have meant
copying production password hashes into a lower environment for no gain.

Auth in this app is application-managed: HR_ID + bcrypt against `app_auth_users`,
plus an app-signed session cookie. The GoTrue bridge is explicitly **best-effort** —
`shouldBlockLoginWhenSupabaseBridgeUnavailable()` in `src/lib/auth/app-sessions.ts`
returns `PHOENIX_STRICT_SUPABASE_BRIDGE === 'true'`, which is opt-in and off, and its
own comment records that the bridge "currently fails" on Cloud Run and that enforcing
it locked out Super Admin/CEO/Finance/SFE/NSM (incident 2026-07-11). Login falls back
to a fully-functional Phoenix-only session, and the login route self-repairs a missing
`authUserId` by calling `provisionSupabaseAuthIdentity`. A failing bridge is the
documented normal state on production too.

### Decision (2026-08-01): leave the 2 foreign keys absent on staging

Fixing this buys the 2 FKs and a working bridge on staging — **not** logins. Weighed
against that:

- Nulling the dangling pointers does not work: `user_access_profiles.auth_user_id`
  is `NOT NULL` (only `app_auth_users.auth_user_id` is nullable), so that FK stays
  uncreatable regardless.
- Copying production's `auth.users` would move password hashes and employee PII into
  a lower environment to satisfy a constraint the application does not depend on.
  Rejected outright.
- Provisioning 144 staging-only GoTrue identities via the supported admin API and
  repointing both tables would reach 278/278, but writes new auth data for 144
  accounts to solve a problem nothing is currently suffering from.

So staging sits at **276 of 278** foreign keys, by decision rather than by accident.
For reference production is fully linked: 147 `auth.users`, 144 `app_auth_users`,
0 orphaned, 0 null.

Revisit only if staging is ever needed to exercise the Supabase bridge itself —
GoTrue sign-in, Storage, or anything relying on `auth.uid()`. The schema-shape
monitor does not assert exact foreign-key counts (it uses floors), so this gap does
not make it red.

---

## Still open after all of this

1. ~~The drift check's production leg has never run~~ — **CLOSED 2026-07-31.**
   `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` was added and the production leg now runs
   on every scheduled pass. Both legs report clean.
2. ~~Nothing asserts schema shape or grants~~ — **CLOSED 2026-08-01** by the
   schema-shape monitor (PR #1518): `phx_ci_schema_shape()` plus
   `scripts/check-schema-shape.ts`, wired into this same scheduled workflow for both
   projects. It asserts invariants rather than a golden snapshot, so it does not rot
   and get muted. It would have caught Fault 2 on 2026-07-11.

   It earned its keep on the first production run, finding a live exposure nobody
   was looking for: `email_backfill_backup_20260730` — `login_id`, `hr_id`,
   `old_email`, `new_email` for 107 accounts — readable by the public anon key with
   RLS never enabled. Because this app authenticates with HR_ID + password, that was
   the complete username list for the login system. Closed by
   `20260801090000_secure_email_backfill_backup_rls.sql`; rows visible to `anon` went
   107 → 0 with all 107 rows retained. **Drop that table once the email backfill has
   settled**, along with its `NO_PRIMARY_KEY_ALLOWED` entry.
3. **Staging's `auth.users` gap is accepted, not outstanding** — see the decision
   recorded above. Staging sits at 276 of 278 foreign keys deliberately. It does not
   affect logins and does not make the monitor red.

4. ~~`anon` and `authenticated` still revoked~~ — **RESTORED 2026-07-31**, after
   RLS was confirmed real. Final matrix: `anon` 96 relations, `authenticated` 149,
   `service_role` 308, schema `USAGE` for all three. Matches production's matrix
   minus the one relation staging does not have.

   Restored only after checking the policies were genuinely enforcing, not merely
   present. Parity confirmed first — staging and production BOTH have 61 tables
   with RLS on and no policies (fail-closed, deny-all) and BOTH have **0**
   permissive `anon`/`public` `USING (true)` policies.

   Then proved empirically by acting as the roles themselves:

   | Table | Actual rows | Seen by `anon` | Seen by `authenticated` |
   | --- | --- | --- | --- |
   | `weekly_sales_rows` | 29,714 | **0** | — |
   | `marketing_requests` | 217 | **0** | **0** |
   | `probation_cases` | 11 | **0** | — |
   | `employees` | 164 | no grant | **0** |
   | `salary_records` | 691 | no grant | **0** |

   Full table grants, zero rows returned. The data is protected by RLS, not by
   the absence of grants — which is exactly production's model, and the thing
   that was untrue here between 2026-07-11 and 2026-07-31.

   (Zero for `authenticated` is correct and expected: the policies call the
   `current_access_*` helpers, which return null without a JWT session, so an
   unauthenticated connection is denied everything. A real signed-in session
   sees its scoped rows.)

5. **`.env.staging.rls.local` is unusable for direct DB access — two faults.**
   Its host `db.cifwmndunmlxjhyjugxa.supabase.co` is IPv6-only, so `psql` cannot
   resolve it; use the `aws-0` pooler form documented above. And as of
   2026-07-31 the password in that file **no longer authenticates** against the
   pooler either (`FATAL: password authentication failed`), on both 5432 and
   6543, having worked earlier the same day — while the production equivalent
   kept working throughout. Rotate/refresh the staging DB password and update
   the file. The Supabase MCP path is unaffected and was used instead.
