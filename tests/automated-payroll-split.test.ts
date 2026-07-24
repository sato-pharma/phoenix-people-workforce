import assert from "node:assert/strict";

import {
  assembleParts,
  effectiveSalary,
  freezeFirstPart,
  type EffectiveSalary,
} from "../src/lib/automated-payroll/split.ts";
import type { PayrollPeriod } from "../src/lib/automated-payroll/types.ts";

// June 2026 = 30 days; July 2026 = 31 days — real calendar days.
const JUNE: PayrollPeriod = { month: 6, year: 2026 };

// Base 30,000 → Basic 21,000 (×0.70); Net 31,500 (= base + ecol + fuel).
const BASE = 30000;
const ECOL = 1000;
const FUEL = 500;
const NET = 31500;
const BASIC = 21000;

const noAdditions = { expenses: 0, incentive: 0, overtime: 0, bonus: 0, otherAdditions: 0 };
const noDeductions = {
  fingerprint: 0,
  crm: 0,
  unpaidVacations: 0,
  medicalInsurance: 0,
  loans: 0,
  otherDeductions: 0,
};

function regularEffective(): EffectiveSalary {
  return effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "regular",
  });
}

export function runAutomatedPayrollSplitTests() {
  // ---- effectiveSalary: regular carries master values unchanged -------------
  const regular = regularEffective();
  assert.deepEqual(regular, { base: BASE, ecol: ECOL, fuel: FUEL, net: NET, lifecycle: "regular" });

  // ---- effectiveSalary: joiner hired on/before the 15th → full ECoL/Fuel ----
  const joinerEarly = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "joiner",
    hireDate: "2026-06-10", // worked 30-10+1 = 21 days
  });
  assert.equal(joinerEarly.base, 21000); // 1000/day × 21
  assert.equal(joinerEarly.ecol, ECOL); // full
  assert.equal(joinerEarly.fuel, FUEL); // full
  assert.equal(joinerEarly.net, 22500);
  assert.equal(joinerEarly.lifecycle, "joiner");

  // ---- joiner hired AFTER the 15th → HALF ECoL/Fuel -------------------------
  const joinerLate = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "joiner",
    hireDate: "2026-06-16", // worked 30-16+1 = 15 days
  });
  assert.equal(joinerLate.base, 15000);
  assert.equal(joinerLate.ecol, 500); // half
  assert.equal(joinerLate.fuel, 250); // half
  assert.equal(joinerLate.net, 15750);

  // ---- leaver on/before the 25th → Base-only proration, no ECoL/Fuel --------
  const leaverEarly = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "leaver",
    lastWorkingDate: "2026-06-20", // 20 days
    unpaidDaysInSpan: 0,
  });
  assert.equal(leaverEarly.base, 20000);
  assert.equal(leaverEarly.ecol, 0);
  assert.equal(leaverEarly.fuel, 0);
  assert.equal(leaverEarly.net, 20000);

  // ---- leaver after the 25th → full Base + ECoL + Fuel ----------------------
  const leaverLate = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "leaver",
    lastWorkingDate: "2026-06-28",
    unpaidDaysInSpan: 0,
  });
  assert.deepEqual(leaverLate, { base: BASE, ecol: ECOL, fuel: FUEL, net: NET, lifecycle: "leaver" });

  // ---- HR settlement override wins over computed proration ------------------
  const overridden = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "joiner",
    hireDate: "2026-06-16",
    overrideBase: 18000,
  });
  assert.equal(overridden.base, 18000);
  assert.equal(overridden.net, 18000 + 500 + 250); // net recomputed from override + computed ecol/fuel

  // ---- freezeFirstPart: two-part anchors to Basic, minus fingerprint --------
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 0 }),
    BASIC,
  );
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 1000 }),
    20000, // 21000 − 1000
  );

  // ---- freezeFirstPart: one-part gets the full Net in Part 1, minus FP ------
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "one_part", fingerprint: 0 }),
    NET,
  );
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "one_part", fingerprint: 500 }),
    31000,
  );

  // ---- freezeFirstPart: leaver whose prorated net < Basic → net − FP --------
  // leaverEarly net = 20000 < Basic 21000 → firstPart = min(21000, 20000) − FP.
  assert.equal(
    freezeFirstPart({ effective: leaverEarly, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 0 }),
    20000,
  );

  // ---- freezeFirstPart never goes negative ---------------------------------
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 99999 }),
    0,
  );

  // ---- leaver-only netting (owner rule 2026-07-20): CRM+vacation deduction --
  // leaverLate: net=31500 (full base+ecol+fuel, after-25th branch), Basic=21000
  // (min(21000,31500)=21000) → provisional Second headroom = 31500-21000 = 10500.

  // Deduction fits entirely within the Second-Part headroom -> First unchanged.
  assert.equal(
    freezeFirstPart({
      effective: leaverLate,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      leaverDeduction: 2000,
    }),
    21000,
  );

  // Deduction exceeds the Second-Part headroom (10500) by 4500 -> shortfall spills into First.
  assert.equal(
    freezeFirstPart({
      effective: leaverLate,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      leaverDeduction: 15000,
    }),
    16500,
  );

  // Non-leavers ignore leaverDeduction entirely, even if passed by mistake.
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      leaverDeduction: 99999,
    }),
    BASIC,
  );

  // ---- assembleParts: First + Second == Total; FP counted once (Part 1) ----
  const frozen = freezeFirstPart({
    effective: regular,
    fullBaseSalary: BASE,
    paymentMode: "two_parts",
    fingerprint: 1000,
  }); // 20000
  const parts = assembleParts({
    effective: regular,
    paymentMode: "two_parts",
    firstPartFrozen: frozen,
    additions: { ...noAdditions, expenses: 2000 },
    deductions: { ...noDeductions, fingerprint: 1000, crm: 500 },
  });
  // totalPayable = Net 31500 + 2000 − (1000 + 500) = 32000
  assert.equal(parts.totalPayable, 32000);
  assert.equal(parts.firstPart, 20000);
  assert.equal(parts.secondPart, 12000);
  assert.equal(parts.monthSalary, 32000);
  assert.equal(parts.overpaidResidual, 0);
  assert.equal(parts.firstPart + parts.secondPart, parts.monthSalary);

  // ---- assembleParts: expenses always land in Part 2 (one-part reconciles) --
  const onePartFrozen = freezeFirstPart({
    effective: regular,
    fullBaseSalary: BASE,
    paymentMode: "one_part",
    fingerprint: 0,
  }); // 31500 (full net)
  const onePart = assembleParts({
    effective: regular,
    paymentMode: "one_part",
    firstPartFrozen: onePartFrozen,
    additions: { ...noAdditions, expenses: 3000 },
    deductions: { ...noDeductions },
  });
  // totalPayable = 31500 + 3000 = 34500; first = 31500 → second = 3000 (the expenses tail)
  assert.equal(onePart.totalPayable, 34500);
  assert.equal(onePart.firstPart, 31500);
  assert.equal(onePart.secondPart, 3000);
  assert.equal(onePart.monthSalary, 34500);

  // ---- assembleParts: Part-2 deductions exceed frozen First → overpaid clamp -
  const overpaid = assembleParts({
    effective: regular,
    paymentMode: "two_parts",
    firstPartFrozen: BASIC, // 21000 already paid in Part 1
    additions: { ...noAdditions },
    deductions: { ...noDeductions, otherDeductions: 25000 },
  });
  // totalPayable = 31500 − 25000 = 6500 < 21000 → clamp second to 0, residual carried
  assert.equal(overpaid.totalPayable, 6500);
  assert.equal(overpaid.firstPart, 21000);
  assert.equal(overpaid.secondPart, 0);
  assert.equal(overpaid.overpaidResidual, 14500);
  assert.equal(overpaid.monthSalary, 21000);

  // ---- owner rule 2026-07-24: one-part medical insurance comes out of Part 1 -
  // (they have no Second Part to net it against). Two-part employees are unaffected
  // — medical insurance stays netted against Second Part only, exactly as before.
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "one_part",
      fingerprint: 0,
      medicalInsurance: 400,
    }),
    31100, // 31500 (full net) − 400
  );
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      medicalInsurance: 400,
    }),
    BASIC, // unchanged — medical insurance ignored for two-part First Part
  );

  // ---- Part-1 "Other deductions" step total reduces First Part for EVERYONE -
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      otherPart1Deductions: 1500,
    }),
    19500, // 21000 − 1500
  );
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "one_part",
      fingerprint: 0,
      otherPart1Deductions: 1500,
      medicalInsurance: 400,
    }),
    29600, // 31500 − 1500 − 400
  );

  // ---- reconciliation: First+Second still equals Total when the Part-1 "Other
  // deductions" amount is also included in the whole-month deduction sum (the
  // same double-bookkeeping pattern fingerprint already uses) ------------------
  const onePartFrozenWithMedical = freezeFirstPart({
    effective: regular,
    fullBaseSalary: BASE,
    paymentMode: "one_part",
    fingerprint: 0,
    otherPart1Deductions: 1500,
    medicalInsurance: 400,
  }); // 29600
  const onePartWithMedical = assembleParts({
    effective: regular,
    paymentMode: "one_part",
    firstPartFrozen: onePartFrozenWithMedical,
    additions: { ...noAdditions },
    deductions: { ...noDeductions, medicalInsurance: 400, otherDeductions: 1500 },
  });
  // totalPayable = 31500 − 400 − 1500 = 29600 → equals the frozen First Part exactly.
  assert.equal(onePartWithMedical.totalPayable, 29600);
  assert.equal(onePartWithMedical.firstPart, 29600);
  assert.equal(onePartWithMedical.secondPart, 0);
  assert.equal(onePartWithMedical.overpaidResidual, 0);
  assert.equal(onePartWithMedical.firstPart + onePartWithMedical.secondPart, onePartWithMedical.monthSalary);
}
