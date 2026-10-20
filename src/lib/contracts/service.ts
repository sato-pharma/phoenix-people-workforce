import {
  canSeeHrScopedRecord,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { parseDateOnly } from "@/lib/date-only";
import { assertContractWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { daysUntilLifecycleDate } from "@/lib/lifecycle-risk/metrics";
import { createSystemNotification } from "@/lib/notifications/system";
import { resignEmployeeAndOpenVacancy } from "@/lib/resignations/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isDateOnlyBefore, nextContractAnniversary } from "./date-rules";
import { WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED } from "./feature-flags";
import type {
  ContractRenewalAction,
  ContractRenewalDashboardData,
  ContractRenewalRecord,
  ContractRenewalStatus,
  CreateContractRenewalInput,
} from "./types";

const activeEmployeeStatuses = new Set(["active", "on_leave"]);
const activeRequestStatuses: ContractRenewalStatus[] = ["requested", "manager_review", "hr_review"];

type ContractDbRow = {
  id: string | number;
  employee_hr_id?: string | null;
  hr_id?: string | null;
  contract_type?: string | null;
  contract_signed_date: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  contract_renewal_date: string | null;
  document_url: string | null;
  document_name: string | null;
  signed_document_url: string | null;
  signed_document_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

type RenewalRequestDbRow = {
  id: string;
  employee_hr_id: string;
  current_contract_id: string | number | null;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  area_name: string | null;
  current_renewal_date: string | null;
  requested_renewal_date: string;
  proposed_start_date: string | null;
  proposed_end_date: string | null;
  new_contract_document_url: string | null;
  new_contract_document_name: string | null;
  signed_contract_url: string | null;
  signed_contract_name: string | null;
  signed_at: string | null;
  workflow_notes: string | null;
  status: ContractRenewalStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  manager_reviewed_at: string | null;
  manager_reviewed_by: string | null;
  hr_reviewed_at: string | null;
  hr_reviewed_by: string | null;
  decision_at: string | null;
  decision_by: string | null;
  decision_reason: string | null;
  completed_contract_id: string | number | null;
};

export class ContractRenewalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRenewalValidationError";
  }
}

export function isContractRenewalValidationError(error: unknown) {
  return error instanceof ContractRenewalValidationError;
}

function todayDate() {
  return currentCairoDateOnlyIso();
}

// Same Cairo calendar day as todayDate(), as a Date — nextContractAnniversary compares against
// this internally too, but call sites here pass it explicitly rather than relying on the
// default `new Date()`, which would read the server's own clock (UTC on Railway) if this ever
// changed. Falls back to the live instant only if todayDate() somehow returns an unparseable
// string, which currentCairoDateOnlyIso() never does.
function todayCairoDate(): Date {
  return parseDateOnly(todayDate()) ?? new Date();
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function cleanHrId(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value);
}

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dateOnly = raw.slice(0, 10);
  return parseDateOnly(dateOnly) ? dateOnly : null;
}

function requireDate(value: string | null | undefined, label: string) {
  const normalized = normalizeDate(value);
  if (!normalized) throw new ContractRenewalValidationError(`${label} is invalid.`);
  return normalized;
}

function canonicalContractHrId(row: ContractDbRow) {
  return cleanHrId(row.employee_hr_id ?? row.hr_id);
}

function isActiveEmployee(employee: Pick<EmployeeDirectoryRow, "employmentStatus" | "organogramVisible" | "payrollEligible">) {
  return (
    activeEmployeeStatuses.has(String(employee.employmentStatus ?? "active").trim().toLowerCase()) &&
    employee.organogramVisible !== false &&
    employee.payrollEligible !== false
  );
}

function isCompanyContractReader(access?: AccessContext) {
  if (!access) return true;
  return (
    access.scope === "system" ||
    access.scope === "company" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "HR Operations" ||
    // The HR Operations Specialist tracks every renewal and prepares its papers (owner, 2026-10-20).
    access.role === "HR Administration"
  );
}

function canSeeContractRow(access: AccessContext | undefined, employee: EmployeeDirectoryRow) {
  if (!access || isCompanyContractReader(access)) return true;
  return canSeeHrScopedRecord(access, {
    employeeHrId: employee.hrId,
    managerHrId: employee.managerHrId,
  });
}

function pickActiveContract(rows: ContractDbRow[]) {
  return [...rows].sort((left, right) => {
    const renewalDelta = String(right.contract_renewal_date ?? "").localeCompare(String(left.contract_renewal_date ?? ""));
    if (renewalDelta !== 0) return renewalDelta;
    return String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
  })[0] ?? null;
}

function contractErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

export function isContractRenewalSchemaMissing(error: unknown) {
  const message = contractErrorMessage(error).toLowerCase();
  return (
    message.includes("phx_create_contract_renewal_request") ||
    message.includes("phx_apply_contract_renewal_workflow") ||
    message.includes("contract_renewal_requests") ||
    message.includes("employee_contracts") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export function contractRenewalErrorMessage(error: unknown) {
  return contractErrorMessage(error);
}

function asIso(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function mapRenewalRequest(row: RenewalRequestDbRow): ContractRenewalRecord {
  return {
    areaName: row.area_name,
    completedContractId: row.completed_contract_id === null ? null : String(row.completed_contract_id),
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    currentContractId: row.current_contract_id === null ? null : String(row.current_contract_id),
    currentRenewalDate: row.current_renewal_date,
    decisionAt: asIso(row.decision_at),
    decisionBy: row.decision_by,
    decisionReason: row.decision_reason,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    hrReviewedAt: asIso(row.hr_reviewed_at),
    hrReviewedBy: row.hr_reviewed_by,
    id: row.id,
    jobTitle: row.job_title,
    lineName: row.line_name,
    managerReviewedAt: asIso(row.manager_reviewed_at),
    managerReviewedBy: row.manager_reviewed_by,
    newContractDocumentName: row.new_contract_document_name,
    newContractDocumentUrl: row.new_contract_document_url,
    proposedEndDate: row.proposed_end_date,
    proposedStartDate: row.proposed_start_date,
    requestedRenewalDate: row.requested_renewal_date,
    signedAt: asIso(row.signed_at),
    signedContractName: row.signed_contract_name,
    signedContractUrl: row.signed_contract_url,
    status: row.status,
    updatedAt: new Date(row.updated_at).toISOString(),
    workflowNotes: row.workflow_notes,
  };
}

async function getContractRowsByHrId() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_contracts")
    .select("*")
    .eq("status", "active")
    .order("contract_renewal_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;

  const grouped = new Map<string, ContractDbRow[]>();
  for (const row of (data ?? []) as ContractDbRow[]) {
    const hrId = canonicalContractHrId(row);
    if (!hrId) continue;
    grouped.set(hrId, [...(grouped.get(hrId) ?? []), row]);
  }

  const contractsByHrId = new Map<string, ContractDbRow>();
  grouped.forEach((rows, hrId) => {
    const contract = pickActiveContract(rows);
    if (contract) contractsByHrId.set(hrId, contract);
  });
  return contractsByHrId;
}

async function getActiveRequestByHrId() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("contract_renewal_requests")
    .select("*")
    .in("status", activeRequestStatuses)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const requestsByHrId = new Map<string, ContractRenewalRecord>();
  for (const row of (data ?? []) as RenewalRequestDbRow[]) {
    const hrId = cleanHrId(row.employee_hr_id);
    if (hrId && !requestsByHrId.has(hrId)) {
      requestsByHrId.set(hrId, mapRenewalRequest(row));
    }
  }
  return requestsByHrId;
}

function renewalDateForEmployee(
  employee: EmployeeDirectoryRow,
  contract: ContractDbRow | null | undefined,
  today: Date,
) {
  return normalizeDate(contract?.contract_renewal_date) ??
    normalizeDate(employee.contractRenewalDate) ??
    nextContractAnniversary(employee.hireDate, today) ??
    "";
}

/**
 * The contract renewal date that is actually RECORDED for one employee, or "" when none is.
 *
 * 🔴 DELIBERATELY NOT `renewalDateForEmployee`, WHICH IS THE DASHBOARD'S ANSWER AND A DIFFERENT
 * QUESTION. That function falls back to `nextContractAnniversary(hireDate)` — the next anniversary
 * of the hire date — so the dashboard always has a date to sort and colour by. Measured on
 * production 2026-09-09: `employee_contracts` holds ZERO rows and `employees.contract_renewal_date`
 * is NULL for all 105 active employees, so **every date that dashboard shows is that computed
 * anniversary**, not a contractual fact anyone recorded.
 *
 * That is fine for a screen HR reads as "renewals are due around here". It is NOT fine to put in a
 * message to the employee, which states it back to them as their contract date. `date-rules.ts`
 * claims nothing about policy for the anniversary — contrast `probation/date.ts`, which opens by
 * naming hire+90 as an owner-locked business rule. One is a rule; this is a convenience.
 *
 * So this returns a date only when something recorded one, and "" otherwise. The WhatsApp send
 * screen then asks a human to type it, which is the same refuse-rather-than-guess rule every other
 * auto-filled field in that feature follows. The day contracts are actually recorded, it fills in
 * by itself with no further change.
 *
 * NEVER THROWS. The contract tables are behind a feature flag and may not exist at all
 * (`isContractRenewalSchemaMissing`); a missing table must degrade to "type the date yourself"
 * rather than failing the whole send screen.
 */
export async function recordedContractRenewalDate(employeeHrId: string): Promise<string> {
  const wanted = cleanHrId(employeeHrId);
  if (!wanted) return "";

  try {
    const contractsByHrId = await getContractRowsByHrId();
    const contract = contractsByHrId.get(wanted);
    const fromContract = normalizeDate(contract?.contract_renewal_date);
    if (fromContract) return fromContract;
  } catch (error) {
    if (!isContractRenewalSchemaMissing(error)) throw error;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("employees")
      .select("contract_renewal_date")
      .eq("hr_id", employeeHrId)
      .maybeSingle();
    if (error) throw error;
    return normalizeDate((data as { contract_renewal_date?: string | null } | null)?.contract_renewal_date) ?? "";
  } catch {
    return "";
  }
}

export async function getContractRenewalDashboardData(access?: AccessContext): Promise<ContractRenewalDashboardData> {
  const employees = (await getEmployeeDirectoryRows()).filter(
    (employee) => isActiveEmployee(employee) && canSeeContractRow(access, employee),
  );
  let contractsByHrId = new Map<string, ContractDbRow>();
  let requestsByHrId = new Map<string, ContractRenewalRecord>();

  try {
    [contractsByHrId, requestsByHrId] = await Promise.all([
      getContractRowsByHrId(),
      getActiveRequestByHrId(),
    ]);
  } catch (error) {
    if (!isContractRenewalSchemaMissing(error)) throw error;
  }

  const today = todayCairoDate();
  const rows = employees.map((employee) => {
    const employeeHrId = cleanHrId(employee.hrId);
    const contract = contractsByHrId.get(employeeHrId ?? "");
    const renewalDate = renewalDateForEmployee(employee, contract, today);
    const renewalDay = parseDateOnly(renewalDate)?.getDate() ?? 0;

    return {
      area: employee.areaName ?? "Unassigned",
      contract_id: contract?.id === undefined ? null : String(contract.id),
      contract_renewal_date: renewalDate,
      contract_signed_date: contract?.contract_signed_date ?? employee.hireDate ?? "",
      crm_id: employee.crmId ?? "",
      full_name: employee.fullName,
      hr_id: employee.hrId,
      job_title: employee.jobTitle ?? employee.positionTitle ?? "Unassigned",
      line: employee.lineName ?? "Unassigned",
      manager_hr_id: employee.managerHrId,
      renewal_day: renewalDay,
      workflow: requestsByHrId.get(employeeHrId ?? "") ?? null,
    };
  });

  const workflows = rows.map((row) => row.workflow).filter((row): row is ContractRenewalRecord => Boolean(row));
  return {
    rows,
    summary: {
      activeRequests: workflows.filter((row) => activeRequestStatuses.includes(row.status)).length,
      hrReview: workflows.filter((row) => row.status === "hr_review").length,
      managerReview: workflows.filter((row) => row.status === "manager_review").length,
      notRenewed: workflows.filter((row) => row.status === "not_renewed").length,
      renewed: workflows.filter((row) => row.status === "renewed").length,
      totalRequests: workflows.length,
    },
  };
}

function validateCreateInput(
  employee: EmployeeDirectoryRow,
  currentContract: ContractDbRow | undefined,
  input: CreateContractRenewalInput,
) {
  if (!isActiveEmployee(employee)) {
    throw new ContractRenewalValidationError("Contract renewals can only be created for active employees.");
  }

  const today = todayCairoDate();
  const currentRenewalDate = (
    currentContract?.status === "active" ? currentContract.contract_renewal_date : null
  ) ?? employee.contractRenewalDate ?? nextContractAnniversary(employee.hireDate, today);
  const requestedRenewalDate = normalizeDate(input.requestedRenewalDate) ?? currentRenewalDate ?? todayDate();
  const proposedStartDate = normalizeDate(input.proposedStartDate) ?? requestedRenewalDate;
  const proposedEndDate = normalizeDate(input.proposedEndDate) ?? nextContractAnniversary(proposedStartDate, today) ?? proposedStartDate;

  requireDate(requestedRenewalDate, "Requested renewal date");
  requireDate(proposedStartDate, "Proposed start date");
  requireDate(proposedEndDate, "Proposed end date");

  if (employee.hireDate && isDateOnlyBefore(requestedRenewalDate, employee.hireDate)) {
    throw new ContractRenewalValidationError("Renewal date cannot be before the employee hire date.");
  }
  if (currentRenewalDate && isDateOnlyBefore(proposedStartDate, currentRenewalDate)) {
    throw new ContractRenewalValidationError("Proposed start date cannot be before the current renewal date.");
  }
  if (isDateOnlyBefore(proposedEndDate, proposedStartDate)) {
    throw new ContractRenewalValidationError("Proposed end date cannot be before the proposed start date.");
  }

  return {
    currentRenewalDate,
    proposedEndDate,
    proposedStartDate,
    requestedRenewalDate,
  };
}

export async function createContractRenewalRequest(
  input: CreateContractRenewalInput,
  actor: string,
  access?: Pick<AccessContext, "role">,
) {
  const employeeHrId = cleanHrId(input.employeeHrId);
  if (!employeeHrId) throw new ContractRenewalValidationError("Employee HR ID is required.");

  const directory = await getEmployeeDirectoryRows();
  const employee = directory.find((row) => cleanHrId(row.hrId) === employeeHrId);
  if (!employee) throw new ContractRenewalValidationError("Employee was not found in the active employee directory.");

  const contractsByHrId = await getContractRowsByHrId().catch((error) => {
    if (isContractRenewalSchemaMissing(error)) return new Map<string, ContractDbRow>();
    throw error;
  });
  const currentContract = contractsByHrId.get(cleanHrId(employee.hrId) ?? "");
  const dates = validateCreateInput(employee, currentContract, input);
  await assertContractWorkflowTransition({
    access,
    action: "create",
    expectedNextStatus: "contract_requested",
    status: "new",
  });
  const supabase = getSupabaseAdmin();
  const actorHrId = await resolveCanonicalActorHrId(actor);
  const { data, error } = await supabase.rpc("phx_create_contract_renewal_request", {
    p_actor: actorHrId,
    p_area_name: employee.areaName,
    p_current_contract_id: currentContract?.id === undefined ? null : String(currentContract.id),
    p_current_renewal_date: dates.currentRenewalDate,
    p_employee_hr_id: employee.hrId,
    p_employee_name: employee.fullName,
    p_job_title: employee.jobTitle ?? employee.positionTitle,
    p_line_name: employee.lineName,
    p_new_contract_document_name: cleanText(input.newContractDocumentName),
    p_new_contract_document_url: cleanText(input.newContractDocumentUrl),
    p_note: cleanText(input.workflowNotes),
    p_proposed_end_date: dates.proposedEndDate,
    p_proposed_start_date: dates.proposedStartDate,
    p_requested_renewal_date: dates.requestedRenewalDate,
  });

  if (error) throw new ContractRenewalValidationError(error.message);
  const record = mapRenewalRequest(data as RenewalRequestDbRow);
  await notifyContractWorkflow(record, "Contract Renewal Request Created", "warning");
  invalidateExecutiveDashboardCache("contract renewal created", ["contracts"]);
  return record;
}

async function notifyContractWorkflow(
  record: ContractRenewalRecord,
  title: string,
  tone: "success" | "warning" | "danger" | "neutral",
) {
  const actionUrl = `/admin/approvals-hub?module=contract_renewal&id=${encodeURIComponent(record.id)}`;
  await createSystemNotification({
    actionUrl,
    actorId: "system",
    email: {
      ctaHref: actionUrl,
      ctaLabel: "Review in Action Center",
      employeeHrId: record.employeeHrId,
      metrics: [
        { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
        { label: "Job Title", value: record.jobTitle ?? "" },
        { label: "Area", value: record.areaName ?? "" },
        { label: "Line", value: record.lineName ?? "" },
        { label: "Status", value: record.status },
        { label: "Renewal date", value: record.requestedRenewalDate },
      ],
      notificationType: "contract_renewal",
      subject: `Phoenix ${title} - ${record.employeeName}`,
      summary: `Contract renewal workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
      // Explicit context so {{status}} renders the clean workflow status instead of the
      // generic "Label: value | Label: value | ..." dump every metric above would otherwise
      // produce (notificationMetricStatus in src/lib/notifications/email.ts).
      templateContext: {
        employeeHrId: record.employeeHrId,
        employeeName: record.employeeName,
        endDate: record.requestedRenewalDate,
        status: record.status.replace(/_/g, " "),
      },
      title,
      tone,
    },
    eventType: "workflow_updated",
    message: `Contract renewal workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    metadata: {
      employeeHrId: record.employeeHrId,
      idempotencyKey: `contract-renewal:${record.id}:${record.status}`,
      renewalDate: record.requestedRenewalDate,
      status: record.status,
    },
    module: "contract_renewal",
    priority: tone === "danger" ? "critical" : "high",
    recordId: record.id,
    subjectHrId: record.employeeHrId,
    title,
  });
}

// WP-6: when a contract is marked not_renewed, terminate the employee and open
// the vacancy via the canonical resignations helper. Behavior-gated by the
// WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED kill switch — when the flag is
// false, this helper is a strict no-op (no DB call, no mutation, no side
// effect).
async function maybeRunNonRenewalTerminalLifecycle(
  record: ContractRenewalRecord,
  access: AccessContext | undefined,
  actor: string,
) {
  if (!WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED) {
    return;
  }

  // Reason must mention "Contract not renewed" so downstream audit + reporting
  // can attribute the termination to the contract non-renewal flow. The
  // contract renewal request id is included in workflowNotes so the resignation
  // record carries traceability back to the originating request.
  const effectiveDate =
    cleanText(record.proposedEndDate) ??
    cleanText(record.currentRenewalDate) ??
    cleanText(record.requestedRenewalDate) ??
    todayDate();
  const reason = `Contract not renewed (request ${record.id}).`;
  const workflowNotes = [
    `Triggered by contract non-renewal.`,
    `contract_renewal_request_id: ${record.id}`,
    cleanText(record.decisionReason),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await resignEmployeeAndOpenVacancy(
      record.employeeHrId,
      {
        effectiveDate,
        employeeHrId: record.employeeHrId,
        employeeStatus: "terminated",
        lastWorkingDate: effectiveDate,
        reason,
        submittedDate: todayDate(),
        workflowNotes,
      },
      actor,
      access,
      // A non-renewal is a COMPANY decision, not a resignation. Without this the resignation
      // recipient list receives a "Resignation Submitted" notice framed as voluntary for an
      // employee the company chose not to renew — see resignations/service.ts:1247-1250.
      { suppressWorkflowNotification: true },
    );
  } catch (error) {
    // Match the surrounding file style: surface the failure as a
    // ContractRenewalValidationError so the API layer can map it to a 4xx.
    throw new ContractRenewalValidationError(contractErrorMessage(error));
  }
}

export function validateWorkflowTransition(status: ContractRenewalStatus, action: ContractRenewalAction) {
  if (action === "manager_review") return status === "requested" || status === "manager_review";
  if (action === "hr_review") return activeRequestStatuses.includes(status);
  if (action === "renew" || action === "not_renew") return activeRequestStatuses.includes(status);
  if (action === "upload_signed") return status === "hr_review" || status === "renewed";
  if (action === "cancel") return activeRequestStatuses.includes(status);
  return false;
}

export async function runContractRenewalWorkflow(
  id: string,
  action: ContractRenewalAction,
  actor: string,
  input: {
    access?: AccessContext;
    decisionReason?: string | null;
    newContractDocumentName?: string | null;
    newContractDocumentUrl?: string | null;
    note?: string | null;
    signedContractName?: string | null;
    signedContractUrl?: string | null;
  } = {},
) {
  const requestId = cleanText(id);
  if (!requestId) throw new ContractRenewalValidationError("Contract renewal request ID is required.");

  const supabase = getSupabaseAdmin();
  const { data: existingData, error: existingError } = await supabase
    .from("contract_renewal_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existingData) return null;

  const existing = existingData as RenewalRequestDbRow;
  if (!validateWorkflowTransition(existing.status, action)) {
    throw new ContractRenewalValidationError(`Invalid contract renewal transition from ${existing.status} using ${action}.`);
  }
  if (action === "upload_signed" && !cleanText(input.signedContractUrl)) {
    throw new ContractRenewalValidationError("Signed contract URL is required.");
  }
  const expectedNextStatusByAction: Partial<Record<ContractRenewalAction, string>> = {
    cancel: "contract_cancelled",
    hr_review: "contract_hr_review",
    manager_review: "contract_manager_review",
    not_renew: "contract_not_renewed",
    renew: "contract_renewed",
  };
  await assertContractWorkflowTransition({
    access: input.access,
    action,
    expectedNextStatus: expectedNextStatusByAction[action],
    status: existing.status,
  });

  const contractEmployees = await getEmployeeDirectoryRows({ includeInactive: true });
  const contractEmployee = contractEmployees.find(
    (item) => cleanHrId(item.hrId) === cleanHrId(existing.employee_hr_id),
  );
  if (!contractEmployee || !canSeeContractRow(input.access, contractEmployee)) {
    throw new ContractRenewalValidationError(`Forbidden: cannot access employee ${existing.employee_hr_id}.`);
  }

  // Persist the canonical HR_ID (never a login token like "admin-HR") into decision_by /
  // manager_reviewed_by / hr_reviewed_by, so the decision is correctly attributed and the
  // Approvals Hub history matches. The RPC writes p_actor verbatim into those columns.
  const actorHrId = await resolveCanonicalActorHrId(actor);
  const { data, error } = await supabase.rpc("phx_apply_contract_renewal_workflow", {
    p_action: action,
    p_actor: actorHrId,
    p_decision_reason: cleanText(input.decisionReason),
    p_new_contract_document_name: cleanText(input.newContractDocumentName),
    p_new_contract_document_url: cleanText(input.newContractDocumentUrl),
    p_note: cleanText(input.note),
    p_request_id: requestId,
    p_signed_contract_name: cleanText(input.signedContractName),
    p_signed_contract_url: cleanText(input.signedContractUrl),
  });

  if (error) throw new ContractRenewalValidationError(error.message);
  const updated = mapRenewalRequest(data as RenewalRequestDbRow);

  // WP-6: terminate the employee + open vacancy on non-renewal, gated by
  // WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED (a kill switch, not a readiness
  // gate — the underlying schema is confirmed live on staging + production).
  if (action === "not_renew") {
    await maybeRunNonRenewalTerminalLifecycle(updated, input.access, actor);
  }

  await notifyContractWorkflow(
    updated,
    action === "not_renew" ? "Contract Not Renewed" : action === "renew" ? "Contract Renewed" : "Contract Renewal Updated",
    action === "not_renew" ? "danger" : action === "renew" ? "success" : "warning",
  );
  invalidateExecutiveDashboardCache("contract renewal workflow updated", ["contracts", "employees", "vacancies"]);

  return updated;
}

// The reminder cadence the owner set on 2026-09-29: 2 months and 15 days, 2 months, 1 month, then
// 15 days before the renewal date. It is DELIBERATELY its own constant rather than
// `lifecycleRiskWindows`, which those numbers look close to: those windows colour the Contract
// Renewal board and drive `summarizeContractRenewalRows`'s "due in 7 / 30 days" tiles, so reusing
// them would have moved the board's bands as a side effect of changing when mail goes out. The
// 7-day and same-day rungs are gone on purpose — a renewal decision needs notice, and a reminder
// that arrives on the renewal date is a record, not a warning.
export const contractRenewalReminderDaysAhead = [75, 60, 30, 15] as const;

export async function getContractRenewalReminderCandidates(
  daysAhead: readonly number[] = contractRenewalReminderDaysAhead,
) {
  const dashboard = await getContractRenewalDashboardData();
  const today = parseDateOnly(todayDate());
  if (!today) return [];
  const allowed = new Set(daysAhead);

  return dashboard.rows
    .map((row) => {
      const daysUntil = daysUntilLifecycleDate(row.contract_renewal_date, today);
      if (daysUntil === null) return null;
      return allowed.has(daysUntil) ? { ...row, daysUntil } : null;
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export { nextContractAnniversary };
