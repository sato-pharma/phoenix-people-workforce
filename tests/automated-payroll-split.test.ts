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
  // workingDays/calendarDays joined this shape on 2026-09-04, when the owner
  // asked for the FULL salary on the sheet with a Working Days column to explain
  // it. A regular row is the whole month on both counts. Asserted with the rest
  // of the shape deliberately: this deepEqual is what catches a field being
  // added to the money struct without anyone deciding what it should hold.
  assert.deepEqual(regular, {
    base: BASE,
    ecol: ECOL,
    fuel: FUEL,
    net: NET,
    lifecycle: "regular",
    workingDays: 30,
    calendarDays: 30,
  });

  // ---- effectiveSalary: a joiner prorates EVERY component by the days worked,
  // ECoL and Fuel included (owner instruction 2026-08-29 — the >15th halving
  // that used to sit here is retired) -----------------------------------------
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
  assert.equal(joinerEarly.ecol, 700); // 1000 × 21/30 — was paid whole under the retired rule
  assert.equal(joinerEarly.fuel, 350); // 500 × 21/30
  assert.equal(joinerEarly.net, 22050); // = 31,500 net × 21/30
  assert.equal(joinerEarly.lifecycle, "joiner");

  // ---- joiner hired the day after the old cliff. The figures below are the
  // one case where the retired rule and this one AGREE: hired on the 16th of a
  // 30-day month is exactly half the month, so "half the allowance" and "the
  // allowance × 15/30" are the same number. That is a coincidence of this
  // fixture, not the rule surviving — joinerEarly above is what tells them
  // apart. -------------------------------------------------------------------
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
  assert.equal(joinerLate.ecol, 500); // 1000 × 15/30
  assert.equal(joinerLate.fuel, 250); // 500 × 15/30
  assert.equal(joinerLate.net, 15750); // = 31,500 net × 15/30

  // ---- leaver on/before the 25th → NET proration, every component at the same
  // day share. Owner instruction 2026-08-29, the second of two that day: the
  // zeros this used to assert were the retired rule, which withheld both
  // allowances from a leaver outright. ---------------------------------------
  const leaverEarly = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "leaver",
    isResignation: true, // these cases are all genuine resignations
    // Was the 20th. Moved to the 18th when the rule changed on 2026-08-29: on
    // net, the 20th pays 31,500 × 20/30 = 21,000, which is exactly the Basic
    // anchor — and every freezeFirstPart case below this one is built on this
    // fixture being a leaver whose settlement is BELOW Basic. Landing on the
    // equality boundary would have left those cases passing while no longer
    // testing the shape they are named for.
    lastWorkingDate: "2026-06-18", // 18 days
  });
  assert.equal(leaverEarly.base, 18000); // 1000/day × 18
  assert.equal(leaverEarly.ecol, 600, "ECoL prorates with the base now — it is no longer withheld"); // 1000 × 18/30
  assert.equal(leaverEarly.fuel, 300, "Fuel prorates with the base now — it is no longer withheld"); // 500 × 18/30
  assert.equal(leaverEarly.net, 18900); // = 31,500 net × 18/30
  assert.ok(leaverEarly.net < BASIC, "this fixture must stay BELOW the Basic anchor — the freezeFirstPart cases below depend on it");

  // ---- leaver after the 25th → full Base + ECoL + Fuel ----------------------
  const leaverLate = effectiveSalary({
    baseSalary: BASE,
    extraCostOfLiving: ECOL,
    fuelAllowance: FUEL,
    netSalary: NET,
    period: JUNE,
    lifecycle: "leaver",
    isResignation: true, // these cases are all genuine resignations
    lastWorkingDate: "2026-06-28",
  });
  // Paid the FULL month under Rule 1 — and he was here 28 of June's 30 days,
  // which is what the count reports. That pair is the whole point of the column:
  // the money is waived UP to a full month, and the calendar is not rewritten to
  // match it. Report 30 here and this sheet contradicts the Ready sheet for the
  // same person.
  assert.deepEqual(leaverLate, {
    base: BASE,
    ecol: ECOL,
    fuel: FUEL,
    net: NET,
    lifecycle: "leaver",
    workingDays: 28,
    calendarDays: 30,
  });

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
  // leaverEarly net = 18900 < Basic 21000 → firstPart = min(21000, 18900) − FP.
  assert.equal(
    freezeFirstPart({ effective: leaverEarly, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 0 }),
    18900,
  );

  // ---- freezeFirstPart never goes negative ---------------------------------
  assert.equal(
    freezeFirstPart({ effective: regular, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 99999 }),
    0,
  );

  // ---- freezeFirstPart: joiner Basic anchor uses the FULL base, not the -----
  // prorated one (bug fixed 2026-07-26, Ahmed Nagy PD-0006 case). Before the
  // fix, anchorBase used effective.base (already prorated), so a joiner's
  // Basic got scaled down TWICE — once from the anchor, once from effNet
  // already being prorated — silently shrinking First Part below what 70% of
  // their real monthly base should have allowed.
  //
  // joinerLate: prorated base=15000, net=15750. Full-base Basic = 0.70×30000 =
  // 21000. min(21000, 15750) = 15750 → the WHOLE prorated net lands in First
  // Part (the owner's "if working days value is less than 70% of base salary
  // then all in 1st part" rule). The old buggy anchor (0.70×15000=10500)
  // would have produced 10500 instead — a materially wrong, smaller number.
  assert.equal(
    freezeFirstPart({ effective: joinerLate, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 0 }),
    15750,
  );

  // joinerEarly: prorated base=21000, net=22050. Full-base Basic = 21000 still
  // caps it: min(21000, 22050) = 21000. The old buggy anchor
  // (0.70×21000=14700) would have produced 14700 instead — again wrong.
  assert.equal(
    freezeFirstPart({ effective: joinerEarly, fullBaseSalary: BASE, paymentMode: "two_parts", fingerprint: 0 }),
    21000,
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

  // ---- two-part LEAVER medical insurance (owner rule 2026-07-26): folded into
  // the SAME shortfall-netting as leaverDeduction, not deferred to a Second
  // Part that may not exist — a leaver has no next month to recover an
  // un-netted medical insurance amount via carry-forward. ---------------------

  // Real case: leaverEarly's settlement (net=18900) already exactly equals its
  // own Basic-anchor first part (min(21000,18900)=18900), so provisional Second
  // headroom is ALREADY ZERO before any deduction — the exact "gets it all in
  // First Part, no Second Part" shape (Amany/Eman). Medical insurance must now
  // come straight out of First Part, not vanish into an unrecoverable residual.
  assert.equal(
    freezeFirstPart({
      effective: leaverEarly,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      medicalInsurance: 400,
    }),
    18500, // 18900 - 400, headroom was already 0
  );

  // Medical insurance ADDS to CRM/vacation in the same shortfall pool, not a
  // separate independent deduction — both must come out of the same First Part.
  assert.equal(
    freezeFirstPart({
      effective: leaverEarly,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      leaverDeduction: 2000,
      medicalInsurance: 400,
    }),
    16500, // 18900 - 2000 - 400
  );

  // leaverLate has real Second-Part headroom (10500) — medical insurance that
  // fits inside it must NOT touch First Part (matches the existing
  // leaverDeduction-fits-headroom case above, same mechanism, same numbers).
  assert.equal(
    freezeFirstPart({
      effective: leaverLate,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      medicalInsurance: 400,
    }),
    21000,
  );

  // Combined CRM/vacation (10000) + medical (3000) = 13000 exceeds the 10500
  // headroom by 2500 -> that shortfall (not the whole 13000) spills into First.
  assert.equal(
    freezeFirstPart({
      effective: leaverLate,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      leaverDeduction: 10000,
      medicalInsurance: 3000,
    }),
    18500, // 21000 - 2500
  );

  // One-part leavers are UNCHANGED: medical insurance still comes out of First
  // Part directly (the pre-existing owner rule 2026-07-24), exactly once — not
  // ALSO folded into the leaver shortfall pool, which would double-count it.
  assert.equal(
    freezeFirstPart({
      effective: leaverEarly,
      fullBaseSalary: BASE,
      paymentMode: "one_part",
      fingerprint: 0,
      medicalInsurance: 400,
    }),
    18500, // 18900 - 400, taken directly — same number, but via the OTHER path
  );

  // Continuing (non-leaver) two-part employees are UNCHANGED: medical insurance
  // has zero effect on First Part regardless of amount — still deferred
  // entirely to a real future Second Part.
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      medicalInsurance: 5000,
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

  // ---- deductions larger than the WHOLE month are carried, not lost (audit 2026-11-07) ----
  // totalPayable floors at 0, so the 350 beyond it used to disappear: 31500 − 31850 = −350.
  const beyondMonth = assembleParts({
    effective: regular,
    paymentMode: "two_parts",
    firstPartFrozen: BASIC,
    additions: { ...noAdditions },
    deductions: { ...noDeductions, unpaidVacations: 31500, medicalInsurance: 350 },
  });
  assert.equal(beyondMonth.totalPayable, 0, "the locked engine still floors the month at zero");
  assert.equal(beyondMonth.secondPart, 0);
  assert.equal(
    beyondMonth.overpaidResidual,
    21350,
    "HEADLINE: the residual is the 21000 already paid plus the 350 the floor hid",
  );
  // Nothing paid yet and deductions beyond the month: the excess is still owed.
  const nothingPaid = assembleParts({
    effective: regular,
    paymentMode: "two_parts",
    firstPartFrozen: 0,
    additions: { ...noAdditions },
    deductions: { ...noDeductions, otherDeductions: 32000 },
  });
  assert.equal(nothingPaid.overpaidResidual, 500, "500 beyond a month nobody was paid for is carried");

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

  // ---- Special Situations (owner rule 2026-07-25): an addition HR routes to the
  // First Part INCREASES the frozen amount — the first time this formula has ever
  // had an addition term (every other input here only reduces First Part). -----
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      otherPart1Additions: 800,
    }),
    21800, // 21000 + 800
  );

  // ---- the addition and the "Other deductions" term combine correctly (both
  // apply independently, order-agnostic since it's plain addition/subtraction) -
  assert.equal(
    freezeFirstPart({
      effective: regular,
      fullBaseSalary: BASE,
      paymentMode: "two_parts",
      fingerprint: 0,
      otherPart1Deductions: 1500,
      otherPart1Additions: 800,
    }),
    20300, // 21000 − 1500 + 800
  );

  // ---- reconciliation: First+Second still equals Total when a Special
  // Situations addition routed to "first" is ALSO included in the whole-month
  // addition sum (same double-bookkeeping pattern as otherDeductions above) ----
  const onePartFrozenWithSpecialAddition = freezeFirstPart({
    effective: regular,
    fullBaseSalary: BASE,
    paymentMode: "one_part",
    fingerprint: 0,
    otherPart1Additions: 1000,
  }); // 32500
  const onePartWithSpecialAddition = assembleParts({
    effective: regular,
    paymentMode: "one_part",
    firstPartFrozen: onePartFrozenWithSpecialAddition,
    additions: { ...noAdditions, otherAdditions: 1000 },
    deductions: { ...noDeductions },
  });
  // totalPayable = 31500 + 1000 = 32500 → equals the frozen First Part exactly.
  assert.equal(onePartWithSpecialAddition.totalPayable, 32500);
  assert.equal(onePartWithSpecialAddition.firstPart, 32500);
  assert.equal(onePartWithSpecialAddition.secondPart, 0);
  assert.equal(onePartWithSpecialAddition.overpaidResidual, 0);
  assert.equal(
    onePartWithSpecialAddition.firstPart + onePartWithSpecialAddition.secondPart,
    onePartWithSpecialAddition.monthSalary,
  );
}
