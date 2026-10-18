import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { upsertEmployee } from "@/lib/employees/employee-directory";
import { outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { approveOutstationRequestForPayroll } from "@/lib/outstation/service";
import { createSalaryBatch, deleteSalaryBatch } from "@/lib/payroll/service";
import { createProbationEvaluation, runProbationWorkflow } from "@/lib/probation/service";
import { resignEmployeeAndOpenVacancy } from "@/lib/resignations/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createVacationRequest, decideVacationRequest } from "@/lib/vacation/service";
import type { AccessContext } from "@/lib/auth/permissions";

const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8).toUpperCase()}`;
const fixture = `PHASE16_${suffix}`.toUpperCase();
const actor = "phase16.fixture.smoke";
const today = "2026-05-18";

loadLocalEnv();

const supabase = getSupabaseAdmin();
const cleanupWarnings: string[] = [];
const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const tracked = {
  employeeHrIds: new Set<string>(),
  expenseTripIds: new Set<string>(),
  outstationRequestIds: new Set<number>(),
  payrollBatchIds: new Set<string>(),
  payrollReportFileNames: new Set<string>(),
  probationEvaluationIds: new Set<string>(),
  vacationRequestIds: new Set<string>(),
};

const adminAccess: AccessContext = {
  hrId: `${fixture}_ADMIN`,
  loginId: actor,
  role: "Super Admin",
  scope: "system",
  source: "system",
};

type LookupContext = {
  areaId: number | null;
  areaName: string;
  departmentId: number | null;
  lineId: number | null;
  lineName: string;
  positionId: number | null;
  positionTitle: string;
};

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Environment variables may be injected by the runner.
  }
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) {
    throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
  }
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

async function safeDelete(table: string, column: string, values: string[] | number[]) {
  if (values.length === 0) return;
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) cleanupWarnings.push(`${table}.${column}: ${error.message}`);
}

async function safeDeleteIlike(table: string, column: string, value: string) {
  const { error } = await supabase.from(table).delete().ilike(column, value);
  if (error) cleanupWarnings.push(`${table}.${column}: ${error.message}`);
}

async function selectMaybeSingle(table: string, select: string, column: string, value: string | number) {
  const { data, error } = await supabase.from(table).select(select).eq(column, value).maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

async function resolveLookupContext(): Promise<LookupContext> {
  const { data: area, error: areaError } = await supabase
    .from("areas")
    .select("id,name,line_id")
    .not("line_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (areaError) throw areaError;
  if (!area) throw new Error("No area lookup row is available for PHASE16 fixture testing.");

  const lineId = Number((area as Record<string, unknown>).line_id);
  const { data: line, error: lineError } = await supabase
    .from("lines")
    .select("id,name,department_id")
    .eq("id", lineId)
    .maybeSingle();
  if (lineError) throw lineError;

  const { data: position, error: positionError } = await supabase
    .from("positions")
    .select("id,title")
    .limit(1)
    .maybeSingle();
  if (positionError) throw positionError;
  if (!position) throw new Error("No position lookup row is available for PHASE16 fixture testing.");

  const lineRow = (line ?? {}) as Record<string, unknown>;
  return {
    areaId: Number((area as Record<string, unknown>).id),
    areaName: String((area as Record<string, unknown>).name ?? "PHASE16 Area"),
    departmentId: Number.isFinite(Number(lineRow.department_id)) ? Number(lineRow.department_id) : null,
    lineId,
    lineName: String(lineRow.name ?? "PHASE16 Line"),
    positionId: Number((position as Record<string, unknown>).id),
    positionTitle: String((position as Record<string, unknown>).title ?? "PHASE16 Position"),
  };
}

function employeeInput(hrId: string, fullName: string, lookup: LookupContext, managerHrId?: string | null) {
  return {
    areaId: lookup.areaId,
    departmentId: lookup.departmentId,
    employmentStatus: "active",
    fullName,
    hireDate: "2026-01-01",
    hrId,
    jobTitle: lookup.positionTitle,
    lineId: lookup.lineId,
    managerHrId: managerHrId ?? null,
    positionId: lookup.positionId,
    salaryPaymentMode: "one_part",
  };
}

function salaryRow(hrId: string, fullName: string, lookup: LookupContext) {
  return {
    area: lookup.areaName,
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 10250,
    fuelAllowance: 250,
    fullName,
    governmentalDeductions: 0,
    grossSalary: 10250,
    hireDate: "2026-01-01",
    hrId,
    incentive: 0,
    jobTitle: lookup.positionTitle,
    line: lookup.lineName,
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 10250,
    nameAr: null,
    netSalary: 10250,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: `${fixture} disposable payroll row`,
    paymentMode: "one_part" as const,
    row: 2,
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  };
}

async function createEmployee(hrId: string, name: string, lookup: LookupContext, managerHrId?: string | null) {
  tracked.employeeHrIds.add(hrId);
  await upsertEmployee(employeeInput(hrId, name, lookup, managerHrId));
}

async function verifyTerminalFlags(hrId: string) {
  const employee = await selectMaybeSingle(
    "employees",
    "hr_id,employment_status,organogram_visible,payroll_eligible",
    "hr_id",
    hrId,
  );
  // No organogram view is read here any more: `v_active_organogram` was dropped on 2026-10-12 and
  // the EU organogram (`au_v_*`) is the source of truth. `organogram_visible` below IS the
  // organogram exclusion for a seatless fixture — see the note in phase15.
  const payroll = await supabase.from("v_payroll_eligible_employees").select("hr_id").eq("hr_id", hrId).limit(1);

  addCheck("terminal raw flags are false", employee?.organogram_visible === false && employee?.payroll_eligible === false, employee);
  addCheck("terminal employee is excluded from payroll eligibility", (payroll.data ?? []).length === 0, { payroll: payroll.data });
}

async function findAvailablePayrollPeriod() {
  const { data, error } = await supabase
    .from("salary_batches")
    .select("month,year")
    .gte("year", 2090)
    .lte("year", 2100);
  if (error) throw error;

  const used = new Set((data ?? []).map((row) => `${Number(row.year)}-${Number(row.month)}`));
  for (let year = 2090; year <= 2100; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if (!used.has(`${year}-${month}`)) return { month, year };
    }
  }
  throw new Error("No disposable payroll period is available between 2090 and 2100.");
}

async function runLifecycleSmoke(lookup: LookupContext) {
  const hrId = `${fixture}_TERM`;
  await createEmployee(hrId, `${fixture} Terminal Employee`, lookup);
  await resignEmployeeAndOpenVacancy(hrId, {
    effectiveDate: today,
    employeeHrId: hrId,
    employeeStatus: "terminated",
    reason: "PHASE16 terminal raw flag verification.",
    submittedDate: today,
    workflowNotes: "PHASE16 disposable lifecycle smoke.",
  }, actor);
  await verifyTerminalFlags(hrId);
}

async function runProbationSmoke(lookup: LookupContext) {
  const hrId = `${fixture}_PROB`;
  await createEmployee(hrId, `${fixture} Probation Employee`, lookup);
  const probationPayload = {
      hr_id: hrId,
      employee_hr_id: hrId,
      probation_end_date: "2026-06-01",
      probation_start_date: "2026-03-01",
      status: "active",
    };
  let probationInsert = await supabase
    .from("employee_probation")
    .insert(probationPayload)
    .select("id")
    .single();
  if (probationInsert.error && message(probationInsert.error).includes("hr_id")) {
    const { hr_id: legacyHrId, ...currentPayload } = probationPayload;
    void legacyHrId;
    probationInsert = await supabase
      .from("employee_probation")
      .insert(currentPayload)
      .select("id")
      .single();
  }
  if (probationInsert.error) throw probationInsert.error;
  const probation = probationInsert.data;

  const evaluation = await createProbationEvaluation({
    employeeHrId: hrId,
    evaluationScores: {},
    managerFeedback: "PHASE16 disposable probation feedback.",
  }, actor, adminAccess);
  tracked.probationEvaluationIds.add(evaluation.id);

  const terminated = await runProbationWorkflow(evaluation.id, "terminate", actor, adminAccess, {
    decisionReason: "PHASE16 disposable probation termination.",
  });
  addCheck("probation termination workflow completed", terminated?.decision === "terminate" && terminated.status === "terminated", terminated);
  const probationRow = await selectMaybeSingle("employee_probation", "id,status", "id", String(probation.id));
  addCheck("probation row marked terminated", probationRow?.status === "terminated", probationRow);
  await verifyTerminalFlags(hrId);
}

async function runVacationServiceSmoke(lookup: LookupContext) {
  const managerHrId = `${fixture}_VMGR`;
  const employeeHrId = `${fixture}_VAC`;
  await createEmployee(managerHrId, `${fixture} Vacation Manager`, lookup);
  await createEmployee(employeeHrId, `${fixture} Vacation Employee`, lookup, managerHrId);

  const request = await createVacationRequest({
    ...adminAccess,
    hrId: employeeHrId,
    loginId: `${actor}.vacation.submit`,
  }, {
    dayPart: "full_day",
    endDate: "2026-07-01",
    startDate: "2026-07-01",
    vacationType: "annual",
  });
  tracked.vacationRequestIds.add(request.id);

  const approved = await decideVacationRequest({
    ...adminAccess,
    hrId: managerHrId,
    loginId: `${actor}.vacation.approve`,
  }, {
    decision: "approve",
    decisionComment: "PHASE16 disposable vacation approval.",
    requestId: request.id,
  });
  addCheck("vacation request approved through app service", approved.status === "approved", approved);
}

async function runOutstationApprovalSmoke(lookup: LookupContext) {
  const hrId = `${fixture}_OUT`;
  await createEmployee(hrId, `${fixture} Outstation Employee`, lookup);
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert({
      allowance_amount: 100,
      allowance_breakdown_json: {},
      approval_reason: "PHASE16 disposable request ready for approval.",
      approval_recommendation: "finance_review",
      area: lookup.areaName,
      calculation_status: "submitted",
      captured_accuracy_meters: 10,
      captured_at: "2026-07-02T08:00:00.000Z",
      captured_latitude: 30.0444,
      captured_location_source: "browser_gps",
      captured_longitude: 31.2357,
      claimed_total_amount: 150,
      distance_from_residence_km: 70,
      distance_km: 70,
      employee_hr_id: hrId,
      employee_name: `${fixture} Outstation Employee`,
      employee_role: "Medical Rep",
      expected_total_amount: 150,
      expense_type: "traveling",
      fuel_amount: 50,
      eligibility_reason: "PHASE16 disposable eligible request.",
      eligibility_status: "eligible",
      fraud_flags_json: [],
      line: lookup.lineName,
      minimum_required_distance_km: 60,
      residence_area: lookup.areaName,
      residence_city: "Cairo",
      status: "submitted",
      submitted_at: "2026-07-02T08:00:00.000Z",
      ticket_amount: 0,
      to_area: "Alexandria",
      to_city: "Alexandria",
      to_label: "Alexandria",
      transportation_type: "car",
      trip_end_date: "2026-07-02T18:00:00.000Z",
      trip_start_date: "2026-07-02T08:00:00.000Z",
    })
    .select("id,updated_at")
    .single();
  if (error) throw error;

  const requestId = Number(data.id);
  tracked.outstationRequestIds.add(requestId);
  const fileName = `outstation-request-${requestId}.workflow`;
  tracked.payrollReportFileNames.add(fileName);
  const result = await approveOutstationRequestForPayroll(requestId, adminAccess, {
    comment: "PHASE16 disposable approved for payroll.",
    // The version just inserted — an approval has to say which figures it was given.
    expectedRevision: outstationClaimRevision(data.updated_at),
  });
  tracked.expenseTripIds.add(result.expenseTripId);
  const expense = await selectMaybeSingle("outstation_expenses", "trip_id,hr_approved,total", "trip_id", result.expenseTripId);
  addCheck("outstation approval created approved payroll expense", expense?.hr_approved === true, expense);
}

async function runPayrollCleanupReadinessSmoke(lookup: LookupContext) {
  const hrId = `${fixture}_PAY`;
  await createEmployee(hrId, `${fixture} Payroll Employee`, lookup);
  const period = await findAvailablePayrollPeriod();
  const created = await createSalaryBatch({
    fileName: `${fixture}-cleanup-readiness.xlsx`,
    month: period.month,
    records: [salaryRow(hrId, `${fixture} Payroll Employee`, lookup)],
    uploadedBy: actor,
    validationWarnings: [],
    year: period.year,
  });
  tracked.payrollBatchIds.add(created.batch.id);

  await deleteSalaryBatch(created.batch.id);
  tracked.payrollBatchIds.delete(created.batch.id);
  const deleted = await selectMaybeSingle("salary_batches", "id", "id", created.batch.id);
  addCheck("unlocked PHASE16 payroll fixture can be cleaned through service", deleted === null, deleted);
}

async function cleanup() {
  await safeDelete("v2_vacation_request_events", "request_id", Array.from(tracked.vacationRequestIds));
  await safeDelete("v2_vacation_email_tokens", "request_id", Array.from(tracked.vacationRequestIds));
  await safeDelete("v2_vacation_requests", "id", Array.from(tracked.vacationRequestIds));
  await safeDelete("probation_history", "evaluation_id", Array.from(tracked.probationEvaluationIds));
  await safeDelete("probation_evaluations", "id", Array.from(tracked.probationEvaluationIds));
  await safeDelete("employee_probation", "employee_hr_id", Array.from(tracked.employeeHrIds));
  await safeDelete("outstation_expenses", "trip_id", Array.from(tracked.expenseTripIds));
  for (const fileName of tracked.payrollReportFileNames) {
    await safeDeleteIlike("outstation_expense_reports", "file_name", fileName);
  }
  await safeDelete("outstation_location_audit_logs", "expense_request_id", Array.from(tracked.outstationRequestIds));
  await safeDelete("outstation_expense_requests", "id", Array.from(tracked.outstationRequestIds));
  await safeDelete("employee_resignations", "employee_hr_id", Array.from(tracked.employeeHrIds));
  await safeDelete("position_vacancies", "replacement_for_hr_id", Array.from(tracked.employeeHrIds));
  await safeDelete("salary_batches", "id", Array.from(tracked.payrollBatchIds));
  await safeDelete("employees", "hr_id", Array.from(tracked.employeeHrIds));
}

async function main() {
  try {
    const lookup = await resolveLookupContext();
    await runLifecycleSmoke(lookup);
    await runProbationSmoke(lookup);
    await runVacationServiceSmoke(lookup);
    await runOutstationApprovalSmoke(lookup);
    await runPayrollCleanupReadinessSmoke(lookup);
  } finally {
    await cleanup();
  }

  console.log(JSON.stringify({
    checks,
    cleanupWarnings,
    fixture,
    passed: checks.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    cleanupWarnings,
    error: message(error),
    fixture,
  }, null, 2));
  process.exitCode = 1;
});
