import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decisionAfterLeaveBalanceCharge,
  isLeaveBalanceReason,
  planLeaveBalanceCharge,
} from "../src/lib/deductions/leave-balance.ts";
import { foldLeaveBalanceCharges } from "../src/lib/deductions/leave-balance-ledger.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildEmployeeEligibilityRows } from "../src/lib/vacation/service.ts";

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
 *   1. the split between leave and salary, and the decision it leaves on the row;
 *   2. the ledger fold — a give-back nets the charge out, a re-charge shows the NEW comment;
 *   3. the balance the report and the portal show subtracts the days;
 *   4. the wiring that keeps the two sides from disagreeing: the decision guard, the route, the
 *      migration's shape, the screens that show the button and the comment.
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

export function runDeductionsLeaveBalanceTests() {
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
    assert.match(source, /input\.viaLeaveBalance !== true && \(candidateRow\.category === "crm" \|\| candidateRow\.category === "crm_half_day"\)/);
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
    assert.match(service, /balanceCharges: leaveBalanceRead\.charges/);
  }
}
