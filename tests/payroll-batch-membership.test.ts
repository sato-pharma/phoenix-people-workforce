import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeHrId } from "../src/lib/auth/permissions.ts";
import {
  filterPayrollFlagsByAccess,
  filterPayrollRowsByAccess,
  type PayrollAccessFilter,
} from "../src/lib/payroll/service.ts";
import type { SalaryFlag } from "../src/lib/payroll/types.ts";

/**
 * A salary batch is a historical record of money already paid; its membership is
 * fixed when the batch is built. The payroll read views used to re-derive membership
 * from present-day employment, so the June 2026 locked batch (123 rows, 2,667,500.00
 * EGP net) displayed 103 rows / 2,267,000.00 EGP: 20 people who resigned AFTER being
 * paid vanished from the dashboard, the export and the bank transfer file, and their
 * payslip document 404'd from the Payslips Center. Ten of the twenty were still
 * working through June (last working dates 2026-07-07..2026-08-31).
 *
 * These tests lock the surviving rule — access scope, i.e. "who may this VIEWER see" —
 * and lock OUT the employment-status limb that must never filter an existing batch.
 */
export function runPayrollBatchMembershipTests() {
  // One paid batch. Two of its people have since resigned and been flagged
  // payroll_eligible=false in the directory; both limbs used to hide them.
  const paidBatchRows = [
    { employee_code: "B-4", hr_id: "B-4", net_salary: 30000 },
    { employee_code: "B-28", hr_id: "B-28", net_salary: 30000 },
    { employee_code: "B-97", hr_id: "B-97", net_salary: 16500 },
    { employee_code: "B-171", hr_id: "B-171", net_salary: 18500 },
    { employee_code: "PD-0003", hr_id: "PD-0003", net_salary: 17000 },
  ];
  const resignedSinceBatch = new Set(["B-171", "PD-0003"]);
  const batchNet = 112000;
  const sumNet = (rows: Array<{ net_salary: number }>) =>
    rows.reduce((total, row) => total + row.net_salary, 0);

  // -- COMPANY / system read: the whole batch, unconditionally.
  const companyViewer: PayrollAccessFilter = { all: true, allowedHrIds: new Set() };
  const companyRows = filterPayrollRowsByAccess(paidBatchRows, companyViewer);

  assert.equal(
    companyRows.length,
    paidBatchRows.length,
    "every row a paid batch holds must stay visible — a resignation after payday cannot retroactively remove someone from the month they were paid for",
  );
  assert.equal(
    sumNet(companyRows),
    batchNet,
    "the displayed net must equal the net the batch actually holds, because the same read feeds the bank transfer file and a short total means real people go unpaid",
  );
  resignedSinceBatch.forEach((hrId) => {
    assert.ok(
      companyRows.some((row) => row.hr_id === hrId),
      `${hrId} resigned after this batch was paid, so the batch — and their payslip document — must still contain them`,
    );
  });

  // -- Access scope survives: it is the only legitimate reason to drop a row.
  const managerViewer: PayrollAccessFilter = {
    all: false,
    allowedHrIds: new Set(
      ["B-97", "B-171"].map((hrId) => normalizeHrId(hrId) as string),
    ),
  };
  const managerRows = filterPayrollRowsByAccess(paidBatchRows, managerViewer);

  assert.deepEqual(
    managerRows.map((row) => row.hr_id).sort(),
    ["B-171", "B-97"],
    "a scoped viewer still sees only their own people — removing the employment filter must not widen who a manager can read",
  );
  assert.ok(
    managerRows.some((row) => row.hr_id === "B-171"),
    "a resigned employee inside the viewer's scope stays readable — scope decides visibility, employment status does not",
  );

  const deniedViewer: PayrollAccessFilter = { all: false, allowedHrIds: new Set() };
  assert.equal(
    filterPayrollRowsByAccess(paidBatchRows, deniedViewer).length,
    0,
    "a viewer with no allowed HR_IDs reads nothing — an empty scope must stay a deny, never fall through to the whole batch",
  );

  // -- Flags follow the same rule as the rows they annotate.
  const flags: SalaryFlag[] = [
    { batchId: "b1", createdAt: "2026-06-30T00:00:00.000Z", flagType: "net_variance", hrId: "B-171", id: "f1", message: "Net changed", severity: "warning" },
    { batchId: "b1", createdAt: "2026-06-30T00:00:00.000Z", flagType: "net_variance", hrId: "B-97", id: "f2", message: "Net changed", severity: "warning" },
    { batchId: "b1", createdAt: "2026-06-30T00:00:00.000Z", flagType: "sheet_totals", hrId: null, id: "f3", message: "Totals row ignored", severity: "info" },
  ];

  assert.equal(
    filterPayrollFlagsByAccess(flags, companyViewer).length,
    flags.length,
    "a leaver's governance flag is part of the batch's approval history and must not disappear with them",
  );
  assert.deepEqual(
    filterPayrollFlagsByAccess(flags, managerViewer).map((flag) => flag.id).sort(),
    ["f1", "f2", "f3"],
    "batch-level flags carry no HR_ID and stay visible, while employee flags follow the viewer's scope",
  );

  // -- Wiring: the read path must not reach for the directory's current employment.
  const serviceSource = readFileSync(
    new URL("../src/lib/payroll/service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    serviceSource,
    /isPayrollIneligibleEmployee/,
    "payroll read views must not consult the payroll-eligibility rule — that rule answers who belongs in a NEW batch, and applying it to an existing one deletes paid employees",
  );
  assert.doesNotMatch(
    serviceSource,
    /ineligibleHrIds/,
    "no eligibility blocklist may be threaded through the access filter again; tangling it with scope is what hid 20 of June 2026's 123 rows",
  );
  assert.doesNotMatch(
    serviceSource,
    /includeInactive/,
    "the read path must not load the inactive roster — it only ever did so to build the blocklist that hid leavers from batches they were paid in",
  );
}
