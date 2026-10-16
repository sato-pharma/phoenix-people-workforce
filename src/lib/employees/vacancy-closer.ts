import { cache } from "react";

import { getRequiredEnv } from "@/lib/env";
import { pickDepartmentSafeVacancy } from "@/lib/employees/vacancy-matching";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";

// Open-vacancy lookups and the hire-time vacancy closer used by
// src/lib/employees/employee-directory.ts. Kept in its own module (talks to
// `position_vacancies`/`employees` directly via the Supabase REST API, not the
// recruitment/offers domain — it never depended on those tables) so
// employee-directory.ts (reachable from client-bundled sales code via
// src/lib/sales/access-scope.ts) never pulls in anything Node-only.

export type VacancyLookupRow = {
  areaId: number | null;
  areaName: string | null;
  departmentId: number | null;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
  replacementForHrId: string | null;
  vacancyCode: string;
  vacancyId: number;
};

const databaseQueryTimeoutMs = 15000;
const databaseQueryRetryMs = 30000;
const databaseQueryMaxAttempts = 2;

function vacancyErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compact(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function normalizeManagerName(value: string | null | undefined) {
  return compact(value)?.toLowerCase().replace(/\s+/g, " ") ?? null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function supabaseRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let lastError: unknown;

  for (let attempt = 0; attempt < databaseQueryMaxAttempts; attempt++) {
    const timeoutMs = attempt === 0 ? databaseQueryTimeoutMs : databaseQueryRetryMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const isTransientServerError = [502, 503, 504].includes(response.status);
        if (isTransientServerError && attempt < databaseQueryMaxAttempts - 1) {
          lastError = new Error(
            typeof payload?.message === "string"
              ? payload.message
              : `Supabase request failed with ${response.status}.`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `Supabase request failed with ${response.status}.`,
        );
      }

      return payload as T;
    } catch (error) {
      lastError = error;
      const message = vacancyErrorMessage(error).toLowerCase();
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || message.includes("timed out"));
      const shouldRetry = isTimeout && attempt < databaseQueryMaxAttempts - 1;

      if (!shouldRetry) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Supabase request timed out.");
        }
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("Supabase request timed out.");
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Supabase request failed.");
}

async function loadEmployeeFullName(hrId: string | null) {
  if (!hrId) {
    return null;
  }

  const params = new URLSearchParams({
    hr_id: `eq.${hrId}`,
    select: "full_name",
  });
  const rows = await supabaseRest<Array<{ full_name: string | null }>>(
    `employees?${params}`,
  );

  return compact(rows[0]?.full_name);
}

// Memoized per-request (React cache()): getOpenWorkforceVacancies()/getOpenMedicalRepVacancies()
// are reached independently from the same /overview + command-center request paths (via
// getEmployeeDirectory()'s internal vacancy calls), so without this a single page load issued
// this same position_vacancies query multiple times.
/**
 * Whether THIS request's open-vacancy read gave up and returned an empty list.
 *
 * `getOpenVacancies` swallows a timeout or a schema-cache miss as "no vacancies" so the directory
 * still loads, which is the right call for a page that merely lists seats and the wrong one for a
 * page that PRINTS a count: "0 vacant, every seat is filled" over a failed read is the false
 * all-clear. Per request (React `cache`), so a page can ask after the directory has loaded, with no
 * second query. Outside a request it is a fresh object each time and always reads "fine" — no worse
 * than before.
 */
const vacancyReadState = cache(() => ({ failed: false }));

export function openVacancyReadFailed(): boolean {
  return vacancyReadState().failed;
}

const getOpenVacancies = cache(async (): Promise<VacancyLookupRow[]> => {
  try {
    const loadRows = (includeReplacement: boolean) => {
      const vacancyParams = new URLSearchParams({
        select: [
          "id",
          "vacancy_code",
          "area_id",
          "line_id",
          "position_id",
          "manager_hr_id",
          "manager_name",
          "job_title",
          "department_id",
          "region_name",
          ...(includeReplacement ? ["replacement_for_hr_id"] : []),
          "status",
          "lines(name)",
          "areas(name)",
          "positions(title)",
        ].join(","),
        status: "eq.open",
      });

      return supabaseRest<Array<{
      area_id: number | null;
      areas?: { name: string | null } | null;
      department_id: number | null;
      id: number;
      job_title: string;
      line_id: number | null;
      lines?: { name: string | null } | null;
      manager_hr_id: string | null;
      manager_name: string | null;
      position_id: number | null;
      positions?: { title: string | null } | null;
      region_name: string | null;
      replacement_for_hr_id?: string | null;
      vacancy_code: string;
      }>>(`position_vacancies?${vacancyParams}`);
    };

    let vacancies: Awaited<ReturnType<typeof loadRows>>;
    try {
      vacancies = await loadRows(true);
    } catch (error) {
      const message = vacancyErrorMessage(error).toLowerCase();
      if (!message.includes("replacement_for_hr_id") && !message.includes("schema cache")) {
        throw error;
      }
      vacancies = await loadRows(false);
    }

    return vacancies.map((v) => {
      const positionTitle = v.positions?.title ?? v.job_title ?? "";
      return {
        areaId: v.area_id,
        areaName: v.areas?.name ?? "Unknown Area",
        departmentId: v.department_id,
        jobTitle: v.job_title,
        lineId: v.line_id,
        lineName: v.lines?.name ?? "Unknown Line",
        managerHrId: v.manager_hr_id,
        managerName: v.manager_name,
        positionId: v.position_id,
        positionTitle,
        regionName: v.region_name,
        replacementForHrId: v.replacement_for_hr_id ?? null,
        vacancyCode: v.vacancy_code,
        vacancyId: v.id,
      };
    });
  } catch (error) {
    const message = vacancyErrorMessage(error).toLowerCase();
    if (
      message.includes("timed out") ||
      message.includes("relationship") ||
      message.includes("schema cache") ||
      message.includes("could not find")
    ) {
      vacancyReadState().failed = true;
      return [];
    }

    throw error;
  }
});

export async function getOpenWorkforceVacancies(): Promise<VacancyLookupRow[]> {
  return getOpenVacancies();
}

export async function getOpenMedicalRepVacancies(): Promise<VacancyLookupRow[]> {
  const vacancies = await getOpenVacancies();

  return vacancies.filter((vacancy) => {
    const normalizedTitle = `${vacancy.jobTitle ?? ""} ${vacancy.positionTitle ?? ""}`.toLowerCase();
    return (
      normalizedTitle.includes("medical representative") ||
      normalizedTitle.includes("medical rep") ||
      (normalizedTitle.includes("medical") && normalizedTitle.includes("representative"))
    );
  });
}

export async function closeVacancyOnHire(input: {
  area_id?: number | null;
  department_id?: number | null;
  filled_by_hr_id?: string | null;
  line_id?: number | null;
  manager_name?: string | null;
  manager_hr_id?: string | null;
  position_id?: number | null;
  vacancy_id?: number | null;
}) {
  // position_vacancies.manager_hr_id is stored canonical-uppercase; PostgREST `eq.` is a
  // case-sensitive string comparison, so a mixed-case input here would silently miss the row
  // and fall through to the weaker manager-NAME / open-manager-less-vacancy branches below,
  // closing the wrong vacancy with no error (AGENTS.md 2.1, "HR ids are MIXED CASE").
  const canonicalManagerHrId = canonicalHrIdForDisplay(input.manager_hr_id);
  const explicitVacancyId = numberOrNull(input.vacancy_id);
  if (!explicitVacancyId && (
    input.area_id === null || input.area_id === undefined ||
    input.line_id === null || input.line_id === undefined ||
    input.position_id === null || input.position_id === undefined
  )) {
    return null;
  }

  type VacancyCloseMatch = {
    id: number;
    department_id?: number | null;
    manager_hr_id?: string | null;
    manager_name?: string | null;
    replacement_for_hr_id?: string | null;
  };

  const baseMatchParams = (select: string) =>
    new URLSearchParams({
      area_id: `eq.${input.area_id}`,
      line_id: `eq.${input.line_id}`,
      order: "created_at.asc",
      position_id: `eq.${input.position_id}`,
      select,
      status: "eq.open",
    });

  // Department-safe selection is delegated to the pure helper in
  // src/lib/employees/vacancy-matching.ts (see pickDepartmentSafeVacancy below).

  const findMatches = async (params: URLSearchParams) => {
    try {
      return await supabaseRest<VacancyCloseMatch[]>(
        `position_vacancies?${params}`,
      );
    } catch (error) {
      const message = vacancyErrorMessage(error).toLowerCase();
      if (!message.includes("replacement_for_hr_id") && !message.includes("schema cache")) {
        throw error;
      }
      params.set("select", params.get("select")?.replace(",replacement_for_hr_id", "") ?? "id");
      return supabaseRest<VacancyCloseMatch[]>(`position_vacancies?${params}`);
    }
  };

  let matches: VacancyCloseMatch[] = [];
  if (explicitVacancyId) {
    const params = new URLSearchParams({
      id: `eq.${explicitVacancyId}`,
      select: "id,replacement_for_hr_id,department_id",
      status: "eq.open",
    });
    matches = await findMatches(params);
  }

  if (!explicitVacancyId && canonicalManagerHrId) {
    const params = baseMatchParams("id,replacement_for_hr_id,department_id");
    params.set("manager_hr_id", `eq.${canonicalManagerHrId}`);
    matches = matches.length > 0 ? matches : await findMatches(params);
  }

  const resolvedManagerName =
    normalizeManagerName(input.manager_name) ??
    normalizeManagerName(await loadEmployeeFullName(canonicalManagerHrId));

  if (matches.length === 0 && resolvedManagerName && !explicitVacancyId) {
    const params = baseMatchParams("id,replacement_for_hr_id,department_id,manager_hr_id,manager_name");
    params.set("manager_hr_id", "is.null");
    const managerNameMatches = await findMatches(params);
    matches = managerNameMatches.filter(
      (vacancy) => normalizeManagerName(vacancy.manager_name) === resolvedManagerName,
    );
  }

  if (matches.length === 0 && canonicalManagerHrId === null && !explicitVacancyId) {
    const params = baseMatchParams("id,replacement_for_hr_id,department_id,manager_hr_id,manager_name");
    params.set("manager_hr_id", "is.null");
    const unmatchedSeatVacancies = await findMatches(params);
    if (unmatchedSeatVacancies.length === 1 && !compact(unmatchedSeatVacancies[0]?.manager_name)) {
      matches = unmatchedSeatVacancies;
    }
  }

  const vacancy = pickDepartmentSafeVacancy(matches, input.department_id);
  const vacancyId = vacancy?.id;
  if (!vacancyId) {
    return null;
  }

  const filledByHrId = compact(input.filled_by_hr_id);
  const fullPayload = {
    filled_at: filledByHrId ? new Date().toISOString() : null,
    filled_by_hr_id: filledByHrId,
    note: filledByHrId
      ? `Auto-closed after employee creation for ${filledByHrId}.`
      : "Auto-closed after employee creation.",
    // A filled seat is no longer pending replacement; clear the marker so it is
    // never read as both filled and vacant by downstream seat-continuity logic.
    replacement_for_hr_id: null,
    status: "filled",
  };

  try {
    await supabaseRest(`position_vacancies?id=eq.${vacancyId}`, {
      body: JSON.stringify(fullPayload),
      headers: {
        Prefer: "return=representation",
      },
      method: "PATCH",
    });
  } catch (error) {
    const message = vacancyErrorMessage(error).toLowerCase();
    if (
      !message.includes("filled_by_hr_id") &&
      !message.includes("filled_at") &&
      !message.includes("replacement_for_hr_id") &&
      !message.includes("schema cache")
    ) {
      throw error;
    }
    await supabaseRest(
      `position_vacancies?id=eq.${vacancyId}`,
      {
        body: JSON.stringify({
        note: "Auto-closed after employee creation.",
        status: "filled",
        }),
        headers: {
          Prefer: "return=representation",
        },
        method: "PATCH",
      },
    );
  }

  return {
    id: vacancyId,
    replacementForHrId: vacancy.replacement_for_hr_id ?? null,
  };
}
