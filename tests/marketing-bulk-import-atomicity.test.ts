import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

// Locks the transactional-bulk-import guarantee: executeBulkImport must insert each
// row (request + products + pharmacies + steps) through the atomic RPC, never through
// the old four-insert sequence with a best-effort parent delete that could leave
// partial data behind. Because executeBulkImport talks to live Supabase, its rollback
// behaviour is proven on staging; here we source-lock the shape so it can't regress.
export function runMarketingBulkImportAtomicityTests() {
  const bulkImport = source("src/lib/marketing-requests/bulk-import.ts");

  // Uses the atomic RPC for the per-row insert.
  assert.match(
    bulkImport,
    /supabase\.rpc\("import_marketing_request_atomic"/,
    "executeBulkImport must insert each row via the atomic RPC",
  );
  assert.match(bulkImport, /p_request:/, "RPC call must pass the request payload");
  assert.match(bulkImport, /p_products:/, "RPC call must pass the products payload");
  assert.match(bulkImport, /p_pharmacies:/, "RPC call must pass the pharmacies payload");
  assert.match(bulkImport, /p_steps:/, "RPC call must pass the approval-steps payload");

  // The old best-effort cleanup must be gone — atomicity replaces it.
  assert.doesNotMatch(
    bulkImport,
    /\.from\("marketing_requests"\)\.delete\(\)\.eq\("id", requestId\)/,
    "best-effort parent-delete cleanup must be removed (the RPC is transactional)",
  );
  assert.doesNotMatch(
    bulkImport,
    /let requestId: string \| null = null/,
    "the requestId-for-cleanup bookkeeping must be gone",
  );

  // Generated columns must not be written from JS (the DB derives them). Sending them
  // would raise "cannot insert a non-DEFAULT value" through the raw-SQL RPC.
  assert.doesNotMatch(bulkImport, /required_roi_value:/, "required_roi_value is GENERATED — must not be sent");
  assert.doesNotMatch(bulkImport, /roi_coverage_ratio:/, "roi_coverage_ratio is GENERATED — must not be sent");
  assert.doesNotMatch(bulkImport, /expected_value:/, "product expected_value is GENERATED — must not be sent");

  // The migration that defines the RPC must exist with the right security posture.
  const migrationDir = "supabase/_migrations_archive/pre-baseline-2026-07-11";
  const migrationFile = readdirSync(migrationDir).find((name) =>
    name.includes("marketing_request_atomic_bulk_import"),
  );
  assert.ok(migrationFile, "the atomic-bulk-import migration must be present");

  const migration = source(`${migrationDir}/${migrationFile}`);
  assert.match(
    migration,
    /create or replace function public\.import_marketing_request_atomic/,
    "migration must define import_marketing_request_atomic",
  );
  assert.match(migration, /language plpgsql/, "must be plpgsql (a transactional function body)");
  assert.match(migration, /security definer/, "must be security definer like sibling admin RPCs");
  assert.match(migration, /grant execute on function[\s\S]*to service_role/, "must grant execute to service_role");
  assert.match(migration, /revoke all on function[\s\S]*from public/, "must revoke from public");

  // The function must NOT list the generated columns in its INSERT column lists.
  assert.doesNotMatch(
    migration,
    /insert into marketing_requests \([^)]*required_roi_value/,
    "generated required_roi_value must not be in the request INSERT column list",
  );
  assert.doesNotMatch(
    migration,
    /insert into marketing_request_products \([^)]*expected_value/,
    "generated expected_value must not be in the products INSERT column list",
  );
}
