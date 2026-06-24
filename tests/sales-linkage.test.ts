import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkSalesRecordAgainstDirectory } from "../src/lib/sales/employees.ts";

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

function vacantAreaCodesDoNotBecomeMissingEmployeeWarnings() {
  const link = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF-1",
      employeeLookupKey: "Ahmed.Nashaat",
      employeeName: "Ahmed.Nashaat",
      line: "Anti Inf",
      territory: "Sohag 2",
    },
    [],
    [
      {
        areaName: "Sohag 2",
        lineName: "Anti infective",
        managerHrId: "B-175",
        status: "open",
        vacancyCode: "resignation_B-150_2026-06-24",
      },
    ],
  );

  const diagnostics = link.diagnostics.join("\n");
  assert.equal(link.linkStatus, "unlinked", "vacant areas remain unlinked at MR level");
  assert.equal(link.employeeHrId, null, "V-AF codes must not be saved as employee HR IDs");
  assert.equal(link.managerHrId, "B-175", "matched vacancy should carry manager HR ID for manager/territory attribution");
  assert.match(diagnostics, /Vacancy area code "V-AF-1" matched open vacancy/, "vacancy code should produce a vacancy diagnostic");
  assert.doesNotMatch(diagnostics, /no employee matched/i, "vacancy codes must not produce missing employee warnings");
}

function vacantAreaCodesWinOverOthersBucket() {
  const link = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF-9",
      employeeLookupKey: "Others",
      employeeName: "Others",
      line: "Anti infective",
      territory: "Ismailia-Suez",
    },
    [],
    [
      {
        areaName: "Ismailia-Suez",
        lineName: "Anti infective",
        managerHrId: "B-200",
        status: "open",
        vacancyCode: "VAC-AF-9",
      },
    ],
  );

  assert.equal(link.employeeLookupKey, "Others", "display value can stay as uploaded");
  assert.equal(link.employeeName, "Others", "display name can stay as uploaded");
  assert.equal(link.managerHrId, "B-200", "V-AF codes must be treated as vacancies even when the display name is Others");
}

function normalRowsStillMapByEmployeeHrId() {
  const link = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "B-187",
      employeeLookupKey: "rep.one",
      employeeName: "Rep One",
      line: "Anti infective",
      territory: "Cairo West",
    },
    [
      {
        area: "Cairo West",
        crm_id: "CRM-187",
        crm_username: "rep.one",
        employment_status: "Active",
        full_name: "Rep One",
        hr_id: "B-187",
        job_title: "Medical Representative",
        line: "Anti infective",
        manager_hr_id: "B-100",
        position_title: "Medical Representative",
        region: "Cairo",
      },
    ],
    [],
  );

  assert.equal(link.linkStatus, "linked", "normal rows should still link by exact HR ID");
  assert.equal(link.employeeHrId, "B-187", "normal HR IDs should be preserved after linking");
  assert.equal(link.employeeCrmId, "CRM-187", "employee details should still hydrate from directory");
  assert.doesNotMatch(link.diagnostics.join("\n"), /no employee matched/i, "valid HR IDs must not get missing employee warnings");
}

export function runSalesLinkageTests() {
  singleEngineSource();
  consumersShareTheEngine();
  normalizerCommitsAreFinalizedAtomically();
  salesUploadCommitDurationIsConfigured();
  vacantAreaCodesDoNotBecomeMissingEmployeeWarnings();
  vacantAreaCodesWinOverOthersBucket();
  normalRowsStillMapByEmployeeHrId();
}
