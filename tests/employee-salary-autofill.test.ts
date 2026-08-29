import assert from "node:assert/strict";

import {
  DEFAULT_EXTRA_COST_OF_LIVING,
  DEFAULT_FUEL_ALLOWANCE,
  deriveSalaryFromNet,
  grossUpFromBase,
  resolveTitleAllowances,
} from "../src/lib/payroll/salary-autofill.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/defaults.ts";

const CONFIG = DEFAULT_STATUTORY_CONFIG;

/**
 * Employee Master salary auto-fill: type the NET, everything else follows.
 *
 * The owner's requirement, in his words, is that base, basic and net "do not
 * change as I calculate them" while the gross may move to whatever the Egyptian
 * statutory treatment actually requires. These tests pin exactly that boundary.
 */
export function runEmployeeSalaryAutofillTests() {
  // --- the owner's own worked example -------------------------------------
  // "net seventeen and a half ... this employee is a Medical Rep, then his base
  // salary will be fifteen, and then his basic will be the ten five hundred, and
  // the extra cost of living two thousand and the fuel five hundred."
  const owner = deriveSalaryFromNet({ jobTitle: "Medical Representative", netSalary: 17500 });
  assert.ok(owner, "a positive net salary must produce a breakdown");
  assert.equal(owner.netSalary, 17500, "the net is what the owner typed and is never rewritten");
  assert.equal(owner.extraCostOfLiving, 2000, "Medical Representative cost of living");
  assert.equal(owner.fuelAllowance, 500, "Medical Representative fuel allowance");
  assert.equal(owner.baseSalary, 15000, "base = net - cost of living - fuel");
  assert.equal(owner.basicSalary, 10500, "basic = base x 70%");
  assert.equal(
    owner.insuranceWage,
    16700,
    "insured wage is the WHOLE wage clamped to the 2026 ceiling, not gross/1.3",
  );
  assert.equal(owner.socialInsurance, 1837, "employee share is 11% of the insured wage");
  assert.equal(owner.employerSocialInsurance, 3131.25, "employer share is 18.75%, a company cost");

  // --- THE HEADLINE: the deductions must return the typed base exactly ------
  // If this drifts, the Employee Master is showing a gross that does not
  // reconcile to the salary the owner actually agreed with the employee.
  for (let net = 3000; net <= 200000; net += 137) {
    const row = deriveSalaryFromNet({ jobTitle: "Medical Representative", netSalary: net });
    assert.ok(row, `net ${net} must produce a breakdown`);
    const backToBase = row.grossSalary - row.socialInsurance - row.taxes;
    assert.ok(
      Math.abs(backToBase - row.baseSalary) < 0.005,
      `gross - insurance - tax must return the base at net ${net}: got ${backToBase}, want ${row.baseSalary}`,
    );
    const backToNet = row.baseSalary + row.extraCostOfLiving + row.fuelAllowance;
    assert.ok(
      Math.abs(backToNet - net) < 0.005,
      `base + allowances must return the typed net at ${net}: got ${backToNet}`,
    );
  }

  // --- the statutory law cannot move base, basic or net --------------------
  // Same net, wildly different insurance parameters: the three the owner pinned
  // must be byte-identical, because none of them reads a statutory input.
  const strange = { ...CONFIG, siEmployeeRate: 0.25, siMaxMonthlyWage: 999999, siMinMonthlyWage: 1 };
  const underStrangeLaw = deriveSalaryFromNet(
    { jobTitle: "Medical Representative", netSalary: 17500 },
    strange,
  );
  assert.ok(underStrangeLaw);
  assert.equal(underStrangeLaw.baseSalary, owner.baseSalary, "base is immune to the statutory config");
  assert.equal(underStrangeLaw.basicSalary, owner.basicSalary, "basic is immune to the statutory config");
  assert.equal(underStrangeLaw.netSalary, owner.netSalary, "net is immune to the statutory config");
  assert.notEqual(
    underStrangeLaw.grossSalary,
    owner.grossSalary,
    "the gross is the field that absorbs a statutory change",
  );

  // --- the TAX cannot move with the insurance wage either ------------------
  // The taxable amount is (gross - employee SI) x 12 - exemption, and gross - SI
  // is identically base + tax, so the taxable base depends on the BASE alone and
  // the insurance wage cancels out. This is why correcting the insured wage
  // raises the insurance and the gross but never the income tax.
  const capped = { ...CONFIG, siMaxMonthlyWage: 16700 };
  const uncapped = { ...CONFIG, siMaxMonthlyWage: 999999 };
  for (const base of [6000, 10000, 15000, 21500, 36500, 64500]) {
    const a = grossUpFromBase(base, capped);
    const b = grossUpFromBase(base, uncapped);
    assert.equal(a.taxes, b.taxes, `income tax must not move with the insurance ceiling at base ${base}`);
    assert.ok(a.grossSalary <= b.grossSalary, `a higher insured wage cannot lower the gross at base ${base}`);
  }
  // ...and above the ceiling the two conventions agree entirely, which is why
  // 33 of the 105 active employees see no change at all.
  assert.equal(
    grossUpFromBase(21500, capped).grossSalary,
    grossUpFromBase(21500, { ...CONFIG, siMaxMonthlyWage: 16700 }).grossSalary,
  );

  // --- allowances by job title ---------------------------------------------
  assert.equal(resolveTitleAllowances("Medical Representative").extraCostOfLiving, 2000);
  assert.equal(resolveTitleAllowances("District Sales Manager").extraCostOfLiving, 3000);
  assert.equal(resolveTitleAllowances("National Sales Manager").extraCostOfLiving, 5000);
  assert.equal(resolveTitleAllowances("Group Product Manager").extraCostOfLiving, 3000);
  assert.equal(
    resolveTitleAllowances("Admin Assistant").extraCostOfLiving,
    DEFAULT_EXTRA_COST_OF_LIVING,
    "an office title falls to the measured default",
  );
  assert.equal(
    resolveTitleAllowances("Chief Widget Officer").extraCostOfLiving,
    DEFAULT_EXTRA_COST_OF_LIVING,
    "an unknown title must not throw or return NaN",
  );
  assert.equal(resolveTitleAllowances(null).fuelAllowance, DEFAULT_FUEL_ALLOWANCE);
  assert.equal(
    resolveTitleAllowances("  medical   REPRESENTATIVE ").extraCostOfLiving,
    2000,
    "title matching survives case and stray whitespace",
  );

  // --- an overridden allowance cascades ------------------------------------
  // Cost of living and fuel FEED the base, so overriding one has to move
  // everything below it -- unlike a pinned output, which only pins itself.
  const overridden = deriveSalaryFromNet({
    extraCostOfLiving: 0,
    jobTitle: "Medical Representative",
    netSalary: 17500,
  });
  assert.ok(overridden);
  assert.equal(overridden.extraCostOfLiving, 0, "the override is honoured");
  assert.equal(overridden.baseSalary, 17000, "base absorbs the removed allowance");
  assert.equal(overridden.basicSalary, 11900, "basic follows the base");
  assert.ok(overridden.grossSalary > owner.grossSalary, "a bigger base means a bigger gross");
  assert.ok(
    Math.abs(overridden.grossSalary - overridden.socialInsurance - overridden.taxes - 17000) < 0.005,
    "the round-trip still holds under an override",
  );

  // --- degenerate input must be quiet, never NaN ---------------------------
  assert.equal(deriveSalaryFromNet({ jobTitle: "Medical Representative", netSalary: 0 }), null);
  assert.equal(deriveSalaryFromNet({ jobTitle: "Medical Representative", netSalary: -5 }), null);
  assert.equal(deriveSalaryFromNet({ jobTitle: "Medical Representative", netSalary: Number.NaN }), null);
  const allowancesExceedNet = deriveSalaryFromNet({ jobTitle: "Admin Assistant", netSalary: 2000 });
  assert.ok(allowancesExceedNet);
  assert.equal(allowancesExceedNet.baseSalary, 0, "allowances larger than the net leave no base");
  assert.equal(allowancesExceedNet.grossSalary, 0, "and therefore no gross to report");
  for (const value of Object.values(grossUpFromBase(Number.NaN))) {
    assert.ok(Number.isFinite(value), "a non-finite base must not leak NaN into the form");
  }
}
