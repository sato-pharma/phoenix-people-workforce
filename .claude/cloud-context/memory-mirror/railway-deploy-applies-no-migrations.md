---
name: railway-deploy-applies-no-migrations
description: "The Railway deploy runs NO migrations — a migration-dependent merge breaks production unless the migration is applied by hand FIRST."
metadata: 
  node_type: memory
  type: project
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-08-03T15:28:58.760Z
---

The Dockerfile has no migration step and `package.json` has no `db push` / `migrate` script — `build` is
plain `next build`, `start` is plain `next start`. **Nothing in the deploy pipeline applies
`supabase/migrations/`.** They are applied by hand, via the Supabase MCP `apply_migration` or the CLI.

Combined with [[railway-merge-is-the-production-deploy]] (merge = instant full-traffic deploy), this
makes ordering load-bearing:

**Apply the migration BEFORE the merge, never after.** A new column is additive — the currently
deployed code never references it, so applying early has a zero-risk window. Merging first means the
new code goes live selecting a column that does not exist, and every page touching it 500s until
someone notices.

Verified 2026-08-03 while shipping the direct-orders pharmacy price (PR #1664).

**Why:** the natural assumption is that a GitHub-connected platform runs migrations on deploy, the way
the old Cloud Run pipeline arguably implied. It does not, and the failure is silent until a user opens
the affected page.

**How to apply:** `mcp__supabase-production__apply_migration` works against BOTH projects — the
`project_id` argument is the only thing separating them (staging `cifwmndunmlxjhyjugxa`, production
`ozucdzovmcqvepbozvqf`). The `supabase-staging` server's own `apply_migration` returns
"You do not have permission"; use the production server with the staging `project_id` instead.

**How to apply it:** before merging any PR that adds a migration — apply to staging, prove with
`pg_attribute` (not `list_migrations`, see [[list-migrations-reports-ledger-not-reality]]), apply to
production, prove again, capture a before/after row-count + sum so you can show the data did not move.
Only then merge.
