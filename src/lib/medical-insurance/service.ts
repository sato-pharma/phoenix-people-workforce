// ─────────────────────────────────────────────────────────────────────────────────────────────
// The server's half of medical insurance. It reads the register and the Employee Master, runs the pure
// rules, and writes what a person decided. Every write is audited, and none of them touches payroll or
// `employees.medical_insurance_status`. Nothing here sends anything or pays anything. Payroll READS one thing
// from here from the December 2026 payroll month on: each employee's monthly share
// (getPayrollMedicalInsuranceCharges), owner, 2026-11-24. The one write into `employees` is
// syncEmployeeMasterFromMedicalInsurance (owner, 2026-11-27): the card number, and blank identity fields
// (./master-sync.ts); never the card-received answer, never an amount.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { hrIdForStorage } from "@/lib/hr-id";
import { employeeExitDay, getEmployeeDirectoryRows, invalidateEmployeeDirectoryCache, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { compareInvoiceToPlan, invoiceDatesProblem, MEDICAL_INSURANCE_INVOICE_KINDS, type InvoiceComparison, type MedicalInsuranceInvoiceKind } from "./compare";
import {
  parseRateCard,
  withPlanRates,
  type MedicalInsuranceCategory,
  type MedicalInsuranceMemberType,
  type MedicalInsuranceRateCard,
} from "./cost";
import {
  additionCategory,
  buildMedicalInsuranceActions,
  buildMedicalInsuranceMovements,
  buildPolicyYearCost,
  isActiveEmploymentStatus,
  planFamilyMove,
  type EmployeeFacts,
  type ExceptionFacts,
  type KeptException,
  type MedicalInsuranceAction,
  type MemberFacts,
  type PolicyYearCost,
} from "./eligibility";
import {
  assertMedicalInsuranceFileAllowed,
  buildMedicalInsuranceFilePath,
  downloadMedicalInsuranceFile,
  removeMedicalInsuranceFile,
  uploadMedicalInsuranceFile,
} from "./file-storage";
import { LIBANO_DELETIONS_SHEET_ROWS } from "./libano-movement-sheet";
import { buildCostLetter, CostLetterError, type CostLetter } from "./cost-letter";
import { cleanCostLetterCc, COST_LETTER_EMAIL_BATCH, sendCostLetterEmails, type CostLetterEmailOutcome } from "./cost-letter-email";
import { buildMonthlySplit, payrollChargesForWindow, type PayrollMedicalInsuranceCharge } from "./monthly-split";
import { libanoLineGaps, type LibanoMemberFileKind, type LibanoMemberLine } from "./workbooks";
import { describeMasterSyncChange, planEmployeeMasterSync, type MasterSyncDifference, type MasterSyncEmployee, type MasterSyncUpdate } from "./master-sync";
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
class MedicalInsuranceInputError extends Error {}

const POLICY_COLUMNS = "id, insurer, policy_number, proposal_code, starts_on, ends_on, rate_card";
const MEMBER_COLUMNS =
  "id, hr_id, certificate_number, staff_number, member_type, principal_member_id, full_name, category, coverage_starts_on, coverage_ends_on, end_reason, birth_date, national_id, gender, phone, notes";
const DOCUMENT_COLUMNS =
  "id, kind, title, file_name, size_bytes, email_from, email_to, email_sent_on, body, note, uploaded_by_hr_id, uploaded_at";
const INVOICE_COLUMNS =
  "id, invoice_number, kind, issued_on, covers_from, covers_to, total_due, file_name, note, recorded_at, compared_at, comparison";

type PolicyDbRow = {
  id: string;
  insurer: string;
  policy_number: string | null;
  proposal_code: string | null;
  starts_on: string;
  ends_on: string;
  rate_card: unknown;
};

type MemberDbRow = {
  id: string;
  hr_id: string | null;
  certificate_number: string | null;
  staff_number: string | null;
  member_type: MedicalInsuranceMemberType;
  principal_member_id: string | null;
  full_name: string;
  category: MedicalInsuranceCategory;
  coverage_starts_on: string;
  coverage_ends_on: string | null;
  end_reason: string | null;
  birth_date: string | null;
  national_id: string | null;
  gender: string | null;
  phone: string | null;
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

type InvoiceDbRow = {
  id: string;
  invoice_number: string;
  kind: MedicalInsuranceInvoiceKind;
  issued_on: string | null;
  covers_from: string | null;
  covers_to: string | null;
  total_due: number | string;
  file_name: string | null;
  note: string | null;
  recorded_at: string;
  compared_at: string;
  comparison: InvoiceComparison;
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
  return error instanceof MedicalInsuranceInputError;
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function toPolicyRecord(row: PolicyDbRow): PolicyRecord {
  return {
    endsOn: row.ends_on,
    id: row.id,
    insurer: row.insurer,
    policyNumber: row.policy_number,
    proposalCode: row.proposal_code,
    rateCard: parseRateCard(row.rate_card),
    startsOn: row.starts_on,
  };
}

function policyView(policy: PolicyRecord): MedicalInsurancePolicyView {
  return {
    endsOn: policy.endsOn,
    id: policy.id,
    insurer: policy.insurer,
    policyNumber: policy.policyNumber,
    proposalCode: policy.proposalCode,
    startsOn: policy.startsOn,
  };
}

/** The policy in force on a day, or the most recent one when none is. Null when none has been set up. */
async function loadPolicy(asOf: string): Promise<PolicyRecord | null> {
  const { data, error } = await getSupabaseAdmin().from("medical_insurance_policies").select(POLICY_COLUMNS).order("starts_on", { ascending: false });
  fail(error);
  const rows = (data ?? []) as PolicyDbRow[];
  const row = rows.find((candidate) => candidate.starts_on <= asOf && candidate.ends_on >= asOf) ?? rows[0];
  return row ? toPolicyRecord(row) : null;
}

async function requirePolicy(asOf: string): Promise<PolicyRecord> {
  const policy = await loadPolicy(asOf);
  if (!policy) throw new MedicalInsuranceInputError("No medical insurance policy has been set up yet.");
  return policy;
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

/** The plan decided for each joiner not on the register yet, by HR id. */
async function loadCategoryChoices(policyId: string): Promise<Map<string, MedicalInsuranceCategory>> {
  const { data, error } = await getSupabaseAdmin().from("medical_insurance_category_choices").select("hr_id, category").eq("policy_id", policyId);
  fail(error);
  return new Map(((data ?? []) as Array<{ hr_id: string; category: MedicalInsuranceCategory }>).map((row) => [row.hr_id, row.category]));
}

/** "Active" is the record's own status: the sole Super Admin is on the policy and is hidden from the directory's active list. */
function toEmployeeFacts(row: EmployeeDirectoryRow): EmployeeFacts {
  return {
    active: isActiveEmploymentStatus(row.employmentStatus),
    employmentStatus: row.employmentStatus,
    exitDay: employeeExitDay(row),
    hireDate: row.hireDate ? row.hireDate.slice(0, 10) : null,
    hrId: row.hrId,
    jobTitle: row.jobTitle,
    lineName: row.lineName,
    areaName: row.areaName,
    name: row.displayName || row.fullName,
  };
}

const dayOnly = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** The birth date that prices a member: their own, else, for an employee, their employee record's. */
function memberBirthDate(row: MemberDbRow, employees: ReadonlyMap<string, EmployeeDirectoryRow>): string | null {
  const own = dayOnly(row.birth_date);
  if (own) return own;
  return row.member_type === "employee" && row.hr_id ? dayOnly(employees.get(row.hr_id)?.birthDate) : null;
}

function toMemberFacts(row: MemberDbRow, employees: ReadonlyMap<string, EmployeeDirectoryRow>): MemberFacts {
  return {
    birthDate: memberBirthDate(row, employees),
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

type State = {
  asOf: string;
  policy: PolicyRecord;
  memberRows: MemberDbRow[];
  members: MemberFacts[];
  employeeRows: Map<string, EmployeeDirectoryRow>;
  employees: EmployeeFacts[];
  actions: MedicalInsuranceAction[];
  exceptions: KeptException[];
};

/** Everything the rule needs, read once: the register, the Employee Master, the exceptions and the decided plans. */
async function loadState(policy: PolicyRecord, asOf: string): Promise<State> {
  const [memberRows, exceptions, directory, categoryChoices] = await Promise.all([
    loadMembers(policy.id),
    loadExceptions(policy.id),
    getEmployeeDirectoryRows({ includeInactive: true }),
    loadCategoryChoices(policy.id),
  ]);
  const employeeRows = new Map(directory.map((row) => [row.hrId, row]));
  const employees = directory.map(toEmployeeFacts);
  const members = memberRows.map((row) => toMemberFacts(row, employeeRows));
  const built = buildMedicalInsuranceActions({
    ageLimits: policy.rateCard.ageLimits,
    asOf,
    employees,
    exceptions,
    members,
    policy: { endsOn: policy.endsOn, startsOn: policy.startsOn },
  });
  const actions = built.actions.map((action) =>
    action.kind === "add" && action.hrId ? { ...action, decidedCategory: categoryChoices.get(action.hrId) ?? null } : action,
  );
  return { actions, asOf, employeeRows, employees, exceptions: built.exceptions, memberRows, members, policy };
}

function yearCost(state: State): PolicyYearCost {
  return buildPolicyYearCost({
    actions: state.actions,
    birthDates: new Map(state.employees.map((employee) => [employee.hrId, dayOnly(state.employeeRows.get(employee.hrId)?.birthDate)])),
    members: state.members,
    policy: { endsOn: state.policy.endsOn, startsOn: state.policy.startsOn },
    rateCard: state.policy.rateCard,
  });
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

  const state = await loadState(policy, asOf);
  const names = new Map(state.employees.map((employee) => [employee.hrId, employee.name]));
  const jobTitles = new Map(state.employees.map((employee) => [employee.hrId, employee.jobTitle]));
  const memberNames = new Map(state.memberRows.map((row) => [row.id, row.full_name]));
  const documents = await loadDocuments(policy.id, ["communication_tool", "form"], names);

  // An employee's own record places them; family and people with no record carry none.
  const recordOf = (row: MemberDbRow) => {
    const record = row.hr_id && row.member_type === "employee" ? state.employeeRows.get(row.hr_id) : undefined;
    return { areaName: record?.areaName ?? null, hireDate: record?.hireDate ? record.hireDate.slice(0, 10) : null, lineName: record?.lineName ?? null };
  };
  const memberView: MedicalInsuranceMemberRow[] = state.memberRows.map((row) => ({
    birthDate: memberBirthDate(row, state.employeeRows),
    category: row.category,
    certificateNumber: row.certificate_number,
    coverageEnd: row.coverage_ends_on,
    coverageStart: row.coverage_starts_on,
    endReason: row.end_reason,
    hrId: row.hr_id,
    id: row.id,
    jobTitle: row.hr_id && row.member_type === "employee" ? jobTitles.get(row.hr_id) ?? null : null,
    ...recordOf(row),
    memberType: row.member_type,
    name: row.full_name,
    notes: row.notes,
    open: !row.coverage_ends_on || row.coverage_ends_on >= asOf,
    principalMemberId: row.principal_member_id,
    principalName: row.principal_member_id ? memberNames.get(row.principal_member_id) ?? null : null,
    staffNumber: row.staff_number,
  }));

  const open = memberView.filter((row) => row.open);
  const count = (kind: MedicalInsuranceAction["kind"], timing: MedicalInsuranceAction["timing"]) =>
    state.actions.filter((action) => action.kind === kind && action.timing === timing).length;

  return {
    actions: state.actions,
    asOf,
    counts: {
      addNow: count("add", "now"),
      addSoon: count("add", "soon"),
      covered: open.length,
      coveredEmployees: open.filter((row) => row.memberType === "employee").length,
      coveredFamily: open.filter((row) => row.memberType !== "employee").length,
      exceptions: state.exceptions.length,
      removeNow: count("remove", "now"),
      removeSoon: count("remove", "soon"),
      review: count("review", "now"),
    },
    documents,
    employees: state.employees
      .filter((employee) => employee.active)
      .map((employee) => ({ hrId: employee.hrId, jobTitle: employee.jobTitle, name: employee.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    exceptions: state.exceptions,
    members: memberView,
    movements: buildMedicalInsuranceMovements(state.members, policy.startsOn),
    policy: policyView(policy),
  };
}

function toInvoiceRow(row: InvoiceDbRow): MedicalInsuranceInvoiceRow {
  return {
    comparedAt: row.compared_at,
    comparison: row.comparison,
    coversFrom: row.covers_from,
    coversTo: row.covers_to,
    fileName: row.file_name,
    id: row.id,
    invoiceNumber: row.invoice_number,
    issuedOn: row.issued_on,
    kind: row.kind,
    note: row.note,
    recordedAt: row.recorded_at,
    totalDue: Number(row.total_due),
  };
}

/**
 * What payroll takes from each employee for the payroll month `from`..`to` (owner, 2026-11-24: "in december
 * implement everyone med ins deductions from medical insurance module"). The policy is the one whose term
 * touches the month and started last; no such policy means nobody is covered and nothing is charged. A read
 * failure throws: payroll must never read a failed read as nobody owing anything. Server-only, for the payroll
 * population (automated-payroll/recommend.ts); it carries amounts, so it is never sent to an HR seat.
 */
export async function getPayrollMedicalInsuranceCharges(window: { from: string; to: string }): Promise<PayrollMedicalInsuranceCharge[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_policies")
    .select(POLICY_COLUMNS)
    .lte("starts_on", window.to)
    .gte("ends_on", window.from)
    .order("starts_on", { ascending: false })
    .limit(1);
  fail(error);
  const row = ((data ?? []) as PolicyDbRow[])[0];
  if (!row) return [];
  const policy = toPolicyRecord(row);
  const [memberRows, directory] = await Promise.all([loadMembers(policy.id), getEmployeeDirectoryRows({ includeInactive: true })]);
  const employeeRows = new Map(directory.map((employee) => [employee.hrId, employee]));
  return payrollChargesForWindow({
    from: window.from,
    members: memberRows.map((member) => toMemberFacts(member, employeeRows)),
    rateCard: policy.rateCard,
    to: window.to,
  });
}

/** The year's cost, the rate card, the bills and the papers that carry amounts. Callers assert medical_insurance_invoices first. */
export async function getMedicalInsuranceMoney(): Promise<MedicalInsuranceMoneyView | null> {
  const asOf = todayInCairo();
  const policy = await loadPolicy(asOf);
  if (!policy) return null;

  const state = await loadState(policy, asOf);
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_invoices")
    .select(INVOICE_COLUMNS)
    .eq("policy_id", policy.id)
    .order("recorded_at", { ascending: false });
  fail(error);

  const names = new Map(state.employees.map((employee) => [employee.hrId, employee.name]));
  return {
    documents: await loadDocuments(policy.id, ["policy", "email"], names),
    invoices: ((data ?? []) as InvoiceDbRow[]).map(toInvoiceRow),
    monthlySplit: buildMonthlySplit({ asOf, members: state.members, rateCard: policy.rateCard }),
    rateCard: policy.rateCard,
    year: yearCost(state),
  };
}

/**
 * One employee's Medical Cover Statement (owner, 2026-11-21), from the same monthly split the Cost tab shows,
 * so the paper and the tab can never disagree. `memberId` is the employee's own row on the register. Callers
 * assert medical_insurance_invoices first: it carries amounts.
 */
export async function getMedicalInsuranceCostLetter(memberId: string): Promise<CostLetter> {
  const id = memberId.trim();
  if (!id) throw new MedicalInsuranceInputError("Choose an employee first.");
  const asOf = todayInCairo();
  const policy = await requirePolicy(asOf);
  const state = await loadState(policy, asOf);
  const split = buildMonthlySplit({ asOf, members: state.members, rateCard: policy.rateCard });
  const row = split.rows.find((candidate) => candidate.employee?.memberId === id);
  if (!row) throw new MedicalInsuranceInputError("That employee is not covered on the policy today, so there is no monthly cost to show.");
  try {
    return buildCostLetter(row, { endsOn: policy.endsOn, insurer: policy.insurer, policyNumber: policy.policyNumber, startsOn: policy.startsOn });
  } catch (error) {
    if (error instanceof CostLetterError) throw new MedicalInsuranceInputError(error.message);
    throw error;
  }
}

/**
 * Emails each chosen employee their own Medical Cover Statement — the statement itself as the body of the
 * house letter, no attachment (owner, 2026-11-21) — to their work email on the Employee Master, one email
 * each. Answers what happened to every person; a person who could not be sent to is named with the reason.
 */
export async function sendMedicalInsuranceCostLetters(access: AccessContext, body: unknown): Promise<CostLetterEmailOutcome[]> {
  const input = (body ?? {}) as { members?: unknown; cc?: unknown; ccManager?: unknown };
  const raw = input.members;
  const memberIds = Array.isArray(raw) ? [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))] : [];
  if (memberIds.length === 0) throw new MedicalInsuranceInputError("Choose at least one employee.");
  if (memberIds.length > COST_LETTER_EMAIL_BATCH) throw new MedicalInsuranceInputError(`Send at most ${COST_LETTER_EMAIL_BATCH} statements at a time.`);
  let cc: string[];
  try {
    cc = cleanCostLetterCc(input.cc);
  } catch (error) {
    if (error instanceof CostLetterError) throw new MedicalInsuranceInputError(error.message);
    throw error;
  }
  const ccManager = input.ccManager === true;

  const [{ emailNotificationsEnabled }, { sendPhoenixEmail }, { systemEmail }, { satoEmailFrom }, { writeAuditLog }] = await Promise.all([
    import("@/lib/notifications/email"),
    import("@/lib/email/send-phoenix-email"),
    import("@/config/system-settings"),
    import("@/lib/sato-email/service"),
    import("@/lib/admin/audit"),
  ]);
  if (!emailNotificationsEnabled()) throw new MedicalInsuranceInputError("Email sending is switched off in Phoenix, so nothing was sent.");

  const asOf = todayInCairo();
  const policy = await requirePolicy(asOf);
  const state = await loadState(policy, asOf);
  const split = buildMonthlySplit({ asOf, members: state.members, rateCard: policy.rateCard });
  const preparedOn = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());

  const outcomes = await sendCostLetterEmails({
    cc,
    ccManager,
    from: satoEmailFrom(systemEmail.satoComposerFromEmail),
    memberIds,
    minute: Math.floor(Date.now() / 60_000),
    policy: { endsOn: policy.endsOn, insurer: policy.insurer, policyNumber: policy.policyNumber, startsOn: policy.startsOn },
    preparedOn,
    replyTo: systemEmail.satoComposerReplyToEmail,
    rows: split.rows,
    send: sendPhoenixEmail,
    managers: new Map([...state.employeeRows].map(([hrId, row]) => [hrId, row.managerHrId])),
    workEmails: new Map([...state.employeeRows].map(([hrId, row]) => [hrId, row.workEmail])),
  });

  for (const outcome of outcomes.filter((candidate) => candidate.status === "sent")) {
    // The email has already gone, so a missed audit row is logged by writeAuditLog, never thrown back as "not sent".
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: outcome.memberId,
      entityType: "medical_insurance_export",
      summary: `Emailed the Medical Cover Statement to ${outcome.name} at ${outcome.email}${outcome.cc.length > 0 ? `, copying ${outcome.cc.join(", ")}` : ""}`,
    });
  }
  return outcomes;
}

// ── Cleaning what a person typed ───────────────────────────────────────────────────────────────

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
  throw new MedicalInsuranceInputError("Choose plan A, B or C.");
}

function cleanGender(value: unknown): "M" | "F" | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("m")) return "M";
  if (text.startsWith("f")) return "F";
  return null;
}

function cleanMoney(value: unknown, label: string): number {
  const text = String(value ?? "").replace(/,/g, "").trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number)) throw new MedicalInsuranceInputError(`${label} is not an amount.`);
  return Math.round(number * 100) / 100;
}

// ── Members ─────────────────────────────────────────────────────────────────────────────────

export type AddMemberInput = {
  hrId?: unknown;
  memberType?: unknown;
  principalMemberId?: unknown;
  fullName?: unknown;
  category?: unknown;
  coverageStart?: unknown;
  certificateNumber?: unknown;
  staffNumber?: unknown;
  birthDate?: unknown;
  nationalId?: unknown;
  gender?: unknown;
  phone?: unknown;
  notes?: unknown;
};

export async function addMedicalInsuranceMember(access: AccessContext, input: AddMemberInput) {
  const policy = await requirePolicy(todayInCairo());
  const memberType: MedicalInsuranceMemberType = input.memberType === "spouse" || input.memberType === "child" ? input.memberType : "employee";
  const typedStart = cleanDay(input.coverageStart, "The start of cover");
  let coverageStart = typedStart ?? policy.startsOn;
  if (coverageStart < policy.startsOn) throw new MedicalInsuranceInputError("Cover cannot start before the policy does.");
  if (coverageStart > policy.endsOn) throw new MedicalInsuranceInputError("Cover cannot start after the policy ends.");

  const supabase = getSupabaseAdmin();
  let hrId = cleanText(input.hrId);
  let fullName = cleanText(input.fullName);
  let principalMemberId: string | null = null;
  let category = input.category;
  let birthDate = cleanDay(input.birthDate, "The date of birth");
  let nationalId = cleanText(input.nationalId);
  let gender = cleanGender(input.gender);
  let phone = cleanText(input.phone);
  let staffNumber = cleanText(input.staffNumber);

  if (memberType === "employee") {
    if (hrId) {
      const employee = (await getEmployeeDirectoryRows({ includeInactive: true })).find((row) => row.hrId === hrId);
      if (!employee) throw new MedicalInsuranceInputError("That employee is not in the Employee Master.");
      fullName = fullName ?? employee.fullName;
      birthDate = birthDate ?? dayOnly(employee.birthDate);
      nationalId = nationalId ?? cleanText(employee.nationalId);
      gender = gender ?? cleanGender(employee.gender);
      phone = phone ?? cleanText(employee.mobileNumber);
      staffNumber = staffNumber ?? hrId;
    }
  } else {
    principalMemberId = cleanText(input.principalMemberId);
    if (!principalMemberId) throw new MedicalInsuranceInputError("Choose the employee this family member sits under.");
    const { data, error } = await supabase
      .from("medical_insurance_members")
      .select("id, hr_id, category, member_type, coverage_starts_on, coverage_ends_on")
      .eq("id", principalMemberId)
      .eq("policy_id", policy.id)
      .maybeSingle();
    fail(error);
    const principal = data as {
      hr_id: string | null;
      category: MedicalInsuranceCategory;
      member_type: string;
      coverage_starts_on: string;
      coverage_ends_on: string | null;
    } | null;
    if (!principal || principal.member_type !== "employee") throw new MedicalInsuranceInputError("Choose the employee this family member sits under.");
    // Only under an open employee row, as planFamilyMove asks: a family member never sits under an ended certificate.
    if (principal.coverage_ends_on) throw new MedicalInsuranceInputError("That employee's cover has ended. Choose an employee who is on cover.");
    // Nobody sits under a certificate before it begins: with no start typed, the family member starts with the employee.
    if (!typedStart && principal.coverage_starts_on > coverageStart) coverageStart = principal.coverage_starts_on;
    if (coverageStart < principal.coverage_starts_on) {
      throw new MedicalInsuranceInputError(`Cover cannot start before the employee's own cover, on ${principal.coverage_starts_on}.`);
    }
    hrId = principal.hr_id;
    category = category ?? principal.category;
  }
  if (!fullName) throw new MedicalInsuranceInputError("Enter the person's name.");
  if (!birthDate) throw new MedicalInsuranceInputError("Enter the date of birth: the premium is priced on age.");

  const { data, error } = await supabase
    .from("medical_insurance_members")
    .insert({
      birth_date: birthDate,
      category: cleanCategory(category),
      certificate_number: cleanText(input.certificateNumber),
      coverage_starts_on: coverageStart,
      created_by_hr_id: hrIdForStorage(access.hrId),
      full_name: fullName,
      gender,
      hr_id: hrId,
      member_type: memberType,
      national_id: nationalId,
      notes: cleanText(input.notes),
      phone,
      policy_id: policy.id,
      principal_member_id: principalMemberId,
      staff_number: staffNumber,
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .select("id")
    .single();
  if (error?.code === "23505") throw new MedicalInsuranceInputError(`${fullName} is already on the policy.`);
  fail(error);

  // Adding someone IS the answer to an Exclude: a live keep_out left beside the new open, priced row would list a
  // covered person "Excluded" on the Exceptions tab. Revoked only once the row is in, so a refused add keeps it.
  if (memberType === "employee" && hrId) {
    await revokeLiveKeepOuts(access, policy.id, hrId, `${fullName} was added to the register`);
  }

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
  staffNumber?: unknown;
  birthDate?: unknown;
  coverageStart?: unknown;
  coverageEnd?: unknown;
  endReason?: unknown;
  notes?: unknown;
  keepOut?: unknown;
  principalMemberId?: unknown;
  relation?: unknown;
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
    // The family is ended on the same day below, so one whose cover starts AFTER it would be refused by the
    // table (cover cannot end before it starts) once the employee row was already ended. Asked first, so
    // nothing is written: the employee, the family, the keep-out and the audit row land together or not at all.
    if (member.member_type === "employee") {
      const { data: later, error: laterError } = await supabase
        .from("medical_insurance_members")
        .select("full_name, coverage_starts_on")
        .eq("principal_member_id", memberId)
        .is("coverage_ends_on", null)
        .gt("coverage_starts_on", endsOn)
        .limit(1);
      fail(laterError);
      const first = ((later ?? []) as Array<{ full_name: string; coverage_starts_on: string }>)[0];
      if (first) {
        throw new MedicalInsuranceInputError(
          `${first.full_name}'s cover under ${member.full_name} starts on ${first.coverage_starts_on}, after this end day. End or correct ${first.full_name}'s cover first.`,
        );
      }
    }

    // The keep-off is written AFTER the end, and the table allows one live exception per person, so a live one is
    // asked for before the first write: a live keep-on is refused with nothing written (removing it is an explicit,
    // reasoned, audited act on the Exceptions tab), and a live keep-off already says what this would write.
    let alreadyKeptOut = false;
    if (input.keepOut === true && member.member_type === "employee" && member.hr_id) {
      const { data: live, error: liveError } = await supabase
        .from("medical_insurance_exceptions")
        .select("decision")
        .eq("policy_id", policy.id)
        .eq("hr_id", member.hr_id)
        .is("revoked_at", null)
        .limit(1);
      fail(liveError);
      const liveDecision = ((live ?? []) as Array<{ decision: string }>)[0]?.decision;
      if (liveDecision === "keep_in") {
        throw new MedicalInsuranceInputError(`${member.full_name} has a keep-on exception. Remove it on the Exceptions tab first, then exclude them.`);
      }
      alreadyKeptOut = liveDecision === "keep_out";
    }

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
    if (input.keepOut === true && !alreadyKeptOut && member.member_type === "employee" && member.hr_id) {
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

  if (input.action === "move_under") {
    const { data: rows, error: rowsError } = await supabase
      .from("medical_insurance_members")
      .select("id, hr_id, member_type, principal_member_id, full_name, coverage_ends_on")
      .eq("policy_id", policy.id);
    fail(rowsError);
    const facts = ((rows ?? []) as Array<Pick<MemberDbRow, "coverage_ends_on" | "full_name" | "hr_id" | "id" | "member_type" | "principal_member_id">>).map((row) => ({
      coverageEnd: row.coverage_ends_on,
      hrId: row.hr_id,
      id: row.id,
      memberType: row.member_type,
      name: row.full_name,
      principalMemberId: row.principal_member_id,
    }));
    const self = facts.find((row) => row.id === memberId);
    const principalId = cleanText(input.principalMemberId);
    const principal = principalId ? facts.find((row) => row.id === principalId) : undefined;
    if (!self) throw new MedicalInsuranceInputError("That person is no longer on the register.");
    const plan = planFamilyMove(self, principal, input.relation, facts);
    if (typeof plan === "string") throw new MedicalInsuranceInputError(plan);

    fail(
      (
        await supabase
          .from("medical_insurance_members")
          .update({ ...stamp, hr_id: plan.hrId, member_type: plan.memberType, principal_member_id: plan.principalMemberId })
          .eq("id", memberId)
      ).error,
    );
    if (plan.dependantIds.length > 0) {
      fail(
        (
          await supabase
            .from("medical_insurance_members")
            .update({ ...stamp, hr_id: plan.hrId, principal_member_id: plan.principalMemberId })
            .in("id", plan.dependantIds)
        ).error,
      );
    }
    const movedWith = facts.filter((row) => plan.dependantIds.includes(row.id)).map((row) => row.name);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: memberId,
      entityType: "medical_insurance_member",
      newValues: { hr_id: plan.hrId, member_type: plan.memberType, moved_with: movedWith, principal_member_id: plan.principalMemberId },
      oldValues: { hr_id: member.hr_id, member_type: member.member_type, principal_member_id: member.principal_member_id },
      summary: `Put ${member.full_name} under ${principal?.name ?? "an employee"} as their ${plan.memberType}${movedWith.length > 0 ? `, with ${movedWith.join(", ")}` : ""}`,
    });
    return;
  }

  if (input.action === "reinstate") {
    // One open row per employee: asked BEFORE the family is reopened, so a refusal cannot leave open family
    // under an ended employee.
    if (member.member_type === "employee" && member.hr_id) {
      const { data: openRows, error: openError } = await supabase
        .from("medical_insurance_members")
        .select("id")
        .eq("policy_id", policy.id)
        .eq("member_type", "employee")
        .eq("hr_id", member.hr_id)
        .is("coverage_ends_on", null)
        .neq("id", memberId)
        .limit(1);
      fail(openError);
      if ((openRows ?? []).length > 0) {
        throw new MedicalInsuranceInputError(`${member.full_name} is already on the register again on another row, so this one cannot be put back.`);
      }
    }
    // A spouse or child only sits under an OPEN employee row (the add path and planFamilyMove hold the same line): put
    // back under a still-ended employee they would be covered with nobody to be covered under.
    if (member.member_type !== "employee" && member.principal_member_id) {
      const { data: owner, error: ownerError } = await supabase
        .from("medical_insurance_members")
        .select("full_name, coverage_ends_on")
        .eq("id", member.principal_member_id)
        .maybeSingle();
      fail(ownerError);
      const ended = owner as { full_name: string; coverage_ends_on: string | null } | null;
      if (ended?.coverage_ends_on) {
        throw new MedicalInsuranceInputError(
          `${ended.full_name}'s cover has ended, so ${member.full_name} cannot be put back under it. Put ${ended.full_name} back first (their family comes back with them), or add ${member.full_name} again under an employee who is on cover.`,
        );
      }
    }
    // Putting someone back undoes an Exclude that ended them: a live keep_out would list them "Excluded" while
    // their row is open and priced. Revoked FIRST, and each revoke audited like the Exceptions tab's own: if a
    // later write fails the employee is still ended (so "Put back" is still offered and a retry finds them), whereas
    // revoking last stranded an open, priced row beside a live keep_out with no button left to repair it.
    if (member.member_type === "employee" && member.hr_id) {
      await revokeLiveKeepOuts(access, policy.id, member.hr_id, `${member.full_name} was put back`);
    }
    // The family the end took with them comes back with them: exactly the rows that end wrote — the same day
    // and its "<employee>: <reason>" — so a family member ended on their own keeps their end. Put back first,
    // so a failure leaves the employee ended and a retry still finds them.
    let familyBack = 0;
    if (member.member_type === "employee" && member.coverage_ends_on && member.end_reason) {
      const { data: back, error: backError } = await supabase
        .from("medical_insurance_members")
        .update({ ...stamp, coverage_ends_on: null, end_reason: null })
        .eq("principal_member_id", memberId)
        .eq("coverage_ends_on", member.coverage_ends_on)
        .eq("end_reason", `${member.full_name}: ${member.end_reason}`)
        .select("id");
      fail(backError);
      familyBack = (back ?? []).length;
    }
    fail((await supabase.from("medical_insurance_members").update({ ...stamp, coverage_ends_on: null, end_reason: null }).eq("id", memberId)).error);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: memberId,
      entityType: "medical_insurance_member",
      summary: `Put ${member.full_name} back on the medical insurance register${familyBack > 0 ? `, with ${familyBack} family member${familyBack === 1 ? "" : "s"}` : ""}`,
    });
    return;
  }

  const coverageStart = cleanDay(input.coverageStart, "The start of cover") ?? member.coverage_starts_on;
  if (coverageStart < policy.startsOn) throw new MedicalInsuranceInputError("Cover cannot start before the policy does.");
  if (coverageStart > policy.endsOn) throw new MedicalInsuranceInputError("Cover cannot start after the policy ends.");
  // Nobody sits under a certificate before it begins — the add path refuses it, so editing a start must too. Asked only
  // when the start CHANGES, so a row that is already early can still have its notes or birth date corrected.
  if (member.member_type !== "employee" && member.principal_member_id && coverageStart !== member.coverage_starts_on) {
    const { data: owner, error: ownerError } = await supabase.from("medical_insurance_members").select("coverage_starts_on").eq("id", member.principal_member_id).maybeSingle();
    fail(ownerError);
    const ownerStart = (owner as { coverage_starts_on: string } | null)?.coverage_starts_on;
    if (ownerStart && coverageStart < ownerStart) {
      throw new MedicalInsuranceInputError(`Cover cannot start before the employee's own cover, on ${ownerStart}.`);
    }
  }
  const patch = {
    ...stamp,
    birth_date: input.birthDate === undefined ? member.birth_date : cleanDay(input.birthDate, "The date of birth"),
    category: input.category === undefined ? member.category : cleanCategory(input.category),
    certificate_number: input.certificateNumber === undefined ? member.certificate_number : cleanText(input.certificateNumber),
    coverage_starts_on: coverageStart,
    notes: input.notes === undefined ? member.notes : cleanText(input.notes),
    staff_number: input.staffNumber === undefined ? member.staff_number : cleanText(input.staffNumber),
  };
  fail((await supabase.from("medical_insurance_members").update(patch).eq("id", memberId)).error);
  // An employee whose cover now starts later takes their family with them: nobody sits under a certificate before it begins.
  // Open family only: a family member whose cover already ended keeps the period it had (and could not take a start
  // after its own end, which the table refuses).
  if (member.member_type === "employee" && coverageStart > member.coverage_starts_on) {
    fail(
      (
        await supabase
          .from("medical_insurance_members")
          .update({ ...stamp, coverage_starts_on: coverageStart })
          .eq("principal_member_id", memberId)
          .is("coverage_ends_on", null)
          .lt("coverage_starts_on", coverageStart)
      ).error,
    );
  }
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: memberId,
    entityType: "medical_insurance_member",
    newValues: {
      birth_date: patch.birth_date,
      category: patch.category,
      certificate_number: patch.certificate_number,
      coverage_starts_on: patch.coverage_starts_on,
      staff_number: patch.staff_number,
    },
    oldValues: {
      birth_date: member.birth_date,
      category: member.category,
      certificate_number: member.certificate_number,
      coverage_starts_on: member.coverage_starts_on,
      staff_number: member.staff_number,
    },
    summary: `Changed ${member.full_name}'s medical insurance record`,
  });
}

/**
 * Revokes every live keep_out for this person on the policy and writes the same audit row the Exceptions tab's own
 * Remove writes, one per exception. An exception is revoked and stays, never deleted. Returns how many were revoked.
 */
async function revokeLiveKeepOuts(access: AccessContext, policyId: string, hrId: string, why: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_exceptions")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: hrIdForStorage(access.hrId) })
    .eq("policy_id", policyId)
    .eq("hr_id", hrId)
    .eq("decision", "keep_out")
    .is("revoked_at", null)
    .select("id, reason");
  fail(error);
  const revoked = (data ?? []) as Array<{ id: string; reason: string }>;
  for (const row of revoked) {
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: row.id,
      entityType: "medical_insurance_exception",
      summary: `Removed a medical insurance exception (${why}). It read: ${row.reason}`,
    });
  }
  return revoked.length;
}

// ── Exceptions ──────────────────────────────────────────────────────────────────────────────

export async function addMedicalInsuranceException(access: AccessContext, input: { hrId?: unknown; decision?: unknown; reason?: unknown }) {
  const policy = await requirePolicy(todayInCairo());
  const hrId = cleanText(input.hrId);
  const reason = cleanText(input.reason);
  if (!hrId) throw new MedicalInsuranceInputError("Choose the employee.");
  if (input.decision !== "keep_in" && input.decision !== "keep_out") throw new MedicalInsuranceInputError("Choose keep on or keep off the policy.");
  if (!reason) throw new MedicalInsuranceInputError("Enter the reason for this exception.");

  // The rule engine honours keep_out only for someone not on the register. Someone already on it is excluded by
  // ending their cover with "keep off", which writes this exception after the end — so refuse the bare exception.
  if (input.decision === "keep_out") {
    const { data: onRegister, error: onRegisterError } = await getSupabaseAdmin()
      .from("medical_insurance_members")
      .select("id")
      .eq("policy_id", policy.id)
      .eq("member_type", "employee")
      .eq("hr_id", hrId)
      .is("coverage_ends_on", null)
      .limit(1);
    fail(onRegisterError);
    if ((onRegister ?? []).length > 0) {
      throw new MedicalInsuranceInputError("This person is already on the register. End their cover and choose keep off to exclude them.");
    }
  }

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

/**
 * Decides the plan a joiner goes on the policy with, before they are on the register. A new decision
 * replaces the last one, and the audit log keeps every one.
 */
export async function decideMedicalInsuranceCategory(access: AccessContext, input: { hrId?: unknown; category?: unknown }) {
  const policy = await requirePolicy(todayInCairo());
  const hrId = cleanText(input.hrId);
  if (!hrId) throw new MedicalInsuranceInputError("Choose the employee.");
  const category = cleanCategory(input.category);
  const state = await loadState(policy, todayInCairo());
  const action = state.actions.find((candidate) => candidate.kind === "add" && candidate.hrId === hrId);
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
    summary: `Medical insurance plan ${category} decided for ${action.name}.`,
  });
}

// ── The policy: its number and its rate card ─────────────────────────────────────────────────

/**
 * Sets the policy number once Libano-Suisse issues it, or replaces one plan's band rates (a re-quote, or a
 * band the offer left blank). Every change is audited with the old and new figures.
 */
export async function updateMedicalInsurancePolicy(access: AccessContext, body: Record<string, unknown>) {
  const policy = await requirePolicy(todayInCairo());
  const supabase = getSupabaseAdmin();
  const stamp = { updated_at: new Date().toISOString() };

  if (body.policyNumber !== undefined) {
    const policyNumber = cleanText(body.policyNumber);
    const { error } = await supabase.from("medical_insurance_policies").update({ ...stamp, policy_number: policyNumber }).eq("id", policy.id);
    if (error?.code === "23505") throw new MedicalInsuranceInputError("Another policy already carries that number.");
    fail(error);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: policy.id,
      entityType: "medical_insurance_policy",
      newValues: { policy_number: policyNumber },
      oldValues: { policy_number: policy.policyNumber },
      summary: policyNumber ? `Set the medical insurance policy number to ${policyNumber}` : "Cleared the medical insurance policy number",
    });
    return;
  }

  const category = cleanCategory(body.category);
  if (!Array.isArray(body.rates)) throw new MedicalInsuranceInputError("Enter a rate or a blank for every age band.");
  const rates = body.rates.map((value, index) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const rate = cleanMoney(value, `The rate for band ${index + 1}`);
    if (rate <= 0) throw new MedicalInsuranceInputError("A rate must be more than zero. Leave a band blank when it is not quoted.");
    return rate;
  });
  let card: MedicalInsuranceRateCard;
  try {
    card = withPlanRates(policy.rateCard, category, rates);
  } catch (error) {
    throw new MedicalInsuranceInputError(medicalInsuranceErrorMessage(error));
  }
  fail((await supabase.from("medical_insurance_policies").update({ ...stamp, rate_card: card }).eq("id", policy.id)).error);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: policy.id,
    entityType: "medical_insurance_policy",
    newValues: { category, rates },
    oldValues: { category, rates: policy.rateCard.plans[category].rates },
    summary: `Changed the plan ${category} rates on the medical insurance rate card`,
  });
}

// ── Invoices, recorded by hand ───────────────────────────────────────────────────────────────

export type InvoiceInput = {
  invoiceNumber?: unknown;
  kind?: unknown;
  issuedOn?: unknown;
  coversFrom?: unknown;
  coversTo?: unknown;
  totalDue?: unknown;
  note?: unknown;
  file?: { bytes: Buffer; fileName: string } | null;
};

/**
 * Records a bill or credit note as the person read it off Libano-Suisse's paper, compares it with the plan
 * and files it, with the paper itself when attached. A credit note's total is stored negative whichever
 * sign was typed. It pays nothing and writes nothing to payroll.
 */
export async function recordMedicalInsuranceInvoice(access: AccessContext, input: InvoiceInput): Promise<MedicalInsuranceInvoiceRow> {
  const asOf = todayInCairo();
  const policy = await requirePolicy(asOf);
  const invoiceNumber = cleanText(input.invoiceNumber);
  if (!invoiceNumber) throw new MedicalInsuranceInputError("Enter the bill's number.");
  const kind = input.kind as MedicalInsuranceInvoiceKind;
  if (!MEDICAL_INSURANCE_INVOICE_KINDS.includes(kind)) throw new MedicalInsuranceInputError("Choose what the bill is for.");
  const coversFrom = cleanDay(input.coversFrom, "The first day the bill covers");
  const coversTo = cleanDay(input.coversTo, "The last day the bill covers");
  const datesProblem = invoiceDatesProblem(kind, coversFrom, coversTo);
  if (datesProblem) throw new MedicalInsuranceInputError(datesProblem);
  const typed = cleanMoney(input.totalDue, "The total");
  const totalDue = kind === "deletions" ? -Math.abs(typed) : typed;

  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase.from("medical_insurance_invoices").select("id").eq("invoice_number", invoiceNumber).maybeSingle();
  fail(existingError);
  if (existing) throw new MedicalInsuranceInputError(`Bill ${invoiceNumber} has already been recorded.`);

  const comparison = compareInvoiceToPlan({ coversFrom, coversTo, kind, totalDue }, yearCost(await loadState(policy, asOf)));

  let storage: { content_type: string; file_name: string; size_bytes: number; storage_path: string } | null = null;
  if (input.file) {
    const contentType = assertMedicalInsuranceFileAllowed({ fileName: input.file.fileName, size: input.file.bytes.length });
    const path = buildMedicalInsuranceFilePath({ fileName: input.file.fileName, folder: `invoices/${invoiceNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}` });
    await uploadMedicalInsuranceFile({ bytes: input.file.bytes, contentType, path });
    storage = { content_type: contentType, file_name: input.file.fileName, size_bytes: input.file.bytes.length, storage_path: path };
  }

  const { data, error } = await supabase
    .from("medical_insurance_invoices")
    .insert({
      ...storage,
      comparison,
      covers_from: coversFrom,
      covers_to: coversTo,
      invoice_number: invoiceNumber,
      issued_on: cleanDay(input.issuedOn, "The bill's date"),
      kind,
      note: cleanText(input.note),
      policy_id: policy.id,
      recorded_by_hr_id: hrIdForStorage(access.hrId),
      total_due: totalDue,
    })
    .select(INVOICE_COLUMNS)
    .single();
  if (error) {
    if (storage) await removeMedicalInsuranceFile(storage.storage_path);
    if (error.code === "23505") throw new MedicalInsuranceInputError(`Bill ${invoiceNumber} has already been recorded.`);
    throw new Error(error.message);
  }
  const row = data as InvoiceDbRow;
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: row.id,
    entityType: "medical_insurance_invoice",
    summary:
      comparison.difference === null
        ? `Recorded medical insurance bill ${invoiceNumber}, EGP ${totalDue.toFixed(2)}`
        : `Recorded medical insurance bill ${invoiceNumber}, EGP ${totalDue.toFixed(2)}, EGP ${comparison.difference.toFixed(2)} against the plan`,
  });
  return toInvoiceRow(row);
}

/** Replaces the stored comparison with one against the register as it stands now. */
export async function recompareMedicalInsuranceInvoice(access: AccessContext, invoiceId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("medical_insurance_invoices")
    .select("id, policy_id, invoice_number, kind, covers_from, covers_to, total_due")
    .eq("id", invoiceId)
    .maybeSingle();
  fail(error);
  const row = data as {
    id: string;
    policy_id: string;
    invoice_number: string;
    kind: MedicalInsuranceInvoiceKind;
    covers_from: string | null;
    covers_to: string | null;
    total_due: number | string;
  } | null;
  if (!row) throw new MedicalInsuranceInputError("That bill is no longer on file.");

  const asOf = todayInCairo();
  const policy = await requirePolicy(asOf);
  if (policy.id !== row.policy_id) throw new MedicalInsuranceInputError("That bill belongs to an earlier policy and cannot be compared with this one.");
  const comparison = compareInvoiceToPlan(
    { coversFrom: row.covers_from, coversTo: row.covers_to, kind: row.kind, totalDue: Number(row.total_due) },
    yearCost(await loadState(policy, asOf)),
  );
  fail((await supabase.from("medical_insurance_invoices").update({ compared_at: new Date().toISOString(), comparison }).eq("id", invoiceId)).error);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: invoiceId,
    entityType: "medical_insurance_invoice",
    summary:
      comparison.difference === null
        ? `Compared medical insurance bill ${row.invoice_number} again`
        : `Compared medical insurance bill ${row.invoice_number} against today's plan: EGP ${comparison.difference.toFixed(2)} difference`,
  });
}

/** The paper attached to a bill, for the file route. Null when the bill or its paper is not on file. */
export async function getMedicalInsuranceInvoiceFile(invoiceId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("medical_insurance_invoices")
    .select("id, file_name, content_type, storage_path")
    .eq("id", invoiceId)
    .maybeSingle();
  fail(error);
  const row = data as { file_name: string | null; content_type: string | null; storage_path: string | null } | null;
  if (!row?.storage_path) return null;
  return { bytes: await downloadMedicalInsuranceFile(row.storage_path), contentType: row.content_type ?? "application/octet-stream", fileName: row.file_name ?? "bill" };
}

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

// ── Libano-Suisse's member file, for the people ticked on the page ───────────────────────────

const FILE_MOST_ROWS = 500;

function memberLine(row: MemberDbRow, rows: ReadonlyMap<string, MemberDbRow>, employees: ReadonlyMap<string, EmployeeDirectoryRow>, day: string): LibanoMemberLine {
  const principal = row.principal_member_id ? rows.get(row.principal_member_id) : undefined;
  return {
    adherentNumber: row.certificate_number,
    birthDate: memberBirthDate(row, employees),
    category: row.category,
    day,
    fullName: row.full_name,
    gender: row.gender,
    memberType: row.member_type,
    nationalId: row.national_id,
    phone: row.phone,
    principalNumber: principal ? principal.certificate_number : row.certificate_number,
    staffNumber: row.staff_number,
  };
}

/**
 * Turns the people ticked on the page into lines of Libano-Suisse's member file. Each one must still be on
 * today's list, as an addition or a deletion as asked, so a stale page cannot put somebody on the file
 * that the rule no longer names. A deleted employee's spouse and children are listed with them, one row
 * each, as the insurer's sheet has a row per person. `everyone` is every person covered today.
 */
export async function prepareLibanoMemberFile(
  body: Record<string, unknown>,
): Promise<{ policyId: string; policy: { startsOn: string; endsOn: string }; kind: LibanoMemberFileKind; rows: LibanoMemberLine[] }> {
  const kind = body.kind;
  if (kind !== "additions" && kind !== "deletions" && kind !== "everyone") throw new MedicalInsuranceInputError("Choose additions, deletions or everyone covered.");
  const asOf = todayInCairo();
  const policy = await requirePolicy(asOf);
  const state = await loadState(policy, asOf);
  const rowsById = new Map(state.memberRows.map((row) => [row.id, row]));
  const isOpen = (row: MemberDbRow) => !row.coverage_ends_on || row.coverage_ends_on >= asOf;

  if (kind === "everyone") {
    const open = state.memberRows.filter(isOpen);
    // Each employee, then the family under them.
    const ordered = open
      .filter((row) => row.member_type === "employee")
      .flatMap((row) => [row, ...open.filter((other) => other.principal_member_id === row.id)]);
    const orphans = open.filter((row) => row.member_type !== "employee" && !ordered.includes(row));
    return {
      kind,
      policy: { endsOn: policy.endsOn, startsOn: policy.startsOn },
      policyId: policy.id,
      rows: [...ordered, ...orphans].map((row) => memberLine(row, rowsById, state.employeeRows, row.coverage_starts_on)),
    };
  }

  const keys = Array.isArray(body.keys) ? [...new Set(body.keys.filter((key): key is string => typeof key === "string" && key.length > 0))] : [];
  if (keys.length === 0) throw new MedicalInsuranceInputError(kind === "additions" ? "Tick at least one person to add." : "Tick at least one person to delete.");
  if (keys.length > FILE_MOST_ROWS) throw new MedicalInsuranceInputError(`One file holds at most ${FILE_MOST_ROWS} people.`);
  const chosenCategories = body.categories && typeof body.categories === "object" ? (body.categories as Record<string, unknown>) : {};

  const wanted = kind === "additions" ? "add" : "remove";
  const byKey = new Map(state.actions.filter((action) => action.kind === wanted).map((action) => [action.key, action]));
  const chosen = keys.map((key) => byKey.get(key));
  if (chosen.some((action) => !action)) {
    throw new MedicalInsuranceInputError(
      `Someone you ticked is no longer on the list to ${kind === "additions" ? "add" : "remove"}. Refresh the page and tick again.`,
    );
  }
  const actions = chosen as MedicalInsuranceAction[];

  if (kind === "deletions") {
    const listed = new Set<string>();
    const rows: LibanoMemberLine[] = [];
    for (const action of actions) {
      const member = action.memberId ? rowsById.get(action.memberId) : undefined;
      if (!member) continue;
      const family = member.member_type === "employee" ? state.memberRows.filter((other) => other.principal_member_id === member.id && isOpen(other)) : [];
      for (const row of [member, ...family]) {
        if (listed.has(row.id)) continue;
        listed.add(row.id);
        rows.push(memberLine(row, rowsById, state.employeeRows, action.effectiveOn));
      }
    }
    if (rows.length > LIBANO_DELETIONS_SHEET_ROWS) {
      throw new MedicalInsuranceInputError(`Libano-Suisse's deletions sheet holds ${LIBANO_DELETIONS_SHEET_ROWS} people, families included; this file has ${rows.length}. Tick fewer and export twice.`);
    }
    return { kind, policy: { endsOn: policy.endsOn, startsOn: policy.startsOn }, policyId: policy.id, rows };
  }

  const rows = actions.map((action): LibanoMemberLine => {
    const category = additionCategory(action, chosenCategories[action.key]);
    if (!category) throw new MedicalInsuranceInputError(`Choose a plan for ${action.name}.`);
    const employee = action.hrId ? state.employeeRows.get(action.hrId) : undefined;
    return {
      adherentNumber: null,
      birthDate: dayOnly(employee?.birthDate),
      category,
      day: action.effectiveOn,
      fullName: employee?.fullName ?? action.name,
      gender: employee?.gender ?? null,
      memberType: "employee",
      nationalId: employee?.nationalId ?? null,
      phone: employee?.mobileNumber ?? null,
      principalNumber: null,
      staffNumber: action.hrId,
    };
  });
  // The insurer's sheet marks the date of birth and the sex mandatory, and the Employee Master can hold neither. The
  // register path refuses a missing date of birth too (addMedicalInsuranceMember), so everyone is named at once and HR
  // fixes the records or unticks them, instead of a file with blank cells going out.
  const gaps = rows.flatMap((line) => {
    const lacking = libanoLineGaps(line);
    return lacking.length > 0 ? [`${line.fullName} (${lacking.join(" and ")})`] : [];
  });
  if (gaps.length > 0) {
    throw new MedicalInsuranceInputError(`Libano-Suisse's file needs a date of birth and sex for everyone. Fill them on the Employee Master, or untick: ${gaps.join(", ")}.`);
  }
  return { kind, policy: { endsOn: policy.endsOn, startsOn: policy.startsOn }, policyId: policy.id, rows };
}

// ── The register feeds the Employee Master what it is missing (owner, 27 Nov 2026) ──────────────────────

export type EmployeeMasterSyncResult = {
  policyNumber: string;
  updated: MasterSyncUpdate[];
  failed: Array<{ hrId: string; name: string; error: string }>;
  differences: MasterSyncDifference[];
};

const MASTER_SYNC_EMPLOYEE_COLUMNS = "hr_id, full_name, nickname, national_id, birth_date, gender, mobile_number, medical_insurance_number";

type MasterSyncEmployeeDbRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  national_id: string | null;
  birth_date: string | null;
  gender: string | null;
  mobile_number: string | null;
  medical_insurance_number: string | null;
};

/**
 * Writes the register's card number, and the identity the Employee Master is blank on, into `employees`
 * (the rule: ./master-sync.ts). Each person is one guarded update — every field is written only while it
 * still holds the value the plan read, so something typed in between is never overwritten — named to the
 * history log as the person running it, and audited. One person's refusal is reported and the rest go on.
 */
export async function syncEmployeeMasterFromMedicalInsurance(access: AccessContext): Promise<EmployeeMasterSyncResult> {
  await assertPermission(access, "medical_insurance", "read");
  await assertPermission(access, "employees", "update");
  const policy = await requirePolicy(todayInCairo());
  const admin = getSupabaseAdmin();

  const memberRows = await loadMembers(policy.id);
  const hrIds = [...new Set(memberRows.filter((row) => row.member_type === "employee" && row.hr_id).map((row) => row.hr_id!.trim()))];
  const employeeRows: MasterSyncEmployeeDbRow[] = [];
  for (let start = 0; start < hrIds.length; start += 200) {
    const { data, error } = await admin.from("employees").select(MASTER_SYNC_EMPLOYEE_COLUMNS).in("hr_id", hrIds.slice(start, start + 200));
    fail(error);
    employeeRows.push(...((data ?? []) as MasterSyncEmployeeDbRow[]));
  }

  const employees: MasterSyncEmployee[] = employeeRows.map((row) => ({
    birthDate: row.birth_date,
    gender: row.gender,
    hrId: row.hr_id,
    medicalInsuranceNumber: row.medical_insurance_number,
    mobileNumber: row.mobile_number,
    name: (row.nickname ?? "").trim() || (row.full_name ?? "").trim() || row.hr_id,
    nationalId: row.national_id,
  }));
  const plan = planEmployeeMasterSync({
    employees,
    members: memberRows.map((row) => ({
      birthDate: row.birth_date,
      certificateNumber: row.certificate_number,
      coverageEnd: row.coverage_ends_on,
      coverageStart: row.coverage_starts_on,
      gender: row.gender,
      hrId: row.hr_id,
      memberType: row.member_type,
      nationalId: row.national_id,
      phone: row.phone,
    })),
  });

  const updated: MasterSyncUpdate[] = [];
  const failed: EmployeeMasterSyncResult["failed"] = [];
  for (const update of plan.updates) {
    const patch: Record<string, string> = { updated_at: new Date().toISOString() };
    for (const change of update.changes) patch[change.field] = change.to;
    let query = admin.from("employees").update(patch).eq("hr_id", update.hrId);
    for (const change of update.changes) query = change.from === null ? query.is(change.field, null) : query.eq(change.field, change.from);
    // A script has no request to carry the actor, so the person is named here (src/lib/supabase/request-actor.ts).
    if (access.loginId) query = query.setHeader("x-phoenix-actor-login-id", access.loginId);
    if (access.hrId) query = query.setHeader("x-phoenix-actor-hr-id", hrIdForStorage(access.hrId));
    const { data, error } = await query.select("hr_id");
    if (error) {
      failed.push({ error: error.message, hrId: update.hrId, name: update.name });
      continue;
    }
    if ((data ?? []).length !== 1) {
      failed.push({ error: "the Employee Master changed since it was read; nothing written for this person", hrId: update.hrId, name: update.name });
      continue;
    }
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: update.hrId,
      entityType: "employee",
      summary: `Filled ${update.name}'s Employee Master from the medical insurance register (policy ${policy.policyNumber}): ${update.changes.map(describeMasterSyncChange).join("; ")}`,
    });
    updated.push(update);
  }
  if (updated.length > 0) invalidateEmployeeDirectoryCache();
  return { differences: plan.differences, failed, policyNumber: policy.policyNumber, updated };
}
