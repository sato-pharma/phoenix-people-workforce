// ─────────────────────────────────────────────────────────────────────────────────────────────
// The server's half of medical insurance. It reads the register and the Employee Master, runs the pure
// rules, and writes what a person decided. Every write is audited, and none of them touches payroll or
// `employees.medical_insurance_status`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { hrIdForStorage } from "@/lib/hr-id";
import { employeeExitDay, getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { parseCvTextInWorker } from "@/lib/recruitment/cv-text-isolation";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { compareInvoiceToPlan, type InvoiceComparison } from "./compare";
import {
  billingPeriodFor,
  billingPeriods,
  parseRateCard,
  type MedicalInsuranceCategory,
  type MedicalInsuranceMemberType,
  type MedicalInsurancePeriod,
  type MedicalInsuranceRateCard,
} from "./cost";
import {
  additionCategory,
  buildMedicalInsuranceActions,
  buildMedicalInsuranceMovements,
  buildMedicalInsurancePlan,
  type EmployeeFacts,
  type ExceptionFacts,
  type MedicalInsuranceAction,
  type MedicalInsurancePlan,
  type MemberFacts,
} from "./eligibility";
import {
  assertMedicalInsuranceFileAllowed,
  buildMedicalInsuranceFilePath,
  downloadMedicalInsuranceFile,
  removeMedicalInsuranceFile,
  uploadMedicalInsuranceFile,
} from "./file-storage";
import { InvoiceUnreadableError, parseMedicalInsuranceInvoice, type ParsedInvoice } from "./invoice-parser";
import type { MetLifeEdiAddition, MetLifeEdiDeletion } from "./workbooks";
import type {
  MedicalInsuranceDocumentKind,
  MedicalInsuranceDocumentRow,
  MedicalInsuranceInvoiceRow,
  MedicalInsuranceMemberRow,
  MedicalInsuranceMoneyView,
  MedicalInsurancePolicyView,
  MedicalInsuranceView,
} from "./view";

/** A refusal the person can act on: the route answers it with its own message, as a 400. */
export class MedicalInsuranceInputError extends Error {}

const POLICY_COLUMNS = "id, insurer, policy_number, group_code, sub_office, starts_on, ends_on, rate_card";
const MEMBER_COLUMNS =
  "id, hr_id, certificate_number, member_type, principal_member_id, full_name, category, coverage_starts_on, coverage_ends_on, end_reason, notes";
const DOCUMENT_COLUMNS =
  "id, kind, title, file_name, size_bytes, email_from, email_to, email_sent_on, body, note, uploaded_by_hr_id, uploaded_at";

type PolicyDbRow = {
  id: string;
  insurer: string;
  policy_number: string;
  group_code: string | null;
  sub_office: string | null;
  starts_on: string;
  ends_on: string;
  rate_card: unknown;
};

type MemberDbRow = {
  id: string;
  hr_id: string | null;
  certificate_number: string | null;
  member_type: MedicalInsuranceMemberType;
  principal_member_id: string | null;
  full_name: string;
  category: MedicalInsuranceCategory;
  coverage_starts_on: string;
  coverage_ends_on: string | null;
  end_reason: string | null;
  notes: string | null;
};

type DocumentDbRow = {
  id: string;
  kind: MedicalInsuranceDocumentKind;
  title: string;
  file_name: string | null;
  size_bytes: number | null;
  email_from: string | null;
  email_to: string | null;
  email_sent_on: string | null;
  body: string | null;
  note: string | null;
  uploaded_by_hr_id: string | null;
  uploaded_at: string;
};

type PolicyRecord = MedicalInsurancePolicyView & { rateCard: MedicalInsuranceRateCard };

export function medicalInsuranceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMedicalInsuranceSchemaMissing(error: unknown): boolean {
  const message = medicalInsuranceErrorMessage(error).toLowerCase();
  return message.includes("could not find the table") || message.includes("schema cache") || (message.includes("relation") && message.includes("does not exist"));
}

export function isMedicalInsuranceInputError(error: unknown): boolean {
  return error instanceof MedicalInsuranceInputError || error instanceof InvoiceUnreadableError;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** The policy in force on a day, or the most recent one when none is. Null when none has been set up. */
async function loadPolicy(asOf: string): Promise<PolicyRecord | null> {
  const { data, error } = await getSupabaseAdmin().from("medical_insurance_policies").select(POLICY_COLUMNS).order("starts_on", { ascending: false });
  fail(error);
  const rows = (data ?? []) as PolicyDbRow[];
  const row = rows.find((candidate) => candidate.starts_on <= asOf && candidate.ends_on >= asOf) ?? rows[0];
  if (!row) return null;
  return {
    endsOn: row.ends_on,
    groupCode: row.group_code,
    id: row.id,
    insurer: row.insurer,
    policyNumber: row.policy_number,
    rateCard: parseRateCard(row.rate_card),
    startsOn: row.starts_on,
    subOffice: row.sub_office,
  };
}

async function requirePolicy(asOf: string): Promise<PolicyRecord> {
  const policy = await loadPolicy(asOf);
  if (!policy) throw new MedicalInsuranceInputError("No medical insurance policy has been set up yet.");
  return policy;
}

function toMemberFacts(row: MemberDbRow): MemberFacts {
  return {
    category: row.category,
    certificateNumber: row.certificate_number,
    coverageEnd: row.coverage_ends_on,
    coverageStart: row.coverage_starts_on,
    hrId: row.hr_id,
    id: row.id,
    memberType: row.member_type,
    name: row.full_name,
    principalMemberId: row.principal_member_id,
  };
}

async function loadMembers(policyId: string): Promise<MemberDbRow[]> {
  const { data, error } = await getSupabaseAdmin().from("medical_insurance_members").select(MEMBER_COLUMNS).eq("policy_id", policyId).order("full_name");
  fail(error);
  return (data ?? []) as MemberDbRow[];
}

async function loadExceptions(policyId: string): Promise<ExceptionFacts[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_exceptions")
    .select("id, hr_id, decision, reason")
    .eq("policy_id", policyId)
    .is("revoked_at", null);
  fail(error);
  return ((data ?? []) as Array<{ id: string; hr_id: string; decision: ExceptionFacts["decision"]; reason: string }>).map((row) => ({
    decision: row.decision,
    hrId: row.hr_id,
    id: row.id,
    reason: row.reason,
  }));
}

/** The category decided for each joiner not on the register yet, by HR id. */
async function loadCategoryChoices(policyId: string): Promise<Map<string, MedicalInsuranceCategory>> {
  const { data, error } = await getSupabaseAdmin().from("medical_insurance_category_choices").select("hr_id, category").eq("policy_id", policyId);
  fail(error);
  return new Map(((data ?? []) as Array<{ hr_id: string; category: MedicalInsuranceCategory }>).map((row) => [row.hr_id, row.category]));
}

/** "Active" is the record's own status: the sole Super Admin is on the policy and is hidden from the directory's active list. */
function toEmployeeFacts(row: EmployeeDirectoryRow): EmployeeFacts {
  return {
    active: String(row.employmentStatus ?? "").trim().toLowerCase() === "active",
    employmentStatus: row.employmentStatus,
    exitDay: employeeExitDay(row),
    hireDate: row.hireDate ? row.hireDate.slice(0, 10) : null,
    hrId: row.hrId,
    jobTitle: row.jobTitle,
    lineName: row.lineName,
    name: row.displayName || row.fullName,
  };
}

async function loadEmployeeRows(): Promise<EmployeeDirectoryRow[]> {
  return getEmployeeDirectoryRows({ includeInactive: true });
}

function policyFacts(policy: PolicyRecord) {
  return { endsOn: policy.endsOn, startsOn: policy.startsOn };
}

function toDocumentRow(row: DocumentDbRow, names: ReadonlyMap<string, string>): MedicalInsuranceDocumentRow {
  return {
    body: row.body,
    emailFrom: row.email_from,
    emailSentOn: row.email_sent_on,
    emailTo: row.email_to,
    fileName: row.file_name,
    id: row.id,
    kind: row.kind,
    note: row.note,
    sizeBytes: row.size_bytes,
    title: row.title,
    uploadedAt: row.uploaded_at,
    uploadedByName: row.uploaded_by_hr_id ? names.get(row.uploaded_by_hr_id) ?? null : null,
  };
}

async function loadDocuments(policyId: string, kinds: readonly MedicalInsuranceDocumentKind[], names: ReadonlyMap<string, string>): Promise<MedicalInsuranceDocumentRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_documents")
    .select(DOCUMENT_COLUMNS)
    .eq("policy_id", policyId)
    .in("kind", [...kinds])
    .is("removed_at", null)
    .order("uploaded_at", { ascending: false });
  fail(error);
  return ((data ?? []) as DocumentDbRow[]).map((row) => toDocumentRow(row, names));
}

/** Everything but the money. Returns null when no policy has been set up. */
export async function getMedicalInsuranceView(): Promise<MedicalInsuranceView | null> {
  const asOf = todayInCairo();
  const policy = await loadPolicy(asOf);
  if (!policy) return null;

  const [memberRows, exceptions, employeeRows, categoryChoices] = await Promise.all([
    loadMembers(policy.id),
    loadExceptions(policy.id),
    loadEmployeeRows(),
    loadCategoryChoices(policy.id),
  ]);
  const employees = employeeRows.map(toEmployeeFacts);
  const members = memberRows.map(toMemberFacts);
  const names = new Map(employees.map((employee) => [employee.hrId, employee.name]));
  const jobTitles = new Map(employees.map((employee) => [employee.hrId, employee.jobTitle]));
  const memberNames = new Map(memberRows.map((row) => [row.id, row.full_name]));

  const built = buildMedicalInsuranceActions({ asOf, employees, exceptions, members, policy: policyFacts(policy) });
  const kept = built.exceptions;
  const actions = built.actions.map((action) =>
    action.kind === "add" && action.hrId ? { ...action, decidedCategory: categoryChoices.get(action.hrId) ?? null } : action,
  );
  const documents = await loadDocuments(policy.id, ["communication_tool", "form"], names);

  const memberView: MedicalInsuranceMemberRow[] = memberRows.map((row) => ({
    category: row.category,
    certificateNumber: row.certificate_number,
    coverageEnd: row.coverage_ends_on,
    coverageStart: row.coverage_starts_on,
    endReason: row.end_reason,
    hrId: row.hr_id,
    id: row.id,
    jobTitle: row.hr_id ? jobTitles.get(row.hr_id) ?? null : null,
    memberType: row.member_type,
    name: row.full_name,
    notes: row.notes,
    open: !row.coverage_ends_on || row.coverage_ends_on >= asOf,
    principalMemberId: row.principal_member_id,
    principalName: row.principal_member_id ? memberNames.get(row.principal_member_id) ?? null : null,
  }));

  const open = memberView.filter((row) => row.open);
  const count = (kind: MedicalInsuranceAction["kind"], timing: MedicalInsuranceAction["timing"]) =>
    actions.filter((action) => action.kind === kind && action.timing === timing).length;

  return {
    actions,
    asOf,
    counts: {
      addNow: count("add", "now"),
      addSoon: count("add", "soon"),
      covered: open.length,
      coveredEmployees: open.filter((row) => row.memberType === "employee").length,
      coveredFamily: open.filter((row) => row.memberType !== "employee").length,
      exceptions: kept.length,
      removeNow: count("remove", "now"),
      removeSoon: count("remove", "soon"),
      review: count("review", "now"),
    },
    documents,
    employees: employees
      .filter((employee) => employee.active)
      .map((employee) => ({ hrId: employee.hrId, jobTitle: employee.jobTitle, name: employee.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    exceptions: kept,
    members: memberView,
    movements: buildMedicalInsuranceMovements(members, policy.startsOn),
    policy: {
      endsOn: policy.endsOn,
      groupCode: policy.groupCode,
      id: policy.id,
      insurer: policy.insurer,
      policyNumber: policy.policyNumber,
      startsOn: policy.startsOn,
      subOffice: policy.subOffice,
    },
  };
}

async function planFor(policy: PolicyRecord, period: MedicalInsurancePeriod, inputs?: { employees: EmployeeFacts[]; exceptions: ExceptionFacts[]; members: MemberFacts[] }): Promise<MedicalInsurancePlan> {
  const [memberRows, exceptions, employeeRows] = inputs
    ? [null, inputs.exceptions, null]
    : await Promise.all([loadMembers(policy.id), loadExceptions(policy.id), loadEmployeeRows()]);
  return buildMedicalInsurancePlan({
    employees: inputs?.employees ?? (employeeRows ?? []).map(toEmployeeFacts),
    exceptions,
    members: inputs?.members ?? (memberRows ?? []).map(toMemberFacts),
    period,
    policy: policyFacts(policy),
    rateCard: policy.rateCard,
  });
}

type InvoiceDbRow = {
  id: string;
  bill_number: string;
  issued_on: string | null;
  period_starts_on: string;
  period_ends_on: string;
  premium_total: number | string;
  fees_total: number | string;
  total_due: number | string;
  file_name: string;
  uploaded_at: string;
  compared_at: string;
  comparison: InvoiceComparison;
};

const INVOICE_COLUMNS =
  "id, bill_number, issued_on, period_starts_on, period_ends_on, premium_total, fees_total, total_due, file_name, uploaded_at, compared_at, comparison";

function toInvoiceRow(row: InvoiceDbRow): MedicalInsuranceInvoiceRow {
  return {
    billNumber: row.bill_number,
    comparedAt: row.compared_at,
    comparison: row.comparison,
    feesTotal: Number(row.fees_total),
    fileName: row.file_name,
    id: row.id,
    issuedOn: row.issued_on,
    periodEnd: row.period_ends_on,
    periodStart: row.period_starts_on,
    premiumTotal: Number(row.premium_total),
    totalDue: Number(row.total_due),
    uploadedAt: row.uploaded_at,
  };
}

/** The cost, the invoices and the papers that carry amounts. Callers assert medical_insurance_invoices first. */
export async function getMedicalInsuranceMoney(): Promise<MedicalInsuranceMoneyView | null> {
  const asOf = todayInCairo();
  const policy = await loadPolicy(asOf);
  if (!policy) return null;

  const [memberRows, exceptions, employeeRows] = await Promise.all([loadMembers(policy.id), loadExceptions(policy.id), loadEmployeeRows()]);
  const inputs = { employees: employeeRows.map(toEmployeeFacts), exceptions, members: memberRows.map(toMemberFacts) };
  const periods = billingPeriods({ billingMonths: policy.rateCard.billingMonths, endsOn: policy.endsOn, startsOn: policy.startsOn });
  const period = billingPeriodFor(periods, asOf);
  const plan = await planFor(policy, period, inputs);

  // A year is the periods the policy holds, each planned as the people stand today.
  const yearPlans = await Promise.all(periods.map((entry) => planFor(policy, entry, inputs)));
  const yearEstimate = Math.round(yearPlans.reduce((sum, entry) => sum + Math.round(entry.statement.total * 100), 0)) / 100;

  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_invoices")
    .select(INVOICE_COLUMNS)
    .eq("policy_id", policy.id)
    .order("period_starts_on", { ascending: false });
  fail(error);

  const names = new Map(inputs.employees.map((employee) => [employee.hrId, employee.name]));
  return {
    documents: await loadDocuments(policy.id, ["policy", "email"], names),
    invoices: ((data ?? []) as InvoiceDbRow[]).map(toInvoiceRow),
    period,
    plan: { people: plan.people, prorated: plan.prorated, statement: plan.statement, unpriced: plan.unpriced },
    yearEstimate,
  };
}

// ── Members ─────────────────────────────────────────────────────────────────────────────────

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanDay(value: unknown, label: string): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new MedicalInsuranceInputError(`${label} is not a date.`);
  }
  return text;
}

function cleanCategory(value: unknown): MedicalInsuranceCategory {
  if (value === "A" || value === "B" || value === "C") return value;
  throw new MedicalInsuranceInputError("Choose category A, B or C.");
}

export type AddMemberInput = {
  hrId?: unknown;
  memberType?: unknown;
  principalMemberId?: unknown;
  fullName?: unknown;
  category?: unknown;
  coverageStart?: unknown;
  certificateNumber?: unknown;
  birthDate?: unknown;
  nationalId?: unknown;
  gender?: unknown;
  notes?: unknown;
};

export async function addMedicalInsuranceMember(access: AccessContext, input: AddMemberInput) {
  const policy = await requirePolicy(todayInCairo());
  const memberType: MedicalInsuranceMemberType = input.memberType === "spouse" || input.memberType === "child" ? input.memberType : "employee";
  const coverageStart = cleanDay(input.coverageStart, "The start of cover") ?? policy.startsOn;
  if (coverageStart < policy.startsOn) throw new MedicalInsuranceInputError("Cover cannot start before the policy does.");
  if (coverageStart > policy.endsOn) throw new MedicalInsuranceInputError("Cover cannot start after the policy ends.");

  const supabase = getSupabaseAdmin();
  let hrId = cleanText(input.hrId);
  let fullName = cleanText(input.fullName);
  let principalMemberId: string | null = null;
  let certificate = cleanText(input.certificateNumber);
  let category = input.category;

  if (memberType === "employee") {
    if (hrId) {
      const employee = (await loadEmployeeRows()).find((row) => row.hrId === hrId);
      if (!employee) throw new MedicalInsuranceInputError("That employee is not in the Employee Master.");
      fullName = fullName ?? employee.fullName;
    }
  } else {
    principalMemberId = cleanText(input.principalMemberId);
    if (!principalMemberId) throw new MedicalInsuranceInputError("Choose the employee this family member sits under.");
    const { data, error } = await supabase
      .from("medical_insurance_members")
      .select("id, hr_id, certificate_number, category, member_type")
      .eq("id", principalMemberId)
      .eq("policy_id", policy.id)
      .maybeSingle();
    fail(error);
    const principal = data as { hr_id: string | null; certificate_number: string | null; category: MedicalInsuranceCategory; member_type: string } | null;
    if (!principal || principal.member_type !== "employee") throw new MedicalInsuranceInputError("Choose the employee this family member sits under.");
    hrId = principal.hr_id;
    certificate = certificate ?? principal.certificate_number;
    category = category ?? principal.category;
  }
  if (!fullName) throw new MedicalInsuranceInputError("Enter the person's name.");

  const { data, error } = await supabase
    .from("medical_insurance_members")
    .insert({
      birth_date: memberType === "employee" ? null : cleanDay(input.birthDate, "The date of birth"),
      category: cleanCategory(category),
      certificate_number: certificate,
      coverage_starts_on: coverageStart,
      created_by_hr_id: hrIdForStorage(access.hrId),
      full_name: fullName,
      gender: memberType !== "employee" && (input.gender === "M" || input.gender === "F") ? input.gender : null,
      hr_id: hrId,
      member_type: memberType,
      national_id: memberType === "employee" ? null : cleanText(input.nationalId),
      notes: cleanText(input.notes),
      policy_id: policy.id,
      principal_member_id: principalMemberId,
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .select("id")
    .single();
  if (error?.code === "23505") throw new MedicalInsuranceInputError(`${fullName} is already on the policy.`);
  fail(error);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: (data as { id: string }).id,
    entityType: "medical_insurance_member",
    summary: `Added ${fullName} to the medical insurance register from ${coverageStart}`,
  });
  return (data as { id: string }).id;
}

export type UpdateMemberInput = {
  action?: unknown;
  category?: unknown;
  certificateNumber?: unknown;
  coverageStart?: unknown;
  coverageEnd?: unknown;
  endReason?: unknown;
  notes?: unknown;
  keepOut?: unknown;
};

/** Change a row, end it, or put it back. Ending an employee ends the family under them on the same day. */
export async function updateMedicalInsuranceMember(access: AccessContext, memberId: string, input: UpdateMemberInput) {
  const policy = await requirePolicy(todayInCairo());
  const supabase = getSupabaseAdmin();
  const { data: found, error: readError } = await supabase.from("medical_insurance_members").select(MEMBER_COLUMNS).eq("id", memberId).eq("policy_id", policy.id).maybeSingle();
  fail(readError);
  const member = found as MemberDbRow | null;
  if (!member) throw new MedicalInsuranceInputError("That person is no longer on the register.");

  const stamp = { updated_at: new Date().toISOString(), updated_by_hr_id: hrIdForStorage(access.hrId) };

  if (input.action === "end") {
    const endsOn = cleanDay(input.coverageEnd, "The end of cover");
    const reason = cleanText(input.endReason);
    if (!endsOn) throw new MedicalInsuranceInputError("Enter the day cover ends.");
    if (!reason) throw new MedicalInsuranceInputError("Enter why cover is ending.");
    if (endsOn < member.coverage_starts_on) throw new MedicalInsuranceInputError("Cover cannot end before it started.");

    fail((await supabase.from("medical_insurance_members").update({ ...stamp, coverage_ends_on: endsOn, end_reason: reason }).eq("id", memberId)).error);
    if (member.member_type === "employee") {
      fail(
        (
          await supabase
            .from("medical_insurance_members")
            .update({ ...stamp, coverage_ends_on: endsOn, end_reason: `${member.full_name}: ${reason}` })
            .eq("principal_member_id", memberId)
            .is("coverage_ends_on", null)
        ).error,
      );
    }
    if (input.keepOut === true && member.member_type === "employee" && member.hr_id) {
      await addMedicalInsuranceException(access, { decision: "keep_out", hrId: member.hr_id, reason });
    }
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: memberId,
      entityType: "medical_insurance_member",
      summary: `Ended ${member.full_name}'s medical insurance cover on ${endsOn}: ${reason}`,
    });
    return;
  }

  if (input.action === "reinstate") {
    fail((await supabase.from("medical_insurance_members").update({ ...stamp, coverage_ends_on: null, end_reason: null }).eq("id", memberId)).error);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: memberId,
      entityType: "medical_insurance_member",
      summary: `Put ${member.full_name} back on the medical insurance register`,
    });
    return;
  }

  const coverageStart = cleanDay(input.coverageStart, "The start of cover") ?? member.coverage_starts_on;
  if (coverageStart < policy.startsOn) throw new MedicalInsuranceInputError("Cover cannot start before the policy does.");
  const patch = {
    ...stamp,
    category: input.category === undefined ? member.category : cleanCategory(input.category),
    certificate_number: input.certificateNumber === undefined ? member.certificate_number : cleanText(input.certificateNumber),
    coverage_starts_on: coverageStart,
    notes: input.notes === undefined ? member.notes : cleanText(input.notes),
  };
  fail((await supabase.from("medical_insurance_members").update(patch).eq("id", memberId)).error);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: memberId,
    entityType: "medical_insurance_member",
    newValues: { category: patch.category, certificate_number: patch.certificate_number, coverage_starts_on: patch.coverage_starts_on },
    oldValues: { category: member.category, certificate_number: member.certificate_number, coverage_starts_on: member.coverage_starts_on },
    summary: `Changed ${member.full_name}'s medical insurance record`,
  });
}

// ── Exceptions ──────────────────────────────────────────────────────────────────────────────

export async function addMedicalInsuranceException(access: AccessContext, input: { hrId?: unknown; decision?: unknown; reason?: unknown }) {
  const policy = await requirePolicy(todayInCairo());
  const hrId = cleanText(input.hrId);
  const reason = cleanText(input.reason);
  if (!hrId) throw new MedicalInsuranceInputError("Choose the employee.");
  if (input.decision !== "keep_in" && input.decision !== "keep_out") throw new MedicalInsuranceInputError("Choose keep on or keep off the policy.");
  if (!reason) throw new MedicalInsuranceInputError("Enter the reason for this exception.");

  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_exceptions")
    .insert({ decided_by_hr_id: hrIdForStorage(access.hrId), decision: input.decision, hr_id: hrId, policy_id: policy.id, reason })
    .select("id")
    .single();
  if (error?.code === "23505") throw new MedicalInsuranceInputError("This person already has an exception. Remove it first.");
  fail(error);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: (data as { id: string }).id,
    entityType: "medical_insurance_exception",
    summary: `Medical insurance exception: ${input.decision === "keep_in" ? "keep on" : "keep off"} the policy. ${reason}`,
  });
}

export async function revokeMedicalInsuranceException(access: AccessContext, exceptionId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_exceptions")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: hrIdForStorage(access.hrId) })
    .eq("id", exceptionId)
    .is("revoked_at", null)
    .select("id, reason");
  fail(error);
  const row = (data as Array<{ id: string; reason: string }> | null)?.[0];
  if (!row) throw new MedicalInsuranceInputError("That exception has already been removed.");
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: exceptionId,
    entityType: "medical_insurance_exception",
    summary: `Removed a medical insurance exception. It read: ${row.reason}`,
  });
}

// ── Invoices ────────────────────────────────────────────────────────────────────────────────

export type InvoiceFile = { bytes: Buffer; contentType: string; fileName: string };

/** The policy's own period when the invoice's dates are one, otherwise the invoice's dates as printed. */
/**
 * Decides the category a joiner goes on the policy with, before they are on the register. A new decision
 * replaces the last one, and the audit log keeps every one.
 */
export async function decideMedicalInsuranceCategory(access: AccessContext, input: { hrId?: unknown; category?: unknown }) {
  const policy = await requirePolicy(todayInCairo());
  const hrId = cleanText(input.hrId);
  if (!hrId) throw new MedicalInsuranceInputError("Choose the employee.");
  const category = cleanCategory(input.category);
  const view = await getMedicalInsuranceView();
  const action = view?.actions.find((candidate) => candidate.kind === "add" && candidate.hrId === hrId);
  if (!action) throw new MedicalInsuranceInputError("This person is no longer on the list to add. Refresh the page.");

  fail(
    (
      await getSupabaseAdmin()
        .from("medical_insurance_category_choices")
        .upsert(
          { category, decided_at: new Date().toISOString(), decided_by_hr_id: hrIdForStorage(access.hrId), hr_id: hrId, policy_id: policy.id },
          { onConflict: "policy_id,hr_id" },
        )
    ).error,
  );

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: hrId,
    entityType: "medical_insurance_category_choice",
    summary: `Medical insurance category ${category} decided for ${action.name}.`,
  });
}

async function comparisonFor(policy: PolicyRecord, parsed: ParsedInvoice): Promise<InvoiceComparison> {
  const plan = await planFor(policy, { end: parsed.periodEnd, start: parsed.periodStart });
  return compareInvoiceToPlan(parsed, plan, { expectedPolicyNumber: policy.policyNumber });
}

export async function uploadMedicalInsuranceInvoice(access: AccessContext, file: InvoiceFile): Promise<MedicalInsuranceInvoiceRow> {
  const contentType = assertMedicalInsuranceFileAllowed({ fileName: file.fileName, size: file.bytes.length });
  if (contentType !== "application/pdf") throw new MedicalInsuranceInputError("An invoice must be the insurer's PDF.");

  const parsed = parseMedicalInsuranceInvoice(await parseCvTextInWorker(file.bytes, "pdf"));
  const policy = await requirePolicy(parsed.periodStart || todayInCairo());
  const supabase = getSupabaseAdmin();

  const { data: existing, error: existingError } = await supabase.from("medical_insurance_invoices").select("id").eq("bill_number", parsed.billNumber).maybeSingle();
  fail(existingError);
  if (existing) throw new MedicalInsuranceInputError(`Bill ${parsed.billNumber} has already been uploaded.`);

  const comparison = await comparisonFor(policy, parsed);
  const path = buildMedicalInsuranceFilePath({ fileName: file.fileName, folder: `invoices/${parsed.billNumber}` });
  await uploadMedicalInsuranceFile({ bytes: file.bytes, contentType, path });

  try {
    const { data, error } = await supabase
      .from("medical_insurance_invoices")
      .insert({
        bill_number: parsed.billNumber,
        comparison,
        content_type: contentType,
        fees_total: parsed.feesTotal,
        file_name: file.fileName,
        issued_on: parsed.issuedOn,
        parsed,
        period_ends_on: parsed.periodEnd,
        period_starts_on: parsed.periodStart,
        policy_id: policy.id,
        premium_total: parsed.premiumTotal,
        size_bytes: file.bytes.length,
        storage_path: path,
        total_due: parsed.totalDue,
        uploaded_by_hr_id: hrIdForStorage(access.hrId),
      })
      .select(INVOICE_COLUMNS)
      .single();
    fail(error);
    const row = data as InvoiceDbRow;

    const lines = parsed.members.flatMap((member) =>
      member.lines
        .filter((line) => line.premium !== 0 || line.adjustment !== 0)
        .map((line) => ({
          adjustment: line.adjustment,
          birth_date: member.birthDate,
          certificate_number: member.certificate,
          cover_type: line.coverType,
          dependant_count: line.dependantCount,
          invoice_id: row.id,
          member_name: member.name,
          plan_code: line.plan,
          premium: line.premium,
          product_code: line.product,
          volume: line.volume,
        })),
    );
    if (lines.length > 0) {
      const { error: linesError } = await supabase.from("medical_insurance_invoice_lines").insert(lines);
      if (linesError) {
        await supabase.from("medical_insurance_invoices").delete().eq("id", row.id);
        throw new Error(linesError.message);
      }
    }

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: row.id,
      entityType: "medical_insurance_invoice",
      summary: `Uploaded medical insurance bill ${parsed.billNumber}, EGP ${parsed.totalDue.toFixed(2)}, EGP ${comparison.difference.toFixed(2)} against the plan`,
    });
    return toInvoiceRow(row);
  } catch (error) {
    await removeMedicalInsuranceFile(path);
    throw error;
  }
}

/** Replaces the stored comparison with one against the register as it stands now. */
export async function recompareMedicalInsuranceInvoice(access: AccessContext, invoiceId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("medical_insurance_invoices").select("id, bill_number, parsed").eq("id", invoiceId).maybeSingle();
  fail(error);
  const row = data as { id: string; bill_number: string; parsed: ParsedInvoice } | null;
  if (!row) throw new MedicalInsuranceInputError("That invoice is no longer on file.");

  const policy = await requirePolicy(row.parsed.periodStart || todayInCairo());
  const comparison = await comparisonFor(policy, row.parsed);
  fail((await supabase.from("medical_insurance_invoices").update({ compared_at: new Date().toISOString(), comparison }).eq("id", invoiceId)).error);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: invoiceId,
    entityType: "medical_insurance_invoice",
    summary: `Compared medical insurance bill ${row.bill_number} against today's plan: EGP ${comparison.difference.toFixed(2)} difference`,
  });
}

export type StoredInvoice = {
  id: string;
  billNumber: string;
  parsed: ParsedInvoice;
  comparison: InvoiceComparison;
  comparedAt: string;
  fileName: string;
  contentType: string;
  storagePath: string;
};

export async function getMedicalInsuranceInvoice(invoiceId: string): Promise<StoredInvoice | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_invoices")
    .select("id, bill_number, parsed, comparison, compared_at, file_name, content_type, storage_path")
    .eq("id", invoiceId)
    .maybeSingle();
  fail(error);
  const row = data as {
    id: string;
    bill_number: string;
    parsed: ParsedInvoice;
    comparison: InvoiceComparison;
    compared_at: string;
    file_name: string;
    content_type: string;
    storage_path: string;
  } | null;
  if (!row) return null;
  return {
    billNumber: row.bill_number,
    comparedAt: row.compared_at,
    comparison: row.comparison,
    contentType: row.content_type,
    fileName: row.file_name,
    id: row.id,
    parsed: row.parsed,
    storagePath: row.storage_path,
  };
}

export { downloadMedicalInsuranceFile };

// ── Documents ───────────────────────────────────────────────────────────────────────────────

export const SEAT_DOCUMENT_KINDS: readonly MedicalInsuranceDocumentKind[] = ["communication_tool", "form"];
export const RESTRICTED_DOCUMENT_KINDS: readonly MedicalInsuranceDocumentKind[] = ["policy", "email"];

export type DocumentInput = {
  kind: unknown;
  title: unknown;
  note?: unknown;
  emailFrom?: unknown;
  emailTo?: unknown;
  emailSentOn?: unknown;
  body?: unknown;
  file?: { bytes: Buffer; fileName: string } | null;
};

/** Saves a paper or an email. `allowedKinds` is the route's own: the two routes hold different permissions. */
export async function addMedicalInsuranceDocument(access: AccessContext, input: DocumentInput, allowedKinds: readonly MedicalInsuranceDocumentKind[]) {
  const policy = await requirePolicy(todayInCairo());
  const kind = input.kind as MedicalInsuranceDocumentKind;
  if (!allowedKinds.includes(kind)) throw new MedicalInsuranceInputError("Choose what kind of document this is.");

  const body = cleanText(input.body);
  if (!input.file && !body) throw new MedicalInsuranceInputError("Attach a file or paste the email's text.");
  const title = cleanText(input.title) ?? input.file?.fileName ?? null;
  if (!title) throw new MedicalInsuranceInputError("Enter a title.");

  let storage: { content_type: string; file_name: string; size_bytes: number; storage_path: string } | null = null;
  if (input.file) {
    const contentType = assertMedicalInsuranceFileAllowed({ fileName: input.file.fileName, size: input.file.bytes.length });
    const path = buildMedicalInsuranceFilePath({ fileName: input.file.fileName, folder: `documents/${kind}` });
    await uploadMedicalInsuranceFile({ bytes: input.file.bytes, contentType, path });
    storage = { content_type: contentType, file_name: input.file.fileName, size_bytes: input.file.bytes.length, storage_path: path };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_documents")
    .insert({
      ...storage,
      body,
      email_from: cleanText(input.emailFrom),
      email_sent_on: cleanDay(input.emailSentOn, "The email's date"),
      email_to: cleanText(input.emailTo),
      kind,
      note: cleanText(input.note),
      policy_id: policy.id,
      title,
      uploaded_by_hr_id: hrIdForStorage(access.hrId),
    })
    .select("id")
    .single();
  if (error) {
    if (storage) await removeMedicalInsuranceFile(storage.storage_path);
    throw new Error(error.message);
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: (data as { id: string }).id,
    entityType: "medical_insurance_document",
    summary: `Saved a medical insurance ${kind.replace("_", " ")}: ${title}`,
  });
}

export async function getMedicalInsuranceDocumentFile(documentId: string, allowedKinds: readonly MedicalInsuranceDocumentKind[]) {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_documents")
    .select("id, kind, file_name, content_type, storage_path")
    .eq("id", documentId)
    .is("removed_at", null)
    .maybeSingle();
  fail(error);
  const row = data as { kind: MedicalInsuranceDocumentKind; file_name: string | null; content_type: string | null; storage_path: string | null } | null;
  if (!row || !allowedKinds.includes(row.kind) || !row.storage_path) return null;
  return { bytes: await downloadMedicalInsuranceFile(row.storage_path), contentType: row.content_type ?? "application/octet-stream", fileName: row.file_name ?? "document" };
}

/** Takes a document off the page. The row and the stored file stay, so the record of what was held remains. */
export async function removeMedicalInsuranceDocument(access: AccessContext, documentId: string, allowedKinds: readonly MedicalInsuranceDocumentKind[]) {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_documents")
    .update({ removed_at: new Date().toISOString(), removed_by_hr_id: hrIdForStorage(access.hrId) })
    .eq("id", documentId)
    .in("kind", [...allowedKinds])
    .is("removed_at", null)
    .select("id, title");
  fail(error);
  const row = (data as Array<{ id: string; title: string }> | null)?.[0];
  if (!row) throw new MedicalInsuranceInputError("That document has already been removed.");
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: documentId,
    entityType: "medical_insurance_document",
    summary: `Took a medical insurance document off the page: ${row.title}`,
  });
}

// ── The insurer's EDI form, for the people ticked on the page ───────────────────────────────

export type MetLifeEdiRequest =
  | { kind: "additions"; rows: MetLifeEdiAddition[] }
  | { kind: "deletions"; rows: MetLifeEdiDeletion[] };

const EDI_MOST_ROWS = 500;

/**
 * Turns the people ticked on the page into the insurer's EDI lines. Each one must still be on today's
 * list, as an addition or a deletion as asked, so a stale page cannot put somebody on the form that the
 * rule no longer names. A deletion lists the employee alone: the insurer's own form says their spouse and
 * children go with them.
 */
export async function prepareMetLifeEdi(body: Record<string, unknown>): Promise<{ policyId: string; request: MetLifeEdiRequest }> {
  const kind = body.kind;
  if (kind !== "additions" && kind !== "deletions") throw new MedicalInsuranceInputError("Choose additions or deletions.");
  const keys = Array.isArray(body.keys) ? [...new Set(body.keys.filter((key): key is string => typeof key === "string" && key.length > 0))] : [];
  if (keys.length === 0) throw new MedicalInsuranceInputError(kind === "additions" ? "Tick at least one person to add." : "Tick at least one person to delete.");
  if (keys.length > EDI_MOST_ROWS) throw new MedicalInsuranceInputError(`One file holds at most ${EDI_MOST_ROWS} people.`);
  const chosenCategories = body.categories && typeof body.categories === "object" ? (body.categories as Record<string, unknown>) : {};

  const view = await getMedicalInsuranceView();
  if (!view) throw new MedicalInsuranceInputError("No medical insurance policy has been set up yet.");
  const wanted = kind === "additions" ? "add" : "remove";
  const byKey = new Map(view.actions.filter((action) => action.kind === wanted).map((action) => [action.key, action]));
  const chosen = keys.map((key) => byKey.get(key));
  if (chosen.some((action) => !action)) {
    throw new MedicalInsuranceInputError(
      `Someone you ticked is no longer on the list to ${kind === "additions" ? "add" : "remove"}. Refresh the page and tick again.`,
    );
  }
  const actions = chosen as MedicalInsuranceAction[];

  if (kind === "deletions") {
    return {
      policyId: view.policy.id,
      request: {
        kind,
        rows: actions.map((action) => ({
          certificateNumber: action.certificateNumber,
          coverageEndsOn: action.effectiveOn,
          memberType: action.memberType,
          name: action.name,
        })),
      },
    };
  }

  const employees = new Map((await loadEmployeeRows()).map((employee) => [employee.hrId, employee]));
  const rows = actions.map((action) => {
    const picked = chosenCategories[action.key];
    const category = additionCategory(action, picked);
    if (!category) throw new MedicalInsuranceInputError(`Choose a category for ${action.name}.`);
    const employee = action.hrId ? employees.get(action.hrId) : undefined;
    return {
      birthDate: employee?.birthDate ?? null,
      category,
      coverageStartsOn: action.effectiveOn,
      email: employee?.workEmail ?? null,
      fullName: employee?.fullName ?? action.name,
      gender: employee?.gender ?? null,
      hireDate: employee?.hireDate ?? null,
      hrId: action.hrId,
      mobileNumber: employee?.mobileNumber ?? null,
      nationalId: employee?.nationalId ?? null,
    };
  });
  return { policyId: view.policy.id, request: { kind, rows } };
}
