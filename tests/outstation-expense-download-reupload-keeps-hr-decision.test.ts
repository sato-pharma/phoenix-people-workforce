import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";
import ts from "typescript";

import { analyzeExpenseWorkbook, type EmployeeLookupMaps } from "../src/lib/outstation/expense-import.ts";
import {
  resolveExpenseDecisionWrite,
  type StoredExpenseDecision,
} from "../src/lib/outstation/approval-state.ts";

/**
 * THE OUTSTATION EXPENSE REVIEW-SCREEN DOWNLOAD ROUND-TRIPS WITHOUT RESETTING HR'S DECISION.
 *
 * Two defects had to be fixed together, and one alone was dangerous.
 *
 *  1. THE DOWNLOAD WOULD NOT RE-IMPORT AT ALL. `downloadFilteredExpenses` gave every column a
 *     `header`, which ExcelJS writes into ROW 1 on top of the merged title — so row 1 read the last
 *     header ("Comments") in every cell, `detectHeaderRowNumber` broke the tie toward the lower row
 *     and picked row 1, and the file came back "Unrecognized expense template". The fix drops
 *     `header`; row 2 already carries the headers explicitly.
 *
 *  2. MAKING IT RE-IMPORTABLE OPENED A MONEY PATH. The importer's rows carry no `hrApproved`,
 *     `approvedAmount` or `hrComment` — they are trip DATA, not a decision. So a re-uploaded sheet,
 *     saved as-is, reset HR's decision on every post-July trip in it: hr_approved back to false,
 *     approved_amount to NULL, the approver and reason cleared. A claim of 800 that HR cut to 500
 *     dropped out of the payroll pre-fill; re-approved without re-cutting, it paid 800. The two
 *     upload routes now save with `preserveStoredDecisions: true`, so a trip already in Phoenix keeps
 *     whatever HR decided, and a sheet's Status column can never approve a trip.
 *
 * WHY THE SHAPE. Like tests/expense-approval-decisions-survive-the-save.ts, the suite has no module
 * mocking, so the database round-trip in savePayrollExpenseApprovals cannot be executed. The pure
 * halves run for real: the download code (lifted out of the component and compiled), the importer,
 * and the resolver that decides what a save writes into the decision columns. The link that stays
 * unexecuted — that the two upload routes pass the flag, and that the decision route does not — is
 * pinned against source, because a correct resolver nothing calls with the flag is exactly the bug.
 */

const REPORT_PATH = "../src/components/outstation/expense-report.tsx";

type TripFixture = Record<string, unknown>;

function reportSource() {
  return readFileSync(new URL(REPORT_PATH, import.meta.url), "utf8");
}

function slice(source: string, from: string, to: string, what: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > -1 && end > start, `positive control: ${what} is still in the expense report`);
  return source.slice(start, end);
}

/**
 * The component's own download code, compiled to plain JS: the module-level header list and the two
 * cell helpers, then the body of downloadFilteredExpenses() up to the point it turns the workbook
 * into a browser download. `approvalFor` is a stub, because it reads component state.
 */
function downloadBuilder(): (records: TripFixture[]) => Promise<ExcelJS.Workbook> {
  const source = reportSource();
  const pieces = [
    slice(source, "const expenseTemplateHeaders = [", "type ExpenseTemplateHeader", "the template header list"),
    slice(source, "function expenseTemplateComment(", "// Geography fields are excluded", "the two cell helpers"),
    slice(
      source,
      "const workbook = new ExcelJS.Workbook();",
      "const output = await workbook.xlsx.writeBuffer();",
      "the download's workbook builder",
    ),
  ];
  const compiled = ts.transpileModule(
    [
      "async function build(ExcelJS: any, records: any[]) {",
      "  const approvalFor = () => ({ hrApproved: false, hrComment: \"\" });",
      ...pieces,
      "  return workbook;",
      "}",
    ].join("\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const build = new Function(`${compiled}\nreturn build;`)() as (
    excel: typeof ExcelJS,
    records: TripFixture[],
  ) => Promise<ExcelJS.Workbook>;
  return (records) => build(ExcelJS, records);
}

const noDirectory: EmployeeLookupMaps = {
  codeByHrId: new Map(),
  codeByName: new Map(),
  residenceByHrId: new Map(),
  residenceByName: new Map(),
};

function trip(tripId: string, overrides: TripFixture = {}): TripFixture {
  return {
    allowance: 125,
    amWorkload: 2,
    date: "2026-09-02",
    description: "",
    from: "Alexandria",
    hr: "",
    hrId: "B-12",
    hrNotes: "",
    km: 67,
    location: "Damanhour",
    meetingAmount: 0,
    other: 0,
    pmWorkload: 8,
    requestType: "Medical Rep",
    row: 0,
    specialist: "Dina Fadel",
    status: "Approved",
    to: "Damanhour",
    toDate: "2026-09-02",
    total: 800,
    transportationType: "Bus",
    travelCost: 675,
    tripId,
    tripType: "Return same day",
    ...overrides,
  };
}

/** The download's own bytes, uploaded AS-IS — row 1 is left exactly as the code wrote it. */
async function asUpload(workbook: ExcelJS.Workbook, fileName: string) {
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as ArrayBuffer], fileName);
}

/** HR cut a claim of 800 down to 500, and left a reason — the decision a re-upload must not erase. */
function storedDecision(): StoredExpenseDecision {
  return {
    approvedAmount: 500,
    approvedAt: "2026-09-10T08:15:00.000Z",
    approvedBy: "B-10",
    hrApproved: true,
    hrComment: "Cut to 500 — one leg under the distance floor.",
    hrStatus: "",
    status: "Approved",
  };
}

/** What the save reads off an imported record for the resolver — exactly the fields the route passes. */
function incomingFrom(record: Record<string, unknown>) {
  return {
    approvedAmount: record.approvedAmount as number | null | undefined,
    hrApproved: record.hrApproved as boolean | undefined,
    hrComment: record.hrComment as string | undefined,
    hrStatus: record.hr as string | undefined,
    status: record.status as string | undefined,
  };
}

export async function runOutstationExpenseDownloadReuploadKeepsHrDecisionTests() {
  const build = downloadBuilder();
  const now = "2026-09-21T12:00:00.000Z";

  // A trip HR already reduced (its sheet Status even reads "Rejected", to prove the cell is ignored),
  // and a brand-new trip whose sheet Status reads "Approved".
  const downloaded = await build([
    trip("XL-1", { status: "Rejected", total: 800 }),
    trip("XL-2", { status: "Approved" }),
  ]);
  const sheet = downloaded.getWorksheet("Outstation expenses");
  assert.ok(sheet, "the download builds its Outstation expenses sheet");

  // ── 1. The download round-trips as-is — the title owns row 1, the headers row 2 ────────────────
  assert.match(
    String(sheet.getCell("A1").value ?? ""),
    /^Outstation expenses - 2 trip/,
    "row 1 is the merged title, not a header — re-adding `header` to sheet.columns clobbers it",
  );
  assert.equal(
    sheet.getRow(2).getCell(1).value,
    "TripID",
    "the headers sit on row 2, written explicitly",
  );
  const roundTrip = await analyzeExpenseWorkbook(
    await asUpload(downloaded, "phoenix-outstation-expenses-2026-09-21.xlsx"),
    { employeeMaps: noDirectory },
  );
  assert.equal(
    roundTrip.template?.recognized,
    true,
    "the downloaded file re-imports as the Phoenix template — with `header` on the columns it does not",
  );
  const byTrip = new Map(roundTrip.records.map((record) => [record.tripId, record]));
  assert.equal(byTrip.size, 2, "both downloaded trips import");
  assert.equal(byTrip.get("XL-1")?.total, 800, "the claim round-trips");

  // ── 2. The importer carries NO decision — this is WHY a naive re-upload reset one ──────────────
  const importedOne = byTrip.get("XL-1") as unknown as Record<string, unknown>;
  assert.equal(importedOne.hrApproved, undefined, "the importer never sets hrApproved");
  assert.equal(importedOne.approvedAmount, undefined, "the importer never sets approvedAmount");
  assert.equal(importedOne.hrComment, undefined, "the importer never sets hrComment");

  // ── 3. A re-upload KEEPS HR's stored decision (the fix), resolved for real ─────────────────────
  const stored = storedDecision();
  const kept = resolveExpenseDecisionWrite({
    approvedBy: "b-99-some-other-session",
    claimedTotal: importedOne.total as number,
    incoming: incomingFrom(importedOne),
    now,
    // The effective flag an upload route now carries (`preserveStoredDecisions: true`).
    preserveExistingDecision: true,
    stored,
  });
  assert.equal(kept.approvedAmount, 500, "the reduction to 500 survives the re-upload");
  assert.equal(kept.hrApproved, true, "the approval flag survives");
  assert.equal(kept.approvedBy, "B-10", "the approver survives — not overwritten by whoever uploaded");
  assert.equal(kept.approvedAt, stored.approvedAt, "when it was decided survives");
  assert.equal(kept.hrComment, "Cut to 500 — one leg under the distance floor.", "the HR reason survives");
  assert.equal(kept.status, "Approved", "the sheet's Status cell (\"Rejected\") does not flip the stored decision");
  assert.equal(kept.decidesApproval, false, "a re-upload exercises no approval authority");

  // A sheet's Status column must NOT approve a NEW trip either — XL-2's cell says "Approved".
  const importedNew = byTrip.get("XL-2") as unknown as Record<string, unknown>;
  assert.equal(importedNew.status, "Approved", "the download wrote the sheet Status through");
  const createdNew = resolveExpenseDecisionWrite({
    approvedBy: "b-99-some-other-session",
    claimedTotal: importedNew.total as number,
    incoming: incomingFrom(importedNew),
    now,
    preserveExistingDecision: true,
    stored: null,
  });
  assert.equal(createdNew.hrApproved, false, "a new trip is created unapproved whatever the Status cell says");
  assert.equal(createdNew.approvedAmount, null, "and with no approved amount");
  assert.equal(createdNew.decidesApproval, false, "and it decides nothing");

  // ── 3b. A re-upload that LOWERS the claim below the preserved amount cannot write approved>claim ─
  // Preservation carries HR's 500 forward. If the re-imported sheet shrinks this trip's total to 400
  // (a removed leg), 500 would now exceed the claim — and approved_amount > total breaches
  // expense_claims_approved_total_range, the exact over-claim that froze all 416 claims once. The
  // carry-forward clamps at the new claim: 500 caps to 400, which equals the claim and so stores as
  // null ("pay the claim") — never a figure above it. The approval, approver and reason still survive.
  const shrunk = resolveExpenseDecisionWrite({
    approvedBy: "b-99-some-other-session",
    claimedTotal: 400,
    incoming: incomingFrom(importedOne),
    now,
    preserveExistingDecision: true,
    stored,
  });
  assert.ok(
    shrunk.approvedAmount === null || (shrunk.approvedAmount as number) <= 400,
    "a preserved approved amount never exceeds a re-imported, lowered claim (approved_amount > total is the frozen-mirror bug)",
  );
  assert.equal(shrunk.approvedAmount, null, "500 approved against a 400 claim caps to the claim, stored as null");
  assert.equal(shrunk.hrApproved, true, "the approval itself still survives the shrink");
  assert.equal(shrunk.approvedBy, "B-10", "the approver still survives the shrink");
  assert.equal(shrunk.hrComment, "Cut to 500 — one leg under the distance floor.", "the reason still survives the shrink");
  assert.equal(shrunk.decidesApproval, false, "and the shrink is still no approval decision");

  // ── 4. BREAK THE FIX — without preservation the imported record resets the decision ────────────
  // This is the pre-fix upload behaviour: preserveExistingDecision false. The new assertion below is
  // the one that fires if the fix is removed — the reduction, approver and reason are all wiped.
  const wiped = resolveExpenseDecisionWrite({
    approvedBy: "b-99-some-other-session",
    claimedTotal: importedOne.total as number,
    incoming: incomingFrom(importedOne),
    now,
    preserveExistingDecision: false,
    stored,
  });
  assert.equal(wiped.approvedAmount, null, "without the fix, the importer's blank resets the approved amount");
  assert.equal(wiped.hrApproved, false, "without the fix, HR's approval is cleared");
  assert.equal(wiped.approvedBy, null, "without the fix, the approver is cleared");

  // ── 5. The wiring — the two UPLOAD routes preserve; the DECISION route does not ────────────────
  const analyzeRoute = readFileSync(
    new URL("../app/api/admin/outstation/expenses/analyze/route.ts", import.meta.url),
    "utf8",
  );
  const replaceRoute = readFileSync(
    new URL("../app/api/admin/outstation/expenses/reports/[id]/route.ts", import.meta.url),
    "utf8",
  );
  const decisionRoute = readFileSync(
    new URL("../app/api/admin/outstation/expenses/route.ts", import.meta.url),
    "utf8",
  );
  const saveSource = readFileSync(
    new URL("../src/lib/outstation/expenses.ts", import.meta.url),
    "utf8",
  );

  const analyzeSave = slice(analyzeRoute, "savePayrollExpenseApprovals(", "return NextResponse", "the analyze route save");
  assert.match(analyzeSave, /preserveStoredDecisions:\s*true/, "the analyze upload route preserves stored decisions");

  const replaceSave = slice(replaceRoute, "savePayrollExpenseApprovals(", "return NextResponse", "the replace route save");
  assert.match(replaceSave, /preserveStoredDecisions:\s*true/, "the replace upload route preserves stored decisions");
  assert.match(
    replaceSave,
    /replaceReportRowsFirst:\s*id/,
    "the replace route hands the clear to the save, so decisions are read before the rows are cleared",
  );

  const decisionSave = slice(
    decisionRoute,
    "savePayrollExpenseApprovals(",
    "// Every other expense screen",
    "the approvals-decision route save",
  );
  assert.doesNotMatch(
    decisionSave,
    /preserveStoredDecisions/,
    "the approvals-decision route must NOT preserve — it IS the decision the screen just made",
  );

  const saveBody = saveSource.slice(saveSource.indexOf("export async function savePayrollExpenseApprovals"));
  assert.match(
    saveBody,
    /recordPreservesDecision\(record\)/,
    "the save applies the effective-preserve flag when resolving each decision write",
  );
  assert.match(
    saveBody,
    /\.filter\(\(record\) => !recordPreservesDecision\(record\)\)/,
    "and excludes preserved records from the imported-history change check",
  );
}
