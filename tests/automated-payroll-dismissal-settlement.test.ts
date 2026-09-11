import assert from "node:assert/strict";

import { assembleRows } from "../src/lib/automated-payroll/assemble.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import { effectiveSalary } from "../src/lib/automated-payroll/split.ts";
import type { PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { computeResignationSettlement } from "../src/lib/payroll/copilot/proration.ts";
import { isResignationEmploymentStatus } from "../src/lib/payroll/leaver-kind.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * A DISMISSAL IS NOT A RESIGNATION, and Automated Payroll used to settle it as one.
 *
 * THE RULE (owner, 2026-08-14). Resignation Rule 1's generosity — a last working day after the
 * 25th is paid a FULL month of Base plus both allowances — belongs to genuine resignations only. A
 * `terminated` or `inactive` leaver has Base prorated to the days actually worked, keeps NEITHER
 * allowance, and gets no waiver.
 *
 * THE DEFECT. The Ready sheet applied that gate. The Automated Payroll engine did not, because it
 * identifies a leaver from the `employee_resignations` workflow and `proration.ts` carried a
 * comment asserting that this meant it could "never see" a dismissal. It can. The exit workflow is
 * how EVERY departure is recorded, whatever caused it — production carries a `terminated` employee
 * with an `employee_resignations` row at `exit_status = completed`. A workflow describes a process,
 * never a reason, so it could not have answered the question; the comment is why nobody checked.
 *
 * ARMED, NEVER FIRED. Both terminations on record left before the 25th (5 May and 7 July 2026),
 * where the waiver is not reached — which is exactly how a wrong comment survives for months.
 */

const JUNE: PayrollPeriod = { month: 6, year: 2026 };
const BASE = 30000;
const ECOL = 1000;
const FUEL = 500;

function compact(hrId: string): string {
  return hrId.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function member(hrId: string, employmentStatus: string, lastWorkingDate: string): PopulationMember {
  return {
    employee: {
      hrId,
      fullName: `Employee ${hrId}`,
      nameAr: null,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      areaName: "Cairo",
      hireDate: "2024-01-01",
      medicalInsurance: 0,
      bankName: "NBE",
      bankAccount: "123456",
      employmentStatus,
      lastWorkingDate,
    } as unknown as EmployeeDirectoryRow,
    compact: compact(hrId),
    lifecycle: "leaver",
    lastWorkingDate,
    noticeLastWorkingDate: null,
  };
}

function sources(hrIds: string[]): Map<string, PayrollSalarySource> {
  const source: PayrollSalarySource = {
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: BASE + ECOL + FUEL,
    grossSalary: BASE,
    socialInsurance: 0,
    employmentIncomeTax: 0,
    paymentMode: "two_parts",
  };
  const map = new Map<string, PayrollSalarySource>();
  for (const hrId of hrIds) {
    map.set(hrId.toLowerCase(), source);
    map.set(compact(hrId), source);
  }
  return map;
}

export function runAutomatedPayrollDismissalSettlementTests() {
  // ---- Who counts as a resignation --------------------------------------------------------------
  assert.equal(isResignationEmploymentStatus("resigned"), true);
  assert.equal(isResignationEmploymentStatus("Resigned"), true, "the status is stored in mixed case");
  assert.equal(isResignationEmploymentStatus("terminated"), false);
  assert.equal(isResignationEmploymentStatus("inactive"), false);
  assert.equal(
    isResignationEmploymentStatus(null),
    false,
    "an unreadable status withholds the generosity rather than granting it — a wrongly withheld " +
      "allowance is visible to the person it affects, a wrongly granted one is visible to nobody",
  );

  // ---- HEADLINE: a dismissal after the 25th is not paid a full month ----------------------------
  const dismissedLate = computeResignationSettlement({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    lastWorkingDate: "2026-06-28",
    isResignation: false,
    period: JUNE,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(dismissedLate);
  assert.equal(dismissedLate.branch, "non_resignation");
  // 28 of June's 30 days: 30,000 × 28/30 = 28,000. No allowances.
  assert.equal(dismissedLate.baseForMonth, 28000);
  assert.equal(dismissedLate.ecolPaid, 0, "a dismissal keeps neither allowance");
  assert.equal(dismissedLate.fuelPaid, 0, "a dismissal keeps neither allowance");
  assert.equal(dismissedLate.netForMonth, 28000);

  // The same person, had they resigned, is paid the full month with both allowances. The gap is
  // what the engine used to hand every dismissal.
  const resignedLate = computeResignationSettlement({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    lastWorkingDate: "2026-06-28",
    isResignation: true,
    period: JUNE,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(resignedLate);
  assert.equal(resignedLate.branch, "after_25");
  assert.equal(resignedLate.netForMonth, 31500, "a genuine resignation after the 25th is unchanged");
  assert.equal(
    resignedLate.netForMonth - dismissedLate.netForMonth,
    3500,
    "3,500 a month is what a late-month dismissal was being overpaid: two days of base it did not " +
      "work, plus both allowances the owner's ruling withholds",
  );

  // ---- Before the 25th the two also differ, on the allowances ------------------------------------
  // This is the half that would have fired on production's real terminations, both of which left
  // before the 25th. It has not, only because those months predate the automated engine.
  const dismissedEarly = computeResignationSettlement({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    lastWorkingDate: "2026-06-10",
    isResignation: false,
    period: JUNE,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  const resignedEarly = computeResignationSettlement({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    lastWorkingDate: "2026-06-10",
    isResignation: true,
    period: JUNE,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(dismissedEarly && resignedEarly);
  assert.equal(dismissedEarly.baseForMonth, 10000, "10 of 30 days of base");
  assert.equal(dismissedEarly.netForMonth, 10000, "base only");
  assert.equal(resignedEarly.netForMonth, 10500, "10 of 30 days of base AND both allowances");

  // ---- End to end through the run assembly -------------------------------------------------------
  // The engine must read the employee's own status. Two people, identical in every way except that
  // one resigned and one was dismissed, on the same late date.
  const resigned = "B-1";
  const dismissed = "B-2";
  const rows = assembleRows({
    members: [
      member(resigned, "resigned", "2026-06-28"),
      member(dismissed, "terminated", "2026-06-28"),
    ],
    sources: sources([resigned, dismissed]),
    draftRows: [],
    period: JUNE,
  });
  const byHr = new Map(rows.map((row) => [row.row.hrId, row]));
  assert.equal(
    byHr.get(dismissed)?.totalPayable,
    28000,
    "the run must settle a dismissal on base alone, prorated — reading the exit workflow instead " +
      "of the employment status paid it a full 31,500",
  );
  assert.equal(byHr.get(resigned)?.totalPayable, 31500, "the resignation beside it is untouched");

  // ---- A leaver with no answer is an ERROR, never a default --------------------------------------
  // Defaulting would have to default to "resignation", which is precisely the defect. So the one
  // thing a caller may not do is stay silent.
  assert.throws(
    () =>
      effectiveSalary({
        baseSalary: BASE,
        extraCostOfLiving: ECOL,
        fuelAllowance: FUEL,
        netSalary: BASE + ECOL + FUEL,
        period: JUNE,
        lifecycle: "leaver",
        lastWorkingDate: "2026-06-28",
      }),
    /isResignation/,
    "a leaver assembled without saying which kind of departure it is must fail loudly",
  );

  // A regular or joiner row has no departure to describe, so it must NOT be forced to answer.
  assert.doesNotThrow(() =>
    effectiveSalary({
      baseSalary: BASE,
      extraCostOfLiving: ECOL,
      fuelAllowance: FUEL,
      netSalary: BASE + ECOL + FUEL,
      period: JUNE,
      lifecycle: "regular",
    }),
  );
}
