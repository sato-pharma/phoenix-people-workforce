---
name: mcp-apply-migration-versions-drift-from-filename
description: "Supabase MCP apply_migration records its own call-time clock as the schema_migrations version, not the timestamp in the local migration filename — check-migrations-applied.ts tolerates this via name-matching, but a raw supabase db push does not"
metadata:
  type: project
  originSessionId: reverent-shaw-9c126a
  modified: 2026-08-09T22:50:44.509Z
---

When a migration is applied via the Supabase MCP `apply_migration` tool (rather than `supabase db
push` replaying the actual repo file), the `version` written to
`supabase_migrations.schema_migrations` is the MCP server's clock **at the moment of the call** —
not the 14-digit timestamp prefix on the local migration filename that inspired the `name`
parameter. The `name` field usually does still match the filename (minus the timestamp), but the
`version` frequently does not.

**Why:** this repo's normal workflow is author file → apply to staging (owner-approved) → apply to
production (separately owner-approved) → PR merges main, often hours apart and out of order with
each apply. Each `apply_migration` call stamps its own moment, so the SAME logical migration can
end up with three different version numbers: the filename's, staging's ledger row, and
production's ledger row — they only coincide by chance.

**How prevalent:** not a one-off. Confirmed live example: PR #1984 authored/merged
`20260810120000_sos_backfill_matches_empty_brick_sentinel.sql`, but production's ledger recorded
it as version `20260809222929` (fixed by follow-up PR #1985 — see
[[sos-backfill-checks-null-not-empty-string]]). `scripts/check-migrations.mjs`'s own
`GRANDFATHERED_DUPLICATE_TIMESTAMPS` set and `scripts/check-migrations-applied.ts`'s
`ACKNOWLEDGED_EXCEPTIONS` block both document several more instances already. Production's own
`list_migrations` output currently shows 8+ ledger rows sharing a `name` with another row
(`phx_closing_customers_prefers_fact_area`, `closing_channel_totals`,
`customer_directory_address_from_customer_map`, `sales_channels_by_rep`,
`direct_order_search_arabic_trigram_reindex`, `closing_channel_unattributed_buckets`,
`ci_schema_shape_rpc`, `secure_email_backfill_backup_rls`) — the same pattern recurring from
re-applies under fresh clock timestamps.

**How to apply:**
- `scripts/check-migrations-applied.ts` (the daily drift-check, `.github/workflows/migration-
  drift-check.yml`) already matches a local file against the remote ledger by **version OR name**
  specifically to tolerate this — so a version/filename mismatch alone does NOT fail CI. Don't
  assume "the ledger version doesn't match the file" means anything is broken; check whether the
  `name` matches before concluding there's real drift. Verify live with `pnpm run
  check:migrations-applied` (needs `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in
  env — `.env.local` already points at production) rather than hand-simulating the match logic.
- The gap that name-matching does NOT cover: a raw `supabase db push` matches strictly by
  version, so a mismatched file still looks "unapplied" to the CLI and would be silently
  re-executed (usually idempotent-safe for `create or replace function`-style migrations, but it
  writes a redundant duplicate ledger row rather than recognizing the migration as already done).
- Renaming an already-merged file to match its actual applied version is safe **only** for the
  clean 1:1 case: exactly one local file whose `name` already exactly matches exactly one remote
  ledger row's `name`, no collision. Before renaming: (1) pull the live ledger row via
  `list_migrations`/`execute_sql` to confirm the exact version+name, (2) diff the live function
  body (`pg_get_functiondef`) against the file to confirm content truly matches, (3) grep the repo
  for the old filename string to confirm nothing else references it, (4) re-run `check:migrations-
  applied` live before AND after to prove neither CI nor reality regressed.
- Do NOT rename for the `GRANDFATHERED_DUPLICATE_TIMESTAMPS` collision case — two *different*
  files sharing one filename-prefix, each independently applied under two different real versions.
  `check-migrations.mjs`'s own comment says those "cannot be renamed without breaking Supabase
  migration history"; picking which file gets which real version is ambiguous in a way the clean
  1:1 case isn't.
