import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { getDataHealthStats } from "@/lib/admin/service";
import { upsertEmployee } from "@/lib/employees/employee-directory";
import { getOperationalRecentActivity } from "@/lib/operations/events";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";
import { outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { approveOutstationRequestForPayroll } from "@/lib/outstation/service";
import { deleteSalesBatch, replaceSalesBatch, updateSalesBatchStatus } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createVacationRequest, decideVacationRequest } from "@/lib/vacation/service";

const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8).toUpperCase()}`;
const fixture = `PHASE17_${suffix}`.toUpperCase();
const actor = "phase17.fixture.smoke";

loadLocalEnv();

const supabase = getSupabaseAdmin();
const cleanupWarnings: string[] = [];
const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const tracked = {
  auditEntityIds: new Set<string>(),
  employeeHrIds: new Set<string>(),
  expenseTripIds: new Set<string>(),
  outstationRequestIds: new Set<number>(),
  payrollReportFileNames: new Set<string>(),
  salesBatchIds: new Set<string>(),
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
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
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
  if (!area) throw new Error("No area lookup row is available for PHASE17 fixture testing.");

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
  if (!position) throw new Error("No position lookup row is available for PHASE17 fixture testing.");

  const lineRow = (line ?? {}) as Record<string, unknown>;
  return {
    areaId: Number((area as Record<string, unknown>).id),
    areaName: String((area as Record<string, unknown>).name ?? "PHASE17 Area"),
    departmentId: Number.isFinite(Number(lineRow.department_id)) ? Number(lineRow.department_id) : null,
    lineId,
    lineName: String(lineRow.name ?? "PHASE17 Line"),
    positionId: Number((position as Record<string, unknown>).id),
    positionTitle: String((position as Record<string, unknown>).title ?? "PHASE17 Position"),
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

async function createEmployee(hrId: string, name: string, lookup: LookupContext, managerHrId?: string | null) {
  tracked.employeeHrIds.add(hrId);
  await upsertEmployee(employeeInput(hrId, name, lookup, managerHrId));
}

async function assertAuditTrace(entityId: string, label: string) {
  const { data, error } = await supabase.from("audit_logs").select("id,summary,entity_type").eq("entity_id", entityId).limit(1);
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
  const { error } = await supabase.from("sales_import_batches").insert({
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
  if (error) throw error;
}

async function insertSalesRecord(batchId: string, lookup: LookupContext, employeeHrId: string, managerHrId: string) {
  const { error } = await supabase.from("sales_records").insert({
    batch_id: batchId,
    employee_hr_id: employeeHrId,
    employee_lookup_key: employeeHrId,
    employee_name: `${fixture} Sales Rep`,
    factory_price: 10,
    family: "PHASE17 Family",
    line: lookup.lineName,
    link_confidence: 1,
    link_status: "linked",
    manager_hr_id: managerHrId,
    month: 10,
    product: "PHASE17 Product",
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

async function runOutstationApprovalSmoke(lookup: LookupContext) {
  const hrId = `${fixture}_OUT`;
  await createEmployee(hrId, `${fixture} Outstation Employee`, lookup);
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert({
      allowance_amount: 100,
      allowance_breakdown_json: {},
      approval_reason: "PHASE17 disposable request ready for approval.",
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
      eligibility_reason: "PHASE17 disposable eligible request.",
      eligibility_status: "eligible",
      expected_total_amount: 150,
      expense_type: "traveling",
      fraud_flags_json: [],
      fuel_amount: 50,
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
  tracked.auditEntityIds.add(String(requestId));
  tracked.payrollReportFileNames.add(`outstation-request-${requestId}.workflow`);
  const result = await approveOutstationRequestForPayroll(requestId, adminAccess, {
    comment: "PHASE17 disposable approved for payroll.",
    // The version just inserted — an approval has to say which figures it was given.
    expectedRevision: outstationClaimRevision(data.updated_at),
  });
  tracked.expenseTripIds.add(result.expenseTripId);
  const expense = await selectMaybeSingle("outstation_expenses", "trip_id,hr_approved,total", "trip_id", result.expenseTripId);
  addCheck("outstation approval created approved payroll expense", expense?.hr_approved === true, expense);
  await assertAuditTrace(String(requestId), "outstation approval");
}

async function runVacationPayrollReadinessSmoke(lookup: LookupContext) {
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
    endDate: "2026-08-03",
    startDate: "2026-08-03",
    vacationType: "annual",
  });
  tracked.vacationRequestIds.add(request.id);
  tracked.auditEntityIds.add(request.id);

  const approved = await decideVacationRequest({
    ...adminAccess,
    hrId: managerHrId,
    loginId: `${actor}.vacation.approve`,
  }, {
    decision: "approve",
    decisionComment: "PHASE17 disposable vacation approval.",
    requestId: request.id,
  });
  addCheck("vacation approval persisted payroll impact readiness", approved.status === "approved" && Boolean(approved.paymentStatus), approved);
  await assertAuditTrace(request.id, "vacation approval");
}

async function runSalesWorkflowSmoke(lookup: LookupContext) {
  const managerHrId = `${fixture}_SMGR`;
  const employeeHrId = `${fixture}_SREP`;
  await createEmployee(managerHrId, `${fixture} Sales Manager`, lookup);
  await createEmployee(employeeHrId, `${fixture} Sales Rep`, lookup, managerHrId);

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
  await Promise.all([
    insertSalesRecord(approveBatch, lookup, employeeHrId, managerHrId),
    insertSalesRecord(rejectBatch, lookup, employeeHrId, managerHrId),
    insertSalesRecord(originalBatch, lookup, employeeHrId, managerHrId),
    insertSalesRecord(replacementBatch, lookup, employeeHrId, managerHrId),
    insertSalesRecord(deleteBatch, lookup, employeeHrId, managerHrId),
  ]);

  await updateSalesBatchStatus(approveBatch, "approved", actor, "Phase 17 Fixture");
  const approved = await selectMaybeSingle("sales_import_batches", "id,status", "id", approveBatch);
  addCheck("sales approve mutation updates batch", approved?.status === "approved", approved);
  await assertSalesAuditTrace(approveBatch, "sales approve");
  await assertAuditTrace(approveBatch, "sales approve");

  await updateSalesBatchStatus(rejectBatch, "rejected", actor, "Phase 17 Fixture");
  const rejected = await selectMaybeSingle("sales_import_batches", "id,status", "id", rejectBatch);
  addCheck("sales reject mutation updates batch", rejected?.status === "rejected", rejected);
  await assertSalesAuditTrace(rejectBatch, "sales reject");
  await assertAuditTrace(rejectBatch, "sales reject");

  await replaceSalesBatch(originalBatch, replacementBatch, actor, "Phase 17 Fixture");
  const original = await selectMaybeSingle("sales_import_batches", "id,status,replaced_by_batch_id", "id", originalBatch);
  const replacement = await selectMaybeSingle("sales_import_batches", "id,status,replacement_for_batch_id", "id", replacementBatch);
  addCheck("sales replace mutation updates original batch", original?.status === "replaced", original);
  addCheck("sales replace mutation approves replacement batch", replacement?.status === "approved", replacement);
  await assertSalesAuditTrace(originalBatch, "sales replace");
  await assertAuditTrace(originalBatch, "sales replace");

  await deleteSalesBatch(deleteBatch, actor, "Phase 17 Fixture");
  const deleted = await selectMaybeSingle("sales_import_batches", "id,status", "id", deleteBatch);
  addCheck("sales delete mutation removes batch", deleted === null, deleted);
  await assertSalesAuditTrace(deleteBatch, "sales delete");
  await assertAuditTrace(deleteBatch, "sales delete");
}

async function runMetricSmoke() {
  const [commandCenter, dataHealth, monitoring, operations] = await Promise.all([
    getAdminCommandCenterData(adminAccess),
    getDataHealthStats(),
    loadLoginSecurityOverview(),
    getOperationalRecentActivity(adminAccess, { limit: 10 }),
  ]);

  addCheck("Command Center totals load after PHASE17 mutations", Number(commandCenter.health.totalEmployees) >= 0, commandCenter.health);
  addCheck("Data Health totals load after PHASE17 mutations", Number(dataHealth.summary.structureNodes) >= Number(dataHealth.summary.activeEmployees), dataHealth.summary);
  addCheck("Monitoring totals load after PHASE17 mutations", monitoring.recentActivity !== null && monitoring.unavailable.length === 0, { recentEvents: monitoring.recentActivity?.total ?? null, unavailable: monitoring.unavailable });
  addCheck(
    "Operational business feed excludes disposable PHASE17 actors",
    !operations.recent.some((event) => /phase17\.fixture\.smoke/i.test(event.userName)),
    operations.recent,
  );
}

async function cleanup() {
  await safeDelete("v2_vacation_request_events", "request_id", Array.from(tracked.vacationRequestIds));
  await safeDelete("v2_vacation_email_tokens", "request_id", Array.from(tracked.vacationRequestIds));
  await safeDelete("v2_vacation_requests", "id", Array.from(tracked.vacationRequestIds));
  await safeDelete("outstation_expenses", "trip_id", Array.from(tracked.expenseTripIds));
  for (const fileName of tracked.payrollReportFileNames) {
    await safeDeleteIlike("outstation_expense_reports", "file_name", fileName);
  }
  await safeDelete("outstation_location_audit_logs", "expense_request_id", Array.from(tracked.outstationRequestIds));
  await safeDelete("outstation_expense_requests", "id", Array.from(tracked.outstationRequestIds));
  await safeDelete("sales_audit_logs", "batch_id", Array.from(tracked.salesBatchIds));
  await safeDelete("sales_records", "batch_id", Array.from(tracked.salesBatchIds));
  await safeDelete("sales_import_batches", "id", Array.from(tracked.salesBatchIds));
  await safeDelete("audit_logs", "entity_id", Array.from(tracked.auditEntityIds));
  await safeDelete("employee_locations", "employee_hr_id", Array.from(tracked.employeeHrIds));
  await safeDelete("employee_compensation", "employee_hr_id", Array.from(tracked.employeeHrIds));
  await safeDelete("employees", "hr_id", Array.from(tracked.employeeHrIds));
}

async function main() {
  try {
    const lookup = await resolveLookupContext();
    await runOutstationApprovalSmoke(lookup);
    await runVacationPayrollReadinessSmoke(lookup);
    await runSalesWorkflowSmoke(lookup);
    await runMetricSmoke();
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
