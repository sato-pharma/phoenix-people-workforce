---
name: the-ledger-can-miss-a-version-whose-objects-are-live
description: the migrations ledger lies in BOTH directions - 20260928014644's column, FK and index are live in production with 12 rows using them, yet that version is in no ledger row (the ledger jumps 20260927231139 to 20260928144209), so "not in the ledger" is never evidence a change did not ship
metadata:
  type: project
---

The known rule is that `list_migrations` reports the ledger, not reality. Measured 2026-10-07, the
same gap runs the OTHER way: `supabase/migrations/20260928014644_add_candidate_offer_pointer.sql` is
on `main` and its objects are all live in production — `ats_candidates.offer_id`, its FK
`ats_candidates_offer_id_fkey`, the index `ats_candidates_offer_idx`, and **12 candidate rows already
carrying a linked offer** — while `supabase_migrations.schema_migrations` holds **no row** for that
version: it jumps straight from `20260927231139` to `20260928144209`.

**Why:** it was applied by hand under a different version string, which is normal here (§8
pre-authorizes Supabase writes). So the ledger's silence says only that nobody recorded that name.

**How to apply:** answer "did this migration ship?" from `pg_attribute`/`pg_class`/`pg_constraint`
for the OBJECTS it creates, never from a ledger row or a version string — in either direction. A
missing ledger row is not a missing change, and the reverse (a ledger row with no object) is the
older half of this trap. Related: [[a-branch-with-no-pr-can-be-the-working-copy-of-shipped-work]].
