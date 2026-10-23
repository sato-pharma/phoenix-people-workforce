---
name: acknowledged-exceptions-tail-conflicts-on-every-parallel-append
description: Every session that applies a migration by hand appends to the SAME tail of ACKNOWLEDGED_EXCEPTIONS, so a parallel PR conflicts there every time — resolve by keeping BOTH entries, never by picking a side.
metadata:
  type: project
---

`ACKNOWLEDGED_EXCEPTIONS` in `scripts/lib/migration-inventory.ts` is a flat `Set` that every
session appends to at the end, so on a day with several hand-applied migrations it is a **guaranteed**
merge conflict for any branch that is not merged within the hour.

On 23 October 2026 PR #6310 conflicted there **twice in twenty minutes** — first against
`981a0a188`, then again against `7a9f1e345` after #6307 and #6309 landed mid-push. Three entries
collided at the same line: the entry-days cache, the release-gate writer login (#6303's) and the
job leases (#6309's).

**Why:** `apply-sql-file.mjs` writes no `schema_migrations` row (AGENTS.md §8), so every hand-applied
migration MUST leave an entry here, and the entry is a long comment block plus one string — the
widest possible conflict footprint in the narrowest possible place.

**How to apply:** resolve it by **deleting only the three conflict markers** — both sides are
additions to a Set and both belong; the order inside the Set is meaningless. Then prove it with
`grep -o '"[0-9]\{14\}_[a-z0-9_]*\.sql"' … | sort | uniq -d` (expect nothing) and re-run
`node scripts/module-memory/build.mjs --check` plus `node scripts/check-migrations.mjs`, because the
same merge usually also carries `modules.mjs` and `run-tests.ts`. Never resolve it with "ours" or
"theirs": dropping the other side silently un-acknowledges a migration that IS live, and the nightly
drift check then reports a false red. See [[a-declined-supabase-mcp-apply-is-not-a-no]] and
[[apply-sql-file-is-the-route-for-a-declined-production-data-write]].
