# One-off SQL scripts

Every `.sql` file here was run by hand, once, against staging or production. None of them is a
migration: nothing applies them automatically, and the migration ledger does not list them. They are
kept as the record of what was run.

- **Moved here on 13 Nov 2026** from the root of `supabase/`, where 62 of them sat beside the
  migrations folder and read like migrations nobody had applied (enterprise audit, F-ENG-016 / REC-041).
  Most date from May 2026, before the migration history was re-based on 11 July 2026; a few are later
  restores and backfills.
- **A new change to the schema is a migration** in `supabase/migrations/`, never a file here. A script
  belongs here only when it is a deliberate one-off (a data backfill, a staging restore) that must not
  run again on its own.
- **`supabase/seed.sql` stays at the root** because `supabase/config.toml` loads it by that path.
- `tests/supabase-folder-layout.test.ts` refuses a new `.sql` file at the root of `supabase/`.
- Some of these are still read: `tests/scripts/bootstrap-phoenix-sandbox.ts` applies several to build a
  sandbox, a few tests read their text, and two app pages name the script an administrator would run.
