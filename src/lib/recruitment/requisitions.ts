// Recruitment / ATS — requisitions service.
//
// A requisition wraps an existing open `position_vacancies` seat and adds the
// fields the organogram does not store (grade, salary band, headcount type,
// recruitment owner/deadline/priority). It snapshots the vacancy's org-unit ids
// so offer creation can pass them straight through to the offer engine.

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getVacancyReport, type VacancyReportRow } from "@/lib/reports/vacancies";
import {
  assertRecruitmentTransition,
  mapRequisition,
  newRequisitionCode,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  type RequisitionDbRow,
} from "@/lib/recruitment/db";
import {
  assertCanDeleteRecruitment,
  assertCanSeeRequisition,
  filterRequisitionsForAccess,
  resolveHiringManagerScopeHrIds,
} from "@/lib/recruitment/access";
import {
  headcountTypes,
  requisitionPriorities,
  type CreateRequisitionInput,
  type HeadcountType,
  type RecruitmentActionKey,
  type Requisition,
  type RequisitionPriority,
} from "@/lib/recruitment/types";

const activeRequisitionStatuses = ["req_draft", "req_open", "req_published", "req_on_hold"];

async function employeeNameByHrId(): Promise<Map<string, string>> {
  const rows = await getEmployeeDirectoryRows();
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) map.set(key, row.displayName);
  }
  return map;
}

function enrich(requisition: Requisition, names: Map<string, string>): Requisition {
  return {
    ...requisition,
    hiringManagerName: requisition.hiringManagerHrId
      ? names.get(canonicalHrIdKey(requisition.hiringManagerHrId) ?? "") ?? null
      : null,
    recruitmentOwnerName: requisition.recruitmentOwnerHrId
      ? names.get(canonicalHrIdKey(requisition.recruitmentOwnerHrId) ?? "") ?? null
      : null,
  };
}

export async function listRequisitions(access: AccessContext): Promise<Requisition[]> {
  const supabase = recruitmentDb();
  const [{ data, error }, names, scopeHrIds] = await Promise.all([
    supabase.from("ats_requisitions").select("*").order("created_at", { ascending: false }),
    employeeNameByHrId(),
    resolveHiringManagerScopeHrIds(access),
  ]);
  if (error) throw error;

  const requisitions = ((data ?? []) as RequisitionDbRow[]).map((row) => enrich(mapRequisition(row), names));
  return filterRequisitionsForAccess(access, requisitions, scopeHrIds);
}

export async function getRequisition(access: AccessContext, id: string): Promise<Requisition | null> {
  const supabase = recruitmentDb();
  const [{ data, error }, names, scopeHrIds] = await Promise.all([
    supabase.from("ats_requisitions").select("*").eq("id", id).maybeSingle(),
    employeeNameByHrId(),
    resolveHiringManagerScopeHrIds(access),
  ]);
  if (error) throw error;
  if (!data) return null;

  const requisition = enrich(mapRequisition(data as RequisitionDbRow), names);
  assertCanSeeRequisition(access, requisition, scopeHrIds);
  return requisition;
}

// Open vacancies that do not yet have an active requisition — the create-form list.
export async function listOpenVacanciesForRequisition(): Promise<VacancyReportRow[]> {
  const [report, supabase] = [await getVacancyReport(), recruitmentDb()];
  const open = report.rows.filter((row) => row.status === "open");
  const { data, error } = await supabase
    .from("ats_requisitions")
    .select("vacancy_id,status")
    .in("status", activeRequisitionStatuses);
  if (error) throw error;
  const wrapped = new Set(
    ((data ?? []) as RequisitionDbRow[])
      .map((row) => numberOrNull(row.vacancy_id))
      .filter((value): value is number => value !== null),
  );
  return open.filter((vacancy) => !wrapped.has(vacancy.id));
}

function normalizeHeadcountType(value: unknown, fallback: HeadcountType): HeadcountType {
  const text = textOrNull(value);
  return text && (headcountTypes as readonly string[]).includes(text) ? (text as HeadcountType) : fallback;
}

function normalizePriority(value: unknown): RequisitionPriority {
  const text = textOrNull(value);
  return text && (requisitionPriorities as readonly string[]).includes(text)
    ? (text as RequisitionPriority)
    : "normal";
}

export async function createRequisition(
  input: CreateRequisitionInput,
  access: AccessContext,
): Promise<Requisition> {
  const supabase = recruitmentDb();
  const vacancyId = numberOrNull(input.vacancyId);

  let vacancy: VacancyReportRow | null = null;
  if (vacancyId) {
    const report = await getVacancyReport();
    vacancy = report.rows.find((row) => row.id === vacancyId) ?? null;
    if (!vacancy) throw new Error("Selected vacancy was not found.");
    if (vacancy.status !== "open") throw new Error("Selected vacancy is not open.");

    const { data: existing, error: existingError } = await supabase
      .from("ats_requisitions")
      .select("id")
      .eq("vacancy_id", vacancyId)
      .in("status", activeRequisitionStatuses)
      .limit(1);
    if (existingError) throw existingError;
    if ((existing ?? []).length > 0) {
      throw new Error("This vacancy already has an active requisition.");
    }
  }

  const headcountType = normalizeHeadcountType(
    input.headcountType,
    vacancy?.replacementForHrId ? "replacement" : "expansion",
  );

  const payload = {
    requisition_code: newRequisitionCode(),
    vacancy_id: vacancyId,
    department_id: vacancy?.departmentId ?? null,
    line_id: vacancy?.lineId ?? null,
    area_id: vacancy?.areaId ?? null,
    team_id: vacancy?.teamId ?? null,
    position_id: vacancy?.positionId ?? null,
    job_title: textOrNull(input.jobTitle) ?? vacancy?.jobTitle ?? vacancy?.positionTitle ?? "",
    hiring_manager_hr_id: textOrNull(input.hiringManagerHrId) ?? vacancy?.managerHrId ?? null,
    recruitment_owner_hr_id: textOrNull(input.recruitmentOwnerHrId) ?? access.hrId ?? null,
    grade: textOrNull(input.grade),
    salary_band_min: numberOrNull(input.salaryBandMin),
    salary_band_max: numberOrNull(input.salaryBandMax),
    headcount_type: headcountType,
    replacement_for_hr_id: vacancy?.replacementForHrId ?? null,
    headcount: numberOrNull(input.headcount) ?? 1,
    priority: normalizePriority(input.priority),
    recruitment_deadline: textOrNull(input.recruitmentDeadline),
    status: "req_draft",
    notes: textOrNull(input.notes),
    created_by: access.hrId ?? access.loginId ?? null,
  };

  const { data, error } = await supabase
    .from("ats_requisitions")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;

  const names = await employeeNameByHrId();
  return enrich(mapRequisition(data as RequisitionDbRow), names);
}

const requisitionNextStatus: Record<string, string> = {
  req_open: "req_open",
  req_publish: "req_published",
  req_hold: "req_on_hold",
  req_resume: "req_open",
  req_fill: "req_filled",
  req_close: "req_closed",
  req_cancel: "req_cancelled",
};

export async function runRequisitionWorkflow(
  id: string,
  actionKey: RecruitmentActionKey,
  access: AccessContext,
  input: { reason?: string | null } = {},
): Promise<Requisition> {
  const requisition = await getRequisition(access, id);
  if (!requisition) throw new Error("Requisition not found.");

  const nextStatus = requisitionNextStatus[actionKey];
  if (!nextStatus) throw new Error("Unsupported requisition action.");

  await assertRecruitmentTransition({
    actionKey,
    role: access.role,
    status: requisition.status,
    reason: input.reason,
  });

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_requisitions")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  const names = await employeeNameByHrId();
  return enrich(mapRequisition(data as RequisitionDbRow), names);
}

// Used by the convert flow to close the requisition when a hire completes.
export async function markRequisitionFilled(id: string, access: AccessContext): Promise<void> {
  const requisition = await getRequisition(access, id);
  if (!requisition) return;
  if (requisition.status === "req_filled") return;
  if (!["req_open", "req_published", "req_on_hold"].includes(requisition.status)) return;
  await runRequisitionWorkflow(id, "req_fill", access);
}

// Hard-delete a requisition (admin cleanup; any status). Database cascades remove
// its applications, events, interviews, onboarding items, postings, and files.
export async function deleteRequisition(access: AccessContext, id: string): Promise<void> {
  assertCanDeleteRecruitment(access);
  const requisition = await getRequisition(access, id); // throws if out of scope
  if (!requisition) throw new Error("Requisition not found.");
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_requisitions").delete().eq("id", id);
  if (error) throw error;
}
