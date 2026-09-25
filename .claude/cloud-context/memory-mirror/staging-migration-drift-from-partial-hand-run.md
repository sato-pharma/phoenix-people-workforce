---
name: staging-migration-drift-from-partial-hand-run
description: "A correct, fully-merged migration file can still be silently unapplied on staging if an earlier partial/hand-run of its SQL already created some of the objects it defines — staging's ledger and pg_proc can disagree with the repo even when the file itself is fine"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9a8c8f5c-a32c-477b-92aa-82c1c7e53cc9
  modified: 2026-08-10T02:09:15.862Z
---

Found 2026-08-10 investigating a staging security-advisor flag on `phx_unlock_monthly_closing` /
`phx_reject_write_to_locked_closing` (from the monthly-closing-lock feature, commit `6a401494`,
PR #1986). The migration file `20260810140000_monthly_closing_lock.sql` was already correct in the
repo — it creates all three functions SECURITY DEFINER and explicitly revokes EXECUTE from
public/anon/authenticated, granting only `service_role`. Production had it applied correctly.

**Staging didn't.** Two of the three functions already existed there — created by an earlier,
partial hand-run of the feature's SQL during development that predated the finished file's REVOKE
statements — and the finished migration was then never (re-)applied afterward, so it never
overwrote the stale grants. The functions sat on Postgres's bare default ACL (`proacl = NULL`, which
means EXECUTE open to `PUBLIC`, inherited by both `anon` and `authenticated`). `phx_unlock_monthly_closing`
does no internal caller check of its own (`p_actor` is an unverified free-text label) — it relies
entirely on the GRANT to gate access — so this was a real, live hole: any anonymous PostgREST request
with the public `anon` key could force-unlock a locked month on staging, bypassing the
Super-Admin-only app route entirely. Fixed same-day: PR #1990, migration
`20260810150000_monthly_closing_lock_revoke_anon_execute.sql`.

**How to apply:** "the migration file is correct and merged" does not mean "staging's live grants
match it" — hand-running SQL during development (common in this repo's fast-iteration workflow) can
leave objects that predate a later, more-restrictive version of the same migration. This is a
sharper version of [[list-migrations-reports-ledger-not-reality]]: there, the ledger lies about
whether a migration ran at all; here, the migration DID partially run — just an earlier, less-safe
draft of it — and nothing in `list_migrations` or a green CI would ever surface that. The only way to
know is to query `pg_proc.proacl` / `pg_class` directly for the actual live grants, on staging
specifically, after any SECURITY DEFINER function ships — which is exactly what
`get_advisors(type: security)` is for; run it after touching any privileged RPC, not just after
"real" migrations.
