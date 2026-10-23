import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasLineMatch, linkSalesRecordAgainstDirectory } from "../src/lib/sales/employees.ts";
import { isSalesOthersBucket } from "../src/lib/sales/others.ts";

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
  assert.match(service, /status: "pending"/, "normalizer imports must start pending (invisible to every rollup) until child rows are persisted");
  assert.match(service, /status: "validated"/, "normalizer imports must finalize to validated after all rows are persisted");
  assert.match(service, /blocking_reasons: \[IMPORT_FINALIZING_REASON\]/, "pending in-flight imports must carry a retry-safe reason");
  assert.match(service, /finalizeSosBatchAndAuditSupersede/, "finalize must run through the atomic phx_finalize_sos_batch RPC, not a separate supersede + update + refresh sequence");
  const upload = read("../src/lib/sales/sales-upload.ts");
  assert.match(upload, /\.eq\("status", "validated"\)/, "duplicate/prior-period checks must only use finalized batches");
}


function vacantAreaCodesDoNotBecomeMissingEmployeeWarnings() {
  const link = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF",
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
  assert.equal(link.employeeLookupKey, "V-AF", "vacancy code should be preserved as a non-login lookup signal");
  assert.match(diagnostics, /Vacancy area code "V-AF" matched open vacancy/, "vacancy code should produce a vacancy diagnostic");
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

  assert.equal(link.employeeLookupKey, "V-AF-9", "vacancy code should win over aggregate display values");
  assert.equal(link.employeeName, "Others", "display name can stay as uploaded");
  assert.equal(link.managerHrId, "B-200", "V-AF codes must be treated as vacancies even when the display name is Others");
}

function vacantAreaRowsStayOutOfTheOthersBucketOnRead() {
  // The linker and the read path must AGREE. linkSalesRecordAgainstDirectory recognises a vacancy
  // area code and deliberately leaves the uploaded display name alone, so a vacant area whose sheet
  // reads "Others" reaches the read path still carrying its code. service.ts then asks
  // isSalesOthersBucket about the LINKED record, and an Others verdict there drops the row from
  // every scoped read, labels it "Unassigned DSM" and excludes it from district attribution — the
  // territory's sales would vanish from the manager who owns the vacancy.
  const link = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF-9",
      employeeName: "Others",
      line: "Anti Infective",
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

  assert.equal(link.employeeLookupKey, "V-AF-9", "the vacancy code must survive linkage");
  assert.equal(
    isSalesOthersBucket({
      employeeHrId: link.employeeHrId,
      employeeLookupKey: link.employeeLookupKey,
      employeeName: link.employeeName,
      line: link.line,
    }),
    false,
    "a linked vacant area must not read as the line's Others bucket, however the sheet named it",
  );

  // The aggregate bucket itself must still be recognised — a line total carries no area code.
  assert.equal(
    isSalesOthersBucket({ employeeLookupKey: "Others", employeeName: "Others", line: "Anti Infective" }),
    true,
    "a genuine line-total row carries no vacancy code and must still read as the Others bucket",
  );
}

function vacancyPlaceholdersDoNotPersistAsManagers() {
  const vacancyManager = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF-8",
      employeeLookupKey: "Cairo DM",
      employeeName: "Cairo DM",
      line: "Anti infective",
      managerHrId: "V-AF-19",
      territory: "Cairo Others",
    },
    [],
    [],
  );

  const dashManager = linkSalesRecordAgainstDirectory(
    {
      employeeHrId: "V-AF-13",
      employeeLookupKey: "Others",
      employeeName: "Others",
      line: "Anti infective",
      managerHrId: "-",
      territory: "Qal",
    },
    [],
    [],
  );

  assert.equal(vacancyManager.managerHrId, null, "vacancy codes in the manager column must not hit the sales_records.manager_hr_id FK");
  assert.equal(dashManager.managerHrId, null, "dash placeholders in the manager column must not hit the sales_records.manager_hr_id FK");
  assert.match(vacancyManager.diagnostics.join("\n"), /not stored as a manager employee ID/);
  assert.match(dashManager.diagnostics.join("\n"), /not stored as a manager employee ID/);
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
  assert.equal(link.managerHrId, "B-100", "linked MR rows should carry their manager HR ID for DSM linkage");
  assert.doesNotMatch(link.diagnostics.join("\n"), /no employee matched/i, "valid HR IDs must not get missing employee warnings");
}

function abbreviatedAntiInfectiveLineStillMatches() {
  const employee = {
    area: "Sohag 2",
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
  };

  assert.equal(
    hasLineMatch(employee, "Anti Inf"),
    true,
    "sheet rows using the abbreviated 'Anti Inf' line must match employees stored under the full 'Anti infective' line",
  );
  assert.equal(
    hasLineMatch(employee, "Anti infective"),
    true,
    "exact line matches must still pass",
  );
  assert.equal(
    hasLineMatch(employee, "CNS"),
    false,
    "genuinely different lines must still be flagged as a mismatch",
  );
}

// Item E — loadDirectory()'s try/catch fallback (raw supabase query, used only when the richer
// getEmployeeDirectoryRows() path throws) previously had NO status filter at all, so a
// resigned/terminated employee's row could still link fresh sales data whenever the fallback
// path was exercised. isInactiveEmploymentStatus also hand-rolled its own substring denylist
// instead of delegating to the canonical isTerminalEmploymentStatus predicate. Source-regex
// style, matching this file's existing singleEngineSource()/consumersShareTheEngine() checks — a
// behavioral test of the fallback path itself would require mocking getEmployeeDirectoryRows to
// throw, which this file's existing conventions don't otherwise reach for.
function employeeDirectoryFallbackStaysActiveOnly() {
  const source = read("../src/lib/sales/employees.ts");
  // Both names, from that module, in whatever order and alongside whatever else it imports there.
  assert.match(
    source,
    /import \{[^}]*\bACTIVE_EMPLOYMENT_STATUSES_IN_LIST\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
    "employees.ts must import the canonical active-status constant",
  );
  assert.match(
    source,
    /import \{[^}]*\bisTerminalEmploymentStatus\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
    "employees.ts must import the canonical terminal-status predicate",
  );
  assert.match(
    source,
    /function isInactiveEmploymentStatus\(status: string \| null \| undefined\) \{\s*return isTerminalEmploymentStatus\(status\);\s*\}/,
    "isInactiveEmploymentStatus must delegate to the canonical isTerminalEmploymentStatus predicate",
  );
  assert.doesNotMatch(
    source,
    /\["inactive", "resigned", "terminated", "left", "suspended", "vacant"\]/,
    "isInactiveEmploymentStatus must no longer hand-roll its own denylist array",
  );
  assert.match(
    source,
    /\.or\(`employment_status\.is\.null,employment_status\.in\.\$\{ACTIVE_EMPLOYMENT_STATUSES_IN_LIST\}`\)/,
    "loadDirectory's raw-query fallback must filter to active-or-null employment_status, matching the primary getEmployeeDirectoryRows() path",
  );
}

export function runSalesLinkageTests() {
  singleEngineSource();
  consumersShareTheEngine();
  normalizerCommitsAreFinalizedAtomically();

  vacantAreaCodesDoNotBecomeMissingEmployeeWarnings();
  vacantAreaCodesWinOverOthersBucket();
  vacantAreaRowsStayOutOfTheOthersBucketOnRead();
  vacancyPlaceholdersDoNotPersistAsManagers();
  normalRowsStillMapByEmployeeHrId();
  abbreviatedAntiInfectiveLineStillMatches();
  employeeDirectoryFallbackStaysActiveOnly();
}
