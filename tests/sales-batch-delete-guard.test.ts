import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Deleting a sales import batch must never destroy the frozen `sales_records` rows underneath it.
 *
 * `sales_records_batch_id_fkey` is a foreign key onto `sales_import_batches`, and a referential
 * action runs with the TABLE OWNER's rights — so the Rule #1 revoke of service_role's DELETE does
 * not stop a cascade. Measured on staging as service_role: a direct delete from `sales_records`
 * fails with 42501, while deleting the parent batch silently took the child row with it.
 *
 * Two layers must therefore both hold, and this file pins both:
 *   1. the application refuses first, with a message a human can act on;
 *   2. the constraint is RESTRICT, so the database still refuses when the request never passes
 *      through that code path.
 *
 * Source-text assertions rather than a call-level fake: both halves are structural — an ordering
 * inside one function and a clause inside one migration — and it is the ORDER, not the response
 * handling, that decides whether the rows survive.
 */
export function runSalesBatchDeleteGuardTests() {
  const service = readFileSync("src/lib/sales/service.ts", "utf8");

  const start = service.indexOf("export async function deleteSalesBatch");
  assert.notEqual(
    start,
    -1,
    "deleteSalesBatch must still exist — if it was renamed, every assertion below silently stops testing anything",
  );
  const end = service.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "could not find the end of deleteSalesBatch — the slice below would be wrong");
  const body = service.slice(start, end);

  const guardAt = body.indexOf("assertSalesBatchHoldsNoFrozenRecords(");
  const batchDeleteAt = body.indexOf('.from("sales_import_batches").delete()');

  assert.notEqual(
    batchDeleteAt,
    -1,
    "deleteSalesBatch must still be the function that deletes the batch row — otherwise this test guards the wrong place",
  );

  // HEADLINE INVARIANT. The guard has to run BEFORE the batch row is deleted. Placed after, it
  // would count rows that the cascade has already destroyed, find zero, and wave the delete
  // through — a guard that reports success precisely when it has failed.
  assert.ok(
    guardAt !== -1 && guardAt < batchDeleteAt,
    "deleteSalesBatch must call assertSalesBatchHoldsNoFrozenRecords BEFORE deleting the batch row — the FK cascade destroys the frozen sales_records rows with it, and the revoke does not stop a cascade",
  );

  // The refusal must carry a status the route can surface. A bare throw would land as a 500 and
  // read like a bug rather than a deliberate block.
  const guardStart = service.indexOf("async function assertSalesBatchHoldsNoFrozenRecords");
  assert.notEqual(guardStart, -1, "the guard helper itself must exist");
  const guardBody = service.slice(guardStart, service.indexOf("\n}\n", guardStart));
  assert.match(
    guardBody,
    /new SalesWorkflowError\(/,
    "the guard must refuse with a SalesWorkflowError, which routes already map to a real status code",
  );
  assert.match(guardBody, /409/, "the refusal is a conflict — the sheet cannot be deleted in its current state");

  // The route must actually map that error, or the status above never reaches the user.
  const route = readFileSync("app/api/sales/imports/[id]/[action]/route.ts", "utf8");
  assert.match(
    route,
    /error instanceof SalesWorkflowError/,
    "the sales import action route must map SalesWorkflowError to its own status, or the guard's 409 degrades to a 500",
  );

  // Layer 2: the database half. The application guard is bypassable by anything that does not go
  // through deleteSalesBatch; the constraint is not.
  const migrationFile = readFileSync(
    "supabase/migrations/20260814162700_sales_records_batch_fk_restrict.sql",
    "utf8",
  ).toLowerCase();
  // Strip `--` comment lines first. The header explains the CASCADE problem in prose, and matching
  // that prose would test the commentary rather than the statement that actually runs.
  const migrationSql = migrationFile
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  assert.match(
    migrationSql,
    /on delete restrict/,
    "the migration must set the batch foreign key to ON DELETE RESTRICT — CASCADE is the back door around the freeze",
  );
  assert.equal(
    /on delete cascade/.test(migrationSql),
    false,
    "the executable SQL must not re-establish ON DELETE CASCADE — that is the exact clause being removed",
  );
}
