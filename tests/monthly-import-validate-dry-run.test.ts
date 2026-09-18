import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The body of the first top-level `export async function <name>(` in a source file, up to the
// closing brace at column zero.
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is still defined`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} has a closing brace`);
  return text.slice(start, end);
}

// The monthly-import validate route (SoS re-measure 2026-09-18, #107). It called the import with
// no dry-run flag, so answering "Validation passed." had already saved the batch and its rows,
// and a coverage snapshot beside them: any sales importer could land a month by asking whether it
// would import. It now runs the import as a dry run and writes nothing; importing stays the
// commit route's job, after the preview.
export function runMonthlyImportValidateDryRunTests() {
  const route = readSource("../app/api/sales/monthly-import/validate/route.ts");

  // ── The route's one call into the import is a dry run ──
  const calls = [...route.matchAll(/importSourceOfSalesFile\(\{([^}]*)\}\)/g)];
  assert.equal(calls.length, 1, "the validate route calls the import exactly once");
  assert.match(
    calls[0][1],
    /\bdryRun:\s*true\b/,
    "the validate route must run the import as a dry run: it answers whether a workbook would import, and saves nothing",
  );

  // ── Nothing else in the route writes ──
  for (const writer of ["saveCoverageSnapshot", "persistDistributorSalesUpload", "createSourceOfSalesUpload", "getSupabaseAdmin"]) {
    assert.doesNotMatch(route, new RegExp(`\\b${writer}\\b`), `the validate route must not reach ${writer}: a dry run creates no batch to record`);
  }
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(/, "the validate route issues no database write of its own");
  assert.doesNotMatch(route, /Import complete/, "the validate route never says a workbook was imported");

  // ── The dry run it relies on really stops before the save, on both import paths ──
  const importer = functionBody(readSource("../src/lib/sales/source-of-sales-upload.ts"), "importSourceOfSalesFile");
  assert.match(importer, /createSourceOfSalesUpload\(input\)/, "the coded path hands the whole request, dry-run flag included, to the uploader");
  const normalizerDryRun = importer.indexOf("if (input.dryRun) {");
  const normalizerPersist = importer.indexOf("persistOnlyIfValidated: false");
  assert.ok(normalizerDryRun >= 0 && normalizerPersist > normalizerDryRun, "a raw sheet's dry run returns before the normalizer's save");

  const uploads = readSource("../src/lib/sales/monthly-distributor-import.ts");
  for (const uploader of ["createSourceOfSalesUpload", "createSourceOfSalesUploadFromBuffer"]) {
    const body = functionBody(uploads, uploader);
    const dryRunReturn = body.indexOf("if (input.dryRun)");
    const persist = body.indexOf("persistDistributorSalesUpload(");
    assert.ok(dryRunReturn >= 0 && persist > dryRunReturn, `${uploader} returns on a dry run before it saves anything`);
  }
}
