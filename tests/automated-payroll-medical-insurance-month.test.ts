import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEDICAL_INSURANCE_FROM_MODULE_SINCE,
  moduleChargesByCompact,
  PayrollMedicalInsuranceError,
  payrollMedicalInsuranceFor,
  payrollMedicalInsuranceSource,
  payrollMonthCoverWindow,
} from "../src/lib/automated-payroll/medical-insurance-month.ts";
import { compactHrKey } from "../src/lib/payroll/copilot/feeders.ts";
import { parseRateCard, type MedicalInsuranceRateCard } from "../src/lib/medical-insurance/cost.ts";
import { buildMonthlySplit, payrollChargesForWindow, type MonthlySplitMember } from "../src/lib/medical-insurance/monthly-split.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * WHERE A PAYROLL MONTH'S MEDICAL INSURANCE COMES FROM (owner, 2026-11-24: "in nov payroll remove med ins
 * dedctions and in december implement everyone med ins deductions from medical insurance module").
 *
 *   * October 2026 and earlier: the Employee Master's figure, untouched.
 *   * November 2026: nobody, one-part or two-part, Part 1 or Part 2.
 *   * December 2026 on: the Medical Insurance module's monthly split, `employeePays` of the employee's row.
 *
 * The month rule and the module's charge builder are pure and called here; the wiring into the payroll
 * population (a database read) is pinned on the source, the way the other automated-payroll tests pin theirs.
 */

const MIGRATION = "supabase/migrations/20261120134229_medical_insurance_rates_before_tax.sql";

function seededRateCard(): MedicalInsuranceRateCard {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("'{\n    \"currency\"");
  const end = sql.indexOf("}'::jsonb", start);
  assert.ok(start > 0 && end > start, "the migration seeds the policy's rate card");
  return parseRateCard(JSON.parse(sql.slice(start + 1, end + 1)));
}

const CARD = seededRateCard();

function member(overrides: Partial<MonthlySplitMember>): MonthlySplitMember {
  return {
    birthDate: "1990-01-01",
    category: "C",
    coverageEnd: null,
    coverageStart: "2026-11-22",
    hrId: "T-1",
    id: "m-1",
    memberType: "employee",
    name: "Test Person",
    principalMemberId: null,
    ...overrides,
  };
}

function testTheMonthPicksTheSource() {
  assert.equal(MEDICAL_INSURANCE_FROM_MODULE_SINCE, "2026-12");
  assert.equal(payrollMedicalInsuranceSource({ month: 9, year: 2026 }), "employee_master");
  assert.equal(payrollMedicalInsuranceSource({ month: 10, year: 2026 }), "employee_master", "October keeps its own Part 2 waiver in assemble.ts");
  assert.equal(payrollMedicalInsuranceSource({ month: 11, year: 2026 }), "waived", "November 2026 charges nobody");
  assert.equal(payrollMedicalInsuranceSource({ month: 12, year: 2026 }), "module", "December 2026 is the module's");
  assert.equal(payrollMedicalInsuranceSource({ month: 1, year: 2027 }), "module", "and every month after it");

  assert.deepEqual(payrollMonthCoverWindow({ month: 12, year: 2026 }), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(payrollMonthCoverWindow({ month: 2, year: 2027 }), { from: "2027-02-01", to: "2027-02-28" });

  const charges = new Map([["t1", 412.5]]);
  assert.equal(payrollMedicalInsuranceFor({ compact: "t1", masterFigure: 300, moduleCharges: null, source: "employee_master" }), 300);
  assert.equal(payrollMedicalInsuranceFor({ compact: "t1", masterFigure: null, moduleCharges: null, source: "employee_master" }), null);
  assert.equal(payrollMedicalInsuranceFor({ compact: "t1", masterFigure: 300, moduleCharges: null, source: "waived" }), 0, "November takes nothing, whatever the master says");
  assert.equal(payrollMedicalInsuranceFor({ compact: "t1", masterFigure: 300, moduleCharges: charges, source: "module" }), 412.5, "December takes the module's figure, not the master's");
  assert.equal(payrollMedicalInsuranceFor({ compact: "t9", masterFigure: 300, moduleCharges: charges, source: "module" }), 0, "someone not on the register pays nothing from December");
  assert.throws(
    () => payrollMedicalInsuranceFor({ compact: "t1", masterFigure: 300, moduleCharges: null, source: "module" }),
    PayrollMedicalInsuranceError,
    "a module month never falls back to the master or to zero when the module was not read",
  );
}

function testTheModuleChargeIsTheEmployeesShareOfTheMonth() {
  const members: MonthlySplitMember[] = [
    member({ hrId: "T-1", id: "e-1", name: "Family Employee" }),
    member({ birthDate: "1992-03-01", hrId: null, id: "s-1", memberType: "spouse", name: "Their Spouse", principalMemberId: "e-1" }),
    member({ birthDate: "1996-01-01", hrId: "T-2", id: "e-2", name: "Single Employee" }),
    member({ coverageStart: "2027-01-05", hrId: "T-3", id: "e-3", name: "January Joiner" }),
    member({ coverageEnd: "2026-11-30", hrId: "T-4", id: "e-4", name: "Left In November" }),
    member({ coverageEnd: "2026-12-10", hrId: "T-5", id: "e-5", name: "Leaves In December" }),
    member({ birthDate: "2010-01-01", hrId: null, id: "c-9", memberType: "child", name: "Stray Child", principalMemberId: "gone" }),
  ];
  const charges = payrollChargesForWindow({ from: "2026-12-01", members, rateCard: CARD, to: "2026-12-31" });
  const byHr = new Map(charges.map((charge) => [charge.hrId, charge]));

  assert.deepEqual([...byHr.keys()].sort(), ["T-1", "T-2", "T-5"], "covered on some day of December: not a later joiner, not a November leaver, never a stray relative");

  const split = buildMonthlySplit({ asOf: "2026-12-01", members: members.filter((m) => ["e-1", "s-1", "e-2", "e-5"].includes(m.id)), rateCard: CARD });
  for (const row of split.rows) {
    assert.ok(row.hrId);
    assert.equal(byHr.get(row.hrId)?.amount, row.employeePays, `${row.employee?.name} is charged exactly what the Cost tab shows them paying`);
  }
  const family = split.rows.find((row) => row.hrId === "T-1");
  assert.ok(family && family.people === 2 && family.familyMonthly > 0, "the spouse rides on the employee's charge");

  const compacted = moduleChargesByCompact(charges, compactHrKey);
  assert.equal(compacted.get("t1"), byHr.get("T-1")?.amount, "keyed by the payroll's compact HR id");

  const unpriced = payrollChargesForWindow({
    from: "2026-12-01",
    members: [member({ birthDate: null, hrId: "T-7", id: "e-7", name: "No Birth Date" })],
    rateCard: CARD,
    to: "2026-12-31",
  });
  assert.throws(() => moduleChargesByCompact(unpriced, compactHrKey), /No Birth Date/, "a covered employee who cannot be priced is refused by name, never undercharged");
}

function testThePayrollPopulationCarriesTheMonthsFigure() {
  const recommend = stripComments(readFileSync("src/lib/automated-payroll/recommend.ts", "utf8"));
  const loader = recommend.slice(recommend.indexOf("export async function resolvePayrollPopulationAndSources"));
  assert.match(loader, /payrollMedicalInsuranceSource\(period\)/, "the population loader asks which source the month uses");
  assert.match(loader, /getPayrollMedicalInsuranceCharges\(payrollMonthCoverWindow\(period\)\)/, "a module month reads the module's charges");
  assert.match(
    loader,
    /employee:\s*\{\s*\.\.\.employee,\s*medicalInsurance:\s*payrollMedicalInsuranceFor\(/,
    "every population member carries the month's medical insurance, so Part 1's freeze and Part 2 read the same figure",
  );

  const assemble = stripComments(readFileSync("src/lib/automated-payroll/assemble.ts", "utf8"));
  assert.match(assemble, /medicalInsurance:\s*roundCurrency\(num\(member\.employee\.medicalInsurance\)\)/, "Part 1's freeze reads the member's figure");
  assert.match(assemble, /part2MedicalInsurance\(employee\.medicalInsurance,/, "Part 2's assembly reads the member's figure");
}

export async function runAutomatedPayrollMedicalInsuranceMonthTests() {
  testTheMonthPicksTheSource();
  testTheModuleChargeIsTheEmployeesShareOfTheMonth();
  testThePayrollPopulationCarriesTheMonthsFigure();
}
