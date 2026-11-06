import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decisionAfterLeaveBalanceCharge,
  isLeaveBalanceReason,
  planLeaveBalanceCharge,
} from "../src/lib/deductions/leave-balance.ts";
import { LEAVE_BALANCE_CATEGORIES, isLeaveBalanceCategory } from "../src/lib/deductions/types.ts";
import { foldLeaveBalanceCharges } from "../src/lib/deductions/leave-balance-ledger.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { calculateVacationPayment, isWithinFirstSixMonths } from "../src/lib/vacation/calculations.ts";
import { DEPARTED_EMPLOYMENT_STATUSES, hasDepartedEmployment } from "../src/lib/auth/session-lifecycle.ts";
import { annualBalanceLedgerDays, buildEmployeeEligibilityRows, requestableAnnualLeaveDays } from "../src/lib/vacation/service.ts";

/**
 * Deductions → "Deduct from leave balance" / "Return to salary" (owner, 2026-10-09).
 *
 *   "if someone have a crm with no record or half day, instead of deducting from salary add a button
 *    deduct from leave balance, and when it appears in his leave report it must show him the comment
 *    that I will write."
 *
 * His answers: annual balance only · take what is there and leave the rest on salary · the comment is
 * required and the employee reads it as written · it can be undone.
 *
 * Widened hours later, same day, on his word — "also show the deduct from balance in unpaid and
 * insufficient" — to Unpaid Vacation and Insufficient Balance Vacation. Section 0 pins the list and
 * every gate that has to agree with it.
 *
 *   1. the split between leave and salary, and the decision it leaves on the row;
 *   2. the ledger fold — a give-back nets the charge out, a re-charge shows the NEW comment;
 *   3. the balance the report and the portal show subtracts the days;
 *   4. the wiring that keeps the two sides from disagreeing: the decision guard, the route, the
 *      migration's shape, the screens that show the button and the comment;
 *   5. the first-six-months override he added once the widening landed — the accrued days are
 *      charged, the block on REQUESTING paid leave is untouched.
 *   6. an already-cleared row can be charged, and a PART charge on one puts nothing back on salary;
 *   7. the balance the Vacation Report shows goes DOWN by the charged days — for every row in that
 *      cohort, so the figure moves the way he asked — while the row still says the employee cannot
 *      request paid leave and the employee's own portal tile still offers them nothing; it counts
 *      EVERY annual-balance pool, says so when it cannot read them, and accrues by completed month.
 *   8. someone who has LEFT is SAID, never refused — the dialog names the day he stopped working and
 *      the charge still goes through, in both views, and the already-charged view actually reads it.
 *   9. a leaver whose balance has actually been spent GETS A ROW on the Entitlements tab, saying so,
 *      without widening request visibility and without moving the active-workforce totals.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function employee(hrId: string): EmployeeDirectoryRow {
  return {
    departmentName: "Sales",
    displayName: `Employee ${hrId}`,
    employmentStatus: "active",
    fullName: `Employee ${hrId}`,
    hireDate: "2023-01-10",
    hrId,
    lineName: "CNS",
    managerHrId: "A-1",
    managerName: "Manager One",
  } as unknown as EmployeeDirectoryRow;
}

type LedgerRow = Parameters<typeof foldLeaveBalanceCharges>[0][number];
function ledger(over: Partial<LedgerRow> & Pick<LedgerRow, "id" | "days">): LedgerRow {
  return {
    comment: null,
    created_at: "2026-10-09T10:00:00Z",
    created_by: "B-10",
    deduction_candidate_id: "cand-1",
    employee_hr_id: "MR-1",
    reverses_charge_id: null,
    work_date: "2026-09-27",
    ...over,
  } as LedgerRow;
}

export async function runDeductionsLeaveBalanceTests() {
  // 0. THE CATEGORIES, AND THE FOUR GATES THAT MUST AGREE ON THEM. Owner, 2026-10-09: "also show the
  // deduct from balance in unpaid and insufficient". A tab that shows the button while any one of the
  // other gates still refuses it is the whole failure mode — so the list is pinned once, and each
  // gate is checked for reading THAT list rather than a second copy of it.
  {
    assert.deepEqual(
      [...LEAVE_BALANCE_CATEGORIES],
      ["crm", "crm_half_day", "unpaid_vacation", "insufficient_balance_vacation"],
      "the leave-balance button covers CRM, CRM half day, Unpaid Vacation and Insufficient Balance Vacation",
    );
    assert.ok(isLeaveBalanceCategory("unpaid_vacation"), "Unpaid Vacation must be chargeable to the leave balance");
    assert.ok(isLeaveBalanceCategory("insufficient_balance_vacation"), "Insufficient Balance Vacation must be chargeable to the leave balance");
    assert.ok(!isLeaveBalanceCategory("fingerprint"), "a fingerprint deduction is not a leave day");
    assert.ok(!isLeaveBalanceCategory("loan") && !isLeaveBalanceCategory("other") && !isLeaveBalanceCategory(null));

    const workspace = read("src/components/admin/deductions-workspace.tsx");
    assert.match(
      workspace,
      /isLeaveBalanceCategory\(row\.category\) && row\.unit === "days"/,
      "the workspace must decide which rows show the button from the shared list, never from its own category test",
    );
    assert.match(workspace, /isLeaveBalanceCategory,[\s\S]{0,200}from "@\/lib\/deductions\/types\.ts"/);

    const decide = read("src/lib/deductions/service.ts");
    assert.match(
      decide,
      /input\.viaLeaveBalance !== true && isLeaveBalanceCategory\(candidateRow\.category\)/,
      "the decide guard must cover every category the button reaches, or a bulk decide takes the same day from salary AND leave",
    );

    const charge = read("src/lib/deductions/leave-balance.ts");
    assert.match(charge, /if \(!categoryTakesLeaveBalance\(candidate\.category\)\)/, "the charge service must gate on the shared list");
    assert.ok(
      !/LEAVE_BALANCE_CATEGORIES = \[/.test(charge),
      "the list must not be declared a second time here — types.ts owns it",
    );

    const sql = read("supabase/migrations/20261009210000_deductions_leave_balance_vacation_categories.sql");
    assert.match(
      sql,
      /category not in \('crm', 'crm_half_day', 'unpaid_vacation', 'insufficient_balance_vacation'\)/,
      "the database function is the last gate and must name the same four categories",
    );
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\(lower\(p_employee_hr_id\)\)\)/, "the widening must not drop the per-employee lock");
    assert.match(sql, /The annual balance changed while this was being saved/, "the widening must not drop the moved-balance refusal");
    // A migration that redefines a public SECURITY DEFINER function must restate its own revoke:
    // anon and authenticated inherit EXECUTE through PUBLIC membership, and a file that defines one
    // and says nothing about grants reads exactly like one that opened it up. check-migrations.mjs
    // fails the required `validate` job over this, which is how it was caught here.
    assert.match(
      sql,
      /revoke execute on function public\.phx_deductions_charge_leave_balance\([^)]*\) from public, anon, authenticated;/,
      "the redefinition must revoke EXECUTE from public, anon and authenticated",
    );
    assert.match(sql, /grant execute on function public\.phx_deductions_charge_leave_balance\([^)]*\) to service_role;/);
  }

  // 1a. THE SPLIT. Enough balance takes the whole deduction; a short balance takes what is there and
  // the rest stays on salary; an empty or unreadable balance takes nothing.
  {
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 1, coverableDays: 5 }), { chargeDays: 1, salaryDays: 0 });
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 3, coverableDays: 1.5 }), { chargeDays: 1.5, salaryDays: 1.5 });
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 0.5, coverableDays: 0.5 }), { chargeDays: 0.5, salaryDays: 0 });
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 2, coverableDays: 0 }), { chargeDays: 0, salaryDays: 2 });
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 2, coverableDays: null }), { chargeDays: 0, salaryDays: 2 });
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 0, coverableDays: 4 }), { chargeDays: 0, salaryDays: 0 });
  }

  // 1b. THE DECISION. Fully covered → cleared with nothing left on salary; part covered → approved for
  // payroll for ONLY the days leave could not pay. The comment is carried into the reason.
  {
    const full = decisionAfterLeaveBalanceCharge({ chargeDays: 1, salaryDays: 0, dueDays: 1, comment: "  Agreed with the manager  " });
    assert.equal(full.status, "Do Not Take Action");
    assert.equal(full.appliedValue, null);
    assert.ok(full.reason.includes("Agreed with the manager"));
    assert.ok(isLeaveBalanceReason(full.reason), "the reason must be recognisable, so an interrupted return can be finished");

    const part = decisionAfterLeaveBalanceCharge({ chargeDays: 1.5, salaryDays: 1.5, dueDays: 3, comment: "Balance ran out" });
    assert.equal(part.status, "Approved for Payroll");
    assert.equal(part.appliedValue, 1.5, "payroll must charge only the days the leave balance could not pay");
    assert.ok(isLeaveBalanceReason(part.reason));
    assert.ok(!isLeaveBalanceReason("Approved for payroll after review (2026-09)"));
  }

  // 2. THE LEDGER FOLD.
  {
    const charge = ledger({ id: 1, days: 1, comment: "First comment" });
    assert.equal(foldLeaveBalanceCharges([charge]).get("cand-1")?.days, 1);
    assert.equal(foldLeaveBalanceCharges([charge]).get("cand-1")?.comment, "First comment");

    const giveBack = ledger({ id: 2, days: -1, reverses_charge_id: 1, comment: null });
    assert.equal(foldLeaveBalanceCharges([charge, giveBack]).has("cand-1"), false, "a returned deduction is no longer on leave");

    const again = ledger({ id: 3, days: 0.5, comment: "Second comment" });
    const live = foldLeaveBalanceCharges([charge, giveBack, again]).get("cand-1");
    assert.equal(live?.days, 0.5);
    assert.equal(live?.comment, "Second comment", "the employee must read the CURRENT comment, never the returned one");

    assert.equal(foldLeaveBalanceCharges([ledger({ id: 9, days: 1, deduction_candidate_id: null, comment: "x" })]).size, 0, "a weekly-review charge is not a deductions charge");
  }

  // 3. THE BALANCE. 21 days, 1 taken for a deduction in the period → 20 left; a charge in another
  // period or for someone else changes nothing.
  {
    const today = "2026-06-15";
    const rep = employee("MR-1");
    const base = buildEmployeeEligibilityRows({ allScopedRows: [], employees: [rep], filters: {}, today });
    assert.equal(base[0]?.annualBalanceDays, 21);
    const charged = buildEmployeeEligibilityRows({
      allScopedRows: [],
      employees: [rep],
      filters: {},
      today,
      balanceCharges: [{ employeeHrId: "mr-1", workDate: "2026-03-02", days: 1 }],
    });
    assert.equal(charged[0]?.annualUsedDays, 1, "the days taken for a deduction count as used (HR id matched case-insensitively)");
    assert.equal(charged[0]?.annualBalanceDays, 20);
    const elsewhere = buildEmployeeEligibilityRows({
      allScopedRows: [],
      employees: [rep],
      filters: {},
      today,
      balanceCharges: [
        { employeeHrId: "MR-1", workDate: "2024-03-02", days: 1 },
        { employeeHrId: "MR-2", workDate: "2026-03-02", days: 1 },
      ],
    });
    assert.equal(elsewhere[0]?.annualBalanceDays, 21, "another period, or another person, must not touch this balance");
  }

  // 4a. THE DECISION GUARD. recordDecision refuses to decide a charged CRM deduction unless the call
  // comes from the leave-balance service itself — otherwise a bulk "Approve" would take the day from
  // salary AND leave.
  {
    const source = read("src/lib/deductions/service.ts");
    assert.match(source, /input\.viaLeaveBalance !== true && isLeaveBalanceCategory\(candidateRow\.category\)/);
    assert.match(source, /getLeaveBalanceChargeForCandidate\(input\.candidateId\)/);
    assert.ok(
      source.indexOf("getLeaveBalanceChargeForCandidate(input.candidateId)") < source.indexOf('.upsert(payload, { onConflict: "candidate_id" })'),
      "the guard must run before the decision is written",
    );
    assert.match(source, /if \(row\.source === "deductions"\) continue;/, "the weekly-review guard must not read a deductions charge as its own");
    const service = read("src/lib/deductions/leave-balance.ts");
    assert.equal((service.match(/viaLeaveBalance: true/g) ?? []).length, 2, "both the charge and the return decide through the bypass");
    assert.match(service, /assertDeductionsDecisionActor\(input\.actor\)/, "Super Admin only");
    assert.match(service, /write the comment the employee will read/, "the comment is required");
    assert.match(service, /phx_deductions_return_leave_balance[\s\S]{0,400}the deduction could not be updated/, "a charge whose decision failed is given straight back");
  }

  // 4b. THE ROUTE and its registry entry.
  {
    const route = read("app/api/admin/deductions/leave-balance/route.ts");
    assert.match(route, /assertSameOriginMutation\(request\)/);
    assert.match(route, /assertPermission\(access, "deductions", "approve"\)/);
    const registry = read("src/lib/security/access-registry.ts");
    assert.match(registry, /methods: \["POST"\], pattern: "\/api\/admin\/deductions\/leave-balance"[^\n]*csrfRequired: true/);
    assert.match(registry, /methods: \["GET"\], pattern: "\/api\/admin\/deductions\/leave-balance"/);
    const candidates = read("app/api/admin/deductions/candidates/route.ts");
    assert.match(candidates, /leaveBalanceCharge: leaveBalanceCharges\.get\(candidate\.id\) \?\? null/);
  }

  // 4c. THE MIGRATION. Same ledger every balance read already sums; the comment is required by the
  // table itself; the charge takes the per-employee lock a leave approval takes and refuses with 40001
  // when the balance moved; a return writes a mirroring negative row, never an edit.
  {
    const sql = read("supabase/migrations/20261009200000_deductions_leave_balance_charges.sql");
    assert.match(sql, /source = 'deductions' and settlement_id is null and digest_line_id is null\s+and deduction_candidate_id is not null and comment is not null and btrim\(comment\) <> ''/);
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\(lower\(p_employee_hr_id\)\)\)/);
    assert.match(sql, /errcode = '40001'/);
    assert.match(sql, /-v_charge\.days, v_charge\.period_start, v_charge\.period_end, p_actor_hr_id, v_charge\.id/);
    assert.ok(!/phx_apply_vacation_paid_approval/.test(sql.replace(/--[^\n]*/g, "")), "no balance reader is redefined: they all sum days already");
    assert.match(sql, /where days > 0 and source = 'weekly_review'/, "the one-charge-per-day index stays the weekly review's");
  }

  // 4d. THE SCREENS. The button, the required comment, the undo, and the employee's view.
  {
    const workspace = read("src/components/admin/deductions-workspace.tsx");
    assert.match(workspace, /Deduct from leave balance/);
    assert.match(workspace, /Return to salary/);
    assert.match(workspace, /disabled=\{busy \|\| loading \|\| !preview \|\| Boolean\(preview\.refusal\) \|\| !comment\.trim\(\)\}/, "no save without a comment");
    assert.match(workspace, /!row\.pushedLineId && !row\.leaveBalanceCharge\) : \[\]/, "a charged row cannot be bulk-decided");
    const report = read("src/components/vacation/vacation-report.tsx");
    assert.match(report, /whitespace-pre-wrap break-words[^"]*">\{row\.comment\}</, "the comment is shown exactly as written");
    const service = read("src/lib/vacation/service.ts");
    assert.match(service, /leaveBalanceDeductions: \{/);
    // The charges SECTION shows the deductions fold; the Used and Balance columns are handed EVERY
    // annual-balance day instead (annualBalanceLedgerDays), or a weekly-review charge and a payroll
    // settlement go missing from Used and the Balance column reads above the request price.
    assert.match(service, /balanceCharges: annualLedgerRead\.rows/);
    assert.match(service, /balanceChargesUnavailable: annualLedgerRead\.failed/);
    assert.ok(
      !/balanceCharges: leaveBalanceRead\.charges/.test(service),
      "the entitlement rows must not be handed the deductions fold alone — that is only one of the three pools a request is priced against",
    );
  }

  // 5. THE FIRST-SIX-MONTHS OVERRIDE (owner, 2026-10-09, after the widening: charge the ACCRUED days
  // and override the block). Without it the button was decoration on the tab he asked for it on —
  // every live Unpaid Vacation row on production is `first_six_months` (16 in September, 23 in
  // August, 8 in July, measured the same day), so each one refused.
  {
    // The rule itself still exists, and still says what it always said.
    assert.ok(isWithinFirstSixMonths({ hireDate: "2026-08-02", referenceDate: "2026-09-26" }));
    assert.ok(!isWithinFirstSixMonths({ hireDate: "2026-08-02", referenceDate: "2027-03-01" }));
    assert.ok(!isWithinFirstSixMonths({ hireDate: null, referenceDate: "2026-09-26" }));

    // A LEAVE REQUEST is unchanged: a man 8 weeks in still cannot take paid annual leave.
    const asRequested = calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      employeeHrId: "MR-7",
      hireDate: "2026-08-02",
      startDate: "2026-09-26",
      vacationType: "annual",
    });
    assert.equal(asRequested.unpaidReason, "first_six_months");
    assert.equal(asRequested.paidDurationDays, 0, "the six-month block on REQUESTING paid leave must not move");

    // The BUTTON spends what he has already earned: 15 days a year accrued monthly from his hire
    // date, so one completed month (02 Aug → 26 Sep) is 1.25 days — enough for this one day.
    const asCharged = calculateVacationPayment({
      allowFirstSixMonths: true,
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      employeeHrId: "MR-7",
      hireDate: "2026-08-02",
      startDate: "2026-09-26",
      vacationType: "annual",
    });
    assert.equal(asCharged.unpaidReason, null, "the override must price the day instead of refusing it");
    assert.equal(asCharged.entitlementDays, 1.25);
    assert.equal(asCharged.balanceBeforeDays, 1.25);
    assert.equal(asCharged.paidDurationDays, 1);
    assert.deepEqual(
      planLeaveBalanceCharge({ dueDays: 1, coverableDays: asCharged.paidDurationDays }),
      { chargeDays: 1, salaryDays: 0 },
      "a first-six-months day with enough accrued comes wholly off leave",
    );

    // A joiner with no completed month has accrued nothing, so the override changes nothing for him:
    // the dialog still refuses and the day stays on salary.
    const brandNew = calculateVacationPayment({
      allowFirstSixMonths: true,
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      employeeHrId: "MR-8",
      hireDate: "2026-09-20",
      startDate: "2026-09-26",
      vacationType: "annual",
    });
    assert.equal(brandNew.entitlementDays, 0);
    assert.equal(brandNew.paidDurationDays, 0);
    assert.deepEqual(planLeaveBalanceCharge({ dueDays: 1, coverableDays: brandNew.paidDurationDays }), { chargeDays: 0, salaryDays: 1 });

    // And the partial rule he set for CRM holds here too: 3 days against 1.25 accrued.
    const shortBalance = calculateVacationPayment({
      allowFirstSixMonths: true,
      approvedPaidDaysInPeriod: 0,
      durationDays: 3,
      employeeHrId: "MR-7",
      hireDate: "2026-08-02",
      startDate: "2026-09-26",
      vacationType: "annual",
    });
    assert.deepEqual(
      planLeaveBalanceCharge({ dueDays: 3, coverableDays: shortBalance.paidDurationDays }),
      { chargeDays: 1.25, salaryDays: 1.75 },
    );

    // THE WIRING. Only the deductions charge passes the flag, and the read no longer refuses the reason.
    const charge = read("src/lib/deductions/leave-balance.ts");
    assert.match(charge, /allowFirstSixMonths: true,/, "the leave-balance read must ask for the accrued days");
    assert.match(
      charge,
      /if \(snapshot\.unpaidReason === "missing_hire_date"\) \{/,
      "first_six_months must no longer be refused by the balance read — only a missing hire date is",
    );
    assert.ok(
      !/unpaidReason === "first_six_months"/.test(charge),
      "a leftover first_six_months refusal would put the whole tab back to refusing every row",
    );
    const calculations = read("src/lib/vacation/calculations.ts");
    assert.match(
      calculations,
      /if \(!input\.allowFirstSixMonths && isWithinFirstSixMonths\(/,
      "the block must stay on by default — the override is opt-in",
    );
    const vacationService = read("src/lib/vacation/service.ts");
    assert.match(
      vacationService,
      /allowFirstSixMonths: input\.allowFirstSixMonths,/,
      "calculatePaymentForRequest must pass the caller's flag through to the calculator",
    );
    assert.ok(
      !/allowFirstSixMonths: true/.test(vacationService),
      "the vacation service must never turn the override on for itself — only the deductions charge asks for it",
    );
    // The entitlement row needs the accrued balance, and reads it off the snapshot it already holds
    // (roundDays(max(0, entitlementDays - usedPaidDays)) — the annual path's own arithmetic, on the
    // two fields the snapshot carries identically with the flag and without it). Section 7 asserts
    // that figure on the ROW. An earlier draft called the calculator a second time behind a guard and
    // pinned it with the guard's exact text plus a 200-character window: it broke on a rename or a
    // reformat, and still allowed the override to reach any other field inside the window.
    // The Super Admin is told what the charge is spending — neutrally worded, like every other
    // string this app shows (tests/neutral-wording.test.ts, which caught the first draft of it).
    assert.match(
      read("src/components/admin/deductions-workspace.tsx"),
      /Still inside the first six months, so this spends days already accrued but not yet available to request/,
    );
  }

  // 6. AN ALREADY-CLEARED ROW CAN BE CHARGED (owner, 2026-10-09, after he pressed the button and read
  // "This deduction is already cleared"). 9 of the 16 live September rows are "Do Not Take Action", so
  // the refusal was the second thing standing between the button and the tab he asked for it on.
  //
  // 🔴 The load-bearing half is what a PART-covered cleared row does. Clearing the row stopped the
  // salary deduction; a charge must not quietly start one again for the days leave could not pay.
  {
    const clearedPart = decisionAfterLeaveBalanceCharge({
      alreadyCleared: true,
      chargeDays: 1.25,
      salaryDays: 1.75,
      dueDays: 3,
      comment: "Taking what the balance has",
    });
    assert.equal(clearedPart.status, "Do Not Take Action", "a cleared row stays cleared after a part charge");
    assert.equal(clearedPart.appliedValue, null, "the days leave could not pay must NOT be put on salary — the row was waived");
    assert.match(clearedPart.reason, /stay cleared and reach no salary/);
    assert.ok(isLeaveBalanceReason(clearedPart.reason), "a return must still recognise its own reason");

    // The same split on a row that was NOT cleared is unchanged: the remainder goes to payroll.
    const livePart = decisionAfterLeaveBalanceCharge({ chargeDays: 1.25, salaryDays: 1.75, dueDays: 3, comment: "x" });
    assert.equal(livePart.status, "Approved for Payroll");
    assert.equal(livePart.appliedValue, 1.75);
    assert.equal(
      decisionAfterLeaveBalanceCharge({ alreadyCleared: false, chargeDays: 1.25, salaryDays: 1.75, dueDays: 3, comment: "x" }).appliedValue,
      1.75,
      "an explicit false must behave exactly like an absent flag",
    );

    // Full coverage is the same either way — nothing was on salary to begin with.
    const clearedFull = decisionAfterLeaveBalanceCharge({ alreadyCleared: true, chargeDays: 1, salaryDays: 0, dueDays: 1, comment: "y" });
    assert.equal(clearedFull.status, "Do Not Take Action");
    assert.equal(clearedFull.appliedValue, null);

    const charge = read("src/lib/deductions/leave-balance.ts");
    assert.ok(
      !/already cleared — there is nothing to take from the leave balance/.test(charge),
      "neither the dialog nor the charge may refuse a cleared row any more",
    );
    assert.match(charge, /const alreadyCleared = candidate\.decisionStatus === "Do Not Take Action";/);
    assert.match(
      charge,
      /decisionAfterLeaveBalanceCharge\(\{ \.\.\.plan, alreadyCleared, dueDays, comment \}\)/,
      "the charge must pass the flag, or a part-covered cleared row goes back onto salary",
    );
    assert.match(
      charge,
      /salaryDays: alreadyCleared \? 0 : plan\.salaryDays,/,
      "the dialog must not promise salary days on a row that has none",
    );
    assert.match(charge, /return \{ chargedDays: plan\.chargeDays, salaryDays: after\.appliedValue \?\? 0,/);

    // The dialog and the save must agree about a released line — the preview used to offer a charge
    // the save then refused, which is the one failure mode this button is designed against.
    assert.match(
      charge,
      /const pushed = await loadActivePushedLineIdByCandidate\(candidate\.monthKey\);[\s\S]{0,600}already released to the employee — withdraw it first, then take it from the leave balance/,
      "the preview must run the same released-line check the charge runs",
    );

    assert.match(
      read("src/components/admin/deductions-workspace.tsx"),
      /This row is already cleared, so nothing is on salary[\s\S]{0,160}Return to salary puts it back to Pending/,
    );
  }
  // 7. THE BALANCE THE VACATION REPORT SHOWS MUST GO DOWN BY THE CHARGED DAYS (owner, 2026-10-09:
  // "make the entitlments of the peoplw qho got this decrease by number of days", then "in vacation
  // report"). Sections 5 and 6 made the button able to charge the tab he asked for it on; the days
  // then landed in the Entitlements tab's Used column while Balance stayed on 0, because inside the
  // first six months calculateVacationPayment answers balanceBeforeDays: 0 flat. Every live charge
  // is on someone inside that window, so the whole screen read as though nothing had been spent.
  //
  // 🔴 AND THE FIRST DRAFT MOVED THE NUMBER THE WRONG WAY. Overriding the figure only for someone who
  // ALREADY had a charge left an uncharged joiner reading 0 and put a charged one on 0.25: the Balance
  // column ROSE when a day was spent, and the colleague who had spent nothing read poorer than the one
  // who had. The accrued balance is what every first-six-months row carries now, charged or not, so a
  // charge subtracts from it and Entitlement - Used adds up for the whole cohort.
  {
    const JOINER_TODAY = "2026-09-26";
    const joiner = { ...employee("MR-9"), hireDate: "2026-08-02" } as EmployeeDirectoryRow;
    const rows = (balanceCharges?: Array<{ employeeHrId: string; workDate: string; days: number }>) =>
      buildEmployeeEligibilityRows({ allScopedRows: [], balanceCharges, employees: [joiner], filters: {}, today: JOINER_TODAY });

    // One completed month since 02 Aug: 15/12 of a day accrued, and nothing charged yet. Balance is
    // that accrued figure, so the three columns agree (1.25 - 0 = 1.25) before anything is spent.
    const before = rows()[0];
    assert.equal(before?.annualEntitlementDays, 1.25, "the accrued first-year entitlement is what the row carries");
    assert.equal(before?.annualUsedDays, 0);
    assert.equal(before?.annualBalanceDays, 1.25, "an uncharged first-six-months row shows what it has accrued, not a flat 0");

    const after = rows([{ employeeHrId: "MR-9", workDate: "2026-09-10", days: 1 }])[0];
    assert.equal(after?.annualUsedDays, 1, "the charged day is used");
    assert.equal(after?.annualBalanceDays, 0.25, "the charged day must come off the balance the Vacation Report shows");
    assert.ok(
      (after?.annualBalanceDays ?? 0) < (before?.annualBalanceDays ?? 0),
      "the figure he reads must go DOWN when a day is charged — the ask itself, and what the first draft had backwards",
    );

    // The thing that must NOT move with it: he is still inside his first six months, so the row must
    // still tell HR he cannot request paid leave. Reading "eligible" here would invite exactly the
    // paid approval the rule exists to prevent.
    assert.equal(after?.eligibilityStatus, "first_six_months", "the override must not make him look eligible");
    assert.equal(after?.eligibleForAnnualPaidLeave, false);
    assert.ok((after?.daysUntilEligibility ?? 0) > 0, "the countdown to paid eligibility must survive the override");
    assert.ok(
      !after?.reviewFlags.includes("No paid annual balance remaining"),
      "the review flags are read off the unoverridden snapshot, so no new flag may appear",
    );

    // 🔴 AND HIS OWN PORTAL TILE MUST NOT OFFER THOSE DAYS. The report shows the accrued balance so HR
    // can see the charge land; the rep still cannot request a paid day, and the request screen the tile
    // links to prices it unpaid. "Annual leave left: 0.25 days" there would contradict the next screen
    // one click away — getEmployeeAnnualLeaveBalanceDays returns exactly this figure.
    assert.equal(requestableAnnualLeaveDays(after!), 0, "a day the request flow refuses is not a day left");
    assert.equal(requestableAnnualLeaveDays(before!), 0, "and that holds with no charge on the row either");

    // The block itself is untouched: with nobody passing the flag the calculator still refuses, which
    // is what keeps a leave REQUEST priced unpaid however the report's own column reads.
    const priced = calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      employeeHrId: "MR-9",
      hireDate: "2026-08-02",
      startDate: JOINER_TODAY,
      vacationType: "annual",
    });
    assert.equal(priced.unpaidReason, "first_six_months", "without the flag the six-month block must still answer");
    assert.equal(priced.balanceBeforeDays, 0, "and still price the request against an empty balance");

    // Half a day decreases it by half a day; a charge past the accrual floors at 0, never below.
    assert.equal(rows([{ employeeHrId: "MR-9", workDate: "2026-09-10", days: 0.5 }])[0]?.annualBalanceDays, 0.75);
    assert.equal(rows([{ employeeHrId: "MR-9", workDate: "2026-09-10", days: 3 }])[0]?.annualBalanceDays, 0);

    // A charge dated outside this balance period belongs to another leave year and must not touch it —
    // the row reads exactly what it reads with no charge at all.
    assert.equal(rows([{ employeeHrId: "MR-9", workDate: "2026-07-30", days: 1 }])[0]?.annualBalanceDays, 1.25);

    // 🔴 EVERY ANNUAL-BALANCE POOL COUNTS, NOT THE DEDUCTIONS FOLD ALONE. approvedPaidDaysInPeriod —
    // what actually prices a request — counts request days PLUS attendance_annual_balance_charges
    // with no source filter PLUS the payroll settlements. The tab was handed only the
    // source = 'deductions' fold, so a day the weekly attendance review had charged, or one payroll
    // had settled, never reached Used and left Balance reading higher than the request price. The row
    // builder sums whatever it is given, so what matters is that the reader fetches both pools and
    // filters neither by source.
    {
      const seen: Array<{ table: string; filters: string[] }> = [];
      const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
        attendance_annual_balance_charges: [
          { employee_hr_id: "MR-9", work_date: "2026-09-10", days: 1 },
          { employee_hr_id: "mr-9", work_date: "2026-09-11", days: 0.5 },
          { employee_hr_id: "MR-9", work_date: "2026-09-10", days: -1 },
        ],
        payroll_copilot_vacation_settlements: [
          { employee_hr_id_compact: "mr9", start_date: "2026-09-15", balance_days_consumed: 2 },
        ],
      };
      const client = {
        from(table: string) {
          const entry = { table, filters: [] as string[] };
          seen.push(entry);
          const builder: Record<string, (...args: unknown[]) => unknown> = {};
          for (const method of ["select", "in", "is", "eq", "gte", "lt", "ilike", "order", "range"]) {
            builder[method] = (...args: unknown[]) => {
              entry.filters.push(`${method}:${String(args[0] ?? "")}`);
              // `range` ends the chain the way the paged read does: one window of the table's rows.
              return method === "range"
                ? Promise.resolve({
                    data: (rowsByTable[table] ?? []).slice(Number(args[0]), Number(args[1]) + 1),
                    error: null,
                  })
                : builder;
            };
          }
          return builder;
        },
      };

      const ledger = await annualBalanceLedgerDays(client as unknown as Parameters<typeof annualBalanceLedgerDays>[0]);
      assert.deepEqual(
        seen.map((entry) => entry.table).sort(),
        ["attendance_annual_balance_charges", "payroll_copilot_vacation_settlements"],
        "both annual-balance pools must be read — the deductions fold alone understates Used",
      );
      const chargeFilters = seen.find((entry) => entry.table === "attendance_annual_balance_charges")?.filters ?? [];
      assert.ok(
        !chargeFilters.some((filter) => filter.includes("source")),
        "the charges read must NOT filter by source — a weekly-review charge spends the same balance",
      );
      assert.equal(ledger.length, 4, "every row comes back; the row builder nets and periods them");
      assert.equal(
        ledger.reduce((sum, row) => sum + row.days, 0),
        2.5,
        "a reversal nets itself and the settlement counts: 1 + 0.5 - 1 + 2",
      );

      // Those rows, through the row builder, must land on the SAME employee whatever the HR_ID case.
      const charged = buildEmployeeEligibilityRows({
        allScopedRows: [],
        balanceCharges: ledger,
        employees: [joiner],
        filters: {},
        today: JOINER_TODAY,
      })[0];
      assert.equal(charged?.annualUsedDays, 2.5, "all four ledger rows reach Used, in any HR_ID casing");
      assert.equal(charged?.annualBalanceDays, 0, "and the accrued 1.25 is spent, floored at 0");

      // No ceiling: a ledger past one page (and past any fixed limit) comes back whole, because a
      // balance that forgot days already spent says more is left than there is.
      rowsByTable.attendance_annual_balance_charges = Array.from({ length: 2500 }, (_, index) => ({
        employee_hr_id: "MR-9",
        work_date: "2026-09-10",
        days: 0.001,
      }));
      const wide = await annualBalanceLedgerDays(client as unknown as Parameters<typeof annualBalanceLedgerDays>[0]);
      assert.equal(wide.length, 2501, "2,500 charges and 1 settlement: every row is read, not the first page");
    }

    // 🔴 10. A FAILED LEDGER READ MUST SAY SO ON THIS TAB. Falling back to no rows leaves Used and
    // Balance reading as though nothing had been spent — the pre-fix screen — and the charges
    // section's own banner is somewhere else entirely.
    {
      const unavailable = buildEmployeeEligibilityRows({
        allScopedRows: [],
        balanceChargesUnavailable: true,
        employees: [joiner],
        filters: {},
        today: JOINER_TODAY,
      })[0];
      assert.ok(
        unavailable?.reviewFlags.includes("Balance charges could not be read"),
        "a failed ledger read must be visible on the Entitlements row, not only in the server log",
      );
      assert.ok(
        !rows()[0]?.reviewFlags.includes("Balance charges could not be read"),
        "and must not appear when the read succeeded",
      );
    }

    // 🔴 4. THE ACCRUAL COUNTS COMPLETED MONTHS, NOT MONTH BOUNDARIES. (y2-y1)*12 + (m2-m1) read
    // 30 Sep -> 01 Oct as a whole month, so a joiner carried 1.25 days after ONE day of service while
    // one hired on the 1st carried 0 after thirty — and that figure is now the Balance column.
    {
      const accrued = (hireDate: string, today: string) =>
        buildEmployeeEligibilityRows({ allScopedRows: [], employees: [{ ...employee("MR-11"), hireDate } as EmployeeDirectoryRow], filters: {}, today })[0]
          ?.annualEntitlementDays;
      assert.equal(accrued("2026-09-30", "2026-10-01"), 0, "one day of service has completed no month");
      assert.equal(accrued("2026-09-30", "2026-10-29"), 0, "nor has 29 of them");
      assert.equal(accrued("2026-09-30", "2026-10-30"), 1.25, "the month completes when the hire day comes round");
      assert.equal(accrued("2026-08-02", "2026-09-26"), 1.25, "02 Aug -> 26 Sep is still the one completed month");
      assert.equal(accrued("2026-01-31", "2026-02-28"), 1.25, "a hire date no shorter month has completes on its last day");
      assert.equal(accrued("2026-08-01", "2026-08-31"), 0, "and thirty days inside the hire month complete nothing");
    }

    // Past six months this already worked, and must keep working through the same one subtraction.
    const senior = buildEmployeeEligibilityRows({
      allScopedRows: [],
      balanceCharges: [{ employeeHrId: "MR-10", workDate: "2026-02-01", days: 2 }],
      employees: [employee("MR-10")],
      filters: {},
      today: "2026-06-15",
    })[0];
    assert.equal(senior?.annualEntitlementDays, 21);
    assert.equal(senior?.annualBalanceDays, 19, "an eligible employee's balance still drops by the charged days");
    assert.equal(senior?.eligibilityStatus, "eligible");
    assert.equal(requestableAnnualLeaveDays(senior!), 19, "and for an eligible employee the tile shows that same number");
  }

  // 🔴 8. A PERSON WHO HAS LEFT IS SAID, NEVER REFUSED. Asked and answered the same day — "Allow it,
  // but say he has left" — after the production read showed three of the sixteen September Unpaid
  // Vacation rows belonging to people who had gone (last working days 17 Sep, 30 Sep and 04 Oct), two
  // of them being offered 5 and 1.25 days of balance with nothing on screen to say so. So this
  // section pins BOTH halves: the charge stays allowed, and the words are there.
  {
    const charge = read("src/lib/deductions/leave-balance.ts");
    const workspace = read("src/components/admin/deductions-workspace.tsx");
    const route = read("app/api/admin/deductions/leave-balance/route.ts");

    // (a) ONE vocabulary for "has left". DEPARTED_EMPLOYMENT_STATUSES is deliberately not the
    // complement of active: production carries 15 historical_payroll_record and 2 system_placeholder
    // rows, and calling either a leaver would put the notice on rows it is not about.
    assert.ok(
      charge.includes('import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle"'),
      "the charge service must read the shared departed-status helper, never its own list",
    );
    assert.ok(
      charge.includes("hasLeft: hasDepartedEmployment(row?.employment_status)"),
      "and must decide it from the employee row's employment_status through that helper",
    );
    assert.ok(
      !charge.includes('!== "active"') && !charge.includes('=== "active"'),
      "a complement-of-active test would call a historical payroll record a leaver",
    );
    assert.deepEqual(
      [...DEPARTED_EMPLOYMENT_STATUSES].sort(),
      ["not_renewed", "resigned", "terminated"],
      "the set this notice hangs off is resigned, terminated and not_renewed",
    );
    assert.ok(hasDepartedEmployment("resigned") && hasDepartedEmployment("terminated") && hasDepartedEmployment("not_renewed"));
    assert.ok(
      !hasDepartedEmployment("active") &&
        !hasDepartedEmployment("historical_payroll_record") &&
        !hasDepartedEmployment("system_placeholder") &&
        !hasDepartedEmployment(null),
      "and nothing else on production is called a leaver",
    );

    // (b) The read asks for the columns, and still has NO employment filter — a deduction raised
    // while someone was working stays chargeable after the resignation is recorded.
    assert.ok(
      charge.includes('.select("hire_date, employment_status, last_working_date")'),
      "the employee read must fetch the status and the last working day, or the notice has nothing to say",
    );
    assert.ok(!charge.includes("loadHireDate"), "the hire-date-only loader is gone — one read answers both questions");
    {
      const start = charge.indexOf("async function loadEmployeeForCharge");
      const body = charge.slice(start, charge.indexOf("\n}\n", start));
      assert.ok(start > 0 && body.length > 0, "loadEmployeeForCharge must exist");
      assert.ok(
        !body.includes('.eq("employment_status') && !body.includes('.in("employment_status'),
        "it must not filter the read by employment status — that would refuse the charge instead of saying so",
      );
    }

    // (c) BOTH return paths carry it. The already-charged path matters most: that is where Return to
    // salary is decided.
    assert.equal(
      charge.split("employeeHasLeft: employee.hasLeft").length - 1,
      2,
      "the preview must carry employeeHasLeft on the already-charged path AND the chargeable one",
    );
    assert.equal(
      charge.split("lastWorkingDate: employee.lastWorkingDate").length - 1,
      2,
      "and the last working day with it, on both",
    );
    assert.ok(
      charge.indexOf("const employee = await loadEmployeeForCharge(candidate.employeeHrId)") <
        charge.indexOf("const charged = await getLeaveBalanceChargeForCandidate(candidate.id)"),
      "the employee must be read BEFORE the already-charged branch, or that branch has nothing to report",
    );

    // (d) SAID, NEVER REFUSED. No gate, no refusal text and no throw may mention it.
    {
      const gateStart = charge.indexOf("function assertChargeable(");
      const gate = charge.slice(gateStart, charge.indexOf("\n}\n", gateStart));
      assert.ok(gateStart > 0 && !gate.includes("hasLeft"), "assertChargeable must not refuse a leaver");
      const refusalStart = charge.indexOf("function refusalText(");
      const refusal = charge.slice(refusalStart, charge.indexOf("\n}\n", refusalStart));
      // "no annual leave balance left" is about days remaining, so the test names the concept
      // instead: no refusal may be about having LEFT THE COMPANY.
      assert.ok(refusalStart > 0, "refusalText must exist");
      for (const phrase of ["left the company", "resign", "terminated", "not renewed", "no longer employed"]) {
        assert.ok(!refusal.toLowerCase().includes(phrase), `no refusal text may be about leaving: ${phrase}`);
      }
      for (const line of charge.split("\n")) {
        if (!line.includes("hasLeft")) continue;
        assert.ok(!line.includes("throw "), `a leaver must never throw: ${line.trim()}`);
        assert.ok(!line.includes("refusal"), `a leaver must never set a refusal: ${line.trim()}`);
      }
    }

    // (e) The route hands the whole preview through, so both fields reach the dialog.
    assert.ok(
      route.includes("return NextResponse.json({ success: true, preview })"),
      "the route must pass the preview through whole — a field whitelist would drop the notice silently",
    );

    // (f) The words, in BOTH views, and nothing disabled by them.
    assert.ok(workspace.includes("function EmployeeHasLeftNotice"), "the notice must be one component, used twice");
    assert.ok(
      workspace.includes("This employee has left the company"),
      "and must say it in plain words, naming what the charge still does",
    );
    assert.equal(
      workspace.split("<EmployeeHasLeftNotice lastWorkingDate=").length - 1,
      2,
      "it belongs in the charge dialog AND beside Return to salary on an already-charged row",
    );
    assert.ok(workspace.includes("employeeHasLeft: boolean;"), "the client type must carry the field or TypeScript drops it");
    for (const line of workspace.split("\n")) {
      if (!line.includes("employeeHasLeft")) continue;
      assert.ok(!line.includes("disabled"), `the notice must never gate a button: ${line.trim()}`);
    }

    // (g) 🔴 THE ALREADY-CHARGED VIEW NEVER OPENS THE DIALOG, so without its own read `preview` stays
    // null there for ever and the notice beside Return to salary is a silently dead branch.
    assert.ok(
      workspace.indexOf("if (!row.leaveBalanceCharge) return;") <
        workspace.indexOf("const charged = row.leaveBalanceCharge ?? null;"),
      "the charged row must fetch its own preview, before the branch that renders it",
    );
    assert.ok(
      workspace.includes("useEffect(() => {") && workspace.includes("}, [row.id, row.leaveBalanceCharge]);"),
      "and it must be an effect keyed on the row, not a fetch on every render",
    );
    {
      const effectStart = workspace.indexOf("if (!row.leaveBalanceCharge) return;");
      const effect = workspace.slice(effectStart, workspace.indexOf("}, [row.id, row.leaveBalanceCharge]);", effectStart));
      assert.ok(effect.includes("setPreview(payload.preview)"), "the effect must actually store what it read");
      assert.ok(effect.includes("live = false"), "and must not set state after the row is gone");
    }

    // (h) 🔴 The last working day goes through this file's own date-only renderer. Two things ride
    // on that: a date-only column formatted in Cairo lands a day early, and a raw
    // `new Intl.DateTimeFormat("en-GB", { month: "short" })` in a CLIENT component is React
    // hydration error #418 on any pre-CLDR-42 ICU build ("Sep" vs "Sept") — in September only, which
    // is exactly when a September deduction is being charged. The first attempt here shipped that
    // raw formatter and the required validate job caught it.
    assert.ok(
      workspace.includes("const label = hireDateLabel(lastWorkingDate);"),
      "the notice must render the last working day through hireDateLabel, not a formatter of its own",
    );
    assert.ok(
      workspace.includes('stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" })'),
      "and that renderer must stay on stableEnGbFormatter in UTC",
    );
    assert.ok(
      !workspace.includes('new Intl.DateTimeFormat("en-GB"'),
      "no client component may build an en-GB formatter directly — that is React #418 every September",
    );
  }


  // 🔴 9. A CHARGED LEAVER GETS A ROW ON THE ENTITLEMENTS TAB, AND IT SAYS SO. Owner, 2026-10-09:
  // "show the charged leavers on the vacation report entitlements tab" — the gap section 8's dialog
  // could only describe. Three of the sixteen September Unpaid Vacation rows on production belong to
  // people who had left, so a day charged against one of them came off a balance that appeared on no
  // screen at all: the tab lists active employees.
  {
    const service = read("src/lib/vacation/service.ts");

    // (a) The row says it, through reviewFlags — the one channel that already reaches all four
    // renderings of a row (desktop table, mobile card, self-only card, CSV export).
    const flagsFor = (over: Partial<EmployeeDirectoryRow>) =>
      buildEmployeeEligibilityRows({
        allScopedRows: [],
        employees: [{ ...employee("MR-20"), ...over } as EmployeeDirectoryRow],
        filters: {},
        today: "2026-10-09",
      })[0]?.reviewFlags ?? [];

    assert.ok(
      // "Sept", not "Sep": stableEnGbFormatter pins the CLDR 42 spelling for every reader, which is
      // the whole point of it — the same words the charge dialog prints.
      flagsFor({ employmentStatus: "resigned", lastWorkingDate: "2026-09-17" }).includes("Left the company on 17 Sept 2026"),
      "a resigned employee's row must say so, with the day they stopped working",
    );
    assert.ok(
      flagsFor({ employmentStatus: "terminated", lastWorkingDate: "2026-10-04" }).includes("Left the company on 04 Oct 2026"),
      "terminated counts as left, and the date is printed the same way",
    );
    assert.ok(
      flagsFor({ employmentStatus: "not_renewed", lastWorkingDate: null }).includes("Left the company"),
      "a leaver with no last working day on record still says they left, without inventing a date",
    );
    for (const status of ["active", "historical_payroll_record", "system_placeholder", null]) {
      assert.ok(
        !flagsFor({ employmentStatus: status, lastWorkingDate: "2026-09-17" }).some((flag) => flag.startsWith("Left the company")),
        `${String(status)} is not a leaver and must never carry the notice`,
      );
    }
    // The date is a DATE-ONLY column: formatted in UTC from its own parts, so it never lands a day
    // early, and through the engine-independent formatter rather than the reader's ICU build.
    assert.ok(
      service.includes('stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" })'),
      "the leaver date must go through stableEnGbFormatter in UTC",
    );

    // (b) WHO gets a row: active employees plus the leavers whose balance was actually spent.
    assert.ok(
      service.includes("employees: [...visibleEmployees, ...chargedLeavers],"),
      "the Entitlements tab must be built from the active employees PLUS the charged leavers",
    );
    assert.ok(
      service.includes("await getEmployeeDirectoryRows({ includeInactive: true })"),
      "finding them needs the directory read that includes the people who have left",
    );
    assert.ok(
      service.includes("if (!hasDepartedEmployment(employee.employmentStatus)) return false;"),
      "and only a departed status qualifies — never the complement of active",
    );

    // (c) 🔴 NET days. A charge RETURNED TO SALARY leaves a negative ledger row that nets it out, and
    // a leaver whose charge was given back is not a charged leaver — otherwise the row would appear
    // for ever after one undone click.
    assert.ok(
      service.includes("    return netDays > 0;"),
      "a leaver qualifies on NET days above zero, not on the presence of any ledger row",
    );
    assert.ok(
      service.includes("annualLedgerRead.failed ? leaveBalanceRead.charges : annualLedgerRead.rows;"),
      "and when the wider ledger read fails, the deductions fold is the fallback rather than silence",
    );
    // 🔴 Scoped to the person's OWN current balance period — the same window Used and Balance count.
    // The period moves with today, so without this the row would never drop off and would eventually
    // show a departed person with a full untouched entitlement.
    assert.ok(
      service.includes("row.workDate >= period.periodStart &&") &&
        service.includes("row.workDate < period.periodEnd"),
      "the leaver's net days must be counted inside their own balance period, not across all time",
    );

    // (d) 🔴 REQUEST VISIBILITY IS NOT WIDENED. visibleEmployeeHrIds decides which REQUESTS a viewer
    // may see; building it from the wider list would hand a manager rows nobody asked to show them.
    assert.ok(
      service.includes("const visibleEmployeeHrIds = buildVisibleHrIdSet(visibleEmployees);"),
      "the visible-request id set must still be built from the ACTIVE list",
    );
    assert.ok(
      !service.includes("buildVisibleHrIdSet(visibleIncludingDeparted)"),
      "it must never be built from the wider list",
    );
    assert.ok(
      service.includes("filterVacationEmployeesForAccess(\n    access,\n    await getEmployeeDirectoryRows({ includeInactive: true }),\n  )"),
      "the wider list must itself pass the access filter, or a manager sees another manager's leavers",
    );

    // (e) The totals stay about the active workforce — the first figure is literally activeEmployees.
    // Owner-confirmed 2026-10-09: "keep the entitlements summary counting active employees only",
    // so this assertion is his rule and not a tidy-up — widening the filter is the regression.
    assert.ok(
      service.includes("employeeEligibility.filter((row) => !hasDepartedEmployment(row.employmentStatus)),"),
      "the summary must exclude the charged leavers so a headcount he reads monthly does not move",
    );

    // (f) The charges section shows a leaver's charge, with a NAME. It was dropped entirely, because
    // the id list stopped at the active employees; and the name lookup would then have said
    // "Name unavailable", against his standing rule of names, never ids.
    assert.ok(
      service.includes("listLeaveBalanceChargesForEmployees(visibleIncludingDeparted.map((employee) => employee.hrId))"),
      "the charges read must cover the leavers too",
    );
    assert.ok(
      service.includes("const person = visibleIncludingDeparted.find((employee) => hrIdsMatch(employee.hrId, charge.employeeHrId));"),
      "and the row's name must be looked up in that same wider list",
    );

    // (g) 🔴 AND THE CHARGES SECTION SAYS IT TOO. This is the one place the charge itself is listed,
    // and it is the case where the final settlement may already have paid that balance out — so the
    // row names the person, then says they have gone.
    const reportTypes = read("src/lib/vacation/types.ts");
    const reportUi = read("src/components/vacation/vacation-report.tsx");
    assert.ok(
      reportTypes.includes("      employeeHasLeft: boolean;") &&
        reportTypes.includes("      lastWorkingDate: string | null;"),
      "the charge row's type must carry it, or TypeScript drops the field on the way to the client",
    );
    assert.ok(
      service.includes("employeeHasLeft: hasDepartedEmployment(person?.employmentStatus),"),
      "it must come from the same directory row the name comes from, through the shared helper",
    );
    assert.ok(
      service.includes("lastWorkingDate: person?.lastWorkingDate ?? null,"),
      "and carry the day they stopped working, with no date invented when it is missing",
    );
    assert.ok(
      reportUi.includes("{!isSelfView && row.employeeHasLeft ? ("),
      "the charges section must print it beside the name — and never in somebody's own self view",
    );
    assert.ok(
      reportUi.includes("left the company{row.lastWorkingDate ?"),
      "in plain words, with the date only when there is one",
    );
  }
}
