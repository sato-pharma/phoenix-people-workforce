import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// G7 — linkage gate: a structural guard that the Sales module stays ONE engine. Every recognition
// consumer must route through src/lib/sales/recognize.ts (directly or via the analyze/commit service
// that uses it), and the new upload path must stay raw-only (no coded-template fork). This fails if a
// future change reintroduces a divergent recognition path — the exact bug this rebuild eliminated.

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function singleEngineSource() {
  const recognize = read("../src/lib/sales/recognize.ts");
  assert.match(recognize, /export async function recognizeDistributorWorkbook/, "recognize.ts must define the canonical recognizer");
  assert.match(recognize, /export const normalizeUploadedFile = recognizeDistributorWorkbook/, "normalizeUploadedFile must alias the canonical recognizer");

  const upload = read("../src/lib/sales/sales-upload.ts");
  assert.match(upload, /from "@\/lib\/sales\/recognize"/, "sales-upload must consume the shared recognizer");
  assert.match(upload, /recognizeDistributorWorkbook/, "sales-upload analyze/commit must call the shared recognizer");
  // Raw-only: the new upload path must NOT reach for the retired coded-template matcher.
  assert.doesNotMatch(upload, /createSourceOfSalesUpload\b/, "sales-upload must stay raw-only (no coded-template fork)");
}

function consumersShareTheEngine() {
  const analyze = read("../app/api/sales/sales-upload/analyze/route.ts");
  assert.match(analyze, /analyzeMonthlyUpload/, "analyze route must use the shared analyze service");
  const commit = read("../app/api/sales/sales-upload/commit/route.ts");
  assert.match(commit, /commitMonthlyUpload/, "commit route must use the shared commit service");
  const diagnostics = read("../src/lib/sales/diagnostics.ts");
  assert.match(diagnostics, /analyzeMonthlyUpload/, "diagnostics must reuse the same analyze (recognizer) path");
  const missing = read("../app/api/sales/monthly-import/missing/route.ts");
  assert.match(missing, /normalizeUploadedFile|recognizeDistributorWorkbook/, "the monthly analyzer must use the shared recognizer");
}

export function runSalesLinkageTests() {
  singleEngineSource();
  consumersShareTheEngine();
}
