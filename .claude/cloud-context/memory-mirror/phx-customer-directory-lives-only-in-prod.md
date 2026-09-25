---
name: phx-customer-directory-lives-only-in-prod
description: "public.phx_customer_directory's Client Address fallback exists ONLY in production — no migration records it, so any rebuild from supabase/migrations silently regresses it"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbfccdf5-5bbf-4ee5-94df-254a1b202152
  modified: 2026-08-05T20:54:18.250Z
---

**Production's `public.phx_customer_directory` is AHEAD of the repo, and nothing
in `supabase/migrations/` records the difference.** Found 2026-08-05 by a full
audit of all 191 migration files against the live catalog.

Live production includes the Client Address inference:

```sql
coalesce(nullif(btrim(l.client_address), ''), nullif(btrim(m.address), ''), '')
...
left join public.source_of_sales_customer_map m
  on m.distributor_code = a.distributor_code
 and m.customer_code    = a.client_code
 and m.active
```

The repo's ONLY definition of this function is the 2026-07-11 snapshot in
`20260711135352_phoenix_production_schema_baseline.sql`, which lacks the fallback
and the join entirely. No later migration touches the function.

**Proof it bites:** staging (`cifwmndunmlxjhyjugxa`) was built from the
migrations, and its copy is **MISSING the address fallback** — verified by
querying `prosrc` on both projects the same day. Production 1,709 normalized
chars, staging 1,958 chars of the older shape.

**Why:** the change was applied straight to production and never written back as
a migration, so the repo lost it. This is the inverse of the usual "migration did
not run" failure and no ledger or existence check can see it — only a body-level
comparison of `prosrc` against the migration text finds it. See
[[list-migrations-reports-ledger-not-reality]] for how to normalize that
comparison, and [[sos-client-address-is-inferred-not-from-distributors]] for why
the fallback exists at all.

**CLOSED 2026-08-05** by
`supabase/migrations/20260805220000_phx_customer_directory_address_fallback.sql`
(note: authored as `...210000`, renamed to `...220000` to clear a collision — see
[[migration-timestamp-collides-across-parallel-branches]]). It transcribes
production's definition verbatim, body kept byte-identical to live `prosrc`.
Merged to `main` in PR #1819 as squash commit `ea3bc6bb`, live in production
(verified via `/api/healthz` `revision`).

Applied to staging AND production. Both now hash to
`e05d362fedde5031dc6ceae7a3baae8e`. Production's before/after hashes were
identical, proving the apply was the intended behavioural no-op; staging's went
from the regressed body to matching production.

**How to apply:** never rebuild a Phoenix database purely from
`supabase/migrations/` and assume parity — before this fix
`scripts/staging-safe-rebuild.ts` would silently ship the regressed function. The
general lesson stands beyond this one function: **a catalog-driven migration
(`pg_get_functiondef()` read-modify-rewrite, as in
`20260802022100_fail_closed_exclude_codes_defaults.sql`) never records the body it
rewrote.** Any function whose only repo definition is the baseline plus a
catalog-driven rewrite is a candidate for exactly this drift — check the body,
not the existence.
