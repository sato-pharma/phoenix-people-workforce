import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

export function runWorkflowControlMigrationReadinessTests() {
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const all = readdirSync(migrationsDir);
  const wc = all.filter((n) => /workflow_control_phase3/.test(n));
  assert.equal(wc.length, 1, "exactly one workflow_control_phase3 migration draft exists");
  const migrationFile = wc[0]!;
  assert.match(migrationFile, /^\d{14}_workflow_control_phase3\.sql$/, "filename convention");

  const sql = readFileSync(new URL(migrationFile, migrationsDir), "utf8");

  for (const table of [
    "workflow_definitions",
    "workflow_versions",
    "workflow_drafts",
    "workflow_publish_history",
    "workflow_audit_logs",
  ]) {
    assert.match(sql, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, "i"), `creates public.${table}`);
    assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"), `RLS enabled on public.${table}`);
    assert.match(sql, new RegExp(`create\\s+policy[\\s\\S]*?on\\s+public\\.${table}[\\s\\S]*?to\\s+service_role`, "i"), `service_role policy on public.${table}`);
  }

  // Strip comments first; then verify only service_role policies exist.
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)--.*$/gm, "$1");
  const policyClauses = [...stripped.matchAll(/create\s+policy[\s\S]*?to\s+([a-z_]+(?:\s*,\s*[a-z_]+)*)/gi)];
  assert.ok(policyClauses.length >= 5, "at least 5 service_role policies");
  for (const [, roleClause] of policyClauses) {
    const roles: string[] = roleClause.split(/[,\s]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);
    const nonServiceRole = roles.filter((r) => r !== "service_role");
    assert.deepEqual(nonServiceRole, [], `policy "to" must be service_role only: "${roleClause.trim()}"`);
    for (const forbidden of ["anon", "authenticated", "public"]) {
      assert.equal(roles.indexOf(forbidden) >= 0, false, `no policy targets "${forbidden}"`);
    }
  }

  // Immutability trigger + function.
  assert.match(sql, /create\s+(or\s+replace\s+)?function\s+public\.workflow_versions_block_mutation/i, "immutability function defined");
  assert.match(sql, /create\s+trigger\s+workflow_versions_block_mutation_trg/i, "immutability trigger defined");
  for (const col of ["payload", "payload_hash", "version_number", "published_at", "published_by_hr_id"]) {
    assert.match(sql, new RegExp(`workflow_versions\\.${col} is immutable`, "i"), `trigger blocks ${col}`);
  }

  // Unique constraints + active_version_id FK.
  assert.match(sql, /unique\s*\(\s*definition_id\s*,\s*owner_hr_id\s*\)/i, "drafts unique");
  assert.match(sql, /unique\s*\(\s*domain_key\s*,\s*subflow_key\s*\)/i, "definitions unique");
  assert.match(sql, /unique\s*\(\s*definition_id\s*,\s*version_number\s*\)/i, "versions unique");
  assert.match(
    sql,
    /alter\s+table\s+public\.workflow_definitions[\s\S]*?foreign\s+key\s*\(\s*active_version_id\s*\)[\s\S]*?references\s+public\.workflow_versions\s*\(\s*id\s*\)/i,
    "active_version_id FK exists",
  );
  assert.match(sql, /payload\s+jsonb\s+not\s+null/i, "payload jsonb not null");
  assert.match(sql, /payload_hash\s+text\s+not\s+null/i, "payload_hash text not null");

  // No data inserts; no production project refs / hardcoded HR_IDs.
  assert.equal(/^\s*insert\s+into/im.test(stripped), false, "no INSERTs");
  for (const ref of ["ozucdzovmcqvepbozvqf", "oaifhavixhdtwmseshff"]) {
    assert.equal(sql.includes(ref), false, `must not reference "${ref}"`);
  }
  assert.equal(/'A-1[06]'|"A-1[06]"|'B-10'|"B-10"/.test(stripped), false, "no hardcoded HR_IDs");

  // DRAFT marker + rollback block.
  assert.match(sql, /DRAFT\b[\s\S]*?DO\s+NOT\s+APPLY/i, "DRAFT — DO NOT APPLY marker");
  assert.match(sql, /ROLLBACK\s+SQL[\s\S]*?drop\s+table\s+if\s+exists\s+public\.workflow_definitions/i, "rollback SQL documented");

  // Indexes present.
  for (const idx of [
    /workflow_definitions_active_idx/i,
    /workflow_definitions_domain_subflow_idx/i,
    /workflow_versions_definition_version_desc_idx/i,
    /workflow_versions_payload_hash_idx/i,
    /workflow_drafts_definition_owner_idx/i,
    /workflow_publish_history_definition_idx/i,
  ]) {
    assert.match(sql, idx, `index ${idx} declared`);
  }
}
