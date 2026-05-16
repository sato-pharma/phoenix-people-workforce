# Supabase migration strategy

## Active bootstrap path

- Fresh local bootstrap uses only the active files in `supabase/migrations/`.
- The active bootstrap baseline is `supabase/migrations/20260517000000_remote_app_baseline.sql`.
- Forward schema work should be added as new migrations after that baseline.

## Legacy pre-baseline history

- Historical repair-style migrations were archived under `supabase/migrations_legacy_prebaseline/20260516185524/`.
- Those files are retained for audit and remote-history reference only.
- Do not use the archived legacy chain for fresh local bootstrap.

## Validation flow

1. `npm run db:local -- start`
2. `npm run db:supabase -- local db push --yes`
3. `npm run db:local -- migration list`
4. `npm run db:supabase -- remote db push --yes`
5. `npm run db:remote -- migration list`

## Production guardrails

- Never run remote `db reset`.
- Never drop or recreate the production database as part of migration reconciliation.
- Treat production baseline reset work as migration-ledger alignment plus reviewed forward migrations only.
