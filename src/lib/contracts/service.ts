import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { addYearsToDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  ContractRenewalAction,
  ContractRenewalDashboardData,
  ContractRenewalRecord,
  ContractRenewalStatus,
  CreateContractRenewalInput,
} from "./types";

type ContractDbRow = {
  id: string | number;
  employee_hr_id: string;
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

function todayDate() {
  return toDateOnlyString(new Date()) ?? "";
}

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.slice(0, 10);
}

function addYears(value: string | null | undefined, years: number) {
  return addYearsToDateOnly(normalizeDate(value), years);
}

function appendWorkflowNote(
  existing: string | null | undefined,
  actor: string,
  action: string,
  note?: string | null,
) {
  const entry = `[${new Date().toISOString()}] ${actor}: ${action}${note ? ` - ${note}` : ""}`;
  return existing ? `${existing}\n${entry}` : entry;
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
    .order("contract_renewal_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;

  const contractsByHrId = new Map<string, ContractDbRow>();
  for (const row of (data ?? []) as ContractDbRow[]) {
    if (!contractsByHrId.has(row.employee_hr_id)) {
      contractsByHrId.set(row.employee_hr_id, row);
    }
  }
  return contractsByHrId;
}

async function getLatestRequestsByHrId() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("contract_renewal_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const requestsByHrId = new Map<string, ContractRenewalRecord>();
  for (const row of (data ?? []) as RenewalRequestDbRow[]) {
    if (!requestsByHrId.has(row.employee_hr_id)) {
      requestsByHrId.set(row.employee_hr_id, mapRenewalRequest(row));
    }
  }
  return requestsByHrId;
}

export async function getContractRenewalDashboardData(): Promise<ContractRenewalDashboardData> {
  const employees = await getEmployeeDirectoryRows();
  let contractsByHrId = new Map<string, ContractDbRow>();
  let requestsByHrId = new Map<string, ContractRenewalRecord>();

  try {
    [contractsByHrId, requestsByHrId] = await Promise.all([
      getContractRowsByHrId(),
      getLatestRequestsByHrId(),
    ]);
  } catch (error) {
    if (!isContractRenewalSchemaMissing(error)) throw error;
  }

  const rows = employees.map((employee) => {
    const contract = contractsByHrId.get(employee.hrId);
    const fallbackRenewalDate = addYears(employee.hireDate, 1) ?? "";
    const renewalDate = contract?.contract_renewal_date ?? fallbackRenewalDate;
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
      renewal_day: renewalDay,
      workflow: requestsByHrId.get(employee.hrId) ?? null,
    };
  });

  const workflows = rows.map((row) => row.workflow).filter((row): row is ContractRenewalRecord => Boolean(row));
  return {
    rows,
    summary: {
      activeRequests: workflows.filter((row) => ["requested", "manager_review", "hr_review"].includes(row.status)).length,
      hrReview: workflows.filter((row) => row.status === "hr_review").length,
      managerReview: workflows.filter((row) => row.status === "manager_review").length,
      notRenewed: workflows.filter((row) => row.status === "not_renewed").length,
      renewed: workflows.filter((row) => row.status === "renewed").length,
      totalRequests: workflows.length,
    },
  };
}

export async function createContractRenewalRequest(input: CreateContractRenewalInput, actor: string) {
  const employeeHrId = cleanText(input.employeeHrId)?.toUpperCase();
  if (!employeeHrId) throw new Error("Employee HR ID is required.");

  const directory = await getEmployeeDirectoryRows();
  const employee = directory.find((row) => row.hrId.toUpperCase() === employeeHrId);
  if (!employee) throw new Error("Employee was not found in the directory.");

  const contractsByHrId = await getContractRowsByHrId().catch((error) => {
    if (isContractRenewalSchemaMissing(error)) return new Map<string, ContractDbRow>();
    throw error;
  });
  const currentContract = contractsByHrId.get(employee.hrId);
  const currentRenewalDate = currentContract?.contract_renewal_date ?? addYears(employee.hireDate, 1);
  const requestedRenewalDate = normalizeDate(input.requestedRenewalDate) ?? currentRenewalDate ?? todayDate();
  const proposedStartDate = normalizeDate(input.proposedStartDate) ?? requestedRenewalDate;
  const proposedEndDate = normalizeDate(input.proposedEndDate) ?? addYears(proposedStartDate, 1);
  const now = new Date().toISOString();
  const note = cleanText(input.workflowNotes);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("contract_renewal_requests")
    .insert({
      area_name: employee.areaName,
      created_by: actor,
      current_contract_id: currentContract?.id === undefined ? null : String(currentContract.id),
      current_renewal_date: currentRenewalDate,
      employee_hr_id: employee.hrId,
      employee_name: employee.fullName,
      job_title: employee.jobTitle ?? employee.positionTitle,
      line_name: employee.lineName,
      new_contract_document_name: cleanText(input.newContractDocumentName),
      new_contract_document_url: cleanText(input.newContractDocumentUrl),
      proposed_end_date: proposedEndDate,
      proposed_start_date: proposedStartDate,
      requested_renewal_date: requestedRenewalDate,
      status: "requested",
      updated_at: now,
      workflow_notes: appendWorkflowNote(null, actor, "created renewal request", note),
    })
    .select("*")
    .single();

  if (error) throw error;
  const record = mapRenewalRequest(data as RenewalRequestDbRow);
  await insertHistory(record, "requested", actor, currentRenewalDate, requestedRenewalDate, { note });
  await notifyContractWorkflow(record, "Contract Renewal Request Created", "warning");
  return record;
}

async function insertHistory(
  request: ContractRenewalRecord,
  action: string,
  actor: string,
  oldRenewalDate?: string | null,
  newRenewalDate?: string | null,
  details: Record<string, unknown> = {},
) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("contract_renewal_history")
    .insert({
      action,
      actor,
      details,
      employee_hr_id: request.employeeHrId,
      new_renewal_date: newRenewalDate ?? null,
      old_renewal_date: oldRenewalDate ?? null,
      request_id: request.id,
    });

  if (error && !isContractRenewalSchemaMissing(error)) throw error;
}

async function notifyContractWorkflow(
  record: ContractRenewalRecord,
  title: string,
  tone: "success" | "warning" | "danger" | "neutral",
) {
  await safeSendNotificationEmail({
    ctaHref: "/contracts",
    ctaLabel: "Open contract renewals",
    employeeHrId: record.employeeHrId,
    metrics: [
      { label: "Employee", value: `${record.employeeName} (${record.employeeHrId})` },
      { label: "Status", value: record.status },
      { label: "Renewal date", value: record.requestedRenewalDate },
    ],
    notificationType: "contract_renewal",
    subject: `Phoenix ${title} - ${record.employeeName}`,
    summary: `Contract renewal workflow for ${record.employeeName} is now ${record.status.replace(/_/g, " ")}.`,
    title,
    tone,
  });
}

export async function runContractRenewalWorkflow(
  id: string,
  action: ContractRenewalAction,
  actor: string,
  input: {
    decisionReason?: string | null;
    newContractDocumentName?: string | null;
    newContractDocumentUrl?: string | null;
    note?: string | null;
    signedContractName?: string | null;
    signedContractUrl?: string | null;
  } = {},
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("contract_renewal_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as RenewalRequestDbRow;
  const now = new Date().toISOString();
  const note = cleanText(input.note);
  const updates: Record<string, unknown> = {
    updated_at: now,
    workflow_notes: appendWorkflowNote(row.workflow_notes, actor, action, note),
  };

  if (input.newContractDocumentUrl !== undefined) {
    updates.new_contract_document_url = cleanText(input.newContractDocumentUrl);
    updates.new_contract_document_name = cleanText(input.newContractDocumentName);
  }

  switch (action) {
    case "manager_review":
      if (!["requested", "manager_review"].includes(row.status)) {
        throw new Error("Only requested renewals can be marked as manager reviewed.");
      }
      updates.status = "manager_review";
      updates.manager_reviewed_at = now;
      updates.manager_reviewed_by = actor;
      break;
    case "hr_review":
      if (!["requested", "manager_review", "hr_review"].includes(row.status)) {
        throw new Error("Only active renewals can be marked as HR reviewed.");
      }
      updates.status = "hr_review";
      updates.hr_reviewed_at = now;
      updates.hr_reviewed_by = actor;
      break;
    case "not_renew":
      if (["renewed", "cancelled"].includes(row.status)) {
        throw new Error("Renewed or cancelled requests cannot be marked not renewed.");
      }
      updates.status = "not_renewed";
      updates.decision_at = now;
      updates.decision_by = actor;
      updates.decision_reason = cleanText(input.decisionReason) ?? "No reason provided.";
      break;
    case "renew":
      if (!["requested", "manager_review", "hr_review"].includes(row.status)) {
        throw new Error("Only active renewal requests can be renewed.");
      }
      updates.status = "renewed";
      updates.decision_at = now;
      updates.decision_by = actor;
      updates.decision_reason = cleanText(input.decisionReason);
      break;
    case "upload_signed":
      if (!["renewed", "hr_review"].includes(row.status)) {
        throw new Error("Signed contracts can be uploaded after HR review or renewal.");
      }
      if (!cleanText(input.signedContractUrl)) {
        throw new Error("Signed contract URL is required.");
      }
      updates.signed_contract_url = cleanText(input.signedContractUrl);
      updates.signed_contract_name = cleanText(input.signedContractName);
      updates.signed_at = now;
      break;
    case "cancel":
      if (row.status === "renewed") throw new Error("Renewed requests cannot be cancelled.");
      updates.status = "cancelled";
      updates.decision_at = now;
      updates.decision_by = actor;
      updates.decision_reason = cleanText(input.decisionReason) ?? "Cancelled.";
      break;
    case "reopen":
      if (!["not_renewed", "cancelled"].includes(row.status)) {
        throw new Error("Only cancelled or not-renewed requests can be reopened.");
      }
      updates.status = "hr_review";
      updates.decision_at = null;
      updates.decision_by = null;
      updates.decision_reason = null;
      break;
    default:
      throw new Error("Unsupported contract renewal action.");
  }

  const { data: updatedData, error: updateError } = await supabase
    .from("contract_renewal_requests")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) throw updateError;
  let updated = mapRenewalRequest(updatedData as RenewalRequestDbRow);

  if (action === "renew") {
    updated = await finalizeRenewal(updated, actor);
  } else if (action === "not_renew") {
    await markContractNotRenewed(updated, actor);
  }

  await insertHistory(updated, action, actor, row.current_renewal_date, updated.requestedRenewalDate, {
    decisionReason: cleanText(input.decisionReason),
    note,
  });

  await notifyContractWorkflow(
    updated,
    action === "not_renew" ? "Contract Not Renewed" : action === "renew" ? "Contract Renewed" : "Contract Renewal Updated",
    action === "not_renew" ? "danger" : action === "renew" ? "success" : "warning",
  );

  return updated;
}

async function finalizeRenewal(record: ContractRenewalRecord, actor: string) {
  const supabase = getSupabaseAdmin();
  const nextRenewalDate = addYears(record.proposedEndDate ?? record.requestedRenewalDate, 1);
  const now = new Date().toISOString();
  const { data: contractData, error: contractError } = await supabase
    .from("employee_contracts")
    .insert({
      contract_end_date: record.proposedEndDate,
      contract_renewal_date: nextRenewalDate,
      contract_signed_date: todayDate(),
      contract_start_date: record.proposedStartDate ?? record.requestedRenewalDate,
      created_by: actor,
      document_name: record.newContractDocumentName,
      document_url: record.newContractDocumentUrl,
      employee_hr_id: record.employeeHrId,
      signed_document_name: record.signedContractName,
      signed_document_url: record.signedContractUrl,
      status: "active",
      updated_at: now,
    })
    .select("*")
    .single();

  if (contractError) throw contractError;

  await supabase
    .from("employees")
    .update({
      contract_renewal_date: nextRenewalDate,
      updated_at: now,
    })
    .eq("hr_id", record.employeeHrId);

  const contract = contractData as ContractDbRow;
  const { data, error } = await supabase
    .from("contract_renewal_requests")
    .update({
      completed_contract_id: String(contract.id),
      updated_at: now,
    })
    .eq("id", record.id)
    .select("*")
    .single();

  if (error) throw error;
  return mapRenewalRequest(data as RenewalRequestDbRow);
}

async function markContractNotRenewed(record: ContractRenewalRecord, actor: string) {
  if (!record.currentContractId) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("employee_contracts")
    .update({
      status: "not_renewed",
      updated_at: new Date().toISOString(),
      created_by: actor,
    })
    .eq("id", record.currentContractId);

  if (error) throw error;
}
