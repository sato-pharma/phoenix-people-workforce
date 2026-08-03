import assert from "node:assert/strict";
import {
  buildExpenseApprovalExportRows,
  expenseApprovalExportEmployeeLabel,
  expenseApprovalExportFilename,
  expenseApprovalExportSubtitle,
} from "../src/lib/outstation/expense-approval-export.ts";
import { expenseEmployeeKey } from "../src/lib/outstation/expense-approval-filters.ts";
import type { PayrollExpenseApproval } from "../src/lib/payroll/types.ts";

const NO_FILTERS = { employee: "", month: "" };

function trip(overrides: Partial<PayrollExpenseApproval>): PayrollExpenseApproval {
  return {
    allowance: 0,
    amWorkload: 0,
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
    date: "2026-06-15T00:00:00.000Z",
    description: "",
    from: "Cairo",
    hr: "",
    hrApproved: false,
    hrComment: "",
    hrId: "HR-1",
    hrNotes: "",
    km: 0,
    location: "Alexandria",
    meetingAmount: 0,
    open: "",
    other: 0,
    payoutMonth: 6,
    payoutYear: 2026,
    pmWorkload: 0,
    reportId: "REPORT-1",
    requestType: "Traveling",
    row: 1,
    sourceFileName: "batch.xlsx",
    specialist: "Mona Khaled",
    status: "",
    to: "",
    toDate: "2026-06-15T00:00:00.000Z",
    total: 1000,
    transportationType: "Car",
    travelCost: 700,
    tripId: "TRIP-1",
    tripType: "traveling",
    ...overrides,
  };
}

export function runOutstationExpenseApprovalExportTests() {
  // --- value before deduction and after: the exact pair the Deduction field is built on ---

  const untouched = buildExpenseApprovalExportRows(
    [trip({ approvedAmount: null, total: 2000, tripId: "untouched" })],
    NO_FILTERS,
    "",
  )[0];
  assert.equal(untouched.claimedTotal, 2000, "claimed total is the raw claim regardless of any decision");
  assert.equal(untouched.deduction, 0, "an unadjusted row (approvedAmount null) shows zero deduction, not a blank or a claim-sized cut");
  assert.equal(untouched.approvedAmount, 2000, "an unadjusted row's payable is the full claim — null must not read as zero");

  const reduced = buildExpenseApprovalExportRows(
    [trip({ approvedAmount: 1500, hrApproved: true, total: 2000, tripId: "reduced" })],
    NO_FILTERS,
    "",
  )[0];
  assert.equal(reduced.claimedTotal, 2000, "the value BEFORE deduction is the original claim");
  assert.equal(reduced.deduction, 500, "the deduction is the gap HR actually cut");
  assert.equal(reduced.approvedAmount, 1500, "the value AFTER deduction is what payroll actually pays");

  const zeroed = buildExpenseApprovalExportRows(
    [trip({ approvedAmount: 0, hrApproved: true, total: 900, tripId: "zeroed" })],
    NO_FILTERS,
    "",
  )[0];
  assert.equal(zeroed.approvedAmount, 0, "approving at zero must show zero, not fall back to the claim");
  assert.equal(zeroed.deduction, 900, "a full-claim deduction shows the whole claim as cut");

  // --- status, comment, and audit trail — "every single thing" ---

  const approvedRow = buildExpenseApprovalExportRows(
    [
      trip({
        approvedAmount: 1500,
        approvedAt: "2026-06-20T10:00:00.000Z",
        approvedBy: "HR-9",
        hrApproved: true,
        hrComment: "Hotel receipt missing",
        reportId: "REPORT-42",
        sourceFileName: "june-batch.xlsx",
        total: 2000,
        tripId: "audited",
      }),
    ],
    NO_FILTERS,
    "",
  )[0];
  assert.equal(approvedRow.status, "Approved", "status reads the human label, not the raw hr_approved boolean");
  assert.equal(approvedRow.hrComment, "Hotel receipt missing", "HR's own comment is carried through verbatim");
  assert.equal(approvedRow.approvedBy, "HR-9", "who approved it is preserved");
  assert.equal(approvedRow.approvedAt, "2026-06-20T10:00:00.000Z", "when it was approved is preserved");
  assert.equal(approvedRow.reportId, "REPORT-42", "the source report/batch is traceable");
  assert.equal(approvedRow.sourceFileName, "june-batch.xlsx", "the source file is traceable");

  const rejectedRow = buildExpenseApprovalExportRows(
    [trip({ hrApproved: false, status: "Rejected", tripId: "rej" })],
    NO_FILTERS,
    "",
  )[0];
  assert.equal(rejectedRow.status, "Rejected", "a rejected trip reads Rejected, not Pending");

  const pendingRow = buildExpenseApprovalExportRows([trip({ tripId: "pend" })], NO_FILTERS, "")[0];
  assert.equal(pendingRow.status, "Pending", "an undecided trip reads Pending");

  // --- distance flag matches the on-screen highlight's own boundary (58/60 km) ---

  assert.equal(
    buildExpenseApprovalExportRows([trip({ km: 40, tripId: "short" })], NO_FILTERS, "")[0].distanceFlag,
    "Under 58 km floor",
    "under the tolerance minimum is flagged, matching the red highlight on screen",
  );
  assert.equal(
    buildExpenseApprovalExportRows([trip({ km: 59, tripId: "tolerance" })], NO_FILTERS, "")[0].distanceFlag,
    "Tolerance band",
    "58-59.9 km is flagged as tolerance, matching the amber highlight on screen",
  );
  assert.equal(
    buildExpenseApprovalExportRows([trip({ km: 65, tripId: "clear" })], NO_FILTERS, "")[0].distanceFlag,
    "",
    "60km+ carries no flag, matching the plain (unflagged) rows on screen",
  );
  assert.equal(
    buildExpenseApprovalExportRows([trip({ km: 0, tripId: "nodist" })], NO_FILTERS, "")[0].distanceFlag,
    "",
    "a trip with no recorded distance is not flagged as short",
  );

  // --- filtering: the SAME shared functions the screen uses, so export can't disagree with it ---

  const rows = [
    trip({ date: "2026-04-10T00:00:00.000Z", specialist: "Ahmed Nashaat", tripId: "april-ahmed" }),
    trip({ date: "2026-05-11T00:00:00.000Z", specialist: "Ahmed Nashaat", tripId: "may-ahmed" }),
    trip({ date: "2026-04-12T00:00:00.000Z", specialist: "Mona Khaled", tripId: "april-mona" }),
  ];

  assert.equal(buildExpenseApprovalExportRows(rows, NO_FILTERS, "").length, 3, "no filter exports everything");
  assert.equal(
    buildExpenseApprovalExportRows(rows, { employee: "", month: "2026-04" }, "").length,
    2,
    "the month filter narrows the export exactly like it narrows the queue",
  );
  assert.equal(
    buildExpenseApprovalExportRows(rows, { employee: expenseEmployeeKey({ specialist: "Ahmed Nashaat" }), month: "" }, "")
      .length,
    2,
    "the employee filter narrows the export exactly like it narrows the queue",
  );
  assert.equal(
    buildExpenseApprovalExportRows(
      rows,
      { employee: expenseEmployeeKey({ specialist: "Ahmed Nashaat" }), month: "2026-04" },
      "",
    ).length,
    1,
    "month and employee narrow together",
  );
  assert.equal(
    buildExpenseApprovalExportRows(rows, NO_FILTERS, "Mona").length,
    1,
    "free text narrows the export exactly like it narrows the queue's search box",
  );

  // Export spans ALL THREE decision states for the scope, unlike a single queue tab.
  const mixedStates = [
    trip({ hrApproved: true, tripId: "a", specialist: "Ahmed Nashaat" }),
    trip({ hrApproved: false, status: "Rejected", tripId: "b", specialist: "Ahmed Nashaat" }),
    trip({ tripId: "c", specialist: "Ahmed Nashaat" }),
  ];
  const mixedExport = buildExpenseApprovalExportRows(
    mixedStates,
    { employee: expenseEmployeeKey({ specialist: "Ahmed Nashaat" }), month: "" },
    "",
  );
  assert.deepEqual(
    mixedExport.map((row) => row.status).sort(),
    ["Approved", "Pending", "Rejected"],
    "the export for one person includes ALL of their trips regardless of decision state — the Status column is what tells them apart",
  );

  // --- ordering: employee alphabetically, newest trip first within each employee ---

  const sorted = buildExpenseApprovalExportRows(rows, NO_FILTERS, "");
  assert.deepEqual(
    sorted.map((row) => row.tripId),
    ["may-ahmed", "april-ahmed", "april-mona"],
    "Ahmed sorts before Mona, and within Ahmed the May trip (newer) comes before the April one",
  );

  // --- empty input ---

  assert.deepEqual(buildExpenseApprovalExportRows([], NO_FILTERS, ""), [], "no trips exports no rows, not an error");

  // --- employee label resolution for the filename/subtitle ---

  const labelPool = [trip({ specialist: "Ahmed.Nashaat", tripId: "handle" })];
  assert.equal(
    expenseApprovalExportEmployeeLabel(labelPool, expenseEmployeeKey({ specialist: "Ahmed.Nashaat" })),
    "Ahmed.Nashaat",
    "resolves the display name behind a given employee key",
  );
  assert.equal(expenseApprovalExportEmployeeLabel(labelPool, ""), "", "an unset employee key resolves to no label");
  assert.equal(
    expenseApprovalExportEmployeeLabel(labelPool, "nobody-with-this-key"),
    "",
    "a key with no matching trip resolves to no label rather than throwing",
  );

  // --- filename and subtitle reflect the active scope ---

  assert.equal(
    expenseApprovalExportFilename(NO_FILTERS, ""),
    "expense-approvals.xlsx",
    "no filters gives the plain default filename",
  );
  assert.equal(
    expenseApprovalExportFilename({ employee: "x", month: "2026-04" }, "Ahmed Nashaat"),
    "expense-approvals-april-2026-ahmed-nashaat.xlsx",
    "a filtered export names the month and person in the filename",
  );

  assert.match(
    expenseApprovalExportSubtitle(NO_FILTERS, "", 12),
    /^All trips · 12 rows/,
    "an unfiltered export's subtitle says so plainly, and states the row count",
  );
  assert.match(
    expenseApprovalExportSubtitle({ employee: "x", month: "2026-04" }, "Ahmed Nashaat", 3),
    /^April 2026 · Ahmed Nashaat · 3 rows/,
    "a filtered export's subtitle names the exact scope it covers",
  );
}
