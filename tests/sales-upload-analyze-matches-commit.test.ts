import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveUploadPeriod, withPeriodGateFinding } from "../src/lib/sales/sales-upload.ts";
import type { ValidationReport } from "../src/lib/sales/upload-validation.ts";

/**
 * Analyze is the dry run: "what happens if I import this now". Commit REFUSES a sheet whose period
 * cannot be resolved — it throws `missing_period` or `multi_period` BEFORE validating anything.
 *
 * Analyze validated regardless, passing `resolvedPeriod: null`, which ALSO disables every
 * period-dependent check (prior-period totals, the one-validated-batch-per-period duplicate test).
 * So a date-less or multi-month sheet could be reported "Validation passed" and then hard-rejected
 * on the very next click — while analyzeMonthlyUpload's own comment promised that "the analyze
 * report matches the commit gate exactly".
 */

const SRC = readFileSync(new URL("../src/lib/sales/sales-upload.ts", import.meta.url), "utf8");

const clean: ValidationReport = { ok: true, errorCount: 0, warningCount: 1, infoCount: 2, findings: [] };

export function runSalesUploadAnalyzeMatchesCommitTests() {
  // 1. A sheet with no date column: commit throws missing_period, so analyze must not pass.
  const missing = resolveUploadPeriod([], "");
  assert.equal(missing.kind, "missing", "no dates and no override is the missing-period case");
  const missingReport = withPeriodGateFinding(clean, missing);
  assert.equal(missingReport.ok, false, "analyze must not report ok for a file commit will refuse");
  assert.equal(missingReport.errorCount, 1, "the refusal is an error, not a warning");
  assert.equal(missingReport.findings[0].code, "period_missing", "and it is named so the UI can explain it");

  // 2. A sheet spanning months: commit throws multi_period, so analyze must not pass either.
  const multi = resolveUploadPeriod(["2026-07", "2026-08"], "");
  assert.equal(multi.kind, "multi", "two distinct months with no override is the multi-period case");
  const multiReport = withPeriodGateFinding(clean, multi);
  assert.equal(multiReport.ok, false, "a multi-month sheet cannot import, so it cannot pass analyze");
  assert.equal(multiReport.findings[0].code, "period_multi");
  assert.match(multiReport.findings[0].detail, /2026-07, 2026-08/, "name the months so the operator can split the file");

  // 3. A resolvable period leaves the report exactly as validation produced it — the gate must not
  //    invent findings for files that CAN import, or it becomes a banner nobody reads.
  const picked = resolveUploadPeriod([], "2026-08");
  assert.equal(picked.kind, "ok", "an explicit override resolves the period");
  assert.deepEqual(
    withPeriodGateFinding(clean, picked),
    clean,
    "a resolvable period must pass the report through untouched",
  );
  const single = resolveUploadPeriod(["2026-08", "2026-08"], "");
  assert.equal(single.kind, "ok", "one distinct month needs no override");
  assert.deepEqual(withPeriodGateFinding(clean, single), clean, "a single-month sheet is untouched too");

  // 4. Existing errors survive — the gate ADDS the refusal, it does not replace the findings.
  const withError: ValidationReport = { ok: false, errorCount: 2, warningCount: 0, infoCount: 0, findings: [
    { code: "dupe", severity: "error", title: "t", detail: "d", count: 1, sampleRows: [] },
  ] };
  const combined = withPeriodGateFinding(withError, missing);
  assert.equal(combined.errorCount, 3, "the period refusal adds to the existing error count");
  assert.equal(combined.findings.length, 2, "and keeps every finding validation already produced");

  // 5. The wiring: analyze must actually apply the gate. A correct helper nobody calls changes
  //    nothing, and this defect was invisible precisely because analyze looked clean.
  assert.ok(
    SRC.includes("const validation = withPeriodGateFinding("),
    "analyzeMonthlyUpload must fold the period decision into the report it returns",
  );
}
