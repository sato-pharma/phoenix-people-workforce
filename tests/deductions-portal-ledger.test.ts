import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  PORTAL_DEDUCTIONS_FIRST_MONTH,
  derivePortalDeductionOutcome,
  mapPortalLedgerRow,
  sortPortalLedgerRows,
} from "../src/lib/deductions/portal.ts";
import {
  PORTAL_LEDGER_ANY,
  PORTAL_LEDGER_OUTCOME_LABEL,
  filterPortalLedgerRows,
  portalLedgerCategories,
  portalLedgerMonthKeys,
  portalLedgerStatuses,
  summarizePortalLedger,
} from "../src/lib/deductions/portal-ledger-filters.ts";
import type { DeductionsPortalLedgerRow } from "../src/lib/deductions/types.ts";

/**
 * The employee portal's deduction ledger (owner, 2026-10-09):
 *
 *   "in deductions in emp portal starting from september salary show all deductions should be
 *    applied on him and how hr responded to every single row, and employee can filter by another
 *    month or period or type or status."
 *
 * His two rulings the same day, both taken: an undecided row IS shown, marked under review; and a
 * reply stays limited to a row that reached the payslip.
 *
 *   1. the outcome a decision produces, and that an unknown status can never read as "no deduction";
 *   2. the mapping — what is charged, what is only an estimate, and who may reply;
 *   3. the three filters and the totals;
 *   4. the wiring: the September floor applied in SQL and in JS, the self-only scope, and both
 *      surfaces reading the ledger.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

type CandidateArg = Parameters<typeof mapPortalLedgerRow>[0]["candidate"];
type DecisionArg = NonNullable<Parameters<typeof mapPortalLedgerRow>[0]["decision"]>;

function candidate(over: Partial<CandidateArg> = {}): CandidateArg {
  return {
    id: "cand-1",
    employee_hr_id: "B-96",
    employee_hr_id_compact: "b96",
    employee_name: "Ayman El Salhy",
    month_key: "2026-09",
    category: "crm",
    unit: "days",
    raw_value: 2,
    estimated_amount: 900,
    dates: ["2026-09-03", "2026-09-04"],
    reason: "No CRM activity recorded",
    created_at: "2026-09-30T10:00:00Z",
    ...over,
  } as CandidateArg;
}

function row(over: Partial<DeductionsPortalLedgerRow> = {}): DeductionsPortalLedgerRow {
  return {
    candidateId: "r-1",
    releasedLineId: null,
    employeeCode: "B-96",
    employeeHrIdCompact: "b96",
    employeeName: "Ayman El Salhy",
    monthKey: "2026-09",
    category: "crm",
    payrollColumn: "crm",
    unit: "days",
    dates: ["2026-09-03"],
    whyFlagged: null,
    detectedValue: 1,
    detectedAmount: 450,
    chargedValue: 0,
    chargedAmount: 0,
    outcome: "under_review",
    hrStatus: "Pending",
    hrResponse: null,
    hrNote: null,
    decidedByName: null,
    decidedAt: null,
    canComment: false,
    createdAt: "2026-09-30T10:00:00Z",
    ...over,
  };
}

export function runDeductionsPortalLedgerTests() {
  // 1. THE OUTCOME. Keyed on the decision, because the decision is what Automated Payroll charges.
  {
    assert.equal(derivePortalDeductionOutcome("Approved for Payroll"), "on_payslip");
    assert.equal(derivePortalDeductionOutcome("Do Not Take Action"), "cleared");
    assert.equal(derivePortalDeductionOutcome("Needs Follow-up"), "needs_follow_up");
    assert.equal(derivePortalDeductionOutcome("Disputed"), "disputed");
    assert.equal(derivePortalDeductionOutcome("Pending"), "under_review");
    assert.equal(derivePortalDeductionOutcome(null), "under_review", "no decision at all is under review");
    assert.equal(
      derivePortalDeductionOutcome("Some Future Status"),
      "under_review",
      "an unknown status must never render as cleared — that would tell someone nothing is being taken while payroll takes it",
    );
    // Every outcome has a label, so a badge can never render blank.
    for (const outcome of ["on_payslip", "cleared", "under_review", "needs_follow_up", "disputed"] as const) {
      assert.ok(PORTAL_LEDGER_OUTCOME_LABEL[outcome], `${outcome} must have a label the employee can read`);
    }
  }

  // 2a. AN APPROVED ROW CHARGES. Narrowed days charge the narrowed figure; an approved row that was
  // never narrowed charges everything detected, the same fallback the admin workspace applies.
  {
    const narrowed = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Approved for Payroll", applied_value: 1, applied_amount: 450, decided_by: "B-10", decided_at: "2026-10-01T09:00:00Z", decision_reason: "One day confirmed" } as DecisionArg,
      releasedLine: null,
      decidedByName: "Omar Gawish",
    });
    assert.equal(narrowed.outcome, "on_payslip");
    assert.equal(narrowed.chargedValue, 1);
    assert.equal(narrowed.chargedAmount, 450);
    assert.equal(narrowed.hrResponse, "One day confirmed", "HR's own words must reach the employee");
    assert.equal(narrowed.decidedByName, "Omar Gawish", "a person, never an HR code");

    const whole = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Approved for Payroll", applied_value: null, applied_amount: null } as DecisionArg,
      releasedLine: null,
      decidedByName: null,
    });
    assert.equal(whole.chargedValue, 2, "an approved row nobody narrowed charges every detected day");
    assert.equal(whole.chargedAmount, 900);
  }

  // 2b. NOTHING ELSE CHARGES. A cleared row and an undecided row both read zero, so no total can
  // ever count money that was not taken.
  {
    const cleared = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Do Not Take Action", applied_value: 2, applied_amount: 900, decision_reason: "Covered by approved leave" } as DecisionArg,
      releasedLine: null,
      decidedByName: null,
    });
    assert.equal(cleared.outcome, "cleared");
    assert.equal(cleared.chargedAmount, 0, "a cleared row takes nothing, whatever the decision row still carries");
    assert.equal(cleared.chargedValue, 0);
    assert.equal(cleared.detectedAmount, 900, "what it would have cost is still shown, apart from the charge");

    const undecided = mapPortalLedgerRow({ candidate: candidate(), decision: null, releasedLine: null, decidedByName: null });
    assert.equal(undecided.outcome, "under_review");
    assert.equal(undecided.chargedAmount, 0);
    assert.equal(undecided.hrStatus, "Pending");
    assert.equal(undecided.hrResponse, null);
  }

  // 2c. THE DISPUTE GATE (owner, 2026-11-13: "make the employee able to dispute in the deduction
  // module"). Every row but a cleared one can be disputed — approved-but-unpushed (charged all the
  // same) and undecided included — the same condition addDeductionsComment enforces server-side.
  {
    const notReleased = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Approved for Payroll" } as DecisionArg,
      releasedLine: null,
      decidedByName: null,
    });
    assert.equal(notReleased.canComment, true, "an approved row is charged, pushed or not, so it can be disputed");
    const undecided = mapPortalLedgerRow({
      candidate: candidate(),
      decision: null,
      releasedLine: null,
      decidedByName: null,
    });
    assert.equal(undecided.canComment, true, "an undecided row can be disputed before the money is taken");
    const cleared = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Do Not Take Action" } as DecisionArg,
      releasedLine: null,
      decidedByName: null,
    });
    assert.equal(cleared.canComment, false, "a cleared row takes nothing, so there is nothing to dispute");
    const released = mapPortalLedgerRow({
      candidate: candidate(),
      decision: { decision_status: "Approved for Payroll" } as DecisionArg,
      releasedLine: { id: "line-9" } as Parameters<typeof mapPortalLedgerRow>[0]["releasedLine"],
      decidedByName: null,
    });
    assert.equal(released.canComment, true);
    assert.equal(released.releasedLineId, "line-9");
  }

  // 3a. THE FILTERS — month, type and status, each narrowing on its own and together.
  {
    const rows = [
      row({ candidateId: "a", monthKey: "2026-09", category: "crm", outcome: "on_payslip", chargedAmount: 450, chargedValue: 1 }),
      row({ candidateId: "b", monthKey: "2026-09", category: "crm_half_day", outcome: "under_review" }),
      row({ candidateId: "c", monthKey: "2026-10", category: "fingerprint", outcome: "cleared" }),
    ];
    const ids = (list: DeductionsPortalLedgerRow[]) => list.map((item) => item.candidateId).sort();

    assert.deepEqual(ids(filterPortalLedgerRows(rows, {})), ["a", "b", "c"], "no filter shows everything");
    assert.deepEqual(
      ids(filterPortalLedgerRows(rows, { category: PORTAL_LEDGER_ANY, monthKey: PORTAL_LEDGER_ANY, status: PORTAL_LEDGER_ANY })),
      ["a", "b", "c"],
      "the 'all' sentinel narrows nothing",
    );
    assert.deepEqual(ids(filterPortalLedgerRows(rows, { monthKey: "2026-09" })), ["a", "b"]);
    assert.deepEqual(ids(filterPortalLedgerRows(rows, { category: "crm_half_day" })), ["b"]);
    assert.deepEqual(ids(filterPortalLedgerRows(rows, { status: "cleared" })), ["c"]);
    assert.deepEqual(ids(filterPortalLedgerRows(rows, { category: "crm", monthKey: "2026-09", status: "on_payslip" })), ["a"]);
    assert.deepEqual(
      filterPortalLedgerRows(rows, { monthKey: "2026-08" }),
      [],
      "a month with no rows shows none — never a silent fall back to everything",
    );

    assert.deepEqual(portalLedgerMonthKeys(rows), ["2026-10", "2026-09"], "newest month first");
    assert.deepEqual(portalLedgerCategories(rows), ["crm", "crm_half_day", "fingerprint"]);
    assert.deepEqual(portalLedgerStatuses(rows), ["on_payslip", "cleared", "under_review"], "only statuses present, in label order");
  }

  // 3b. THE TOTALS. Only an approved row adds money; the rest are counted, not summed.
  {
    const totals = summarizePortalLedger([
      row({ outcome: "on_payslip", chargedAmount: 450, chargedValue: 1, unit: "days" }),
      row({ outcome: "on_payslip", chargedAmount: 1000, chargedValue: 1000, unit: "amount" }),
      row({ outcome: "cleared" }),
      row({ outcome: "under_review" }),
      row({ outcome: "needs_follow_up" }),
      row({ outcome: "disputed" }),
    ]);
    assert.equal(totals.total, 6);
    assert.equal(totals.deductedAmount, 1450);
    assert.equal(totals.deductedDays, 1, "an amount-unit deduction contributes money, never days");
    assert.equal(totals.deductedCount, 2);
    assert.equal(totals.clearedCount, 1);
    assert.equal(totals.openCount, 3, "under review, needs follow-up and disputed are all still open");
  }

  // 3c. Newest month first, then the biggest charge — and the sort never mutates its input.
  {
    const input = [
      row({ candidateId: "old", monthKey: "2026-09", chargedAmount: 999 }),
      row({ candidateId: "small", monthKey: "2026-10", chargedAmount: 10 }),
      row({ candidateId: "big", monthKey: "2026-10", chargedAmount: 500 }),
    ];
    const snapshot = input.map((item) => item.candidateId);
    assert.deepEqual(sortPortalLedgerRows(input).map((item) => item.candidateId), ["big", "small", "old"]);
    assert.deepEqual(input.map((item) => item.candidateId), snapshot, "pure: the caller's array is untouched");
    assert.deepEqual(sortPortalLedgerRows([]), []);
  }

  // 4a. SEPTEMBER IS THE FLOOR, in the query AND in JS. His instruction, not an optimisation: an
  // earlier month was never reviewed with an employee reading it.
  {
    assert.equal(PORTAL_DEDUCTIONS_FIRST_MONTH, "2026-09");
    const source = read("src/lib/deductions/portal.ts");
    const start = source.indexOf("export async function getPortalDeductionLedger(");
    assert.ok(start > 0, "getPortalDeductionLedger must exist");
    const body = source.slice(start);
    assert.match(body, /\.gte\("month_key", PORTAL_DEDUCTIONS_FIRST_MONTH\)/, "the floor must be in the query");
    assert.match(
      body,
      /String\(row\.month_key \?\? ""\) >= PORTAL_DEDUCTIONS_FIRST_MONTH/,
      "and asserted again in JS, so a widened query cannot surface an earlier month",
    );
    // 4b. SELF-ONLY, through the one resolver tests/deductions-read-gate.test.ts already pins.
    assert.match(body, /collectPortalDeductionScope\(\{ access: input\.access \}\)/);
    assert.match(body, /scope\.all \|\| scope\.compactHrIds\.has\(/, "the JS filter stays the authority on whose rows these are");
    assert.ok(
      !/\.in\("employee_hr_id_compact", \[\.\.\.scope\.compactHrIds\]\)[\s\S]{0,40}return \{ rows/.test(body),
      "the SQL narrowing must never be the only scope check",
    );
    // Every own row's conversation is read, so an accepted dispute's thread stays readable on its
    // cleared row (owner, 2026-11-13) — the rows are already self-scoped above.
    assert.match(body, /listDeductionsComments\(\{ candidateIds: rows\.map\(\(row\) => row\.candidateId\) \}\)/);
  }

  // 4c. BOTH SURFACES read the ledger — the portal page and the admin shell's own copy. If one
  // keeps the released-lines read they drift, which is exactly what portal.ts's header forbids.
  {
    const page = read("app/employee-portals/deductions/page.tsx");
    assert.match(page, /getPortalDeductionLedger\(\{ access \}\)/);
    assert.match(page, /rows=\{data\.rows\}/);
    const shell = read("src/components/workspace/admin-shell-employee-pages.tsx");
    assert.match(shell, /getPortalDeductionLedger\(\{ access \}\)/);
    assert.match(shell, /rows=\{data\.rows\}/);
  }

  // 4d. THE SCREEN. HR's answer on every row, the three filters, and the undecided row saying in
  // words that nothing is taken yet.
  {
    const workspace = read("src/components/employee-portal/deductions-workspace.tsx");
    assert.match(workspace, /HR response/, "every row must show how HR responded");
    assert.match(workspace, /Not reviewed yet/, "an undecided row must say so rather than show a blank status");
    assert.match(workspace, /whitespace-pre-wrap break-words[^"]*">\{row\.hrResponse\}</, "HR's words shown as written, never truncated");
    for (const control of ["All months", "All types", "Any status"]) {
      assert.ok(workspace.includes(control), `the ${control} filter must be on the screen`);
    }
    assert.ok(!/text-ellipsis|truncate/.test(workspace), "no ellipsis truncation — the owner's standing rule");
  }
}
