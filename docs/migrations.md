# Migration Policy

## File Location

All database migrations live in supabase/migrations/ with timestamped filenames:
YYYYMMDDHHMMSS_description.sql

The supabase/ root also contains historical hardening scripts and operational patches. These are reference material, not part of the automated migration pipeline.

## Creating Migrations

1. Write SQL in a new file under supabase/migrations/ with the current timestamp prefix
2. Include both the forward migration and document any manual rollback steps
3. Test on a staging/development Supabase project first
4. Never apply directly to production without explicit approval

## Safety Rules

- All migrations require staging validation before production
- RLS-affecting changes require security review
- Destructive operations (DROP, DELETE, ALTER TABLE DROP COLUMN) require explicit approval and documented rollback
- Production migration application follows the phase pipeline (see scripts reference)
- Never use the Supabase Dashboard to make schema changes — all changes go through migration files

## Migration Pipeline

The repository includes a phased migration validation pipeline (phase25 through phase36) that gates production database changes through staging validation, approval, and post-apply verification. These scripts are documented in docs/scripts.md.

## Rollback Strategy

- Each migration should be designed to be rollback-safe where possible
- Document rollback SQL in comments or companion files
- For complex migrations, create a backup migration first (see 20260512235939_backup_leave_domain_before_rebuild.sql as an example)

## Loose SQL Files

The supabase/ root contains ~50 historical SQL files (phoenix-*.sql, security-*.sql, etc.). These are operational scripts that were applied during early development before the timestamped migration convention was established. They remain as documentation but are not part of the automated migration pipeline.
