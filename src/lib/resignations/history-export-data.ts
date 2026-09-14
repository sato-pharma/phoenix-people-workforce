// Loads everything the full-history workbook needs, for ONE viewer.
//
// The record list is getResignationsDashboardData(access) — the same read, and so the same scope
// rule, as the Resignations page. What this adds is only the detail the page does not carry: the
// subject's area/region/department/manager and Arabic name, their exit reason and category, a name
// for every workflow actor, and the linked replacement vacancy's status.
//
// FAILS CLOSED. Every read here throws on error rather than degrading to blanks: an export that
// silently drops the manager or the vacancy column reads as "there was nothing", which is worse
// than an export that refuses and says why.

import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { ResignationHistoryLookups, ResignationHistoryPerson } from "./history-export";
import { getResignationsDashboardData } from "./service";

type EmployeeExitRow = {
  employment_status: string | null;
  exit_category: string | null;
  exit_reason: string | null;
  full_name: string | null;
  hr_id: string;
  name_ar: string | null;
  nickname: string | null;
};

function keyOf(value: string | null | undefined) {
  return normalizeHrId(value) ?? "";
}

/** Stored hr_ids are exact-case while actors arrive lower-cased, so ask for both spellings. */
function hrIdQueryValues(values: ReadonlyArray<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .flatMap((value) => [value, value.toUpperCase()]),
    ),
  );
}

async function loadEmployeeExitRows(hrIds: string[]) {
  if (hrIds.length === 0) return [] as EmployeeExitRow[];
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, nickname, name_ar, employment_status, exit_category, exit_reason")
    .in("hr_id", hrIds);
  if (error) throw error;
  return (data ?? []) as EmployeeExitRow[];
}

async function loadVacancyStatusByRecordId(recordIds: string[]) {
  const statusByRecordId = new Map<string, string>();
  if (recordIds.length === 0) return statusByRecordId;

  const supabase = getSupabaseAdmin();
  const { data: links, error: linksError } = await supabase
    .from("employee_resignations")
    .select("id, vacancy_id")
    .in("id", recordIds);
  if (linksError) throw linksError;

  const vacancyIdByRecordId = new Map(
    ((links ?? []) as Array<{ id: string; vacancy_id: number | null }>)
      .filter((link) => link.vacancy_id !== null)
      .map((link) => [link.id, Number(link.vacancy_id)]),
  );
  const vacancyIds = Array.from(new Set(vacancyIdByRecordId.values()));
  if (vacancyIds.length === 0) return statusByRecordId;

  const { data: vacancies, error: vacanciesError } = await supabase
    .from("position_vacancies")
    .select("id, status")
    .in("id", vacancyIds);
  if (vacanciesError) throw vacanciesError;

  const statusByVacancyId = new Map(
    ((vacancies ?? []) as Array<{ id: number; status: string | null }>).map((vacancy) => [
      Number(vacancy.id),
      // The SQL guard reads a NULL status as open; so does this.
      String(vacancy.status ?? "open").toLowerCase(),
    ]),
  );
  for (const [recordId, vacancyId] of vacancyIdByRecordId) {
    const status = statusByVacancyId.get(vacancyId);
    if (status) statusByRecordId.set(recordId, status);
  }
  return statusByRecordId;
}

export async function loadResignationHistoryExport(access: AccessContext) {
  const dashboard = await getResignationsDashboardData(access);
  const { payrollCandidates, records } = dashboard;

  const hrIds = hrIdQueryValues([
    ...records.flatMap((record) => [
      record.employeeHrId,
      record.createdBy,
      record.reviewedBy,
      record.approvedBy,
      record.rejectedBy,
      record.completedBy,
      record.cancelledBy,
    ]),
    ...payrollCandidates.flatMap((candidate) => [candidate.hrId, candidate.createdBy]),
  ]);
  const workflowRecordIds = records.map((record) => record.id).filter((id) => !id.startsWith("legacy:"));

  const [directoryRows, employeeRows, vacancyStatusByRecordId] = await Promise.all([
    // includeInactive: nearly every subject here has left, and the default directory omits them.
    getEmployeeDirectoryRows({ includeInactive: true }),
    loadEmployeeExitRows(hrIds),
    loadVacancyStatusByRecordId(workflowRecordIds),
  ]);

  const directoryByKey = new Map(directoryRows.map((row) => [keyOf(row.hrId), row]));
  const employeeByKey = new Map(employeeRows.map((row) => [keyOf(row.hr_id), row]));

  const lookups: ResignationHistoryLookups = {
    actorName: (id) => {
      const row = employeeByKey.get(keyOf(id));
      return row ? resolveEmployeeDisplayName(row.full_name ?? row.hr_id, row.nickname) : null;
    },
    person: (hrId): ResignationHistoryPerson | null => {
      const key = keyOf(hrId);
      const directory = directoryByKey.get(key);
      const employee = employeeByKey.get(key);
      if (!directory && !employee) return null;
      return {
        areaName: directory?.areaName ?? null,
        departmentName: directory?.departmentName ?? null,
        employmentStatus: employee?.employment_status ?? directory?.employmentStatus ?? null,
        exitCategory: employee?.exit_category ?? null,
        exitReason: employee?.exit_reason ?? null,
        managerName: directory?.managerName ?? null,
        nameAr: employee?.name_ar ?? directory?.nameAr ?? null,
        regionName: directory?.regionName ?? null,
      };
    },
    vacancyStatus: (recordId) => vacancyStatusByRecordId.get(recordId) ?? null,
  };

  return { lookups, payrollCandidates, records };
}
