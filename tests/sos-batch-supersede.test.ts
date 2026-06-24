import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Guards the SoS batch-supersede fix: re-uploading a distributor + period replaces the prior batch
// (validated or blocked) instead of accumulating duplicates. Pins the shared helper's status-agnostic
// query, both call sites wiring it in at the right point, and the dead duplicate-block throw's removal.
export function runSosBatchSupersedeTests() {
  const helper = readSource("../src/lib/sales/source-of-sales-batch-supersede.ts");
  assert.match(helper, /export async function supersedeExistingSalesBatches/,
    "shared helper is exported");
  assert.match(helper, /\.eq\("distributor_code", input\.distributorCode\)/,
    "helper filters by distributor_code");
  assert.match(helper, /\.eq\("period", input\.period\)/,
    "helper filters by period");
  assert.match(helper, /writeAuditLog/,
    "helper writes an audit log entry for each superseded batch");
  assert.match(helper, /entityType: "sales_import_batch"/,
    "audit log uses the existing sales_import_batch entity type");
  assert.doesNotMatch(helper, /\.eq\("status",/,
    "helper must be status-agnostic — it supersedes validated AND blocked batches");

  const importer = readSource("../src/lib/sales/monthly-distributor-import.ts");
  assert.match(importer, /supersedeExistingSalesBatches/,
    "persistDistributorSalesUpload calls the shared supersede helper");
  assert.doesNotMatch(importer, /duplicate_sales_batch/,
    "the old throw-and-block duplicate guard is removed");

  const normalizerService = readSource("../src/lib/sales/normalizer/service.ts");
  assert.match(normalizerService, /supersedeExistingSalesBatches/,
    "persistNormalizedBatch calls the shared supersede helper");
  const supersedeIdx = normalizerService.indexOf("supersedeExistingSalesBatches(");
  const finalizeIdx = normalizerService.indexOf('status: "validated", blocking_reasons: []');
  assert.ok(supersedeIdx > 0 && finalizeIdx > supersedeIdx,
    "supersede must run after rows/summaries are already inserted and right before the " +
    "validated finalize UPDATE — never before this batch's own validity is established");
}
