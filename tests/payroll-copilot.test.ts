import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildRowForEmployee } from "../src/lib/payroll/copilot/assemble.ts";
import { evaluateEmployeeFlags } from "../src/lib/payroll/copilot/flags.ts";
import { normalizeAction, parseDeterministic } from "../src/lib/payroll/copilot/llm.ts";
import { recommendResolution } from "../src/lib/payroll/copilot/recommend.ts";
import { buildAssistantContext, type AssistantEmployeeContext } from "../src/lib/payroll/copilot/assistant.ts";
import { isRecurringActiveForPeriod } from "../src/lib/payroll/copilot/recurring.ts";
import type {
  CopilotAdjustment,
  CopilotFlag,
  CopilotFlagRule,
  CopilotFlagSeverity,
  CopilotPeriod,
  RecurringAdjustment,
} from "../src/lib/payroll/copilot/types.ts";
import { validateSalaryRows, type SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

const PERIOD: CopilotPeriod = { month: 6, year: 2026 };

function makeRow(overrides: Partial<SalaryValidationRow> = {}): SalaryValidationRow {
  return {
    area: "",
    baseSalary: 0,
    bonus: 0,
    crm: 0,
    hrId: "B-1",
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 0,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    fullName: "Test Employee",
    grossSalary: 0,
    hireDate: null,
    incentive: 0,
    jobTitle: "",
    line: "",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 0,
    nameAr: null,
    netSalary: 0,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    row: 1,
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    ...overrides,
  };
}

function makeSource(overrides: Partial<PayrollSalarySource> = {}): PayrollSalarySource {
  return {
    baseSalary: 5000,
    grossSalary: 6000,
    netSalary: 5000,
    socialInsurance: 500,
    employmentIncomeTax: 500,
    extraCostOfLiving: 2000,
    fuelAllowance: 500,
    paymentMode: "two_parts",
    ...overrides,
  };
}

function makeEmp(overrides: Record<string, unknown> = {}): EmployeeDirectoryRow {
  return {
    hrId: "B-1",
    fullName: "Test Employee",
    nameAr: null,
    jobTitle: "Medical Representative",
    lineName: "Line A",
    areaName: "Area 1",
    hireDate: "2020-01-01",
    employmentStatus: "active",
    payrollEligible: true,
    ...overrides,
  } as unknown as EmployeeDirectoryRow;
}

function adj(overrides: Partial<CopilotAdjustment>): CopilotAdjustment {
  return {
    id: "a1",
    runId: "r1",
    employeeHrId: "B-1",
    kind: "bonus",
    amount: null,
    field: null,
    workedDays: null,
    reason: null,
    recurringId: null,
    source: "chat",
    createdBy: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function rec(overrides: Partial<RecurringAdjustment>): RecurringAdjustment {
  return {
    id: "rec1",
    employeeHrId: "B-1",
    kind: "loan",
    monthlyAmount: 1000,
    remainingInstallments: 6,
    startMonth: 6,
    startYear: 2026,
    active: true,
    note: null,
    ...overrides,
  };
}

function rulesOf(flags: ReturnType<typeof evaluateEmployeeFlags>): string[] {
  return flags.map((flag) => flag.rule);
}

export function runPayrollCopilotTests() {
  // --- assembly: green seed ---------------------------------------------------
  const green = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [],
    period: PERIOD,
    index: 1,
  });
  assert.ok(green, "green row should assemble");
  assert.equal(green.baseSalary, 5000);
  assert.equal(green.grossSalary, 6000);
  assert.equal(green.netSalary, 5000);
  assert.equal(green.extraCostOfLiving, 2000);
  assert.equal(green.fuelAllowance, 500);
  assert.equal(green.governmentalDeductions, 1000);
  assert.equal(green.totalAdditions, 2500);
  assert.equal(green.totalDeductions, 0);
  assert.equal(green.firstPart + green.secondPart, green.monthSalary);

  // --- assembly: chat adjustments ---------------------------------------------
  const withBonus = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "bonus", amount: 1000 })],
    period: PERIOD,
    index: 1,
  });
  assert.equal(withBonus?.bonus, 1000);
  assert.equal(withBonus?.totalAdditions, 3500);

  const withPenalty = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "penalty", amount: 500 })],
    period: PERIOD,
    index: 1,
  });
  assert.equal(withPenalty?.otherDeductions, 500);
  assert.equal(withPenalty?.totalDeductions, 500);

  const withOverride = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "override", field: "loans", amount: 300 })],
    period: PERIOD,
    index: 1,
  });
  assert.equal(withOverride?.loans, 300);
  assert.equal(withOverride?.totalDeductions, 300);

  // prorate: worked 15/30 days → half of net deducted as unpaid
  const prorated = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "prorate", workedDays: 15 })],
    period: PERIOD,
    index: 1,
  });
  assert.equal(prorated?.unpaidVacations, 2500);
  assert.equal(prorated?.totalDeductions, 2500);

  // defer excludes the employee
  const deferred = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "defer" })],
    period: PERIOD,
    index: 1,
  });
  assert.equal(deferred, null);

  // hold: unlike defer, still produces a row (0 payable) with the required
  // comment surfaced via payrollComment (already rendered on the payslip)
  const held = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [],
    adjustments: [adj({ kind: "hold", reason: "Pending final HR review" })],
    period: PERIOD,
    index: 1,
  });
  assert.ok(held, "held row must still assemble, unlike defer");
  assert.equal(held.firstPart, 0);
  assert.equal(held.secondPart, 0);
  assert.equal(held.monthSalary, 0);
  assert.equal(held.payrollComment, "Pending final HR review");

  // recurring loan installment lands as a deduction
  const withRecurring = buildRowForEmployee({
    employee: makeEmp(),
    source: makeSource(),
    recurring: [rec({ kind: "loan", monthlyAmount: 1000 })],
    adjustments: [],
    period: PERIOD,
    index: 1,
  });
  assert.equal(withRecurring?.loans, 1000);
  assert.equal(withRecurring?.totalDeductions, 1000);

  // --- flags ------------------------------------------------------------------
  const base = {
    period: PERIOD,
    bigChangeThreshold: 0.25,
    prior: null,
    feeder: undefined,
  } as const;

  // green: complete data, tenured, no feeder, no prior → no flags
  assert.equal(
    evaluateEmployeeFlags({
      ...base,
      row: makeRow({ grossSalary: 6000, netSalary: 5000, baseSalary: 5000 }),
      employee: makeEmp(),
      source: makeSource(),
    }).length,
    0,
  );

  // missing data
  assert.ok(
    rulesOf(
      evaluateEmployeeFlags({
        ...base,
        row: makeRow({ grossSalary: 0, netSalary: 0 }),
        employee: makeEmp(),
        source: undefined,
      }),
    ).includes("missing_data"),
  );

  // joiner in period
  assert.ok(
    rulesOf(
      evaluateEmployeeFlags({
        ...base,
        row: makeRow({ grossSalary: 6000, netSalary: 5000, baseSalary: 5000 }),
        employee: makeEmp({ hireDate: "2026-06-10" }),
        source: makeSource(),
      }),
    ).includes("joiner_leaver"),
  );

  // unpaid leave
  assert.ok(
    rulesOf(
      evaluateEmployeeFlags({
        ...base,
        row: makeRow({ grossSalary: 6000, netSalary: 5000, baseSalary: 5000 }),
        employee: makeEmp(),
        source: makeSource(),
        feeder: {
          unpaidLeaveDays: 3,
          leaverLastWorkingDate: null,
          unpaidDaysBeforeLastWorkingDate: 0,
        },
      }),
    ).includes("unpaid_leave"),
  );

  // salary/role change
  assert.ok(
    rulesOf(
      evaluateEmployeeFlags({
        ...base,
        row: makeRow({ grossSalary: 6000, netSalary: 5000, baseSalary: 5000, line: "Line A", jobTitle: "Medical Representative" }),
        employee: makeEmp(),
        source: makeSource(),
        prior: { netSalary: 5000, baseSalary: 4000, line: "Line A", jobTitle: "Medical Representative" },
      }),
    ).includes("salary_role_change"),
  );

  // big change vs last month
  assert.ok(
    rulesOf(
      evaluateEmployeeFlags({
        ...base,
        row: makeRow({ grossSalary: 6000, netSalary: 8000, baseSalary: 5000, line: "Line A", jobTitle: "Medical Representative" }),
        employee: makeEmp(),
        source: makeSource(),
        prior: { netSalary: 5000, baseSalary: 5000, line: "Line A", jobTitle: "Medical Representative" },
      }),
    ).includes("big_change"),
  );

  // --- shared validator: new guards -------------------------------------------
  assert.equal(
    validateSalaryRows([makeRow({ hrId: "B-1", fullName: "A", grossSalary: 6000, netSalary: 5000 })]).length,
    0,
  );
  const overGuard = validateSalaryRows([
    makeRow({ hrId: "B-2", fullName: "B", grossSalary: 6000, netSalary: 1000, loans: 2000, totalDeductions: 2000 }),
  ]);
  assert.ok(overGuard.some((issue) => issue.code === "deductions_exceed_net"));
  const dupes = validateSalaryRows([
    makeRow({ hrId: "B-3", fullName: "C", grossSalary: 1, row: 1 }),
    makeRow({ hrId: "B-3", fullName: "C", grossSalary: 1, row: 2 }),
  ]);
  assert.ok(dupes.some((issue) => issue.code === "duplicate_hr_id"));

  // --- deterministic parser ---------------------------------------------------
  const candidates = [
    { hrId: "B-100", name: "Ahmed Sharaf" },
    { hrId: "B-142", name: "Mona Ali" },
  ];
  const bonusActions = parseDeterministic("give B-100 a 2000 bonus", { candidates });
  assert.equal(bonusActions.length, 1);
  assert.equal(bonusActions[0].kind, "bonus");
  assert.equal(bonusActions[0].hrId, "B-100");
  assert.equal(bonusActions[0].kind === "bonus" ? bonusActions[0].amount : 0, 2000);

  const penaltyActions = parseDeterministic("deduct 500 from Mona", { candidates });
  assert.equal(penaltyActions[0]?.kind, "penalty");
  assert.equal(penaltyActions[0]?.hrId, "B-142");

  const loanActions = parseDeterministic("loan B-100 1000 for 6 months", { candidates });
  assert.equal(loanActions[0]?.kind, "loan");
  assert.equal(loanActions[0]?.kind === "loan" ? loanActions[0].installments : 0, 6);
  assert.equal(loanActions[0]?.kind === "loan" ? loanActions[0].monthlyAmount : 0, 1000);

  // normalizeAction resolves case + rejects invalid
  assert.equal(
    normalizeAction({ kind: "bonus", hrId: "b-100", amount: 2000, reason: "x" }, candidates)?.hrId,
    "B-100",
  );
  assert.equal(normalizeAction({ kind: "bogus", hrId: "B-100" }, candidates), null);
  assert.equal(normalizeAction({ kind: "bonus", hrId: "B-100", amount: 0 }, candidates), null);

  // --- recurring window logic -------------------------------------------------
  assert.equal(isRecurringActiveForPeriod(rec({ startMonth: 6, startYear: 2026, remainingInstallments: 3 }), PERIOD), true);
  assert.equal(isRecurringActiveForPeriod(rec({ startMonth: 6, startYear: 2026 }), { month: 5, year: 2026 }), false);
  assert.equal(isRecurringActiveForPeriod(rec({ remainingInstallments: 0 }), PERIOD), false);
  assert.equal(isRecurringActiveForPeriod(rec({ active: false }), PERIOD), false);

  // --- recommendation engine (the one-click "AI") -----------------------------
  const flag = (rule: CopilotFlagRule, severity: CopilotFlagSeverity, question = "q"): CopilotFlag => ({
    employeeHrId: "B-1",
    rule,
    severity,
    question,
  });
  const recInput = (openFlags: CopilotFlag[], extra: Partial<Parameters<typeof recommendResolution>[0]> = {}) => ({
    hrId: "B-1",
    openFlags,
    row: makeRow(),
    monthSalary: 0,
    unpaidLeaveDays: 0,
    prior: null,
    period: PERIOD,
    ...extra,
  });

  // green (no open flags) -> no recommendation
  assert.equal(recommendResolution(recInput([])), null);

  // missing_data -> no auto-action, needs manual entry
  const recMissing = recommendResolution(recInput([flag("missing_data", "block")]));
  assert.equal(recMissing?.action, null);
  assert.equal(recMissing?.confidence, "needs_input");

  // unpaid_leave -> prorate to worked days (June = 30 days; 5 unpaid -> 25 worked)
  const recUnpaid = recommendResolution(recInput([flag("unpaid_leave", "block")], { unpaidLeaveDays: 5 }));
  assert.equal(recUnpaid?.action?.kind, "prorate");
  assert.equal(recUnpaid?.action && recUnpaid.action.kind === "prorate" ? recUnpaid.action.workedDays : -1, 25);
  assert.equal(recUnpaid?.confidence, "high");

  // joiner/leaver (warn, computed) -> accept the auto-settlement, high confidence
  const recJoiner = recommendResolution(recInput([flag("joiner_leaver", "warn")], { monthSalary: 6400 }));
  assert.equal(recJoiner?.action?.kind, "confirm");
  assert.equal(recJoiner?.confidence, "high");
  assert.ok(recJoiner?.why.includes("6,400"), "joiner recommendation states the computed settlement");

  // joiner/leaver (block, unparseable date) -> needs a human to fix the date
  const recJoinerBlock = recommendResolution(recInput([flag("joiner_leaver", "block")]));
  assert.equal(recJoinerBlock?.action, null);
  assert.equal(recJoinerBlock?.confidence, "needs_input");

  // salary_role_change with a BASE move -> real money, mark review
  const recBase = recommendResolution(
    recInput([flag("salary_role_change", "warn")], {
      row: makeRow({ baseSalary: 16500 }),
      prior: { netSalary: 15000, baseSalary: 14000, line: "A", jobTitle: "MR" },
    }),
  );
  assert.equal(recBase?.action?.kind, "confirm");
  assert.equal(recBase?.confidence, "review");

  // salary_role_change with ONLY a line/role move (org churn) -> safe to bulk-accept
  const recLine = recommendResolution(
    recInput([flag("salary_role_change", "warn")], {
      row: makeRow({ baseSalary: 14000, line: "B" }),
      prior: { netSalary: 15000, baseSalary: 14000, line: "A", jobTitle: "MR" },
    }),
  );
  assert.equal(recLine?.confidence, "high");

  // --- hold verb: now parseable AND normalizable (was accepted by the route but
  //     unspeakable by the parser) --------------------------------------------
  const holdParsed = parseDeterministic("hold B-100 salary, under investigation", { candidates });
  assert.equal(holdParsed[0]?.kind, "hold");
  assert.equal(holdParsed[0]?.hrId, "B-100");
  const holdNorm = normalizeAction({ kind: "hold", hrId: "B-100", reason: "under investigation" }, candidates);
  assert.equal(holdNorm?.kind, "hold");
  assert.equal(holdNorm && holdNorm.kind === "hold" ? holdNorm.reason : "", "under investigation");

  // --- assistant context builder (the prose-Q&A grounding) --------------------
  const asstEmp = (over: Partial<AssistantEmployeeContext>): AssistantEmployeeContext => ({
    hrId: "B-1",
    name: "Test",
    status: "green",
    netSalary: 0,
    monthSalary: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    flags: [],
    recommendation: null,
    ...over,
  });
  const ctx = buildAssistantContext([
    asstEmp({ hrId: "B-1", name: "Green One", status: "green" }),
    asstEmp({ hrId: "B-2", name: "Green Two", status: "green" }),
    asstEmp({
      hrId: "B-3",
      name: "Flagged Joiner",
      status: "question",
      monthSalary: 6400,
      flags: [{ rule: "joiner_leaver", question: "joined mid-month" }],
      recommendation: { why: "Partial month — accept settlement EGP 6,400.", confidence: "high" },
    }),
  ]);
  // Green employees are summarised as a count, not listed line-by-line.
  assert.ok(ctx.includes("3 (2 clean/green"), "green employees are summarised as a count");
  assert.ok(!ctx.includes("Green One"), "clean employees are NOT listed individually");
  // The flagged employee IS listed, with its flag + recommendation.
  assert.ok(ctx.includes("B-3 Flagged Joiner"), "flagged employee is listed by id + name");
  assert.ok(ctx.includes("joiner_leaver"), "flagged employee's flag rule is included");
  assert.ok(ctx.includes("Partial month"), "flagged employee's recommendation is included");
}
