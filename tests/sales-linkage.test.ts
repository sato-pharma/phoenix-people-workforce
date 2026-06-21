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
  assert.match(commit, /export const maxDuration = 300/, "large sales-upload commits must have a five-minute Vercel duration");
  const diagnostics = read("../src/lib/sales/diagnostics.ts");
  assert.match(diagnostics, /analyzeMonthlyUpload/, "diagnostics must reuse the same analyze (recognizer) path");
  const missing = read("../app/api/sales/monthly-import/missing/route.ts");
  assert.match(missing, /normalizeUploadedFile|recognizeDistributorWorkbook/, "the monthly analyzer must use the shared recognizer");
}

function normalizerCommitsAreFinalizedAtomically() {
  const service = read("../src/lib/sales/normalizer/service.ts");
  assert.match(service, /status: "blocked"/, "normalizer imports must start blocked until child rows are persisted");
  assert.match(service, /status: "validated"/, "normalizer imports must finalize to validated after all rows are persisted");
  assert.match(service, /blocking_reasons: \[IMPORT_FINALIZING_REASON\]/, "blocked in-flight imports must carry a retry-safe reason");
  const upload = read("../src/lib/sales/sales-upload.ts");
  assert.match(upload, /\.eq\("status", "validated"\)/, "duplicate/prior-period checks must only use finalized batches");
}

function salesUploadCommitDurationIsConfigured() {
  const raw = read("../vercel.json");
  const specific = raw.indexOf('"app/api/sales/sales-upload/commit/route.ts"');
  const broad = raw.indexOf('"app/api/sales/**/*"');
  assert.ok(specific >= 0, "vercel.json must configure the sales-upload commit route explicitly");
  assert.ok(broad >= 0, "vercel.json must retain the broad sales API duration default");
  assert.ok(specific < broad, "the sales-upload commit duration must be declared before the broad sales API rule");
  const vercel = JSON.parse(raw) as { functions?: Record<string, { maxDuration?: number }> };
  assert.equal(vercel.functions?.["app/api/sales/sales-upload/commit/route.ts"]?.maxDuration, 300, "sales-upload commit needs a five-minute Vercel duration");
}

export function runSalesLinkageTests() {
  singleEngineSource();
  consumersShareTheEngine();
  normalizerCommitsAreFinalizedAtomically();
  salesUploadCommitDurationIsConfigured();
}
