---
name: supabase-db-push-blocked-by-archived-baseline
description: "supabase db push always fails here — the remote ledger holds ~669 versions but 450 files were archived at the July baseline; never run the repair it suggests"
metadata: 
  node_type: memory
  type: project
  originSessionId: d0007173-7b15-4def-a4c3-f0d0670c67f0
  modified: 2026-08-09T09:40:44.111Z
---

`supabase db push` cannot run against production and never will without a deliberate
reconciliation. Verified 2026-08-09:

- production ledger `supabase_migrations.schema_migrations`: **669 rows** (20260501000000 →
  20260809092500)
- `supabase/migrations/`: **216 files**
- `supabase/_migrations_archive/pre-baseline-2026-07-11/`: **450 files**

The CLI sees ~450 remote versions with no local file and refuses with *"Remote migration versions
not found in local migrations directory."* This is a bookkeeping mismatch created by the 2026-07-11
baseline, not a broken database — the objects all exist.

**Why:** the CLI then suggests two remedies, and BOTH are destructive:
`supabase migration repair --status reverted <~450 versions>` rewrites the migration history of a
live payroll database on the strength of a file-presence check, and `supabase db pull` overwrites
the local migrations directory from the remote schema. Neither is undone by re-running.

**How to apply:** don't "fix" the error. Schema changes here go through the Supabase MCP
`apply_migration`, which is unaffected — `db push` simply isn't the route this repo uses. A dry run
is still useful as a pure connectivity/credential check: reaching "Connecting to remote
database..." proves the DB password works even though the push then stops.
See [[list-migrations-reports-ledger-not-reality]] — same underlying theme, that the ledger and
reality disagree here and the ledger is the unreliable one.
