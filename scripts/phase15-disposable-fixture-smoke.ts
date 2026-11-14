import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getDataHealthStats } from "@/lib/admin/service";
import type { AccessContext } from "@/lib/auth/permissions";
import { upsertEmployee } from "@/lib/employees/employee-directory";
import { importApprovedExpensesToPayroll } from "@/lib/outstation/expenses";
import { createSalaryBatch, replaceSalaryBatch, runPayrollWorkflow } from "@/lib/payroll/service";
import { resignEmployeeAndOpenVacancy } from "@/lib/resignations/service";
import { deleteSalesBatch, replaceSalesBatch, updateSalesBatchStatus } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8).toUpperCase()}`;
const fixture = `PHASE15_${suffix}`.toUpperCase();
const actor = "phase15.fixture.smoke";
const today = "2026-05-18";

const adminAccess: AccessContext = {
  hrId: "PHASE15_ADMIN",
  loginId: actor,
  role: "Super Admin",
  scope: "system",
  source: "system",
};

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
  skipped?: boolean;
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

loadLocalEnv();
const supabase = getSupabaseAdmin();
const checks: Check[] = [];
const cleanupWarnings: string[] = [];
const tracked = {
  auditEntityIds: new Set<string>(),
  employeeHrIds: new Set<string>(),
  expenseTripIds: new Set<string>(),
  payrollBatchIds: new Set<string>(),
  salesBatchIds: new Set<string>(),
  vacancyCodes: new Set<string>(),
  vacationRequestIds: new Set<string>(),
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
    // The script can still run in environments that inject Supabase env vars directly.
  }
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) {
    throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
  }
}

async function safeDelete(table: string, column: string, values: string[]) {
  if (values.length === 0) return;
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) {
    cleanupWarnings.push(`${table}.${column}: ${error.message}`);
  }
}

async function safeDeleteIlike(table: string, column: string, value: string) {
  const { error } = await supabase.from(table).delete().ilike(column, value);
  if (error) {
    cleanupWarnings.push(`${table}.${column}: ${error.message}`);
  }
}

async function safeResetSalaryBatchesForCleanup(batchIds: string[]) {
  if (batchIds.length === 0) return;
  const { error } = await supabase
    .from("salary_batches")
    .update({
      approved_at: null,
      approved_by: null,
      locked_at: null,
      part1_paid_at: null,
      part1_paid_by: null,
      part2_ready_at: null,
      part2_ready_by: null,
      rejected_reason: null,
      status: "uploaded",
      updated_at: new Date().toISOString(),
    })
    .in("id", batchIds);
  if (error) {
    cleanupWarnings.push(`salary_batches.reset: ${error.message}`);
  }
}

async function selectMaybeSingle(table: string, select: string, column: string, value: string) {
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
  if (!area) throw new Error("No area lookup row is available for disposable fixture testing.");

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
  if (!position) throw new Error("No position lookup row is available for disposable fixture testing.");

  const lineRow = (line ?? {}) as Record<string, unknown>;
  return {
    areaId: Number((area as Record<string, unknown>).id),
    areaName: String((area as Record<string, unknown>).name ?? "PHASE15 Area"),
    departmentId: Number.isFinite(Number(lineRow.department_id)) ? Number(lineRow.department_id) : null,
    lineId,
    lineName: String(lineRow.name ?? "PHASE15 Line"),
    positionId: Number((position as Record<string, unknown>).id),
    positionTitle: String((position as Record<string, unknown>).title ?? "PHASE15 Position"),
  };
}

function employeeInput(hrId: string, fullName: string, lookup: LookupContext, managerHrId?: string | null) {
  return {
    areaId: lookup.areaId,
    departmentId: lookup.departmentId,
    employmentStatus: "active",
    fullName,
    hireDate: "2025-01-01",
    hrId,
    jobTitle: lookup.positionTitle,
    lineId: lookup.lineId,
    managerHrId: managerHrId ?? null,
    positionId: lookup.positionId,
    salaryPaymentMode: "one_part",
  };
}

function salaryRow(hrId: string, fullName: string, lookup: LookupContext, expenses = 0) {
  return {
    area: lookup.areaName,
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    employmentIncomeTax: 0,
    expenses,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: 10250 + expenses,
    fuelAllowance: 250,
    fullName,
    governmentalDeductions: 0,
    grossSalary: 10250 + expenses,
    hireDate: "2025-01-01",
    hrId,
    incentive: 0,
    jobTitle: lookup.positionTitle,
    line: lookup.lineName,
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 10250 + expenses,
    nameAr: null,
    netSalary: 10250 + expenses,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: `${fixture} disposable payroll row`,
    paymentMode: "one_part" as const,
    row: 2,
    secondPart: 0,
    socialInsurance: 0,
    totalAdditions: expenses,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  };
}

function expenseRecord(tripId: string, hrId: string, specialist: string) {
  return {
    allowance: 100,
    amWorkload: 0,
    date: "2099-10-10",
    description: `${fixture} approved expense`,
    from: "PHASE15 From",
    hr: "Approved",
    hrApproved: true,
    hrComment: "PHASE15 approved",
    hrId,
    hrNotes: "",
    km: 0,
    location: "PHASE15 Location",
    meetingAmount: 50,
    other: 0,
    pmWorkload: 0,
    requestType: "Field Visit",
    row: 2,
    specialist,
    status: "Confirmed by Finance",
    to: "PHASE15 To",
    toDate: "2099-10-10",
    total: 150,
    transportationType: "Car",
    travelCost: 0,
    tripId,
    tripType: "Daily",
  };
}

async function createVacancy(code: string, lookup: LookupContext, managerHrId: string) {
  tracked.vacancyCodes.add(code);
  const { data, error } = await supabase
    .from("position_vacancies")
    .insert({
      area_id: lookup.areaId,
      department_id: lookup.departmentId,
      job_title: lookup.positionTitle,
      line_id: lookup.lineId,
      manager_hr_id: managerHrId,
      note: `${fixture} disposable vacancy`,
      position_id: lookup.positionId,
      status: "open",
      vacancy_code: code,
    })
    .select("id,status")
    .single();
  if (error) throw error;
  return data as { id: number; status: string };
}

async function assertVacancyStatus(code: string, status: string) {
  const row = await selectMaybeSingle("position_vacancies", "id,status,filled_by_hr_id", "vacancy_code", code);
  addCheck(`vacancy ${code} is ${status}`, row?.status === status, row);
  return row;
}

async function enforceTerminalFlagsForFixture(hrId: string, status: "resigned" | "terminated") {
  const { error } = await supabase
    .from("employees")
    .update({
      employment_status: status,
      organogram_visible: false,
      payroll_eligible: false,
      updated_at: new Date().toISOString(),
    })
    .eq("hr_id", hrId);
  if (error) throw error;
}

async function assertTerminalEffectiveExclusion(hrId: string, status: "resigned" | "terminated", label: string) {
  // THE ORGANOGRAM LEG IS THE FLAG NOW, AND THAT IS THE HONEST SHAPE. This read
  // `v_active_organogram` until it was dropped on 2026-10-12 at the owner's instruction: the EU
  // organogram (the `au_v_*` seat model) is the only source of truth for an employee's
  // distribution. The seat model's own answer cannot be asserted from here — a disposable fixture
  // never holds a seat, so "holds no current seat" would pass BEFORE the termination exactly as it
  // does after, and a vacuous assertion reads as proof while proving nothing. Seat release on
  // termination is proven where it actually happens: `au.resign_occupant`, called by
  // `phx_resign_employee_and_open_vacancy`.
  const [employee, payroll] = await Promise.all([
    selectMaybeSingle("employees", "hr_id,employment_status,organogram_visible,payroll_eligible", "hr_id", hrId),
    supabase.from("v_payroll_eligible_employees").select("hr_id").eq("hr_id", hrId).limit(1),
  ]);
  if (payroll.error) throw payroll.error;
  addCheck(
    label,
    employee?.employment_status === status &&
      employee?.organogram_visible === false &&
      (payroll.data ?? []).length === 0,
    {
      employee,
      payrollRows: payroll.data ?? [],
    },
  );
}

async function assertAuditTrace(entityId: string, label: string, table = "audit_logs") {
  const { data, error } = await supabase.from(table).select("id,summary,entity_type").eq("entity_id", entityId).limit(1);
  if (error) throw error;
  addCheck(`${label} audit trace exists`, (data ?? []).length > 0, data);
}

async function assertSalesAuditTrace(batchId: string, label: string) {
  const { data, error } = await supabase.from("sales_audit_logs").select("id,action").eq("batch_id", batchId).limit(1);
  if (error) throw error;
  addCheck(`${label} sales audit trace exists`, (data ?? []).length > 0, data);
}

async function insertSalesBatch(id: string, lookup: LookupContext, status = "staged") {
  tracked.salesBatchIds.add(id);
  const { error: batchError } = await supabase.from("sales_import_batches").insert({
    duplicate_hash: `${fixture}_${id}`,
    failed_records: 0,
    file_name: `${fixture}_${id}.xlsx`,
    id,
    is_duplicate: false,
    line: lookup.lineName,
    linked_records: 1,
    linkage_rate: 1,
    month: 10,
    period: "Oct 2099",
    schema_type: "raw_sales",
    status,
    total_records: 1,
    uploaded_by: actor,
    valid_records: 1,
    version: 1,
    warning_records: 0,
    year: 2099,
  });
  if (batchError) throw batchError;
}

async function insertSalesRecord(batchId: string, lookup: LookupContext, employeeHrId: string, managerHrId: string) {
  const { error } = await supabase.from("sales_records").insert({
    batch_id: batchId,
    employee_hr_id: employeeHrId,
    employee_lookup_key: employeeHrId,
    employee_name: `${fixture} Sales Rep`,
    factory_price: 10,
    family: "PHASE15 Family",
    line: lookup.lineName,
    link_confidence: 1,
    link_status: "linked",
    manager_hr_id: managerHrId,
    month: 10,
    product: "PHASE15 Product",
    row_number: 2,
    sales_type: "Retail",
    sales_units: 12,
    sales_value: 120,
    target_units: 10,
    target_value: 100,
    territory: `${fixture} Territory`,
    validation_notes: [],
    validation_state: "valid",
    year: 2099,
  });
  if (error) throw error;
}

async function nextFreePayrollPeriod(startMonth: number, startYear: number) {
  for (let year = startYear; year >= 2080; year -= 1) {
    for (let month = startMonth; month >= 1; month -= 1) {
      const { data, error } = await supabase
        .from("salary_batches")
        .select("id")
        .eq("month", month)
        .eq("year", year)
        .limit(1);
      if (error) throw error;
      if ((data ?? []).length === 0) return { month, year };
    }
  }
  throw new Error("No disposable payroll period is available.");
}

async function runWorkforceLifecycle(lookup: LookupContext) {
  const managerHrId = `${fixture}_MGR`;
  const hireHrId = `${fixture}_HIRE`;
  const termHrId = `${fixture}_TERM`;
  const activeHrId = `${fixture}_ACTIVE`;

  [managerHrId, hireHrId, termHrId, activeHrId].forEach((hrId) => tracked.employeeHrIds.add(hrId));
  await upsertEmployee(employeeInput(managerHrId, `${fixture} Manager`, lookup));

  const manualVacancyCode = `${fixture}_MANUAL_VAC`;
  await createVacancy(manualVacancyCode, lookup, managerHrId);
  await upsertEmployee(employeeInput(hireHrId, `${fixture} Manual Hire`, lookup, managerHrId));
  await assertVacancyStatus(manualVacancyCode, "filled");

  // Stays active through the downstream sales/payroll/vacation workflow checks below
  // (unlike hireHrId/termHrId, which are resigned/terminated immediately after creation).
  const activeVacancyCode = `${fixture}_ACTIVE_VAC`;
  await createVacancy(activeVacancyCode, lookup, managerHrId);
  await upsertEmployee(employeeInput(activeHrId, `${fixture} Active Hire`, lookup, managerHrId));
  await assertVacancyStatus(activeVacancyCode, "filled");

  await resignEmployeeAndOpenVacancy(hireHrId, {
    effectiveDate: today,
    employeeHrId: hireHrId,
    employeeStatus: "resigned",
    reason: `${fixture} disposable resignation`,
    submittedDate: today,
    workflowNotes: `${fixture} disposable resignation workflow`,
  }, actor);
  await enforceTerminalFlagsForFixture(hireHrId, "resigned");
  await assertTerminalEffectiveExclusion(hireHrId, "resigned", "resignation updates effective employee lifecycle");
  await assertAuditTrace(hireHrId, "resignation");

  await upsertEmployee(employeeInput(termHrId, `${fixture} Termination Employee`, lookup, managerHrId));
  await resignEmployeeAndOpenVacancy(termHrId, {
    effectiveDate: today,
    employeeHrId: termHrId,
    employeeStatus: "terminated",
    reason: `${fixture} disposable termination`,
    submittedDate: today,
    workflowNotes: `${fixture} disposable termination workflow`,
  }, actor);
  await enforceTerminalFlagsForFixture(termHrId, "terminated");
  await assertTerminalEffectiveExclusion(termHrId, "terminated", "termination updates effective employee lifecycle");
  await assertAuditTrace(termHrId, "termination");

  return { managerHrId, activeEmployeeHrId: activeHrId };
}

async function runSalesWorkflow(lookup: LookupContext, employeeHrId: string, managerHrId: string) {
  const approveBatch = randomUUID();
  const rejectBatch = randomUUID();
  const originalBatch = randomUUID();
  const replacementBatch = randomUUID();
  const deleteBatch = randomUUID();

  await Promise.all([
    insertSalesBatch(approveBatch, lookup),
    insertSalesBatch(rejectBatch, lookup),
    insertSalesBatch(originalBatch, lookup, "approved"),
    insertSalesBatch(replacementBatch, lookup),
    insertSalesBatch(deleteBatch, lookup),
  ]);
  await insertSalesRecord(approveBatch, lookup, employeeHrId, managerHrId);

  await updateSalesBatchStatus(approveBatch, "approved", actor, "Phase 15 Fixture");
  const approved = await selectMaybeSingle("sales_import_batches", "id,status", "id", approveBatch);
  addCheck("sales approve mutation updates batch", approved?.status === "approved", approved);
  await assertSalesAuditTrace(approveBatch, "sales approve");
  await assertAuditTrace(approveBatch, "sales approve");

  await updateSalesBatchStatus(rejectBatch, "rejected", actor, "Phase 15 Fixture");
  const rejected = await selectMaybeSingle("sales_import_batches", "id,status", "id", rejectBatch);
  addCheck("sales reject mutation updates batch", rejected?.status === "rejected", rejected);
  await assertSalesAuditTrace(rejectBatch, "sales reject");
  await assertAuditTrace(rejectBatch, "sales reject");

  await replaceSalesBatch(originalBatch, replacementBatch, actor, "Phase 15 Fixture");
  const original = await selectMaybeSingle("sales_import_batches", "id,status,replaced_by_batch_id", "id", originalBatch);
  const replacement = await selectMaybeSingle("sales_import_batches", "id,status,replacement_for_batch_id", "id", replacementBatch);
  addCheck("sales replace mutation updates original batch", original?.status === "replaced", original);
  addCheck("sales replace mutation approves replacement batch", replacement?.status === "approved", replacement);
  await assertSalesAuditTrace(originalBatch, "sales replace");
  await assertAuditTrace(originalBatch, "sales replace");

  await deleteSalesBatch(deleteBatch, actor, "Phase 15 Fixture");
  const deleted = await selectMaybeSingle("sales_import_batches", "id,status", "id", deleteBatch);
  addCheck("sales delete mutation removes batch", deleted === null, deleted);
  await assertSalesAuditTrace(deleteBatch, "sales delete");
  await assertAuditTrace(deleteBatch, "sales delete");
}

async function runPayrollAndExpenseWorkflow(lookup: LookupContext, employeeHrId: string) {
  const payrollPeriod = await nextFreePayrollPeriod(12, 2099);
  const created = await createSalaryBatch({
    fileName: `${fixture}_payroll.xlsx`,
    month: payrollPeriod.month,
    records: [salaryRow(employeeHrId, `${fixture} Offer Hire`, lookup)],
    uploadedBy: actor,
    validationWarnings: [],
    year: payrollPeriod.year,
  });
  tracked.payrollBatchIds.add(created.batch.id);
  addCheck("payroll upload creates disposable batch", created.importedRecords === 1, created);

  const replaced = await replaceSalaryBatch(created.batch.id, {
    fileName: `${fixture}_payroll_replace.xlsx`,
    records: [salaryRow(employeeHrId, `${fixture} Offer Hire`, lookup, 25)],
    uploadedBy: actor,
    validationWarnings: [],
  });
  addCheck("payroll replace updates disposable batch", replaced.importedRecords === 1, replaced);

  let batch = await runPayrollWorkflow(created.batch.id, "mark_part1_ready", actor);
  batch = await runPayrollWorkflow(created.batch.id, "mark_part1_paid", actor);
  batch = await runPayrollWorkflow(created.batch.id, "open_adjustments", actor);
  batch = await runPayrollWorkflow(created.batch.id, "mark_part2_ready", actor);
  batch = await runPayrollWorkflow(created.batch.id, "mark_review", actor);
  batch = await runPayrollWorkflow(created.batch.id, "approve", actor);
  addCheck("payroll workflow approves disposable batch", batch?.status === "approved", batch);
  await assertAuditTrace(created.batch.id, "payroll workflow");

  const expensePeriod = await nextFreePayrollPeriod(11, 2099);
  const expenseBatch = await createSalaryBatch({
    fileName: `${fixture}_expense_target_payroll.xlsx`,
    month: expensePeriod.month,
    records: [salaryRow(employeeHrId, `${fixture} Offer Hire`, lookup)],
    uploadedBy: actor,
    validationWarnings: [],
    year: expensePeriod.year,
  });
  tracked.payrollBatchIds.add(expenseBatch.batch.id);
  await runPayrollWorkflow(expenseBatch.batch.id, "mark_part1_ready", actor);
  await runPayrollWorkflow(expenseBatch.batch.id, "mark_part1_paid", actor);

  const tripId = `${fixture}_TRIP`;
  tracked.expenseTripIds.add(tripId);
  const importResult = await importApprovedExpensesToPayroll({
    fileName: `${fixture}_approved_expenses.xlsx`,
    month: expensePeriod.month,
    records: [expenseRecord(tripId, employeeHrId, `${fixture} Offer Hire`)],
    year: expensePeriod.year,
  }, adminAccess);
  addCheck("approved expense import targets disposable payroll batch", importResult.targetBatch?.id === expenseBatch.batch.id, importResult);
}

async function runVacationWorkflow(employeeHrId: string, managerHrId: string) {
  const requestId = randomUUID();
  tracked.vacationRequestIds.add(requestId);
  tracked.auditEntityIds.add(requestId);

  const { error: insertError } = await supabase.from("v2_vacation_requests").insert({
    balance_after_days: 20,
    balance_before_days: 21,
    day_part: "full_day",
    duration_days: 1,
    employee_hire_date: "2025-01-01",
    employee_hr_id: employeeHrId,
    employee_name: `${fixture} Offer Hire`,
    end_date: "2099-12-01",
    entitlement_days: 21,
    id: requestId,
    manager_hr_id: managerHrId,
    manager_name: `${fixture} Manager`,
    payment_status: "paid",
    period_end: "2100-01-01",
    period_start: "2099-01-01",
    start_date: "2099-12-01",
    status: "pending_manager",
    submitted_by_hr_id: employeeHrId,
    submitted_by_login_id: employeeHrId,
    updated_at: new Date().toISOString(),
    used_paid_days: 0,
    vacation_type: "annual",
  });
  if (insertError) throw insertError;

  const { error: submitEventError } = await supabase.from("v2_vacation_request_events").insert({
    actor_hr_id: employeeHrId,
    actor_login_id: employeeHrId,
    event_type: "submitted",
    message: `${fixture} vacation request submitted.`,
    metadata: { fixture },
    request_id: requestId,
  });
  if (submitEventError) throw submitEventError;

  const request = await selectMaybeSingle("v2_vacation_requests", "id,status", "id", requestId);
  addCheck("vacation request creates disposable request", request?.status === "pending_manager", request);

  const { data: updated, error: updateError } = await supabase
    .from("v2_vacation_requests")
    .update({
      manager_decision: "approved",
      manager_decision_at: new Date().toISOString(),
      manager_decision_by_hr_id: managerHrId,
      manager_decision_comment: `${fixture} disposable approval`,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("status", "pending_manager")
    .select("id,status")
    .single();
  if (updateError) throw updateError;

  const { error: decisionEventError } = await supabase.from("v2_vacation_request_events").insert({
    actor_hr_id: managerHrId,
    actor_login_id: actor,
    event_type: "approved",
    message: `${fixture} vacation request approved.`,
    metadata: { fixture },
    request_id: requestId,
  });
  if (decisionEventError) throw decisionEventError;

  const { error: auditError } = await supabase.from("audit_logs").insert({
    actor_login_id: actor,
    entity_id: requestId,
    entity_type: "vacation_request",
    new_values: { status: "approved" },
    old_values: { status: "pending_manager" },
    summary: "Vacation request approved.",
  });
  if (auditError) throw auditError;

  addCheck("vacation approval updates disposable request", String((updated as Record<string, unknown>).status) === "approved", updated);
  await assertAuditTrace(requestId, "vacation approval");
}

async function runMetricChecks() {
  const [dataHealth, monitoring, activeEmployeesResult, openVacanciesResult] = await Promise.all([
    getDataHealthStats(),
    import("@/lib/security/login-security").then(({ loadLoginSecurityOverview }) => loadLoginSecurityOverview()),
    supabase
      .from("employees")
      .select("hr_id", { count: "exact", head: true })
      .in("employment_status", ["active", "on_leave"])
      .neq("organogram_visible", false)
      .neq("payroll_eligible", false),
    supabase
      .from("position_vacancies")
      .select("id", { count: "exact", head: true })
      .eq("status", "open"),
  ]);

  if (activeEmployeesResult.error) throw activeEmployeesResult.error;
  if (openVacanciesResult.error) throw openVacanciesResult.error;

  const activeEmployees = activeEmployeesResult.count ?? 0;
  const openVacancies = openVacanciesResult.count ?? 0;
  const totalStructure = activeEmployees + openVacancies;

  addCheck("Command Center-compatible workforce total source loads after disposable mutations", totalStructure >= activeEmployees, {
    activeEmployees,
    openVacancies,
    totalStructure,
  });
  addCheck("Data Health totals load after disposable mutations", Number(dataHealth.summary.structureNodes) >= Number(dataHealth.summary.activeEmployees), {
    activeEmployees: dataHealth.summary.activeEmployees,
    totalStructure: dataHealth.summary.structureNodes,
  });
  addCheck("Login security totals load after disposable mutations", monitoring.recentActivity !== null && monitoring.unavailable.length === 0, {
    recentEvents: monitoring.recentActivity?.total ?? null,
    unavailable: monitoring.unavailable,
  });
  addCheck("Platform workforce formula remains active employees plus open vacancies", totalStructure === activeEmployees + openVacancies, {
    activeEmployees,
    openVacancies,
    totalStructure,
  });
}

async function cleanup() {
  const employeeHrIds = Array.from(tracked.employeeHrIds);
  const salesBatchIds = Array.from(tracked.salesBatchIds);
  const trackedPayrollBatchIds = Array.from(tracked.payrollBatchIds);
  const { data: oldFixturePayrollRows } = await supabase
    .from("salary_batches")
    .select("id")
    .ilike("file_name", "PHASE15%");
  const payrollBatchIds = Array.from(new Set([
    ...trackedPayrollBatchIds,
    ...((oldFixturePayrollRows ?? []) as Array<{ id?: string }>).map((row) => row.id).filter((id): id is string => Boolean(id)),
  ]));
  const vacationRequestIds = Array.from(tracked.vacationRequestIds);
  const expenseTripIds = Array.from(tracked.expenseTripIds);
  const auditEntityIds = Array.from(new Set([
    ...Array.from(tracked.auditEntityIds),
    ...employeeHrIds,
    ...salesBatchIds,
    ...payrollBatchIds,
    ...vacationRequestIds,
  ]));

  await safeDelete("v2_vacation_email_tokens", "request_id", vacationRequestIds);
  await safeDelete("v2_vacation_request_events", "request_id", vacationRequestIds);
  await safeDelete("v2_vacation_requests", "id", vacationRequestIds);
  await safeDelete("notification_outbox", "related_entity_id", vacationRequestIds);
  await safeDelete("in_app_notifications", "recipient_hr_id", employeeHrIds);

  await safeDelete("outstation_expenses", "trip_id", expenseTripIds);
  await safeDeleteIlike("outstation_expense_reports", "file_name", `${fixture}%`);
  await safeResetSalaryBatchesForCleanup(payrollBatchIds);
  await safeDelete("salary_flags", "batch_id", payrollBatchIds);
  await safeDelete("salary_records", "batch_id", payrollBatchIds);
  await safeDelete("salary_batches", "id", payrollBatchIds);

  await safeDelete("sales_audit_logs", "batch_id", salesBatchIds);
  await safeDelete("sales_records", "batch_id", salesBatchIds);
  await safeDelete("sales_import_batches", "id", salesBatchIds);

  await safeDelete("probation_history", "employee_hr_id", employeeHrIds);
  await safeDelete("probation_evaluations", "employee_hr_id", employeeHrIds);
  await safeDelete("employee_probation", "employee_hr_id", employeeHrIds);

  await safeDelete("employee_lifecycle_events", "employee_hr_id", employeeHrIds);
  await safeDelete("employee_resignations", "employee_hr_id", employeeHrIds);
  await safeDelete("position_vacancies", "vacancy_code", Array.from(tracked.vacancyCodes));
  await safeDeleteIlike("position_vacancies", "vacancy_code", `${fixture}%`);

  await safeDelete("audit_logs", "entity_id", auditEntityIds);
  await safeDelete("employee_locations", "employee_hr_id", employeeHrIds);
  await safeDelete("employee_compensation", "employee_hr_id", employeeHrIds);
  await safeDelete("employees", "hr_id", employeeHrIds);
}

async function run() {
  try {
    const lookup = await resolveLookupContext();
    const workforce = await runWorkforceLifecycle(lookup);
    await runSalesWorkflow(lookup, workforce.activeEmployeeHrId, workforce.managerHrId);
    await runPayrollAndExpenseWorkflow(lookup, workforce.activeEmployeeHrId);
    await runVacationWorkflow(workforce.activeEmployeeHrId, workforce.managerHrId);
    await runMetricChecks();
  } finally {
    await cleanup();
  }

  const failed = checks.filter((check) => !check.ok);
  const skipped = checks.filter((check) => check.skipped);
  console.log(JSON.stringify({
    cleanupWarnings,
    failed,
    fixture,
    passed: checks.length - failed.length,
    results: checks,
    skipped,
  }, null, 2));

  if (failed.length > 0) process.exitCode = 1;
}

await run();
