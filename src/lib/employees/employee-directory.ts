import {
  getSalesScope,
  normalizeHrId as normalizeHrIdForAccess,
  normalizeLineName,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  normalizePayrollPaymentMode,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import { isDevelopment } from "@/lib/env";
import { googleGeocodeAddress } from "@/lib/google-maps/server";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { generateNextHrIdForLine } from "./hr-id-helper";
import { isManagerOptionalHrId, isMissingRequiredManager } from "./hierarchy-governance";

const hrIdPattern = /^[A-Z0-9][A-Z0-9_-]*$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const activeLifecycleStatuses = new Set(["active", "on_leave"]);
const statusOptions = ["active", "inactive", "on_leave", "terminated", "resigned"];
const directoryStatusFilterValues = new Set(["all", ...statusOptions]);

export type EmployeeDirectoryRow = {
  areaId: number | null;
  areaName: string | null;
  birthDate: string | null;
  bankName: string | null;
  bankAccount: string | null;
  baseSalary: number | null;
  basicSalary: number | null;
  contractType: string | null;
  createdAt: string;
  crmId: string | null;
  crmUsername: string | null;
  departmentId: number | null;
  departmentName: string | null;
  education: string | null;
  employmentStatus: string | null;
  extraCostOfLiving: number | null;
  fullName: string;
  gender: string | null;
  fuelAllowance: number | null;
  grossSalary: number | null;
  hasBankAccount: string | null;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  medicalInsurance: number | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  mobileNumber: string | null;
  nameAr: string | null;
  nationalId: string | null;
  netSalary: number | null;
  organogramVisible: boolean;
  payrollEligible: boolean;
  salaryPaymentMode: PayrollPaymentMode;
  positionId: number | null;
  positionTitle: string | null;
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
  residenceGeocodeStatus: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  regionName: string | null;
  socialInsurance: number | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  teamId: number | null;
  teamName: string | null;
  taxes: number | null;
  updatedAt: string;
  workEmail: string | null;
};

import {
  closeVacancyForOffer,
  getOpenMedicalRepVacancies,
  getOpenWorkforceVacancies,
  type VacancyLookupRow,
} from "@/lib/offers/service";

export type EmployeeLookupOption = {
  id?: number;
  label: string;
  value: string;
  areaId?: number | null;
  departmentId?: number | null;
  jobTitle?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  positionId?: number | null;
  positionTitle?: string | null;
  regionName?: string | null;
  teamId?: number | null;
};

export type EmployeeDirectoryData = {
  employees: EmployeeDirectoryRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  lookups: {
    areas: EmployeeLookupOption[];
    departments: EmployeeLookupOption[];
    lines: EmployeeLookupOption[];
    managers: EmployeeLookupOption[];
    positions: EmployeeLookupOption[];
    teams: EmployeeLookupOption[];
    statuses: EmployeeLookupOption[];
    medicalRepVacancies: VacancyLookupRow[];
    workforceVacancies: VacancyLookupRow[];
  };
  summary: {
    activeEmployees: number;
    employeesWithoutManagers: number;
    totalEmployees: number;
    uniqueAreas: number;
    uniqueLines: number;
  };
  diagnostics?: {
    rawRowsMatched: number;
    returnedRows: number;
    page: number;
    pageSize: number;
    filters: {
      status?: string | null;
      lineId?: number;
      areaId?: number;
      departmentId?: number;
      teamId?: number;
      region?: string | null;
      hasBankAccount?: string | null;
      medicalInsuranceStatus?: string | null;
      socialInsuranceStatus?: string | null;
      salaryPaymentMode?: string | null;
    };
    duplicateHrIdCount?: number;
    duplicateHrIds?: string[];
  };
};

export type EmployeeDirectoryFilter = {
  search?: string;
  lineId?: number;
  areaId?: number;
  departmentId?: number;
  teamId?: number;
  positionId?: number;
  status?: string;
  region?: string;
  hasBankAccount?: string;
  medicalInsuranceStatus?: string;
  socialInsuranceStatus?: string;
  salaryPaymentMode?: string;
  page?: number;
  pageSize?: number;
};

export type EmployeeMutationInput = {
  areaId?: number | null;
  crmId?: string | null;
  crmUsername?: string | null;
  departmentId?: number | null;
  education?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  baseSalary?: number | null;
  basicSalary?: number | null;
  birthDate?: string | null;
  contractType?: string | null;
  gender?: string | null;
  extraCostOfLiving?: number | null;
  employmentStatus?: string | null;
  fuelAllowance?: number | null;
  fullName?: string | null;
  grossSalary?: number | null;
  hasBankAccount?: string | null;
  hireDate?: string | null;
  hrId?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  mobileNumber?: string | null;
  nameAr?: string | null;
  nationalId?: string | null;
  netSalary?: number | null;
  medicalInsurance?: number | null;
  medicalInsuranceStatus?: string | null;
  medicalInsuranceNumber?: string | null;
  originalHrId?: string | null;
  positionId?: number | null;
  residenceAddress?: string | null;
  residenceArea?: string | null;
  residenceCity?: string | null;
  regionName?: string | null;
  salaryPaymentMode?: string | null;
  socialInsurance?: number | null;
  socialInsuranceStatus?: string | null;
  socialInsuranceNumber?: string | null;
  taxes?: number | null;
  teamId?: number | null;
  workEmail?: string | null;
};

type EmployeeDbRow = {
  area_id: number | null;
  birth_date?: string | null;
  bank_account?: string | null;
  bank_name?: string | null;
  base_salary?: number | null;
  basic_salary?: number | null;
  contract_type?: string | null;
  created_at: string;
  crm_id: string | null;
  crm_username: string | null;
  department_id: number | null;
  education: string | null;
  employment_status: string | null;
  full_name: string;
  gender?: string | null;
  has_bank_account?: string | null;
  extra_cost_of_living?: number | null;
  fuel_allowance?: number | null;
  gross_salary?: number | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
  mobile_number: string | null;
  name_ar: string | null;
  national_id?: string | null;
  net_salary?: number | null;
  medical_insurance_number?: string | null;
  medical_insurance?: number | null;
  medical_insurance_status?: string | null;
  organogram_visible?: boolean | null;
  payroll_eligible?: boolean | null;
  payment_mode?: string | null;
  position_id: number | null;
  region_name?: string | null;
  residence_address?: string | null;
  residence_area?: string | null;
  residence_city?: string | null;
  social_insurance?: number | null;
  social_insurance_status?: string | null;
  social_insurance_number?: string | null;
  team_id: number | null;
  taxes?: number | null;
  updated_at: string;
  work_email: string | null;
};

type LookupRow = {
  code?: string;
  full_name?: string | null;
  hr_id?: string;
  id: number;
  line_id?: number | null;
  name?: string | null;
  title?: string | null;
};

type EmployeeCompensationDbRow = {
  employee_hr_id: string;
  extra_cost_of_living: number | null;
  fuel_allowance: number | null;
  gross_salary: number | null;
  medical_insurance: number | null;
  net_salary: number | null;
  payment_mode?: string | null;
  social_insurance: number | null;
  taxes: number | null;
};

type EmployeeResidenceDbRow = {
  employee_hr_id: string;
  geocode_status: string | null;
  residence_address: string | null;
  residence_area: string | null;
  residence_city: string | null;
  residence_latitude: number | null;
  residence_longitude: number | null;
};

type JoinedEmployeeDbRow = EmployeeDbRow & {
  areas?: { name: string | null } | null;
  departments?: { name: string | null } | null;
  employee_compensation?: EmployeeCompensationDbRow | EmployeeCompensationDbRow[] | null;
  lines?: { name: string | null } | null;
  positions?: { title: string | null } | null;
  teams?: { name: string | null } | null;
};

const databaseQueryTimeoutMs = 15000;
const databaseQueryRetryMs = 30000;
const DATABASE_QUERY_MAX_ATTEMPTS = 2;
const EMPLOYEE_DIRECTORY_PAGE_SIZE = 1000;

let directoryCache: {
  data: EmployeeDirectoryData;
  timestamp: number;
} | null = null;

const CACHE_TTL = 30000; // 30 seconds

function isClassifiedActiveEmployee(employee: EmployeeDirectoryRow) {
  return classifyEmployeeNode(employee).eligible_for_headcount;
}

export function invalidateEmployeeDirectoryCache() {
  directoryCache = null;
}

function normalizeHrId(value: string | null | undefined) {
  return compact(value)?.toUpperCase() ?? null;
}

function normalizeLifecycleStatus(value: string | null | undefined) {
  return compact(value)?.toLowerCase() ?? "active";
}

function isActiveLifecycleStatus(value: string | null | undefined) {
  return activeLifecycleStatuses.has(normalizeLifecycleStatus(value));
}

function normalizeYesNo(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" ? normalized : null;
}

function normalizeDirectoryStatusFilter(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  if (!normalized) return null;
  return directoryStatusFilterValues.has(normalized) ? normalized : null;
}

function normalizeEnrollmentStatus(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" || normalized === "pending"
    ? normalized
    : null;
}

function isActiveDirectoryEmployee(employee: EmployeeDirectoryRow) {
  return (
    employee.payrollEligible !== false &&
    employee.organogramVisible !== false &&
    isClassifiedActiveEmployee(employee)
  );
}

function activeStatusOptions(employees: EmployeeDirectoryRow[]) {
  const statuses = new Set(
    employees
      .map((employee) => normalizeLifecycleStatus(employee.employmentStatus))
      .filter((status) => activeLifecycleStatuses.has(status)),
  );

  return Array.from(statuses.size ? statuses : activeLifecycleStatuses)
    .sort()
    .map((status) => ({
      label: status.replace(/_/g, " "),
      value: status,
    }));
}

function isManagerialTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes("manager") ||
    normalized.includes("director") ||
    normalized.includes("head") ||
    normalized.includes("lead") ||
    normalized.includes("supervisor") ||
    normalized.includes("chief") ||
    normalized.includes("ceo") ||
    /\b(nsm|rsm|dsm)\b/.test(normalized)
  );
}

function managerLookupOptions(activeEmployees: EmployeeDirectoryRow[]) {
  return activeEmployees
    .filter((employee) =>
      isManagerOptionalHrId(employee.hrId) ||
      isManagerialTitle(`${employee.positionTitle ?? ""} ${employee.jobTitle ?? ""}`),
    )
    .map((employee) => {
      const title = employee.positionTitle ?? employee.jobTitle ?? "Manager";

      return {
        areaId: employee.areaId,
        departmentId: employee.departmentId,
        jobTitle: employee.jobTitle,
        label: `${employee.fullName} - ${title} (${employee.hrId})`,
        lineId: employee.lineId,
        managerHrId: employee.managerHrId,
        positionId: employee.positionId,
        positionTitle: employee.positionTitle,
        regionName: employee.regionName,
        teamId: employee.teamId,
        value: employee.hrId,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

export function employeeDirectoryErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isEmployeeDirectoryEnvMissing(error: unknown) {
  const message = employeeDirectoryErrorMessage(error);

  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

export function isEmployeeDirectorySchemaMissing(error: unknown) {
  const message = employeeDirectoryErrorMessage(error).toLowerCase();

  return (
    message.includes("could not find the table") ||
    (message.includes("column") && message.includes("does not exist")) ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function isMissingRelationMessage(error: unknown) {
  return isEmployeeDirectorySchemaMissing(error);
}

export function isEmployeeDirectoryTimeout(error: unknown) {
  return employeeDirectoryErrorMessage(error).toLowerCase().includes("timed out");
}

function compact(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function findDuplicateHrIds(rows: EmployeeDbRow[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const normalizedHrId = normalizeHrId(row.hr_id);
    if (!normalizedHrId) {
      continue;
    }

    if (seen.has(normalizedHrId)) {
      duplicates.add(normalizedHrId);
      continue;
    }

    seen.add(normalizedHrId);
  }

  return Array.from(duplicates).sort();
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function textInFilter(values: string[]) {
  return `in.(${values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`;
}

function idInFilter(values: number[]) {
  return `in.(${values.join(",")})`;
}

async function supabaseRest<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; count?: number }> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let lastError: unknown;

  for (let attempt = 0; attempt < DATABASE_QUERY_MAX_ATTEMPTS; attempt++) {
    const timeoutMs =
      attempt === 0 ? databaseQueryTimeoutMs : databaseQueryRetryMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Prefer": (init.headers as Record<string, string> | undefined)?.["Prefer"] ?? "return=representation",
        ...(init.headers as Record<string, string> ?? {}),
      };

      const response = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : `Supabase request failed with ${response.status}.`;
        throw new Error(message);
      }

      const contentRange = response.headers.get("Content-Range");
      const count = contentRange ? parseInt(contentRange.split("/")[1], 10) : undefined;

      return { data: payload as T, count };
    } catch (error) {
      lastError = error;
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.toLowerCase().includes("timed out"));
      const shouldRetry = isTimeout && attempt < DATABASE_QUERY_MAX_ATTEMPTS - 1;

      if (!shouldRetry) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Supabase request timed out.");
        }
        throw error;
      }

      if (attempt < DATABASE_QUERY_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("Supabase request timed out.");
  }
  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Supabase request failed.");
}

function uniqueNumberValues(rows: EmployeeDbRow[], key: keyof EmployeeDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is number => typeof value === "number"),
    ),
  );
}

function uniqueTextValues(rows: EmployeeDbRow[], key: keyof EmployeeDbRow) {
  return Array.from(
    new Set(
      rows
        .map((row) => row[key])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
}

async function loadLookup(table: string, ids: number[], label = "name") {
  if (ids.length === 0) {
    return new Map<number, string>();
  }

  const params = new URLSearchParams({
    select: `id,${label}`,
    id: idInFilter(ids),
  });
  const { data: rows } = await supabaseRest<LookupRow[]>(`${table}?${params}`);

  return new Map(
    rows.map((row) => [
      row.id,
      String(label === "title" ? row.title ?? "" : row.name ?? ""),
    ]),
  );
}

async function loadAllOptions(table: string, label = "name") {
  if (table === "departments") {
    const params = new URLSearchParams({
      select: `id,${label},is_active`,
      order: `${label}.asc`,
    });

    try {
      const { data: rows } = await supabaseRest<Array<LookupRow & { is_active?: boolean | null }>>(`${table}?${params}`);

      return rows
        .filter((row) => row.is_active !== false)
        .map((row) => ({
          id: row.id,
          label: String(label === "title" ? row.title ?? "" : row.name ?? ""),
          value: String(row.id),
        }));
    } catch (error) {
      const message = employeeDirectoryErrorMessage(error).toLowerCase();
      if (!message.includes("is_active") && !message.includes("schema cache")) {
        throw error;
      }
    }
  }

  const select =
    table === "areas"
      ? `id,${label},line_id`
      : table === "teams"
        ? `id,${label},area_id,is_active`
        : `id,${label}`;
  const params = new URLSearchParams({
    select,
    order: `${label}.asc`,
  });
  let rows: Array<LookupRow & { area_id?: number | null; is_active?: boolean | null }>;

  try {
    const result = await supabaseRest<Array<LookupRow & { area_id?: number | null; is_active?: boolean | null }>>(`${table}?${params}`);
    rows = result.data;
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();
    if (
      table !== "teams" ||
      (!message.includes("is_active") && !message.includes("area_id") && !message.includes("schema cache"))
    ) {
      throw error;
    }

    const fallbackParams = new URLSearchParams({
      select: `id,${label}`,
      order: `${label}.asc`,
    });
    const result = await supabaseRest<LookupRow[]>(`${table}?${fallbackParams}`);
    rows = result.data;
  }

  return rows
    .filter((row) => row.is_active !== false)
    .map((row) => ({
      areaId: row.area_id ?? null,
      id: row.id,
      label: String(label === "title" ? row.title ?? "" : row.name ?? ""),
      lineId: row.line_id ?? null,
      value: String(row.id),
    }));
}

async function loadManagerNames(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, string>();
  }

  const params = new URLSearchParams({
    select: "hr_id,full_name",
    hr_id: textInFilter(hrIds),
  });
  const { data: rows } = await supabaseRest<LookupRow[]>(`employees?${params}`);

  return new Map(
    rows
      .map((row) => {
        const normalized = normalizeHrId(row.hr_id);
        return normalized ? [normalized, String(row.full_name ?? "")] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );
}

async function fetchAllEmployees(
  baseParams: Record<string, string>,
  filters: string[] = [],
  pageSize: number = EMPLOYEE_DIRECTORY_PAGE_SIZE,
): Promise<EmployeeDbRow[]> {
  const rows: EmployeeDbRow[] = [];
  let offset = Number(baseParams.offset ?? 0);

  while (true) {
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));

    const { data: batch } = await supabaseRest<EmployeeDbRow[]>(
      `employees?${params}${filters.length > 0 ? `&${filters.join("&")}` : ""}`,
    );

    rows.push(...batch);

    if (!Array.isArray(batch) || batch.length < pageSize) {
      return rows;
    }

    offset += pageSize;
  }
}

async function loadCompensationByHrId(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, EmployeeCompensationDbRow>();
  }

  const params = new URLSearchParams({
    select:
      "employee_hr_id,net_salary,social_insurance,taxes,medical_insurance,fuel_allowance,extra_cost_of_living,gross_salary,payment_mode",
    employee_hr_id: textInFilter(hrIds),
  });

  try {
    const { data: rows } = await supabaseRest<EmployeeCompensationDbRow[]>(
      `employee_compensation?${params}`,
    );

    return new Map(rows.map((row) => [row.employee_hr_id, row]));
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();

    if (message.includes("payment_mode") || message.includes("schema cache")) {
      const fallbackParams = new URLSearchParams({
        select:
          "employee_hr_id,net_salary,social_insurance,taxes,medical_insurance,fuel_allowance,extra_cost_of_living,gross_salary",
        employee_hr_id: textInFilter(hrIds),
      });
      const { data: rows } = await supabaseRest<EmployeeCompensationDbRow[]>(
        `employee_compensation?${fallbackParams}`,
      );

      return new Map(rows.map((row) => [row.employee_hr_id, row]));
    }

    if (isMissingRelationMessage(error)) {
      return new Map<string, EmployeeCompensationDbRow>();
    }

    throw error;
  }
}

async function loadResidenceByHrId(hrIds: string[]) {
  const cleanedHrIds = Array.from(new Set(hrIds.map(compact).filter(Boolean))) as string[];
  if (cleanedHrIds.length === 0) {
    return new Map<string, EmployeeResidenceDbRow>();
  }

  try {
    const { data: rows } = await supabaseRest<EmployeeResidenceDbRow[]>(
      `employee_locations?employee_hr_id=${encodeURIComponent(
        textInFilter(cleanedHrIds),
      )}&select=employee_hr_id,residence_address,residence_city,residence_area,residence_latitude,residence_longitude,geocode_status`,
    );

    return new Map(
      rows.map((row) => [row.employee_hr_id.trim().toUpperCase(), row]),
    );
  } catch (error) {
    if (isMissingRelationMessage(error)) {
      return new Map<string, EmployeeResidenceDbRow>();
    }
    throw error;
  }
}

export async function getEmployeeDirectory(
  filter: EmployeeDirectoryFilter = {},
  access?: AccessContext,
): Promise<EmployeeDirectoryData> {
  const page = Math.max(1, filter.page ?? 1);
  const isAllEmployees = filter.pageSize === -1;
  const pageSize = isAllEmployees ? EMPLOYEE_DIRECTORY_PAGE_SIZE : Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const offset = isAllEmployees ? 0 : (page - 1) * pageSize;

  const baseEmployeeSelect =
    "hr_id,full_name,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at,region_name,birth_date";

  // Apply filters in SQL
  const filters: string[] = [];
  if (filter.search) {
    const search = filter.search.trim();
    if (search) {
      filters.push(`or=(full_name.ilike.*${search}*,hr_id.ilike.*${search}*,work_email.ilike.*${search}*)`);
    }
  }
  if (filter.lineId) filters.push(`line_id=eq.${filter.lineId}`);
  if (filter.areaId) filters.push(`area_id=eq.${filter.areaId}`);
  if (filter.departmentId) filters.push(`department_id=eq.${filter.departmentId}`);
  if (filter.teamId) filters.push(`team_id=eq.${filter.teamId}`);
  if (filter.positionId) filters.push(`position_id=eq.${filter.positionId}`);
  const normalizedStatusFilter = normalizeDirectoryStatusFilter(filter.status ?? "all");
  if (normalizedStatusFilter && normalizedStatusFilter !== "all") {
    filters.push(`employment_status=eq.${normalizedStatusFilter}`);
  }
  if (filter.region) {
    filters.push(`region_name=ilike.*${filter.region}*`);
  }
  const normalizedHasBankAccount = normalizeYesNo(filter.hasBankAccount);
  if (normalizedHasBankAccount) {
    filters.push(`has_bank_account=eq.${normalizedHasBankAccount}`);
  }
  const normalizedMedicalInsuranceStatus = normalizeEnrollmentStatus(filter.medicalInsuranceStatus);
  if (normalizedMedicalInsuranceStatus) {
    filters.push(`medical_insurance_status=eq.${normalizedMedicalInsuranceStatus}`);
  }
  const normalizedSocialInsuranceStatus = normalizeEnrollmentStatus(filter.socialInsuranceStatus);
  if (normalizedSocialInsuranceStatus) {
    filters.push(`social_insurance_status=eq.${normalizedSocialInsuranceStatus}`);
  }
  const normalizedSalaryPaymentMode = normalizePayrollPaymentMode(filter.salaryPaymentMode);
  if (normalizedSalaryPaymentMode) {
    filters.push(`payment_mode=eq.${normalizedSalaryPaymentMode}`);
  }

  // Apply Access Scoping in SQL
  if (access && access.scope !== "system") {
    const currentHrId = access.hrId;
    if (["Super Admin", "CEO", "HR Specialist", "Finance Manager"].includes(access.role)) {
      // Company scope
    } else if (["Regional Manager", "Regional Sales Manager"].includes(access.role)) {
      const hierarchyHrIds = await getHierarchyHrIdsInSql(access.hrId);
      filters.push(`hr_id=${hierarchyHrIds.length > 0 ? textInFilter(hierarchyHrIds) : "eq.NONE"}`);
    } else if (access.scope === "line") {
      const lineId = await getEmployeeLineIdForHrId(currentHrId);
      if (lineId !== null) {
        filters.push(`line_id=eq.${lineId}`);
      } else if (currentHrId) {
        filters.push(`hr_id=eq.${currentHrId}`);
      }
    } else if (["District Manager", "Manager"].includes(access.role)) {
      if (currentHrId) {
        filters.push(`or=(hr_id.eq.${currentHrId},manager_hr_id.eq.${currentHrId})`);
      } else {
        filters.push("hr_id=is.null");
      }
    } else {
      if (currentHrId) {
        filters.push(`hr_id=eq.${currentHrId}`);
      } else {
        filters.push("hr_id=is.null");
      }
    }
  }

  const queryBase = {
    select: baseEmployeeSelect,
    order: "full_name.asc",
    ...(isAllEmployees ? {} : { offset: String(offset), limit: String(pageSize) }),
  };

  let employeeRows: EmployeeDbRow[];
  let total: number | undefined;

  if (isAllEmployees) {
    employeeRows = await fetchAllEmployees(queryBase, filters);
    total = employeeRows.length;
  } else {
    const pagedResult = await supabaseRest<EmployeeDbRow[]>(
      `employees?${new URLSearchParams(queryBase).toString()}${filters.length > 0 ? `&${filters.join("&")}` : ""}`,
      { headers: { Prefer: "count=exact" } },
    );
    employeeRows = pagedResult.data;
    total = pagedResult.count ?? employeeRows.length;
  }

  const [areas, departments, lines, positions, teams, managerNames] = await Promise.all([
    loadAllOptions("areas"),
    loadAllOptions("departments"),
    loadAllOptions("lines"),
    loadAllOptions("positions", "title"),
    loadAllOptions("teams"),
    loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
  ]);

  const employees = mapSimpleRows(employeeRows, { areas, departments, lines, managerNames, positions, teams });
  const totalCount = total ?? employees.length;
  const duplicateHrIds = findDuplicateHrIds(employeeRows);
  const filteredEmployees = employees;
  const effectiveTotalCount = totalCount;

  return {
    employees: filteredEmployees,
    total: isAllEmployees ? filteredEmployees.length : effectiveTotalCount,
    page,
    pageSize: isAllEmployees ? filteredEmployees.length : pageSize,
    pageCount: Math.max(
      1,
      Math.ceil((isAllEmployees ? filteredEmployees.length : effectiveTotalCount) / pageSize),
    ),
    lookups: {
      areas,
      departments,
      lines,
      managers: managerLookupOptions(filteredEmployees),
      positions,
      teams,
      statuses: activeStatusOptions(filteredEmployees),
      medicalRepVacancies: [], 
      workforceVacancies: [],
    },
    summary: {
      activeEmployees: filteredEmployees.filter((employee) =>
        ["active", "on_leave"].includes(String(employee.employmentStatus ?? "active").toLowerCase()),
      ).length,
      employeesWithoutManagers: filteredEmployees.filter(isMissingRequiredManager).length,
      totalEmployees: effectiveTotalCount,
      uniqueAreas: areas.length,
      uniqueLines: lines.length,
    },
    diagnostics: {
      rawRowsMatched: totalCount,
      returnedRows: filteredEmployees.length,
      page,
      pageSize,
      filters: {
        status: normalizedStatusFilter,
        lineId: filter.lineId,
        areaId: filter.areaId,
        departmentId: filter.departmentId,
        teamId: filter.teamId,
        region: filter.region ? compact(filter.region) : null,
        hasBankAccount: normalizedHasBankAccount,
        medicalInsuranceStatus: normalizedMedicalInsuranceStatus,
        socialInsuranceStatus: normalizedSocialInsuranceStatus,
        salaryPaymentMode: normalizedSalaryPaymentMode,
      },
      duplicateHrIdCount: duplicateHrIds.length,
      duplicateHrIds,
    },
  };
}

async function getHierarchyHrIdsInSql(rootHrId: string | null): Promise<string[]> {
  if (!rootHrId) return [];
  const { data, error } = await getSupabaseAdmin().rpc("fn_get_employee_hierarchy", {
    p_root_hr_id: rootHrId,
  });
  if (error) return [rootHrId];
  return (data as Array<{ hr_id: string }>).map((row) => row.hr_id);
}

function mapSimpleRows(
  rows: EmployeeDbRow[],
  lookups: {
    areas: EmployeeLookupOption[];
    departments: EmployeeLookupOption[];
    lines: EmployeeLookupOption[];
    managerNames: Map<string, string>;
    positions: EmployeeLookupOption[];
    teams: EmployeeLookupOption[];
  }
): EmployeeDirectoryRow[] {
  const areaMap = new Map(lookups.areas.map(a => [a.id, a.label]));
  const deptMap = new Map(lookups.departments.map(d => [d.id, d.label]));
  const lineMap = new Map(lookups.lines.map(l => [l.id, l.label]));
  const posMap = new Map(lookups.positions.map(p => [p.id, p.label]));
  const teamMap = new Map(lookups.teams.map(t => [t.id, t.label]));
  return rows.map((row) => {
    const managerKey = normalizeHrId(row.manager_hr_id);
    const managerName = managerKey ? lookups.managerNames.get(managerKey) ?? null : null;

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaMap.get(row.area_id) ?? null : null,
      birthDate: row.birth_date ?? null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.department_id ? deptMap.get(row.department_id) ?? null : null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? null,
      fullName: row.full_name,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? null,
      grossSalary: row.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.line_id ? lineMap.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: managerName,
      medicalInsurance: row.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode),
      positionId: row.position_id,
      positionTitle: row.position_id ? posMap.get(row.position_id) ?? null : null,
      residenceAddress: row.residence_address ?? null,
      residenceArea: row.residence_area ?? null,
      residenceCity: row.residence_city ?? null,
      residenceGeocodeStatus: null,
      residenceLatitude: null,
      residenceLongitude: null,
      regionName: row.region_name ?? null,
      socialInsurance: row.social_insurance ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? null,
      teamId: row.team_id,
      teamName: row.team_id ? teamMap.get(row.team_id) ?? null : null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  });
}

async function getEmployeeLineIdForHrId(hrId: string | null | undefined) {
  if (!hrId) {
    return null;
  }

  const { data: rows } = await supabaseRest<
    Array<{ line_id: number | null }>
  >(
    `employees?hr_id=eq.${hrId}&select=line_id&limit=1`,
  );

  return rows[0]?.line_id ?? null;
}

function mapJoinedRows(rows: JoinedEmployeeDbRow[]): EmployeeDirectoryRow[] {
  const managerMap = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeHrId(row.hr_id);
    if (key) managerMap.set(key, row.full_name);
  }

  return rows.map((row) => {
    const compensation = Array.isArray(row.employee_compensation)
      ? row.employee_compensation[0]
      : row.employee_compensation;
    const managerKey = normalizeHrId(row.manager_hr_id);

    return {
      areaId: row.area_id,
      areaName: row.areas?.name ?? null,
      birthDate: row.birth_date ?? null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.departments?.name ?? null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? compensation?.extra_cost_of_living ?? null,
      fullName: row.full_name,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? compensation?.fuel_allowance ?? null,
      grossSalary: row.gross_salary ?? compensation?.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.lines?.name ?? null,
      managerHrId: row.manager_hr_id,
      managerName: managerKey ? managerMap.get(managerKey) ?? row.manager_hr_id ?? null : null,
      medicalInsurance: row.medical_insurance ?? compensation?.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? compensation?.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
      positionId: row.position_id,
      positionTitle: row.positions?.title ?? null,
      residenceAddress: row.residence_address ?? null,
      residenceArea: row.residence_area ?? null,
      residenceCity: row.residence_city ?? null,
      residenceGeocodeStatus: null,
      residenceLatitude: null,
      residenceLongitude: null,
      regionName: row.region_name ?? null,
      socialInsurance: row.social_insurance ?? compensation?.social_insurance ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? compensation?.taxes ?? null,
      teamId: row.team_id,
      teamName: row.teams?.name ?? null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  });
}

export async function getEmployeeDirectoryRows(
  includeInactiveEmployees = true,
): Promise<EmployeeDirectoryRow[]> {
  const baseEmployeeSelect =
    "hr_id,full_name,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at";
  const employeeParams = new URLSearchParams({
    select: `${baseEmployeeSelect},region_name,birth_date`,
    order: "full_name.asc",
  });
  let employeeRows: EmployeeDbRow[];
  const pageSize = EMPLOYEE_DIRECTORY_PAGE_SIZE;

  try {
    employeeRows = await fetchAllEmployees(
      {
        select: `${baseEmployeeSelect},region_name,birth_date`,
        order: "full_name.asc",
      },
      [],
      pageSize,
    );
  } catch (error) {
    if (!isMissingRelationMessage(error)) {
      throw error;
    }

    employeeRows = await fetchAllEmployees({
      select: baseEmployeeSelect,
      order: "full_name.asc",
    });
  }

  const [departmentNames, lineNames, areaNames, positionTitles, teamNames, managerNames] =
    await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadLookup("teams", uniqueNumberValues(employeeRows, "team_id")),
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
    ]);

  const residenceByHrId = await loadResidenceByHrId(uniqueTextValues(employeeRows, "hr_id"));

  const rows = employeeRows
    .map((row) => {
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
    const managerKey = normalizeHrId(row.manager_hr_id);

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      birthDate: row.birth_date ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.department_id
        ? departmentNames.get(row.department_id) ?? null
        : null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? null,
      fullName: row.full_name,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? null,
      grossSalary: row.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: managerKey
        ? managerNames.get(managerKey) ?? null
        : null,
      medicalInsurance: row.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode),
      positionId: row.position_id,
      positionTitle: row.position_id
        ? positionTitles.get(row.position_id) ?? null
        : null,
      residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
      residenceArea: row.residence_area ?? residence?.residence_area ?? null,
      residenceCity: row.residence_city ?? residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      socialInsurance: row.social_insurance ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? null,
      teamId: row.team_id,
      teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  });

  // Keep active-only filtering explicit; never hide rows by default.
  return includeInactiveEmployees ? rows : rows.filter(isActiveDirectoryEmployee);
}

async function ensureManagerIsValid(managerHrId: string | null, employeeHrId: string) {
  if (!managerHrId) {
    return;
  }

  if (managerHrId === employeeHrId) {
    throw new Error("An employee cannot be assigned as their own manager.");
  }

  const { data: managers } = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=eq.${encodeURIComponent(managerHrId)}&select=hr_id,employment_status,payroll_eligible,organogram_visible,full_name,name_ar,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,created_at,updated_at`,
  );

  if (managers.length === 0) {
    throw new Error(`Manager HR_ID ${managerHrId} was not found.`);
  }

  const manager = managers[0];
  if (
    !isActiveLifecycleStatus(manager.employment_status) ||
    manager.organogram_visible === false
  ) {
    throw new Error(`Manager HR_ID ${managerHrId} is not active for hierarchy assignment.`);
  }

  const managerPositionTitle = await loadPositionTitleById(numberOrNull(manager.position_id));
  if (
    !isManagerOptionalHrId(manager.hr_id) &&
    !isManagerialTitle(`${managerPositionTitle ?? ""} ${manager.job_title ?? ""}`)
  ) {
    throw new Error(`Manager HR_ID ${managerHrId} is not a valid manager-level employee.`);
  }
}

function isRegionalSalesManagerTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.includes("regional sales manager") || normalized === "rsm";
}

function isNationalSalesManagerTitle(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.includes("national sales manager") || normalized === "nsm";
}

async function loadPositionTitleById(positionId: number | null) {
  if (!positionId) {
    return null;
  }

  const { data: rows } = await supabaseRest<Array<{ title: string | null }>>(
    `positions?id=eq.${positionId}&select=title&limit=1`,
  );

  return rows[0]?.title ?? null;
}

async function loadLineNameById(lineId: number | null) {
  if (!lineId) {
    return null;
  }

  const { data: rows } = await supabaseRest<Array<{ name: string | null }>>(
    `lines?id=eq.${lineId}&select=name&limit=1`,
  );

  return rows[0]?.name ?? null;
}

async function findNationalSalesManagerForLine(lineId: number) {
  type NsmCandidateRow = {
    hr_id: string;
    job_title: string | null;
    positions?: { title: string | null } | null;
  };
  const params = new URLSearchParams({
    employment_status: "in.(active,on_leave)",
    line_id: `eq.${lineId}`,
    organogram_visible: "is.true",
    select: "hr_id,job_title,position_id,positions(title)",
  });
  let rows: NsmCandidateRow[];

  try {
    const result = await supabaseRest<NsmCandidateRow[]>(`employees?${params}`);
    rows = result.data;
  } catch (error) {
    if (!isEmployeeDirectorySchemaMissing(error)) {
      throw error;
    }

    const fallbackParams = new URLSearchParams({
      employment_status: "in.(active,on_leave)",
      line_id: `eq.${lineId}`,
      organogram_visible: "is.true",
      select: "hr_id,job_title,position_id",
    });
    const result = await supabaseRest<NsmCandidateRow[]>(`employees?${fallbackParams}`);
    rows = result.data;
  }

  return rows.find((row) =>
    isNationalSalesManagerTitle(`${row.job_title ?? ""} ${row.positions?.title ?? ""}`),
  )?.hr_id ?? null;
}

async function defaultRegionalSalesManagerManager(input: EmployeeMutationInput, lineId: number | null) {
  if (!lineId) {
    return null;
  }

  const inputTitle = compact(input.jobTitle);
  const positionTitle = inputTitle ?? await loadPositionTitleById(numberOrNull(input.positionId));
  if (!isRegionalSalesManagerTitle(positionTitle)) {
    return null;
  }

  const lineName = await loadLineNameById(lineId);
  if (!lineName || !lineName.trim().toLowerCase().includes("pedia")) {
    return null;
  }

  return findNationalSalesManagerForLine(lineId);
}

async function ensureCrmIdIsUnique(crmId: string | null, employeeHrId: string) {
  if (!crmId) {
    return;
  }

  const { data: matches } = await supabaseRest<Array<{ hr_id: string }>>(
    `employees?crm_id=eq.${encodeURIComponent(crmId)}&select=hr_id`,
  );
  const conflict = matches.find(
    (row: any) => normalizeHrId(row.hr_id) !== employeeHrId,
  );

  if (conflict) {
    throw new Error(`CRM ID ${crmId} is already assigned to HR_ID ${conflict.hr_id}.`);
  }
}

async function employeePayload(input: EmployeeMutationInput, isUpdate: boolean) {
  const fullName = compact(input.fullName);
  if (!fullName) {
    throw new Error("Full name is required.");
  }

  const lineId = numberOrNull(input.lineId);
  let hrId = normalizeHrId(input.hrId);
  const employmentStatus = normalizeLifecycleStatus(input.employmentStatus);
  const workEmail = compact(input.workEmail)?.toLowerCase();

  if (!statusOptions.includes(employmentStatus)) {
    throw new Error(`Employment status ${employmentStatus} is not allowed.`);
  }

  if (employmentStatus === "resigned" || employmentStatus === "terminated") {
    throw new Error("Use the resignation workflow for resigned or terminated employees.");
  }

  if (hrId && !hrIdPattern.test(hrId)) {
    throw new Error(`Invalid HR_ID format: ${hrId}.`);
  }

  if (workEmail && !emailPattern.test(workEmail)) {
    throw new Error("Work email format is invalid.");
  }

  // 1. Handle HR_ID based on operation type
  if (isUpdate) {
    // When updating, HR_ID must be provided and stable
    if (!hrId) {
      throw new Error("HR_ID is required for updates.");
    }
  } else {
    // When creating a NEW employee
    if (!hrId) {
      // Auto-generate if missing
      hrId = await generateNextHrIdForLine(lineId);
    } else {
      // Validate uniqueness if manually entered
      const { data: existing } = await supabaseRest<Array<{ hr_id: string }>>(
        `employees?hr_id=eq.${hrId}&select=hr_id`,
      );
      if (existing.length > 0) {
        throw new Error(`HR_ID ${hrId} already exists.`);
      }
    }
  }

  if (!hrId) {
    throw new Error("HR_ID is required.");
  }

  const requestedManagerHrId = normalizeHrId(input.managerHrId);
  let managerHrId = requestedManagerHrId;
  if (!managerHrId) {
    managerHrId = await defaultRegionalSalesManagerManager(input, lineId);
  }
  await ensureManagerIsValid(managerHrId, hrId);
  const crmId = compact(input.crmId);
  await ensureCrmIdIsUnique(crmId, hrId);

  const lifecycleActive = isActiveLifecycleStatus(employmentStatus);

  return {
    area_id: numberOrNull(input.areaId),
    bank_account: compact(input.bankAccount),
    bank_name: compact(input.bankName),
    base_salary: numberOrNull(input.baseSalary),
    basic_salary: numberOrNull(input.basicSalary),
    birth_date: compact(input.birthDate),
    contract_type: compact(input.contractType),
    crm_id: crmId,
    crm_username: compact(input.crmUsername),
    department_id: numberOrNull(input.departmentId),
    education: compact(input.education),
    employment_status: employmentStatus,
    extra_cost_of_living: numberOrNull(input.extraCostOfLiving),
    full_name: fullName,
    gender: compact(input.gender)?.toLowerCase(),
    fuel_allowance: numberOrNull(input.fuelAllowance),
    gross_salary: numberOrNull(input.grossSalary),
    has_bank_account: normalizeYesNo(input.hasBankAccount),
    hire_date: compact(input.hireDate),
    hr_id: hrId,
    job_title: compact(input.jobTitle),
    line_id: lineId,
    manager_hr_id: managerHrId,
    mobile_number: compact(input.mobileNumber),
    name_ar: compact(input.nameAr),
    national_id: compact(input.nationalId),
    net_salary: numberOrNull(input.netSalary),
    medical_insurance: numberOrNull(input.medicalInsurance),
    medical_insurance_status: normalizeEnrollmentStatus(input.medicalInsuranceStatus),
    medical_insurance_number: compact(input.medicalInsuranceNumber),
    organogram_visible: lifecycleActive,
    payroll_eligible: lifecycleActive,
    position_id: numberOrNull(input.positionId),
    payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode),
    residence_address: compact(input.residenceAddress),
    residence_area: compact(input.residenceArea),
    residence_city: compact(input.residenceCity),
    region_name: compact(input.regionName),
    social_insurance: numberOrNull(input.socialInsurance),
    social_insurance_status: normalizeEnrollmentStatus(input.socialInsuranceStatus),
    social_insurance_number: compact(input.socialInsuranceNumber),
    taxes: numberOrNull(input.taxes),
    team_id: numberOrNull(input.teamId),
    updated_at: new Date().toISOString(),
    work_email: workEmail,
  };
}

async function upsertEmployeePaymentMode(
  hrId: string,
  paymentMode: string | null | undefined,
) {
  if (paymentMode === undefined) {
    return;
  }

  const payload = {
    employee_hr_id: hrId,
    payment_mode: normalizePayrollPaymentMode(paymentMode),
    updated_at: new Date().toISOString(),
  };

  try {
    await supabaseRest<EmployeeCompensationDbRow[]>(
      "employee_compensation?on_conflict=employee_hr_id",
      {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "resolution=merge-duplicates",
      },
      method: "POST",
      },
    );
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();

    if (
      isMissingRelationMessage(error) ||
      message.includes("payment_mode") ||
      message.includes("schema cache")
    ) {
      return;
    }

    throw error;
  }
}

async function upsertEmployeeResidenceLocation(
  input: EmployeeMutationInput,
  hrId: string,
) {
  if (
    input.residenceAddress === undefined &&
    input.residenceArea === undefined &&
    input.residenceCity === undefined
  ) {
    return;
  }

  const residenceAddress = compact(input.residenceAddress);
  const residenceArea = compact(input.residenceArea);
  const residenceCity = compact(input.residenceCity);
  const geocodeQuery = [residenceAddress, residenceArea, residenceCity, "Egypt"]
    .filter(Boolean)
    .join(", ");
  const geocoded = geocodeQuery
    ? await googleGeocodeAddress(geocodeQuery).catch(() => null)
    : null;

  await supabaseRest<EmployeeResidenceDbRow[]>(
    "employee_locations?on_conflict=employee_hr_id",
    {
      body: JSON.stringify({
        employee_hr_id: hrId,
        geocode_status: residenceAddress
          ? geocoded
            ? "success"
            : "failed"
          : "missing_address",
        residence_address: residenceAddress,
        residence_area: residenceArea,
        residence_city: residenceCity,
        residence_latitude: geocoded?.lat ?? null,
        residence_longitude: geocoded?.lng ?? null,
        updated_at: new Date().toISOString(),
      }),
      headers: {
        Prefer: "resolution=merge-duplicates",
      },
      method: "POST",
    },
  );
}

function shouldIgnoreOptionalCascadeError(error: unknown) {
  return isMissingRelationMessage(error) || isEmployeeDirectorySchemaMissing(error);
}

function isMissingReplacementOwnershipRpc(error: unknown) {
  const message = employeeDirectoryErrorMessage(error).toLowerCase();

  return (
    message.includes("phx_reassign_replacement_ownership") ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

async function patchOptionalTable(path: string, payload: Record<string, unknown>) {
  try {
    await supabaseRest(path, {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "return=minimal",
      },
      method: "PATCH",
    });
  } catch (error) {
    if (!shouldIgnoreOptionalCascadeError(error)) {
      throw error;
    }
  }
}

async function replacementForVacancy(vacancyId: number | null | undefined) {
  if (!vacancyId) {
    return null;
  }

  try {
    const { data: rows } = await supabaseRest<Array<{
      effective_date?: string | null;
      employee_hr_id: string | null;
      last_working_date?: string | null;
    }>>(
      `employee_resignations?${new URLSearchParams({
        limit: "1",
        order: "created_at.desc",
        select: "employee_hr_id,effective_date,last_working_date",
        vacancy_id: `eq.${vacancyId}`,
      })}`,
    );
    const row = rows[0];
    return row?.employee_hr_id
      ? {
          effectiveDate: row.effective_date ?? row.last_working_date ?? null,
          hrId: normalizeHrId(row.employee_hr_id),
        }
      : null;
  } catch (error) {
    if (shouldIgnoreOptionalCascadeError(error)) {
      return null;
    }
    throw error;
  }
}

async function reassignLiveManagerOwnership(input: {
  effectiveDate?: string | null;
  newManagerHrId: string;
  previousManagerHrId: string;
}) {
  const previousManagerHrId = normalizeHrId(input.previousManagerHrId);
  const newManagerHrId = normalizeHrId(input.newManagerHrId);

  if (!previousManagerHrId || !newManagerHrId || previousManagerHrId === newManagerHrId) {
    return;
  }

  const effectiveDate = compact(input.effectiveDate);
  try {
    await supabaseRest<unknown>("rpc/phx_reassign_replacement_ownership", {
      body: JSON.stringify({
        p_effective_date: effectiveDate ? effectiveDate.slice(0, 10) : null,
        p_previous_hr_id: previousManagerHrId,
        p_replacement_hr_id: newManagerHrId,
      }),
      headers: {
        Prefer: "return=minimal",
      },
      method: "POST",
    });
    return;
  } catch (error) {
    if (!isMissingReplacementOwnershipRpc(error)) {
      throw error;
    }
  }

  const now = new Date().toISOString();
  const previous = encodeURIComponent(previousManagerHrId);
  const nextPayload = {
    manager_hr_id: newManagerHrId,
    updated_at: now,
  };

  await patchOptionalTable(
    `employees?manager_hr_id=eq.${previous}&employment_status=not.in.(resigned,terminated,inactive)`,
    nextPayload,
  );

  await patchOptionalTable(
    `app_auth_users?manager_hr_id=eq.${previous}&is_active=is.true`,
    nextPayload,
  );

  await patchOptionalTable(
    `user_access_profiles?manager_hr_id=eq.${previous}&is_active=is.true`,
    nextPayload,
  );

  await patchOptionalTable(
    `position_vacancies?manager_hr_id=eq.${previous}&status=eq.open`,
    nextPayload,
  );

  if (!effectiveDate) {
    return;
  }

  const date = new Date(`${effectiveDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return;
  }

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const salesPayload = {
    manager_hr_id: newManagerHrId,
  };

  await patchOptionalTable(
    `sales_records?manager_hr_id=eq.${previous}&year=gt.${year}`,
    salesPayload,
  );
  await patchOptionalTable(
    `sales_records?manager_hr_id=eq.${previous}&year=eq.${year}&month=gte.${month}`,
    salesPayload,
  );
  await patchOptionalTable(
    `sales_targets?manager_hr_id=eq.${previous}&year=gt.${year}`,
    salesPayload,
  );
  await patchOptionalTable(
    `sales_targets?manager_hr_id=eq.${previous}&year=eq.${year}&month=gte.${month}`,
    salesPayload,
  );
}

export async function upsertEmployee(input: EmployeeMutationInput) {
  const hrId = normalizeHrId(input.hrId);
  const originalHrId = normalizeHrId(input.originalHrId);
  const isUpdate = Boolean(originalHrId);

  if (isUpdate) {
    if (!hrId) {
      throw new Error("HR_ID is required for updates.");
    }

    if (hrId !== originalHrId) {
      throw new Error("HR_ID is immutable after employee creation. Use a governed HR_ID rename workflow.");
    }

    const { data: existing } = await supabaseRest<Array<{ hr_id: string }>>(
      `employees?hr_id=eq.${encodeURIComponent(originalHrId as string)}&select=hr_id`,
    );
    if (existing.length === 0) {
      throw new Error(`Employee ${originalHrId} was not found.`);
    }
  } else if (hrId) {
    const { data: existing } = await supabaseRest<Array<{ hr_id: string }>>(
      `employees?hr_id=eq.${encodeURIComponent(hrId)}&select=hr_id`,
    );
    if (existing.length > 0) {
      throw new Error(`HR_ID ${hrId} already exists. Open the employee record before editing.`);
    }
  }

  const payload = await employeePayload(input, isUpdate);
  const params = new URLSearchParams({
    on_conflict: "hr_id",
  });

  const { data: rows } = await supabaseRest<EmployeeDbRow[]>(`employees?${params}`, {
    body: JSON.stringify(payload),
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    method: "POST",
  });

  await Promise.all([
    upsertEmployeePaymentMode(payload.hr_id, input.salaryPaymentMode),
    upsertEmployeeResidenceLocation(input, payload.hr_id),
  ]);

  // Requirement: closeVacancyForOffer should only run after a NEW employee is created
  if (!isUpdate) {
    const closedVacancy = await closeVacancyForOffer({
      area_id: payload.area_id,
      filled_by_hr_id: payload.hr_id,
      line_id: payload.line_id,
      manager_hr_id: payload.manager_hr_id,
      position_id: payload.position_id,
    });

    const resignationReplacement = await replacementForVacancy(closedVacancy?.id);
    const vacancyReplacement = {
      effectiveDate: resignationReplacement?.effectiveDate ?? null,
      hrId: normalizeHrId(closedVacancy?.replacementForHrId) ?? resignationReplacement?.hrId ?? null,
    };

    if (vacancyReplacement?.hrId) {
      await reassignLiveManagerOwnership({
        effectiveDate: vacancyReplacement.effectiveDate,
        newManagerHrId: payload.hr_id,
        previousManagerHrId: vacancyReplacement.hrId,
      });
    }
  }

  invalidateEmployeeDirectoryCache();

  return rows;
}

export async function bulkUpdateEmployees(
  hrIds: string[],
  values: Pick<
    EmployeeMutationInput,
    | "areaId"
    | "departmentId"
    | "employmentStatus"
    | "lineId"
    | "managerHrId"
    | "positionId"
  >,
) {
  const cleanedHrIds = Array.from(new Set(hrIds.map(compact).filter(Boolean))) as string[];

  if (cleanedHrIds.length === 0) {
    throw new Error("Select at least one employee.");
  }

  const employmentStatus = values.employmentStatus === undefined
    ? undefined
    : normalizeLifecycleStatus(values.employmentStatus);

  if (employmentStatus !== undefined && !statusOptions.includes(employmentStatus)) {
    throw new Error(`Employment status ${employmentStatus} is not allowed.`);
  }

  const payload = {
    ...(values.areaId !== undefined ? { area_id: numberOrNull(values.areaId) } : {}),
    ...(values.departmentId !== undefined
      ? { department_id: numberOrNull(values.departmentId) }
      : {}),
    ...(employmentStatus !== undefined
      ? {
          employment_status: employmentStatus,
          organogram_visible: isActiveLifecycleStatus(employmentStatus),
          payroll_eligible: isActiveLifecycleStatus(employmentStatus),
        }
      : {}),
    ...(values.lineId !== undefined ? { line_id: numberOrNull(values.lineId) } : {}),
    ...(values.managerHrId !== undefined
      ? { manager_hr_id: normalizeHrId(values.managerHrId) }
      : {}),
    ...(values.positionId !== undefined
      ? { position_id: numberOrNull(values.positionId) }
      : {}),
    updated_at: new Date().toISOString(),
  };

  const { data: rows } = await supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=${encodeURIComponent(textInFilter(cleanedHrIds))}`,
    {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "return=representation",
      },
      method: "PATCH",
    },
  );

  invalidateEmployeeDirectoryCache();

  return rows;
}
