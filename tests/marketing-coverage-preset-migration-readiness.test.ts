import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const MIGRATION_PATH = "supabase/migrations/20260704010000_marketing_coverage_report_preset_kind.sql";

const FORBIDDEN_PROD_PROJECT_REF = "ozucdzovmcqvepbozvqf";

function stripSqlComments(sql: string) {
  const withoutBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export async function runMarketingCoveragePresetMigrationReadinessTests() {
  assert.ok(existsSync(MIGRATION_PATH), `migration file ${MIGRATION_PATH} must exist`);
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  // (a) approval-gated header, matching this table's own established convention
  //     (the original marketing_roi_filter_presets migration uses this exact phrase).
  assert.match(sql, /APPROVAL-GATED/, "must be marked approval-gated, not yet applied");
  assert.match(sql, /NOT YET APPLIED/i);

  // (b) additive column with a backward-compatible default — every existing ROI
  //     Tracking preset row must keep working unchanged.
  assert.match(
    sql,
    /add column if not exists\s+report_kind\s+text\s+not null\s+default\s+'roi_tracking'/i,
    "report_kind must be added additively, defaulting existing rows to 'roi_tracking'",
  );

  // (c) check constraint pins the exact 2 allowed values.
  assert.match(
    sql,
    /check\s*\(\s*report_kind\s+in\s*\(\s*'roi_tracking'\s*,\s*'coverage_report'\s*\)\s*\)/i,
    "report_kind must be constrained to exactly roi_tracking / coverage_report",
  );

  // (d) the owner+name uniqueness is widened to include report_kind, so the two
  //     reports' presets can never collide on name.
  assert.match(
    sql,
    /unique\s*\(\s*owner_hr_id\s*,\s*report_kind\s*,\s*name\s*\)/i,
    "unique constraint must be scoped to (owner_hr_id, report_kind, name)",
  );

  // (e) "one default per owner" partial index is scoped per report_kind too.
  assert.match(
    sql,
    /create unique index if not exists\s+marketing_roi_filter_presets_one_default_per_kind_uidx\s+on\s+public\.marketing_roi_filter_presets\s*\(\s*owner_hr_id\s*,\s*report_kind\s*\)\s+where\s+is_default\s*=\s*true/i,
    "the one-default-per-owner index must be scoped per (owner_hr_id, report_kind)",
  );

  // (f) no destructive statements: no drop table, no delete, no truncate.
  const stripped = stripSqlComments(sql);
  assert.doesNotMatch(stripped, /\bdrop\s+table\b/i, "must not drop the shared presets table");
  assert.doesNotMatch(stripped, /\bdelete\s+from\b/i, "must not delete existing preset rows");
  assert.doesNotMatch(stripped, /\btruncate\b/i, "must not truncate the shared presets table");

  // (g) no production project ref string, no unsafe grants.
  assert.ok(!sql.includes(FORBIDDEN_PROD_PROJECT_REF), "migration file must not reference the production project ref");
  assert.doesNotMatch(stripped, /grant\s+[\s\S]*?\bto\s+anon\b/i);
  assert.doesNotMatch(stripped, /grant\s+[\s\S]*?\bto\s+authenticated\b/i);
  assert.doesNotMatch(stripped, /grant\s+[\s\S]*?\bto\s+public\b/i);
}
