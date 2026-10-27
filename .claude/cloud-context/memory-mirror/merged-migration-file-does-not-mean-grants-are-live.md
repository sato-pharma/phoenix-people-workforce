---
name: merged-migration-file-does-not-mean-grants-are-live
description: "A migration merged to main with correct REVOKE statements can still leave a live anon-executable function on staging — the objects were created by earlier ad-hoc SQL that predates the file's safety statements, and the migration itself was never applied there"
metadata:
  type: project
  originSessionId: c75c1b69-be03-48c9-9f83-34b5813dc6e8
  modified: 2026-08-10T01:45:29.121Z
---

**Confirmed 2026-08-10, staging `cifwmndunmlxjhyjugxa`:** a Supabase security advisor flagged
`phx_unlock_monthly_closing` and `phx_reject_write_to_locked_closing` (from #1986's monthly-closing
lock feature) as anon-EXECUTE-able. The migration file `20260810140000_monthly_closing_lock.sql` —
already merged to `main`, already correct, ends with `revoke execute on function ... from public,
anon, authenticated` for exactly these functions — was **entirely absent from staging's migration
ledger**. Yet two of its three functions already existed on staging, with `pg_proc.proacl = NULL`
(the bare Postgres default: EXECUTE open to `PUBLIC`, which `anon`/`authenticated` inherit). The
third function (`phx_lock_monthly_closing`) didn't exist at all. Production had the fully correct
state the whole time.

**Reading:** someone created two of the three functions by hand (`execute_sql`, not
`apply_migration`) while drafting the feature — before the file's final REVOKE statements were
written — then finished and merged the file without ever re-applying it to staging. `CREATE OR
REPLACE FUNCTION` doesn't reset an existing function's ACL, so once created open, a function stays
open until something explicitly revokes it — and nothing had.

**Why this is a different trap from [[list-migrations-reports-ledger-not-reality]]:** that memory is
about the ledger *over-claiming* (rows present, objects missing). This is the ledger *under-claiming
while a dangerous partial state exists* — zero ledger rows, yet the exact functions a security
advisor cares about are live and open. "The migration isn't even in the ledger" is not reassurance
that nothing is there; ad-hoc dev SQL leaves objects with none of a migration's safety statements
attached, and the git file being correct and merged proves nothing about any specific database.

**How to apply:** when a security advisor (or anyone) flags a SECURITY DEFINER function, do not
reason from the migration file's content or from `list_migrations`. Query `pg_proc.proacl` /
`information_schema.routine_privileges` directly on the flagged project. A `NULL` proacl means the
bare Postgres default (PUBLIC has EXECUTE) — that is the vulnerable state regardless of what any
`.sql` file in the repo says. Check the same query on the sibling environment (staging vs production)
before assuming both share the finding; they can diverge completely. If the fix turns out to be "the
already-merged file was simply never applied here," re-applying that exact file (idempotent
`CREATE OR REPLACE` / `IF NOT EXISTS` statements are safe to re-run) is the correct remediation — not
rewriting new SQL. Still worth also shipping a small standalone revoke-only migration afterward as a
function-named, git-tracked backstop (this repo's established convention — see
`20260719190000_phx_revoke_anon_executable_secdef_triggers.sql`,
`20260718205253_phx_revoke_authenticated_execute_marketing_import_and_direct_order_decision.sql`),
so the fix has an audit trail independent of whether the original feature migration ever gets
re-applied correctly again.

Fixed in [PR #1990](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1990) (open, not
merged — owner approval pending). Staging verified clean via a fresh `get_advisors(security)` scan
after the fix; production required no change.
