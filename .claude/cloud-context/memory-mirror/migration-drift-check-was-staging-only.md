---
name: migration-drift-check-was-staging-only
description: "The daily Migration Drift Check ran against STAGING only and was green for a week while production was missing a migration — the staging proxy is backwards, because staging-first means the normal drift is applied-on-staging/missing-on-production."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5445d88d-bb17-4027-9b98-f20f99b400f1
  modified: 2026-07-31T19:23:50.192Z
---

`scripts/check-migrations-applied.ts` + `.github/workflows/migration-drift-check.yml` ran against
**staging only** (ref `cifwmndunmlxjhyjugxa`), justified in its own header as a proxy: *"if a
migration never reached staging, it almost certainly never reached production either."*

**That proxy runs backwards.** The documented workflow is staging-**first**, with production apply
gated on separate explicit approval (AGENTS.md). So the NORMAL drift in this repo is
*applied-on-staging / missing-on-production* — exactly the state a staging-only check reports as
green. It is structurally blind to the only direction that hurts.

Proven 2026-07-30 during a production go/no-go audit: the staging leg had concluded `success` on
8 consecutive daily runs while production was missing
`20260725180000_analytics_dim_products_exclude_head_office.sql` (merged 110h earlier). Confirmed
against the live schema, not bookkeeping: `pg_get_viewdef('analytics.dim_products')` on production
had no Head Office exclusion, exposing 1 active Head-Office-line product's name/family/
factory_price to `analytics_readonly` / `metabase` / `service_role` (not `anon`/`authenticated`).

**Also note:** `pnpm run check:migrations` (`scripts/check-migrations.mjs`) is a totally different
thing — it only LINTS the migrations directory (filename format, duplicate timestamps, unannotated
DROP/TRUNCATE). It never contacts a database. Do not mistake its green for schema parity; that is
`check:migrations-applied`.

**How to apply:** to answer "is production's schema in sync with the repo?", run
`pnpm run check:migrations-applied` with the env pointed at the target project and read the
`target project ref:` line it now prints — never infer production from a green staging run.
Name matching must stay version-OR-name-OR-substring: MCP `apply_migration` records its own clock
as the version, and some historical rows store the full timestamped filename in the `name` column,
so a naive name-only comparison reports ~8 false positives. See [[mcp-apply-migration-version-drift]]
and [[local-env-already-points-at-production]] (the local `.env.local` targets production, which is
what let the check be run against production by hand).

**RESOLVED 2026-07-30:** PR #1490 (`f09a58d1`, live prod rev `phoenix-hr-00685-yey`) added a
production leg to the workflow. The missing migration was applied to production with owner
approval and verified — Head-Office rows visible via `analytics.dim_products` went 1 → 0,
`dim_products_all` untouched (still 4), grants unchanged. Production drift is now **zero**
(566 migrations recorded).

**STILL OPEN:** the production leg only *runs* once a `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`
GitHub secret exists; until then the step is skipped and the job emits a `::warning::` — a skipped
step and a passing step look identical at a glance, which is the same silent-green failure the
workflow exists to prevent. So today's zero-drift is hand-verified, not continuously enforced.
Still true on 2026-07-31: every run logs `HAS_PRODUCTION_SUPABASE_KEY: false`, so the production
leg has **never executed once**.

⚠️ **2026-07-31 — the proxy is worse than "backwards", it is measuring a broken database.** Staging
has had **zero RLS policies, zero foreign keys and zero triggers since 2026-07-11**, so the only leg
that actually runs is pointed at a schema skeleton. The drift failure it currently reports
(`20260728190000_sos_block_grouping`) is real but **not fixable by applying the migration** — it is
blocked on missing primary keys. See [[staging-is-a-schema-skeleton-not-a-clone]] before acting on
any drift-check red.
