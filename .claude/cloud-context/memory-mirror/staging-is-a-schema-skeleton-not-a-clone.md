---
name: staging-is-a-schema-skeleton-not-a-clone
description: "✅ RESOLVED 2026-07-31. For three weeks (07-11 → 07-31) staging had ZERO RLS policies, FKs and triggers, so every staging RLS/preview-smoke pass in that window proved nothing. Repaired IN PLACE — not rebuilt — which matters for what it did and did NOT rotate."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-01T01:47:03.072Z
---

Discovered 2026-07-31 by a parallel session while repairing a separate staging outage; documented
in **PR #1512** and `docs/runbooks/staging-recovery-2026-07-31.md`.

## ✅ FIXED 2026-07-31 — verified live, not taken from the write-up

Repaired **in place** (`pg_dump` post-data from production with `--no-acl`, applied to staging),
**not** rebuilt as a new project. Independently confirmed by querying
`cifwmndunmlxjhyjugxa` directly:

| | before | after | production |
| --- | --- | --- | --- |
| RLS policies | **0** | **359** | 359 ✅ |
| Tables with RLS | **0 of 284** | **284 of 284** | 284 ✅ |
| Foreign keys | **0** | **276** | 278 ⚠️ |
| Primary keys | 105 | 282 | 282 ✅ |
| Indexes | 138 | 1096 | 1096 ✅ |
| Triggers | 0 | 33 | 33 ✅ |

And RLS is **enforcing, not merely present** — acting as `authenticated`, `marketing_requests`
returned 0 of 217 rows and `employees` 0 of 164, with full grants restored. Data is protected by
RLS rather than by absent grants, which is production's model.

**The 2 missing FKs are an accepted decision, not a loose end** — both target `auth.users`, and
staging has 12 `auth.users` rows against 144 `app_auth_users` (all orphaned). A *data* gap the
absence of FKs had hidden. Staging sits at 276/278 deliberately.

🔴 **`--no-acl` was essential** on that dump: without it the post-data carries GRANT statements that
would have silently undone the deliberate `anon`/`authenticated` revoke. Remember this if the repair
is ever repeated.

## The historical record — what was wrong for three weeks

| | Staging `cifwmndunmlxjhyjugxa` | Production `ozucdzovmcqvepbozvqf` |
| --- | --- | --- |
| **RLS policies** | **0** | 359 |
| **Tables with RLS enabled** | **0 of 284** | 284 of 285 |
| **Foreign keys** | **0** | 278 |
| **User triggers** | **0** | 33 |
| Primary keys | 105 | 282 |
| Unique constraints | 33 | 98 |
| Indexes | 138 | 1096 |
| Tables | 284 | 285 |
| CHECK constraints | 492 | 492 ✅ |

Only the CHECK constraints and table list survived. This has been true **since the project was
created on 2026-07-11** — it is not recent damage.

🔴 **AGENTS.md says staging was "created 2026-07-11 as a 1:1 clone of production." That statement
is false** and it is the premise the whole staging-as-safety-proxy model rests on. Treat any doc,
prompt, or memory that leans on it as unreliable until staging is rebuilt.

## What this invalidates

Against a database with **zero RLS policies**, an RLS test cannot fail. So every RLS check,
role-alignment runner and `preview-smoke` run against staging since 2026-07-11 has been passing
**vacuously — not reassuring.** Roughly three weeks of green signal that proved nothing. Do not
cite a historical staging pass as evidence that a permission boundary holds.

## Don't "just apply" the missing migration

`20260728190000_sos_block_grouping` shows up in Migration Drift Check as merged-but-not-applied.
It is **BLOCKED, not merely pending**: it was attempted 2026-07-31, failed on its foreign key
(staging has no primary keys for the FK to reference), and rolled back cleanly without being
recorded. Its other objects already exist on staging; only the FK and the bookkeeping are missing.
**Re-running it just reproduces the rollback.** It unblocks only once staging has primary keys —
i.e. after the rebuild. The drift check failing on this is the check working correctly, so do not
"fix" it by re-running the workflow.

## Separate, earlier fault — the grant wipe (resolved)

Staging's `public` schema lost **every grant** on 2026-07-30 (0 of 308 tables reachable by any
role, including `service_role`). Timeline from CI + staging `audit_logs`: healthy 07:33 UTC, last
successful write 08:10, `permission denied for schema public` at 08:13. **No migration in this repo
does that** — every schema-level revoke targets `internal`/`private`/`backup`/`vault`, never
`public`, and production has the identical migration set and stayed healthy. Recorded as hypothesis,
not fact: an out-of-band `revoke ... on schema` fired with the wrong target or wrong `project_id`.
Grants were restored 2026-07-31 ~18:10 from production's live catalog; `anon` + `authenticated`
were then deliberately **re-revoked** ~18:45 because of the skeleton problem above.
⚠️ This is exactly the two-sessions-on-one-database hazard in [[parallel-session-swarm-hazard]] —
avoid a second session touching staging while a repair is in flight.

## Production is fine

Production is **unaffected and verified healthy** — checked live, and separately verified drift-clean
by hand on 2026-07-31. No production action was needed for any of this.

## Was "waiting on the rebuild" — resolved 2026-07-31, with one prediction wrong

🔴 **The repair was IN PLACE, so `app_auth_users` was never replaced.** I had deferred the
credential rotation on the assumption a rebuild would replace that table and rotate it for free.
**That never happened and the assumption was wrong** — do not wait for it.

1. ❌ **`PHOENIX_RLS_ADMIN_PASSWORD` rotation — NOT OUTSTANDING. Both premises were wrong.**
   Measured 2026-08-01: the value authenticates **nothing** on staging (0 of 144 `app_auth_users`
   hashes, 0 of 12 `auth.users`), because the bootstrap script that would have set it never ran and
   refuses to overwrite an existing user. See [[protected-files-phrase-was-a-live-credential]].
   The staging **database** password is also fine — it authenticated on the first try on 2026-08-01
   (`aws-0-eu-central-1.pooler.supabase.com:5432`), so the "must reset it in Supabase → Settings →
   Database first" blocker recorded here was either transient or already resolved. **Do not send
   the owner to the dashboard for either of these.**
   ⚠️ Two of my own diagnoses were wrong in sequence here: first I blamed a wrong password in the
   URL, then I blamed the DB password having independently died. Neither survived measurement.

2. ✅ **`sos_block_grouping` — APPLIED AND VERIFIED** on BOTH projects 2026-07-31. Checked
   effectiveness, not just bookkeeping: the FK to `source_of_sales_bricks` that originally failed
   now exists, along with the `master_brick_id` column, the `phx_assert_master_brick_in_block`
   guard, and both views. Recorded on staging as `20260731192522` (MCP clock, not the file's
   `20260728190000` — [[mcp-apply-migration-version-drift]]). Drift check green on both legs.

3. ✅ **PR #1400 (supabase-js 2.110.8) — MERGED and VERIFIED 2026-08-01. Nothing outstanding.**
   The `TS2345` at `src/lib/crm/sync.ts:84` was fixed and shipped. The role-scoped check this was
   held for is done, and the premise behind the hold was largely wrong: visibility is
   application-scoped, not RLS-scoped ([[app-visibility-is-application-scoped-not-rls]]), so a
   session regression could never have changed what a Medical Rep sees on the CRM/portal surfaces.
   Measured against an isolated install of exactly 2.110.8: `setSession` still attaches the user
   JWT to PostgREST requests, so the payroll/expenses fail-open path is not triggered.
   The extra end-to-end page sweep was **skipped by owner decision 2026-08-01** — additional
   assurance on an already-decisive result, and the attempt burned an hour failing to prove which
   environment a dev server was actually talking to ([[test-seams-for-supabase-backed-code]]).

### Superseded list (kept so the reasoning is auditable)
2. **PR #1400 `@supabase/supabase-js` 2.105.1 → 2.110.8 — HELD by owner decision 2026-07-31.**
   Dependabot rebased it clean onto main, but **`typecheck` FAILS** on the new version:
   ```
   src/lib/crm/sync.ts(84,61): error TS2345
     Argument of type 'T[]' is not assignable to parameter of type
     'RejectExcessProperties<any, T> | RejectExcessProperties<any, T>[]'
   ```
   supabase-js tightened its insert/upsert generics; the generic helper at `crm/sync.ts:84` passes a
   bare `T[]` where the new `RejectExcessProperties<any, T>` is expected. **This needs a real code
   fix, not a rebase.** Beyond that, the library backs BOTH clients in `src/lib/supabase/server.ts`
   (`getSupabaseAdmin` service-role and `getSupabaseUserClient` RLS-respecting) across 12 importing
   files — an auth/session regression would show up as *wrong data visibility*, which typecheck
   cannot catch and which **staging cannot catch either while it has 0 RLS policies.** Merge only
   after the rebuild, with a real role-scoped check (Medical Rep + District Manager see only their
   own scope).

## Also still open

- **`PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` is not set as a GitHub secret**, so Migration Drift
  Check logs `HAS_PRODUCTION_SUPABASE_KEY: false` and its **production leg has never run once**.
  Only staging is watched — and staging is the broken one. Owner-only to add.
  See [[migration-drift-check-was-staging-only]], which called this shape of failure in advance.
- **Decision taken 2026-07-31: rebuild staging from production.** That restores genuine parity and
  unblocks `sos_block_grouping` as a side effect.

Related: [[agents-md-stale-staging-ref]], [[staging-cloud-run-url-2026-07-12]],
[[supabase-dual-project-schema]], [[prod-mcp-token-owns-staging-supabase]].
