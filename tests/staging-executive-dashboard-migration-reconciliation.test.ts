import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runStagingExecutiveDashboardMigrationReconciliationTests() {
  const script = readFileSync("scripts/staging-executive-dashboard-migration-reconciliation.ts", "utf8");
  const packageJson = readFileSync("package.json", "utf8");

  assert.match(script, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  assert.match(script, /YES_STAGING_ONLY/);
  assert.match(script, /approvedStagingRef = "oaifhavixhdtwmseshff"/);
  assert.match(script, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(script, /20260602082351_executive_dashboard_snapshot\.sql/);
  assert.match(script, /PHOENIX_CONFIRM_STAGING_BACKUP/);
  assert.match(script, /PHOENIX_CONFIRM_STAGING_MIGRATION_REPAIR/);
  assert.match(script, /PHOENIX_CONFIRM_STAGING_EXECUTIVE_MIGRATION_APPLY/);

  assert.match(script, /supabase_migrations\.schema_migrations/);
  assert.match(script, /to_regclass/);
  assert.match(script, /pg_policies/);
  assert.match(script, /relrowsecurity/);
  assert.match(script, /has_function_privilege\('service_role'/);
  assert.match(script, /has_function_privilege\('anon'/);
  assert.match(script, /has_function_privilege\('authenticated'/);

  assert.match(script, /--repair-verified-history/);
  assert.match(script, /--apply-executive-migration/);
  assert.match(script, /Refusing repair because/);
  assert.match(script, /Refusing apply because clean dry-run/);
  assert.match(script, /noLiveIncludeAll: true/);
  assert.match(script, /BLOCKED_PENDING_MANUAL_PARITY_REVIEW/);
  assert.match(script, /READY_TO_APPLY_ONLY_EXECUTIVE_DASHBOARD_MIGRATION/);

  assert.match(script, /"db", "push", "--db-url", dbUrl, "--dry-run", "--include-all"/);
  assert.match(script, /"db", "push", "--db-url", stagingDatabaseUrl\(\), "--yes"/);
  assert.match(script, /"migration",\s+"repair"/);
  assert.doesNotMatch(script, /db", "push", "--db-url", dbUrl, "--include-all"/);
  assert.doesNotMatch(script, /insert into supabase_migrations\.schema_migrations/i);
  assert.doesNotMatch(script, /vercel\s+(--prod|deploy)/i);

  assert.match(packageJson, /db:staging:executive-migration:reconcile/);
  assert.match(packageJson, /db:staging:executive-migration:repair-history/);
  assert.match(packageJson, /db:staging:executive-migration:apply/);
}
