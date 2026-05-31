import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const MIGRATION_PATH =
  "supabase/migrations/20260531120000_contract_non_renewal_terminal_lifecycle.sql";

const FORBIDDEN_PROD_PROJECT_REF = "ozucdzovmcqvepbozvqf";

function stripSqlComments(sql: string) {
  // Remove block comments first, then line comments.
  const withoutBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export async function runContractNonRenewalMigrationReadinessTests() {
  // (a) file exists
  assert.ok(existsSync(MIGRATION_PATH), `migration file ${MIGRATION_PATH} must exist`);
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const firstLine = sql.split(/\r?\n/, 1)[0] ?? "";

  // (b) header has DRAFT and DO NOT APPLY
  assert.match(firstLine, /DRAFT/, "first line must contain DRAFT");
  assert.match(firstLine, /DO NOT APPLY/, "first line must contain DO NOT APPLY");

  // (c) additive column
  assert.match(
    sql,
    /add column if not exists\s+contract_renewal_request_id/i,
    "migration must add the additive contract_renewal_request_id column",
  );

  // (d) index
  assert.match(
    sql,
    /create index if not exists\s+employee_resignations_contract_renewal_idx/i,
    "migration must create employee_resignations_contract_renewal_idx",
  );

  // (e) RPC definition
  assert.match(
    sql,
    /create or replace function\s+public\.phx_terminate_employee_for_non_renewal/i,
    "migration must define public.phx_terminate_employee_for_non_renewal",
  );

  // (f) grant execute to service_role
  assert.match(
    sql,
    /grant execute on function\s+public\.phx_terminate_employee_for_non_renewal\s*\(\s*uuid\s*,\s*text\s*\)\s+to\s+service_role/i,
    "migration must grant execute on the RPC to service_role with signature (uuid, text)",
  );

  // Strip comments for the "no INSERT / no unsafe grant" scans.
  const stripped = stripSqlComments(sql);

  // (g) no INSERT statements outside comments
  assert.doesNotMatch(
    stripped,
    /\binsert\s+into\b/i,
    "migration body must contain no insert statements",
  );

  // (h) no production project ref string
  assert.ok(
    !sql.includes(FORBIDDEN_PROD_PROJECT_REF),
    `migration file must not reference the production project ref ${FORBIDDEN_PROD_PROJECT_REF}`,
  );

  // (i) no grants to anon / authenticated / public (outside comments)
  assert.doesNotMatch(
    stripped,
    /grant\s+[\s\S]*?\bto\s+anon\b/i,
    "migration must not grant to anon",
  );
  assert.doesNotMatch(
    stripped,
    /grant\s+[\s\S]*?\bto\s+authenticated\b/i,
    "migration must not grant to authenticated",
  );
  // The `revoke ... from public` statement is allowed; only `grant ... to public` is forbidden.
  assert.doesNotMatch(
    stripped,
    /grant\s+[\s\S]*?\bto\s+public\b/i,
    "migration must not grant to public",
  );

  // (j) rollback block inside /* ... */ comment with the three reverse-dependency statements.
  const rollbackBlockMatch = sql.match(/\/\*[\s\S]*?\*\//g);
  assert.ok(rollbackBlockMatch && rollbackBlockMatch.length > 0, "migration must contain at least one /* ... */ rollback comment block");
  const rollbackBlock = rollbackBlockMatch!.join("\n");
  const dropFunctionIdx = rollbackBlock.search(/drop function[\s\S]*?phx_terminate_employee_for_non_renewal/i);
  const dropIndexIdx = rollbackBlock.search(/drop index[\s\S]*?employee_resignations_contract_renewal_idx/i);
  const dropColumnIdx = rollbackBlock.search(/alter table[\s\S]*?drop column[\s\S]*?contract_renewal_request_id/i);
  assert.ok(dropFunctionIdx >= 0, "rollback block must drop function phx_terminate_employee_for_non_renewal");
  assert.ok(dropIndexIdx >= 0, "rollback block must drop index employee_resignations_contract_renewal_idx");
  assert.ok(dropColumnIdx >= 0, "rollback block must drop column contract_renewal_request_id");
  // Reverse-dependency order: function before index before column.
  assert.ok(
    dropFunctionIdx < dropIndexIdx && dropIndexIdx < dropColumnIdx,
    "rollback block statements must appear in reverse-dependency order: drop function, drop index, drop column",
  );
}
