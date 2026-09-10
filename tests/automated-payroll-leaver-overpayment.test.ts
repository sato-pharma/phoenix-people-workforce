import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

import { assembleParts, freezeFirstPart, type EffectiveSalary } from "../src/lib/automated-payroll/split.ts";
import { computeResignationSettlement } from "../src/lib/payroll/copilot/proration.ts";

/**
 * A leaver's frozen first instalment was inflated by his own Part-1 deductions, and he was overpaid.
 *
 * THE RULE. A leaver's final CRM and unpaid-vacation charge nets against his own remaining Second
 * Part first; any shortfall spills into the First Part, because — unlike a continuing employee — he
 * has no next month to carry an unresolved residual to.
 *
 * THE DEFECT. "His own remaining Second Part" was measured as `effNet - firstAfterFp`, and
 * `firstAfterFp` has already had fingerprint, the Part-1 other-deduction tabs and (one-part only)
 * medical insurance subtracted from it. So the remainder it measured WAS those deductions, treated
 * as spare Second Part still available to absorb the final charge. The shortfall came out too small,
 * too little was taken off the frozen First Part, and the leaver was paid more than the month owed.
 *
 * WHY IT WAS INVISIBLE. The excess does not surface as an error. assembleParts clamps Second Part to
 * zero and books the difference as an `overpaidResidual` — a debt to recover next month, from a
 * leaver who has no next month. It read as a recoverable balance and was neither recoverable nor,
 * really, a debt: it was simply money out.
 *
 * The fix measures the remainder from the Part-1 ANCHOR (`firstBeforeFp`), which is what "how much
 * of this month's net is not anchored to the first instalment" actually means.
 */

function effective(net: number, base = net): EffectiveSalary {
  return {
    base,
    ecol: 0,
    fuel: 0,
    net,
    lifecycle: "leaver",
    workingDays: 30,
    calendarDays: 30,
  };
}

export function runAutomatedPayrollLeaverOverpaymentTests() {
  // ---- HEADLINE: the one-part leaver from the audit, worked through --------------------------
  // Net 12,000. Fingerprint 400, loan 600, medical 300, final CRM/vacation 1,500.
  // A one-part employee has NO second part at all, so the whole 1,500 must come out of Part 1.
  const frozen = freezeFirstPart({
    effective: effective(12000),
    fullBaseSalary: 12000,
    paymentMode: "one_part",
    fingerprint: 400,
    otherPart1Deductions: 600,
    medicalInsurance: 300,
    leaverDeduction: 1500,
  });

  // What the month actually owes: net minus every deduction.
  const owed = 12000 - 400 - 600 - 300 - 1500;
  assert.equal(owed, 9200);
  assert.equal(
    frozen,
    9200,
    "a one-part leaver has no Second Part, so his whole final charge must come off the First Part. " +
      "The old form measured 1,300 of 'remaining Second Part' — which was exactly the 400 + 600 + 300 " +
      "already deducted — and froze 10,500, overpaying by 1,300",
  );

  // And the overpayment really was invisible: assembleParts would have booked it as a recoverable
  // debt rather than reporting an error. Pin that the corrected freeze produces NO residual.
  const parts = assembleParts({
    effective: effective(12000),
    paymentMode: "one_part",
    firstPartFrozen: frozen,
    additions: { expenses: 0, incentive: 0, overtime: 0, bonus: 0, otherAdditions: 0 },
    deductions: {
      fingerprint: 400,
      crm: 1500,
      unpaidVacations: 0,
      medicalInsurance: 300,
      loans: 600,
      otherDeductions: 0,
    },
  });
  assert.equal(parts.totalPayable, 9200, "the locked engine agrees on what the month owes");
  assert.equal(parts.firstPart, 9200);
  assert.equal(parts.secondPart, 0);
  assert.equal(
    parts.overpaidResidual,
    0,
    "with the freeze corrected there is no residual — the old 10,500 freeze produced a 1,300 " +
      "'overpayment to recover next month' against someone who has no next month",
  );

  // The old behaviour, stated as a fixture so a revert is recognised on sight: a freeze of 10,500
  // against a payable of 9,200 books exactly the 1,300 that used to be paid out.
  const asItWas = assembleParts({
    effective: effective(12000),
    paymentMode: "one_part",
    firstPartFrozen: 10500,
    additions: { expenses: 0, incentive: 0, overtime: 0, bonus: 0, otherAdditions: 0 },
    deductions: {
      fingerprint: 400,
      crm: 1500,
      unpaidVacations: 0,
      medicalInsurance: 300,
      loans: 600,
      otherDeductions: 0,
    },
  });
  assert.equal(asItWas.overpaidResidual, 1300, "fixture: the old freeze overpaid by exactly 1,300");

  // ---- A two-part leaver with room to absorb is UNCHANGED ------------------------------------
  // This is the case that must not move: the fix only bites where the settlement has collapsed.
  const roomy = freezeFirstPart({
    effective: effective(20000),
    fullBaseSalary: 20000,
    paymentMode: "two_parts",
    fingerprint: 400,
    otherPart1Deductions: 0,
    medicalInsurance: 300,
    leaverDeduction: 1000,
  });
  // Basic is 70% of base = 14,000; minus the 400 fingerprint = 13,600. The 1,300 of CRM + medical
  // fits inside the 6,000 of Second Part, so nothing spills and the freeze is untouched.
  assert.equal(roomy, 13600, "a two-part leaver whose Second Part can absorb the charge is unaffected");

  // ---- A two-part leaver whose Second Part CANNOT absorb it ----------------------------------
  // Net 15,000, basic 10,500, so Second Part is 4,500. A 6,000 final charge overruns it by 1,500.
  const tight = freezeFirstPart({
    effective: effective(15000),
    fullBaseSalary: 15000,
    paymentMode: "two_parts",
    fingerprint: 500,
    otherPart1Deductions: 0,
    medicalInsurance: 0,
    leaverDeduction: 6000,
  });
  // Anchor 10,500; after fingerprint 10,000. Second Part is measured from the ANCHOR: 15,000 -
  // 10,500 = 4,500. Shortfall 6,000 - 4,500 = 1,500. Frozen 10,000 - 1,500 = 8,500.
  //
  // Measured the old way it would have been 15,000 - 10,000 = 5,000 of "remaining Second Part",
  // a shortfall of 1,000, and a freeze of 9,000 — 500 too high, which is exactly the 500
  // fingerprint that had already been taken.
  assert.equal(
    tight,
    8500,
    "the shortfall must be measured against the Second Part the leaver really has, not against a " +
      "remainder that includes his own already-deducted Part-1 charges",
  );

  // The whole month reconciles at the corrected freeze.
  const tightParts = assembleParts({
    effective: effective(15000),
    paymentMode: "two_parts",
    firstPartFrozen: tight,
    additions: { expenses: 0, incentive: 0, overtime: 0, bonus: 0, otherAdditions: 0 },
    deductions: {
      fingerprint: 500,
      crm: 6000,
      unpaidVacations: 0,
      medicalInsurance: 0,
      loans: 0,
      otherDeductions: 0,
    },
  });
  assert.equal(tightParts.totalPayable, 15000 - 500 - 6000);
  assert.equal(tightParts.overpaidResidual, 0, "no phantom debt against a leaver who has no next month");

  // ---- A non-leaver is never touched by this path ---------------------------------------------
  const continuing = freezeFirstPart({
    effective: { ...effective(20000), lifecycle: "regular" },
    fullBaseSalary: 20000,
    paymentMode: "two_parts",
    fingerprint: 400,
    otherPart1Deductions: 600,
    medicalInsurance: 300,
    leaverDeduction: 5000,
  });
  assert.equal(
    continuing,
    13000,
    "a continuing employee's leaverDeduction is ignored entirely — he has a next month, and the " +
      "spill rule is a leaver rule",
  );

  // ---- ONE MECHANISM CHARGES A LEAVER'S UNPAID LEAVE, NOT TWO --------------------------------
  //
  // `computeResignationSettlement` used to subtract approved unpaid-leave days from the days a
  // leaver is paid for. The Deductions module raises an unpaid-vacation candidate from the very
  // same `v2_vacation_requests` rows, and payroll charges it on the Unpaid Vacation tab — so the
  // days came off the pay and the money came off again.
  //
  // Unified on the admin-edited figure (owner, 2026-09-11: "we must unify... what really wins,
  // admin edit outputs"). Days worked is now the calendar count to the last working day, and the
  // reviewable deduction is the single charge.
  const june = { month: 6, year: 2026 };
  const settlement = computeResignationSettlement({
    baseSalary: 30000,
    extraCostOfLiving: 0,
    fuelAllowance: 0,
    lastWorkingDate: "2026-06-20",
    period: june,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  assert.ok(settlement);
  assert.equal(
    settlement.daysWorked,
    20,
    "days worked is the calendar count to the last working day — nothing is netted out of it here, " +
      "because the deduction the admin reviews is what charges unpaid leave",
  );

  // THE UNIFICATION ITSELF. The second opinion is not merely unused, it is gone: no payroll source
  // file may carry `unpaidDaysInSpan` as code again, or the two mechanisms drift apart a second
  // time. Comments naming the retired field are allowed — they are the record of why it went.
  const roots = [
    "src/lib/automated-payroll",
    "src/lib/payroll/copilot",
    "src/lib/payroll/ready-proration.ts",
    "src/lib/resignations",
  ];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of walkTypeScript(root)) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      if (code.includes("unpaidDaysInSpan")) offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a leaver's unpaid leave must be charged in ONE place. `unpaidDaysInSpan` was the second " +
      "opinion — it subtracted days from the settlement while the Deductions module charged the " +
      "same approved requests as money. Reintroducing it re-creates the double charge",
  );
}

/** Every .ts file under a path (or the file itself), for the source sweep above. */
function walkTypeScript(target: string): string[] {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) return target.endsWith(".ts") ? [target] : [];
  const out: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const next = `${target}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTypeScript(next));
    else if (entry.name.endsWith(".ts")) out.push(next);
  }
  return out;
}
