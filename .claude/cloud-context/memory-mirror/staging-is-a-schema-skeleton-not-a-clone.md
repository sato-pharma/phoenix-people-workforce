---
name: staging-is-a-schema-skeleton-not-a-clone
description: "HISTORICAL, RESOLVED — for three weeks (2026-07-11 → 07-31) the staging project (cifwmndunmlxjhyjugxa) had ZERO RLS policies, FKs and triggers behind a normal-looking schema, so every staging RLS / role-alignment / preview-smoke pass in that window passed VACUOUSLY and proved nothing. Repaired in place 2026-07-31, then re-cloned later — the CURRENT staging is a full physical clone of production (see the newer memory). Kept for two durable lessons: pg_dump post-data to staging needs --no-acl or it silently undoes the anon/authenticated revoke, and a green staging pass is worthless unless staging actually enforces RLS."
metadata:
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-09-26T01:59:39.620Z
---

## This is a historical, resolved incident — read the current state elsewhere

For **CURRENT** staging state, read [[staging-is-now-mock-data-not-a-production-mirror]]: staging
(`cifwmndunmlxjhyjugxa`) is now a **full physical clone of production** with real data. Everything below
is the record of a **resolved** 2026-07 incident, kept only for the durable lessons — do not act on its
point-in-time state claims (missing FKs, orphan `app_auth_users`, blocked migrations, held PRs: all long
since resolved or superseded).

**What was wrong:** from the project's creation on 2026-07-11 until 2026-07-31, staging carried a normal
table and CHECK-constraint set but **0 RLS policies, 0 tables with RLS enabled, 0 foreign keys and 0
triggers** — a schema skeleton, not the "1:1 clone of production" the docs claimed. It was repaired **in
place** (production `pg_dump` post-data applied to staging), not rebuilt.

## The two durable lessons

- 🔴 **`pg_dump ... --no-acl` is ESSENTIAL when applying production post-data to staging.** Without it the
  post-data carries GRANT statements that **silently undo the deliberate `anon` / `authenticated` revoke** —
  re-opening the very hole the revoke closed. Remember this if a staging schema repair is ever repeated.
- 🔴 **A green staging pass is worthless unless staging actually ENFORCES RLS.** Against a database with
  zero RLS policies, an RLS test *cannot fail* — so ~three weeks of RLS checks, role-alignment runners and
  `preview-smoke` runs passed **vacuously, not reassuringly.** Never cite a historical staging pass as
  evidence that a permission boundary holds without confirming staging had real policies at that time.
  Corollary — **RLS is "enforcing" only when data is protected BY RLS, not by absent grants**: on a correct
  project, acting as `authenticated` returns 0 restricted rows *with full grants in place* (production's
  model); 0 rows because grants are missing is a different, broken state that looks the same from the
  outside. [[app-visibility-is-application-scoped-not-rls]]

## Two facts that outlived the incident

- **The staging repair was IN PLACE, so `app_auth_users` was never replaced or rotated** — do not defer a
  staging credential decision on the assumption a rebuild will rotate it "for free"; that assumption was
  wrong once already.
- **Both Supabase projects share one MCP token** ([[prod-mcp-token-owns-staging-supabase]]), and an
  out-of-band `revoke ... on schema public` aimed at the wrong `project_id` is the leading hypothesis for a
  same-period grant wipe — so never let a second session touch staging while a repair is in flight, and
  always print the project ref before a grant/schema operation. [[supabase-dual-project-schema]]

**Production was unaffected throughout** — verified live and drift-clean at the time; no production action
was ever needed for any of this.
