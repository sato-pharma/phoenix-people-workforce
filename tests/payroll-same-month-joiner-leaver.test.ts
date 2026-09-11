import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeResignationSettlement } from "../src/lib/payroll/copilot/proration.ts";

/**
 * SOMEBODY HIRED AND GONE IN THE SAME MONTH IS PAID FROM THEIR HIRE DATE, NOT FROM THE 1st.
 *
 * FINDING 29. A person who both joined and left in one month is classified as a LEAVER only — the
 * leaver branch returns before the joiner branch is ever reached — and the settlement counted days
 * from the 1st. So it paid for days before the person was hired.
 *
 * The audit's worked case, on 18,000 net in a 31-day August: hired on the 20th, resigning on the
 * 24th, recommended 18,000 x 24/31 = 13,935.48 for five days of work. Leaving on the 26th instead
 * crossed the >25th waiver and recommended the FULL 18,000 for seven days.
 *
 * THE WAIVER WAIVES THE LEAVING END, NEVER THE JOINING ONE. That is the Ready sheet's rule, stated
 * there in as many words: "a same-month hire still pays for its own unworked start-of-month days".
 * The two surfaces disagreed because this calculation never saw a hire date, though its caller had
 * one in scope and simply discarded it.
 *
 * NOTHING HAS BEEN OVERPAID. Production carries five same-month joiner-leavers. The one who worked
 * the whole month needs no clamp; all three August cases were EXCLUDED from the run by hand, which
 * looks very much like HR working around this. So this is a latent correctness fix, not a recovery.
 *
 * The ordinary leaver — hired in an earlier month — must not move at all, and that is half of what
 * this file checks.
 */

const AUGUST = { month: 8, year: 2026 } as const;
const FEBRUARY = { month: 2, year: 2026 } as const;
// 15,500 + 2,000 + 500 = 18,000 net, the audit's own figures.
const PAY = { baseSalary: 15500, extraCostOfLiving: 2000, fuelAllowance: 500 };
const BASE = { ...PAY, period: AUGUST, otherAdditions: 0, otherDeductions: 0, isResignation: true };

export async function runPayrollSameMonthJoinerLeaverTests() {
  // ---- HEADLINE: the audit's worked case ------------------------------------------------------
  const hiredThe20thLeftThe24th = computeResignationSettlement({
    ...BASE,
    lastWorkingDate: "2026-08-24",
    hireDate: "2026-08-20",
  });
  assert.ok(hiredThe20thLeftThe24th);
  assert.equal(hiredThe20thLeftThe24th.daysWorked, 5, "the 20th to the 24th inclusive is five days");
  assert.equal(
    hiredThe20thLeftThe24th.netForMonth,
    2903.23,
    "five days of an 18,000 month is 2,903.23 — it used to recommend 13,935.49, paying for the " +
      "nineteen days before the person was hired",
  );

  // ---- The >25th waiver waives the LEAVING end only ------------------------------------------------
  const hiredThe20thLeftThe26th = computeResignationSettlement({
    ...BASE,
    lastWorkingDate: "2026-08-26",
    hireDate: "2026-08-20",
  });
  assert.ok(hiredThe20thLeftThe26th);
  assert.equal(hiredThe20thLeftThe26th.branch, "after_25", "the waiver still applies to the departure");
  assert.equal(
    hiredThe20thLeftThe26th.netForMonth,
    6967.74,
    "paid to month end from the hire date — twelve of thirty-one days. It used to recommend the " +
      "full 18,000 for seven days worked, which is the same rule the Ready sheet already refuses",
  );

  // ---- AN ORDINARY LEAVER DOES NOT MOVE ------------------------------------------------------------
  // This is the half that matters most: almost every leaver was hired in an earlier month.
  for (const hireDate of [null, undefined, "2025-03-01", "2026-07-31"]) {
    const onOrBefore = computeResignationSettlement({ ...BASE, lastWorkingDate: "2026-08-24", hireDate });
    assert.equal(onOrBefore?.daysWorked, 24, `hired ${String(hireDate)}: the span still starts on the 1st`);
    assert.equal(onOrBefore?.netForMonth, 13935.49, `hired ${String(hireDate)}: unchanged`);

    const after25 = computeResignationSettlement({ ...BASE, lastWorkingDate: "2026-08-26", hireDate });
    assert.equal(after25?.netForMonth, 18000, `hired ${String(hireDate)}: the waiver still pays the month`);
  }

  // ---- A dismissal keeps the clamp and still keeps neither allowance ---------------------------------
  const dismissed = computeResignationSettlement({
    ...BASE,
    isResignation: false,
    lastWorkingDate: "2026-08-24",
    hireDate: "2026-08-20",
  });
  assert.ok(dismissed);
  assert.equal(dismissed.branch, "non_resignation");
  assert.equal(dismissed.daysWorked, 5, "the clamp applies to a company-ended departure too");
  assert.equal(dismissed.ecolPaid, 0, "and a dismissal still keeps neither allowance");
  assert.equal(dismissed.fuelPaid, 0);
  assert.equal(dismissed.netForMonth, 2500, "15,500 x 5/31, base only");

  // ---- Hired and gone on the same day is one day, not nought ------------------------------------------
  // Two of the five on production are exactly this shape.
  const oneDay = computeResignationSettlement({
    ...BASE,
    lastWorkingDate: "2026-08-24",
    hireDate: "2026-08-24",
  });
  assert.equal(oneDay?.daysWorked, 1, "the span is inclusive at both ends");

  // ---- A short month moves the other way, and that is arithmetic, not a rule ---------------------------
  const february = computeResignationSettlement({
    ...BASE,
    period: FEBRUARY,
    lastWorkingDate: "2026-02-20",
    hireDate: "2026-02-16",
  });
  assert.equal(february?.daysWorked, 5, "five days in a 28-day month is still five days");
  assert.equal(february?.netForMonth, 3214.29, "but each one is worth more: 18,000 x 5/28");

  // ---- Every surface passes the date, so they cannot disagree -------------------------------------------
  // The defect existed because ONE caller discarded a date it already held. A second caller doing
  // the same would recreate it silently, on whichever screen HR happened to read.
  const callers: Array<[string, string]> = [
    ["src/lib/automated-payroll/split.ts", "hireDate: input.hireDate"],
    ["src/lib/automated-payroll/leaver-basis.ts", "hireDate: input.hireDate"],
    ["src/lib/payroll/copilot/assemble.ts", "hireDate: employee.hireDate"],
    ["src/lib/resignations/service.ts", "hireDate,"],
  ];
  for (const [file, expected] of callers) {
    assert.ok(
      readFileSync(file, "utf8").includes(expected),
      `${file} must pass the hire date into the settlement, or that surface still counts from the 1st`,
    );
  }

  // The two wizard steps that resolve a leaver's basis pass it too. Counted INSIDE each call rather
  // than across the file: `hireDate: member.employee.hireDate` appears elsewhere in recommend.ts for
  // an unrelated joiner call, and counting those made this assertion pass for the wrong reason.
  const recommend = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  let at = recommend.indexOf("resolveLeaverBasis({");
  let callSites = 0;
  while (at >= 0) {
    const call = recommend.slice(at, recommend.indexOf("});", at));
    assert.ok(
      call.includes("hireDate: member.employee.hireDate"),
      "every resolveLeaverBasis call must pass the hire date, or that step still counts from the 1st",
    );
    callSites += 1;
    at = recommend.indexOf("resolveLeaverBasis({", at + 1);
  }
  assert.equal(callSites, 2, `both leaver-basis call sites must be found (found ${callSites})`);
}
