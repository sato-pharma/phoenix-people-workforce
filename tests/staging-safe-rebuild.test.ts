import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runStagingSafeRebuildTests() {
  const script = readFileSync("scripts/staging-safe-rebuild.ts", "utf8");
  const packageJson = readFileSync("package.json", "utf8");
  const gitignore = readFileSync(".gitignore", "utf8");

  assert.match(script, /currentStagingRef = "oaifhavixhdtwmseshff"/);
  assert.match(script, /productionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(script, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  assert.match(script, /YES_STAGING_ONLY/);
  assert.match(script, /PHOENIX_CONFIRM_NEW_STAGING_TARGET/);
  assert.match(script, /YES_NEW_STAGING_ONLY/);
  assert.match(script, /PHOENIX_CONFIRM_OLD_STAGING_ARCHIVE_ONLINE/);
  assert.match(script, /YES_OLD_STAGING_REMAINS_ONLINE/);
  assert.match(script, /PHOENIX_CONFIRM_NEW_STAGING_MIGRATION_APPLY/);
  assert.match(script, /YES_APPLY_FULL_CHAIN_TO_NEW_STAGING/);
  assert.match(script, /PHOENIX_STAGING_BACKUP_ID/);
  assert.match(script, /statement_timeout=8000/);
  assert.match(script, /connect_timeout/);

  assert.match(script, /supabase-export/);
  assert.match(script, /staging-rebuild/);
  assert.match(script, /row-counts\.json/);
  assert.match(script, /migration-history\.json/);
  assert.match(script, /auth-metadata\.json/);
  assert.match(script, /storage-metadata\.json/);
  assert.match(script, /selected-table-inventories\.json/);
  assert.match(script, /manifest\.json/);
  assert.match(script, /backupComplete/);
  assert.match(script, /archivePreserved/);
  assert.match(script, /archive-preserved/);
  assert.match(script, /oldStagingArchiveConfirmedOnline/);
  assert.match(script, /ARCHIVE_PRESERVED_WITH_INVENTORY_WARNINGS/);
  assert.match(script, /partialInventoryWarnings/);
  assert.match(script, /No business rows, payroll rows, salary rows, auth secrets, or employee PII/);
  assert.match(script, /Storage binary object contents are not included/);
  assert.match(script, /Sensitive auth password hashes/);
  assert.match(script, /PHOENIX_CONFIRM_STAGING_SENSITIVE_AUTH_EXPORT/);

  assert.match(script, /"db", "dump"/);
  assert.match(script, /"db", "push", "--db-url", target\.databaseUrl, "--dry-run"/);
  assert.match(script, /"db", "push", "--db-url", target\.databaseUrl, "--yes"/);
  assert.match(script, /noIncludeAll: true/);
  assert.match(script, /noDbReset: true/);
  assert.match(script, /noDeleteOldStaging: true/);
  assert.match(script, /productionExcluded: true/);
  assert.match(script, /archivePreservedGateAccepted: true/);

  assert.doesNotMatch(script, /"db", "reset"/);
  assert.doesNotMatch(script, /--include-all/);
  assert.doesNotMatch(script, /drop database/i);
  assert.doesNotMatch(script, /delete old staging/i);
  assert.doesNotMatch(script, /vercel\s+(--prod|deploy)/i);
  assert.doesNotMatch(script, /insert into supabase_migrations\.schema_migrations/i);

  assert.match(packageJson, /db:staging:rebuild:plan/);
  assert.match(packageJson, /db:staging:rebuild:archive-current/);
  assert.match(packageJson, /db:staging:rebuild:backup-current/);
  assert.match(packageJson, /db:staging:rebuild:dry-run-new/);
  assert.match(packageJson, /db:staging:rebuild:apply-new/);
  assert.match(packageJson, /db:staging:rebuild:verify-new/);
  assert.match(gitignore, /supabase-export\//);
}
