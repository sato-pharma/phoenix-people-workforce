# Baseline reset backup set

Created: 2026-05-16 18:55:24
Source: current remote Supabase database

Artifacts:
- remote-schema.sql: full remote schema-only dump (public/auth/storage)
- remote-app-schema.sql: app-owned schema dump (public/internal) used for active baseline generation
- remote-migration-ledger.csv: remote migration ledger snapshot
- remote-row-counts.csv: critical row-count checkpoint snapshot
- local-active-migrations.txt: pre-reset active migration filenames
