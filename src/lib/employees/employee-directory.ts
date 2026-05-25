import {
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import { googleGeocodeAddress } from "@/lib/google-maps/server";
import { canonicalHrIdForDisplay, hrIdLookupKeys } from "@/lib/hr-id";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import { generateNextHrIdForLine } from "./hr-id-helper";
import { isMissingRequiredManager } from "./hierarchy-governance";

const hrIdPattern = /^[A-Z0-9][A-Z0-9_-]*$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const activeLifecycleStatuses = new Set(["active", "on_leave"]);
const statusOptions = ["active", "inactive", "on_leave", "terminated", "resigned"];
const employeeSalaryDetailCategories = new Set([
  "earning",
  "deduction",
  "reference",
  "other",
]);
const employeeSalaryDetailValueTypes = new Set(["amount", "text"]);

export type EmployeeSalaryDetailCategory =
  | "earning"
  | "deduction"
  | "reference"
  | "other";

export type EmployeeSalaryDetailValueType = "amount" | "text";

export type EmployeeSalaryDetail = {
  category: EmployeeSalaryDetailCategory;
  id: string;
  label: string;
  notes: string | null;
  value: string;
  valueType: EmployeeSalaryDetailValueType;
};

export type EmployeeDirectoryRow = {
  areaId: number | null;
  areaName: string | null;
  birthDate: string | null;
  bankName: string | null;
  bankAccount: string | null;
  baseSalary: number | null;
  basicSalary: number | null;
  contractRenewalDate: string | null;
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
  lastWorkingDate: string | null;
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
  resignationDate: string | null;
  salaryDetails?: EmployeeSalaryDetail[] | null;
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
  lineId?: number | null;
  positionId?: number | null;
  managerHrId?: string | null;
  departmentId?: number | null;
};

export type EmployeeDirectoryData = {
  employees: EmployeeDirectoryRow[];
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
  payrollEligible?: boolean | null;
  positionId?: number | null;
  residenceAddress?: string | null;
  residenceArea?: string | null;
  residenceCity?: string | null;
  regionName?: string | null;
  salaryDetails?: EmployeeSalaryDetail[] | null;
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
  contract_renewal_date?: string | null;
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
  last_working_date?: string | null;
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
  resignation_date?: string | null;
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
  salary_details?: unknown;
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
  return canonicalHrIdForDisplay(value);
}

function normalizeIdentityText(value: string | null | undefined) {
  return compact(value)?.toLowerCase() ?? "";
}

function normalizeLifecycleStatus(value: string | null | undefined) {
  return compact(value)?.toLowerCase() ?? "active";
}

function isActiveLifecycleStatus(value: string | null | undefined) {
  return activeLifecycleStatuses.has(normalizeLifecycleStatus(value));
}

function isSystemAdminDirectoryEmployee(employee: EmployeeDirectoryRow) {
  const hrId = normalizeHrId(employee.hrId);

  return (
    hrId === "ADMIN-HR" ||
    hrId === "RLS-ADMIN-HR" ||
    (normalizeIdentityText(employee.fullName) === "phoenix system administrator" &&
      normalizeIdentityText(employee.jobTitle) === "system administrator")
  );
}

function normalizeYesNo(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" ? normalized : null;
}

function normalizeEnrollmentStatus(value: string | null | undefined) {
  const normalized = compact(value)?.toLowerCase();
  return normalized === "yes" || normalized === "no" || normalized === "pending"
    ? normalized
    : null;
}

function isActiveDirectoryEmployee(employee: EmployeeDirectoryRow) {
  return (
    isActiveLifecycleStatus(employee.employmentStatus) &&
    employee.organogramVisible !== false &&
    !isSystemAdminDirectoryEmployee(employee) &&
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

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function normalizeEmployeeSalaryDetails(value: unknown): EmployeeSalaryDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const label =
        compact(typeof row.label === "string" ? row.label : null) ??
        compact(typeof row.name === "string" ? row.name : null);
      const notes = compact(typeof row.notes === "string" ? row.notes : null);
      const rawValue =
        row.value === null || row.value === undefined ? "" : String(row.value).trim();
      const category = employeeSalaryDetailCategories.has(String(row.category))
        ? (String(row.category) as EmployeeSalaryDetailCategory)
        : "other";
      const valueType = employeeSalaryDetailValueTypes.has(String(row.valueType))
        ? (String(row.valueType) as EmployeeSalaryDetailValueType)
        : (numberOrNull(rawValue) !== null ? "amount" : "text");

      if (!label && !rawValue && !notes) {
        return null;
      }

      return {
        category,
        id: compact(typeof row.id === "string" ? row.id : null) ?? `salary-detail-${index + 1}`,
        label: label ?? (valueType === "amount" ? "Salary item" : "Salary note"),
        notes,
        value: rawValue,
        valueType,
      };
    })
    .filter((item): item is EmployeeSalaryDetail => item !== null);
}

function compensationSelect(includeSalaryDetails = true) {
  const fields = [
    "employee_hr_id",
    "net_salary",
    "social_insurance",
    "taxes",
    "medical_insurance",
    "fuel_allowance",
    "extra_cost_of_living",
    "gross_salary",
    "payment_mode",
  ];

  if (includeSalaryDetails) {
    fields.push("salary_details");
  }

  return fields.join(",");
}

function textInFilter(values: string[]) {
  return `in.(${values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`;
}

function idInFilter(values: number[]) {
  return `in.(${values.join(",")})`;
}

async function supabaseRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let lastError: unknown;

  for (let attempt = 0; attempt < DATABASE_QUERY_MAX_ATTEMPTS; attempt++) {
    const timeoutMs =
      attempt === 0 ? databaseQueryTimeoutMs : databaseQueryRetryMs;
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
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : `Supabase request failed with ${response.status}.`;
        throw new Error(message);
      }

      return payload as T;
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
  const rows = await supabaseRest<LookupRow[]>(`${table}?${params}`);

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
      const rows = await supabaseRest<Array<LookupRow & { is_active?: boolean | null }>>(`${table}?${params}`);

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
    rows = await supabaseRest<Array<LookupRow & { area_id?: number | null; is_active?: boolean | null }>>(`${table}?${params}`);
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();
    if (table !== "teams") throw error;

    const isColumnIssue = message.includes("is_active") || message.includes("area_id") || message.includes("schema cache");
    const isTableMissing = !isColumnIssue && isMissingRelationMessage(error);

    if (isTableMissing) return [];
    if (!isColumnIssue) throw error;

    const fallbackParams = new URLSearchParams({
      select: `id,${label}`,
      order: `${label}.asc`,
    });
    try {
      rows = await supabaseRest<LookupRow[]>(`${table}?${fallbackParams}`);
    } catch (fallbackError) {
      if (isMissingRelationMessage(fallbackError)) return [];
      throw fallbackError;
    }
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
  const lookupHrIds = Array.from(
    new Set(
      hrIds
        .flatMap((hrId) => {
          const trimmed = compact(hrId);
          const normalized = normalizeHrId(hrId);
          return [
            ...hrIdLookupKeys(hrId),
            trimmed,
            normalized,
            trimmed?.toLowerCase(),
          ].filter(Boolean) as string[];
        })
        .filter(Boolean),
    ),
  );

  if (lookupHrIds.length === 0) {
    return new Map<string, string>();
  }

  const params = new URLSearchParams({
    select: "hr_id,full_name",
    hr_id: textInFilter(lookupHrIds),
  });
  const rows = await supabaseRest<LookupRow[]>(`employees?${params}`);

  const names = new Map<string, string>();
  rows.forEach((row) => {
    const hrId = String(row.hr_id);
    const name = String(row.full_name ?? "");
    names.set(hrId, name);
    const normalizedHrId = normalizeHrId(hrId);
    if (normalizedHrId) names.set(normalizedHrId, name);
    hrIdLookupKeys(hrId).forEach((key) => names.set(key, name));
  });

  return names;
}

function managerNameFromLookup(managerNames: Map<string, string>, managerHrId: string | null | undefined) {
  if (!managerHrId) return null;
  for (const key of hrIdLookupKeys(managerHrId)) {
    const name = managerNames.get(key);
    if (name) return name;
  }
  return managerNames.get(managerHrId) ?? managerNames.get(normalizeHrId(managerHrId) ?? "") ?? null;
}

async function loadCompensationByHrId(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, EmployeeCompensationDbRow>();
  }

  const params = new URLSearchParams({
    select: compensationSelect(),
    employee_hr_id: textInFilter(hrIds),
  });

  try {
    const rows = await supabaseRest<EmployeeCompensationDbRow[]>(
      `employee_compensation?${params}`,
    );

    return new Map(rows.map((row) => [row.employee_hr_id, row]));
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();

    if (
      message.includes("payment_mode") ||
      message.includes("salary_details") ||
      message.includes("schema cache")
    ) {
      const fallbackParams = new URLSearchParams({
        select: compensationSelect(false).replace(",payment_mode", ""),
        employee_hr_id: textInFilter(hrIds),
      });
      const rows = await supabaseRest<EmployeeCompensationDbRow[]>(
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
    const rows = await supabaseRest<EmployeeResidenceDbRow[]>(
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

export async function getEmployeeDirectory(): Promise<EmployeeDirectoryData> {
  const now = Date.now();
  if (directoryCache && now - directoryCache.timestamp < CACHE_TTL) {
    return directoryCache.data;
  }

  try {
    const result = await fetchEmployeeDirectory();
    directoryCache = {
      data: result,
      timestamp: now,
    };
    return result;
  } catch (error) {
    if (isEmployeeDirectoryTimeout(error) && directoryCache) {
      return directoryCache.data;
    }

    throw error;
  }
}

async function fetchEmployeeDirectory(): Promise<EmployeeDirectoryData> {
  const baseEmployeeSelect =
    "hr_id,full_name,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,contract_renewal_date,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,resignation_date,last_working_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at";

  // Try to join compensation and other lookups in a single query to reduce N+1 and massive IN filters
  const joinedSelect = `${baseEmployeeSelect},region_name,birth_date,
    employee_compensation(${compensationSelect()}),
    departments(name),
    lines(name),
    areas(name),
    positions(title),
    teams(name)`;

  const employeeParams = new URLSearchParams({
    select: joinedSelect,
    order: "full_name.asc",
  });

  let employeeRows: JoinedEmployeeDbRow[];

  try {
    employeeRows = await supabaseRest<JoinedEmployeeDbRow[]>(`employees?${employeeParams}`);
  } catch {
    // Fallback if joined query fails due to schema/relationship issues
    const fallbackParams = new URLSearchParams({
      select: `${baseEmployeeSelect},region_name,birth_date`,
      order: "full_name.asc",
    });
    employeeRows = await supabaseRest<EmployeeDbRow[]>(`employees?${fallbackParams}`);
  }

  const residenceByHrId = await loadResidenceByHrId(uniqueTextValues(employeeRows, "hr_id"));

  // Check if we got joined data
  const hasJoinedData = employeeRows.length > 0 && (employeeRows[0].employee_compensation || employeeRows[0].departments);

  let departmentNames: Map<number, string>;
  let lineNames: Map<number, string>;
  let areaNames: Map<number, string>;
  let positionTitles: Map<number, string>;
  let managerNames: Map<string, string>;
  let compensationByHrId: Map<string, EmployeeCompensationDbRow>;
  let departments: EmployeeLookupOption[];
  let lines: EmployeeLookupOption[];
  let areas: EmployeeLookupOption[];
  let positions: EmployeeLookupOption[];
  let teams: EmployeeLookupOption[] = [];

  if (hasJoinedData) {
    // Extract lookups from joined data to avoid extra requests
    departmentNames = new Map();
    lineNames = new Map();
    areaNames = new Map();
    positionTitles = new Map();
    const teamNames = new Map<number, string>();
    compensationByHrId = new Map();

    employeeRows.forEach(row => {
      if (row.departments && row.department_id !== null) departmentNames.set(row.department_id, row.departments.name ?? "");
      if (row.lines && row.line_id !== null) lineNames.set(row.line_id, row.lines.name ?? "");
      if (row.areas && row.area_id !== null) areaNames.set(row.area_id, row.areas.name ?? "");
      if (row.positions && row.position_id !== null) positionTitles.set(row.position_id, row.positions.title ?? "");
      if (row.teams && row.team_id !== null) teamNames.set(row.team_id, row.teams.name ?? "");
      if (row.employee_compensation) {
        const comp = Array.isArray(row.employee_compensation) ? row.employee_compensation[0] : row.employee_compensation;
        if (comp) compensationByHrId.set(row.hr_id, comp);
      }
    });

    // Still need these for the filter dropdowns, but these are small tables usually
    const [managerNamesResult, departmentsResult, linesResult, areasResult, positionsResult, teamsResult, medicalRepVacancies, workforceVacancies] = await Promise.all([
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      loadAllOptions("teams"),
      getOpenMedicalRepVacancies(),
      getOpenWorkforceVacancies(),
    ]);

    managerNames = managerNamesResult;
    departments = departmentsResult;
    lines = linesResult;
    areas = areasResult;
    positions = positionsResult;
    teams = teamsResult;

    const employeesData = employeeRows.map((row) => {
      const compensation = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      const departmentName = row.department_id ? departmentNames.get(row.department_id) ?? null : null;
      const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
      const positionTitle = row.position_id ? positionTitles.get(row.position_id) ?? null : null;
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName,
        employeeHrId: row.hr_id,
        jobTitle: row.job_title,
        lineName,
        positionTitle,
      });

      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        bankName: row.bank_name ?? null,
        bankAccount: row.bank_account ?? null,
        baseSalary: row.base_salary ?? null,
        basicSalary: row.basic_salary ?? null,
        birthDate: row.birth_date ?? null,
        contractRenewalDate: row.contract_renewal_date ?? null,
        contractType: row.contract_type ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: row.extra_cost_of_living ?? compensation?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
        fullName: row.full_name,
        gender: row.gender ?? null,
        fuelAllowance: row.fuel_allowance ?? compensation?.fuel_allowance ?? standardAllowances.fuelAllowance,
        grossSalary: row.gross_salary ?? compensation?.gross_salary ?? null,
        hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lastWorkingDate: row.last_working_date ?? null,
        lineId: row.line_id,
        lineName,
        managerHrId: row.manager_hr_id,
        managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
        medicalInsurance: row.medical_insurance ?? compensation?.medical_insurance ?? null,
        medicalInsuranceStatus: row.medical_insurance_status ?? null,
        medicalInsuranceNumber: row.medical_insurance_number ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        nationalId: row.national_id ?? null,
        netSalary: row.net_salary ?? compensation?.net_salary ?? null,
        organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
        payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
        salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
        salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
        positionId: row.position_id,
        positionTitle,
        residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
        residenceArea: row.residence_area ?? residence?.residence_area ?? null,
        residenceCity: row.residence_city ?? residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        resignationDate: row.resignation_date ?? null,
        socialInsurance: row.social_insurance ?? compensation?.social_insurance ?? null,
        socialInsuranceStatus: row.social_insurance_status ?? null,
        socialInsuranceNumber: row.social_insurance_number ?? null,
        taxes: row.taxes ?? compensation?.taxes ?? null,
        teamId: row.team_id,
        teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
      };
    });

    const activeEmployees = employeesData.filter(isActiveDirectoryEmployee);

    return {
      employees: activeEmployees,
      lookups: {
        areas,
        departments,
        lines,
        managers: activeEmployees
          .map((employee) => ({
            departmentId: employee.departmentId,
            label: employee.fullName,
            lineId: employee.lineId,
            positionId: employee.positionId,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: activeStatusOptions(activeEmployees),
        teams,
        workforceVacancies,
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
        totalEmployees: activeEmployees.length,
        uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
        uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
      },
    };
  } else {
    // Fallback to original slow method if join failed
    const [
      departmentNamesRes,
      lineNamesRes,
      areaNamesRes,
      positionTitlesRes,
      teamNamesRes,
      managerNamesRes,
      compensationByHrIdRes,
      departmentsRes,
      linesRes,
      areasRes,
      positionsRes,
      teamsRes,
      medicalRepVacancies,
      workforceVacancies
    ] = await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadLookup("teams", uniqueNumberValues(employeeRows, "team_id")),
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
      loadCompensationByHrId(uniqueTextValues(employeeRows, "hr_id")),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      loadAllOptions("teams"),
      getOpenMedicalRepVacancies(),
      getOpenWorkforceVacancies(),
    ]);

    departmentNames = departmentNamesRes;
    lineNames = lineNamesRes;
    areaNames = areaNamesRes;
    positionTitles = positionTitlesRes;
    const teamNames = teamNamesRes;
    managerNames = managerNamesRes;
    compensationByHrId = compensationByHrIdRes;
    departments = departmentsRes;
    lines = linesRes;
    areas = areasRes;
    positions = positionsRes;
    teams = teamsRes;

    const employeesData = employeeRows.map((row) => {
      const comp = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      const departmentName = row.department_id ? departmentNames.get(row.department_id) ?? null : null;
      const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
      const positionTitle = row.position_id ? positionTitles.get(row.position_id) ?? null : null;
      const standardAllowances = resolveStandardSalaryAllowances({
        departmentName,
        employeeHrId: row.hr_id,
        jobTitle: row.job_title,
        lineName,
        positionTitle,
      });

      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        bankName: row.bank_name ?? null,
        bankAccount: row.bank_account ?? null,
        baseSalary: row.base_salary ?? null,
        basicSalary: row.basic_salary ?? null,
        birthDate: row.birth_date ?? null,
        contractRenewalDate: row.contract_renewal_date ?? null,
        contractType: row.contract_type ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: row.extra_cost_of_living ?? comp?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
        fullName: row.full_name,
        gender: row.gender ?? null,
        fuelAllowance: row.fuel_allowance ?? comp?.fuel_allowance ?? standardAllowances.fuelAllowance,
        grossSalary: row.gross_salary ?? comp?.gross_salary ?? null,
        hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lastWorkingDate: row.last_working_date ?? null,
        lineId: row.line_id,
        lineName,
        managerHrId: row.manager_hr_id,
        managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
        medicalInsurance: row.medical_insurance ?? comp?.medical_insurance ?? null,
        medicalInsuranceStatus: row.medical_insurance_status ?? null,
        medicalInsuranceNumber: row.medical_insurance_number ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        nationalId: row.national_id ?? null,
        netSalary: row.net_salary ?? comp?.net_salary ?? null,
        organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
        payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
        salaryDetails: normalizeEmployeeSalaryDetails(comp?.salary_details),
        salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? comp?.payment_mode),
        positionId: row.position_id,
        positionTitle,
        residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
        residenceArea: row.residence_area ?? residence?.residence_area ?? null,
        residenceCity: row.residence_city ?? residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        resignationDate: row.resignation_date ?? null,
        socialInsurance: row.social_insurance ?? comp?.social_insurance ?? null,
        socialInsuranceStatus: row.social_insurance_status ?? null,
        socialInsuranceNumber: row.social_insurance_number ?? null,
        taxes: row.taxes ?? comp?.taxes ?? null,
        teamId: row.team_id,
        teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
      };
    });

    const activeEmployees = employeesData.filter(isActiveDirectoryEmployee);

    return {
      employees: activeEmployees,
      lookups: {
        areas,
        departments,
        lines,
        managers: activeEmployees
          .map((employee) => ({
            departmentId: employee.departmentId,
            label: employee.fullName,
            lineId: employee.lineId,
            positionId: employee.positionId,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: activeStatusOptions(activeEmployees),
        teams,
        workforceVacancies,
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
        totalEmployees: activeEmployees.length,
        uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
        uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
      },
    };
  }

  const employees = employeeRows.map((row) => {
    const compensation = compensationByHrId.get(row.hr_id);
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
    const departmentName = row.department_id
      ? departmentNames.get(row.department_id) ?? null
      : null;
    const lineName = row.line_id ? lineNames.get(row.line_id) ?? null : null;
    const positionTitle = row.position_id
      ? positionTitles.get(row.position_id) ?? null
      : null;
    const standardAllowances = resolveStandardSalaryAllowances({
      departmentName,
      employeeHrId: row.hr_id,
      jobTitle: row.job_title,
      lineName,
      positionTitle,
    });

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      birthDate: row.birth_date ?? null,
      contractRenewalDate: row.contract_renewal_date ?? null,
      contractType: row.contract_type ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: row.extra_cost_of_living ?? compensation?.extra_cost_of_living ?? standardAllowances.extraCostOfLiving,
      fullName: row.full_name,
      gender: row.gender ?? null,
      fuelAllowance: row.fuel_allowance ?? compensation?.fuel_allowance ?? standardAllowances.fuelAllowance,
      grossSalary: row.gross_salary ?? compensation?.gross_salary ?? null,
      hasBankAccount: row.has_bank_account ?? (row.bank_account ? "yes" : "no"),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lastWorkingDate: row.last_working_date ?? null,
      lineId: row.line_id,
      lineName,
      managerHrId: row.manager_hr_id,
      managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
      medicalInsurance: row.medical_insurance ?? compensation?.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? compensation?.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
      positionId: row.position_id,
      positionTitle,
      residenceAddress: row.residence_address ?? residence?.residence_address ?? null,
      residenceArea: row.residence_area ?? residence?.residence_area ?? null,
      residenceCity: row.residence_city ?? residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      resignationDate: row.resignation_date ?? null,
      socialInsurance: row.social_insurance ?? compensation?.social_insurance ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? compensation?.taxes ?? null,
      teamId: row.team_id,
      teamName: null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  });
  const activeEmployees = employees.filter(isActiveDirectoryEmployee);

  return {
    employees: activeEmployees,
    lookups: {
      areas,
      departments,
      lines,
      managers: activeEmployees
        .map((employee) => ({
          departmentId: employee.departmentId,
          label: employee.fullName,
          lineId: employee.lineId,
          positionId: employee.positionId,
          value: employee.hrId,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      medicalRepVacancies: [],
      positions,
      statuses: activeStatusOptions(activeEmployees),
      teams,
      workforceVacancies: [],
    },
    summary: {
      activeEmployees: activeEmployees.length,
      employeesWithoutManagers: activeEmployees.filter(isMissingRequiredManager).length,
      totalEmployees: activeEmployees.length,
      uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
      uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
    },
  };
}

export async function getEmployeeDirectoryRows(
  options: { includeInactive?: boolean } = {},
): Promise<EmployeeDirectoryRow[]> {
  const baseEmployeeSelect =
    "hr_id,full_name,name_ar,national_id,gender,has_bank_account,bank_name,bank_account,social_insurance_status,social_insurance_number,medical_insurance_status,medical_insurance_number,basic_salary,base_salary,gross_salary,net_salary,fuel_allowance,extra_cost_of_living,medical_insurance,social_insurance,taxes,payment_mode,residence_address,residence_city,residence_area,contract_type,contract_renewal_date,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,resignation_date,last_working_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,payroll_eligible,organogram_visible,created_at,updated_at";
  const employeeParams = new URLSearchParams({
    select: `${baseEmployeeSelect},region_name,birth_date`,
    order: "full_name.asc",
  });
  let employeeRows: EmployeeDbRow[];

  try {
    employeeRows = await supabaseRest<EmployeeDbRow[]>(
      `employees?${employeeParams}`,
    );
  } catch (error) {
    if (!isMissingRelationMessage(error)) {
      throw error;
    }

    const fallbackParams = new URLSearchParams({
      select: baseEmployeeSelect,
      order: "full_name.asc",
    });
    employeeRows = await supabaseRest<EmployeeDbRow[]>(
      `employees?${fallbackParams}`,
    );
  }

  const [departmentNames, lineNames, areaNames, positionTitles, teamNames, managerNames, compensationByHrId] =
    await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadLookup("teams", uniqueNumberValues(employeeRows, "team_id")),
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
      loadCompensationByHrId(uniqueTextValues(employeeRows, "hr_id")),
    ]);

  const residenceByHrId = await loadResidenceByHrId(uniqueTextValues(employeeRows, "hr_id"));

  return employeeRows.map((row) => {
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
    const compensation = compensationByHrId.get(row.hr_id);

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      bankName: row.bank_name ?? null,
      bankAccount: row.bank_account ?? null,
      baseSalary: row.base_salary ?? null,
      basicSalary: row.basic_salary ?? null,
      birthDate: row.birth_date ?? null,
      contractRenewalDate: row.contract_renewal_date ?? null,
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
      lastWorkingDate: row.last_working_date ?? null,
      lineId: row.line_id,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: managerNameFromLookup(managerNames, row.manager_hr_id),
      medicalInsurance: row.medical_insurance ?? null,
      medicalInsuranceStatus: row.medical_insurance_status ?? null,
      medicalInsuranceNumber: row.medical_insurance_number ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id ?? null,
      netSalary: row.net_salary ?? null,
      organogramVisible: row.organogram_visible ?? isActiveLifecycleStatus(row.employment_status),
      payrollEligible: row.payroll_eligible ?? isActiveLifecycleStatus(row.employment_status),
      salaryDetails: normalizeEmployeeSalaryDetails(compensation?.salary_details),
      salaryPaymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensation?.payment_mode),
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
      resignationDate: row.resignation_date ?? null,
      socialInsurance: row.social_insurance ?? null,
      socialInsuranceStatus: row.social_insurance_status ?? null,
      socialInsuranceNumber: row.social_insurance_number ?? null,
      taxes: row.taxes ?? null,
      teamId: row.team_id,
      teamName: row.team_id ? teamNames.get(row.team_id) ?? null : null,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
    };
  }).filter((employee) => options.includeInactive || isActiveDirectoryEmployee(employee));
}

async function ensureManagerIsValid(managerHrId: string | null, employeeHrId: string) {
  if (!managerHrId) {
    return;
  }

  if (managerHrId === employeeHrId) {
    throw new Error("An employee cannot be assigned as their own manager.");
  }

  const managers = await supabaseRest<EmployeeDbRow[]>(
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
}

async function ensureCrmIdIsUnique(crmId: string | null, employeeHrId: string) {
  if (!crmId) {
    return;
  }

  const matches = await supabaseRest<Array<{ hr_id: string }>>(
    `employees?crm_id=eq.${encodeURIComponent(crmId)}&select=hr_id`,
  );
  const conflict = matches.find(
    (row) => normalizeHrId(row.hr_id) !== employeeHrId,
  );

  if (conflict) {
    throw new Error(`CRM ID ${crmId} is already assigned to HR_ID ${conflict.hr_id}.`);
  }
}

function resolveEmployeeCompensationInput(input: EmployeeMutationInput) {
  const baseSalary = numberOrNull(input.baseSalary);
  const basicSalary = numberOrNull(input.basicSalary);
  const grossSalary = numberOrNull(input.grossSalary);
  const netSalary = numberOrNull(input.netSalary);
  const socialInsurance = numberOrNull(input.socialInsurance);
  const taxes = numberOrNull(input.taxes);
  const explicitExtraCostOfLiving = numberOrNull(input.extraCostOfLiving);
  const explicitFuelAllowance = numberOrNull(input.fuelAllowance);
  const standardAllowances = resolveStandardSalaryAllowances({
    employeeHrId: input.hrId,
    jobTitle: input.jobTitle,
  });
  const extraCostOfLiving = explicitExtraCostOfLiving ?? standardAllowances.extraCostOfLiving;
  const fuelAllowance = explicitFuelAllowance ?? standardAllowances.fuelAllowance;
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary,
    basicSalary,
    employmentIncomeTax: taxes,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary,
    netSalary,
    socialInsurance,
  });

  if (fixedSalary.baseSalary <= 0) {
    return {
      baseSalary,
      basicSalary,
      extraCostOfLiving: explicitExtraCostOfLiving,
      fuelAllowance: explicitFuelAllowance,
      grossSalary,
      netSalary,
    };
  }

  return {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: fixedSalary.netSalary,
  };
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
      const existing = await supabaseRest<Array<{ hr_id: string }>>(
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

  const managerHrId = normalizeHrId(input.managerHrId);
  await ensureManagerIsValid(managerHrId, hrId);
  const crmId = compact(input.crmId);
  await ensureCrmIdIsUnique(crmId, hrId);

  const lifecycleActive = isActiveLifecycleStatus(employmentStatus);
  const payrollEligible = lifecycleActive ? input.payrollEligible !== false : false;
  const compensation = resolveEmployeeCompensationInput(input);

  return {
    area_id: numberOrNull(input.areaId),
    bank_account: compact(input.bankAccount),
    bank_name: compact(input.bankName),
    base_salary: compensation.baseSalary,
    basic_salary: compensation.basicSalary,
    birth_date: compact(input.birthDate),
    contract_type: compact(input.contractType),
    crm_id: crmId,
    crm_username: compact(input.crmUsername),
    department_id: numberOrNull(input.departmentId),
    education: compact(input.education),
    employment_status: employmentStatus,
    extra_cost_of_living: compensation.extraCostOfLiving,
    full_name: fullName,
    gender: compact(input.gender)?.toLowerCase(),
    fuel_allowance: compensation.fuelAllowance,
    gross_salary: compensation.grossSalary,
    has_bank_account: normalizeYesNo(input.hasBankAccount),
    hire_date: compact(input.hireDate),
    hr_id: hrId,
    job_title: compact(input.jobTitle),
    line_id: lineId,
    manager_hr_id: managerHrId,
    mobile_number: compact(input.mobileNumber),
    name_ar: compact(input.nameAr),
    national_id: compact(input.nationalId),
    net_salary: compensation.netSalary,
    medical_insurance: numberOrNull(input.medicalInsurance),
    medical_insurance_status: normalizeEnrollmentStatus(input.medicalInsuranceStatus),
    medical_insurance_number: compact(input.medicalInsuranceNumber),
    organogram_visible: lifecycleActive,
    payroll_eligible: payrollEligible,
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

async function upsertEmployeeCompensation(
  hrId: string,
  input: Pick<EmployeeMutationInput, "salaryDetails" | "salaryPaymentMode">,
) {
  if (input.salaryPaymentMode === undefined && input.salaryDetails === undefined) {
    return;
  }

  const payload = {
    employee_hr_id: hrId,
    updated_at: new Date().toISOString(),
    ...(input.salaryPaymentMode !== undefined
      ? { payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode) }
      : {}),
    ...(input.salaryDetails !== undefined
      ? { salary_details: normalizeEmployeeSalaryDetails(input.salaryDetails) }
      : {}),
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
      message.includes("salary_details") ||
      message.includes("payment_mode") ||
      message.includes("schema cache")
    ) {
      if (input.salaryPaymentMode === undefined) {
        return;
      }

      try {
        await supabaseRest<EmployeeCompensationDbRow[]>(
          "employee_compensation?on_conflict=employee_hr_id",
          {
            body: JSON.stringify({
              employee_hr_id: hrId,
              payment_mode: normalizePayrollPaymentMode(input.salaryPaymentMode),
              updated_at: new Date().toISOString(),
            }),
            headers: {
              Prefer: "resolution=merge-duplicates",
            },
            method: "POST",
          },
        );
      } catch (fallbackError) {
        const fallbackMessage = employeeDirectoryErrorMessage(fallbackError).toLowerCase();

        if (
          isMissingRelationMessage(fallbackError) ||
          fallbackMessage.includes("payment_mode") ||
          fallbackMessage.includes("schema cache")
        ) {
          return;
        }

        throw fallbackError;
      }

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
    const rows = await supabaseRest<Array<{
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

    const existing = await supabaseRest<Array<{ hr_id: string }>>(
      `employees?hr_id=eq.${encodeURIComponent(originalHrId as string)}&select=hr_id`,
    );
    if (existing.length === 0) {
      throw new Error(`Employee ${originalHrId} was not found.`);
    }
  } else if (hrId) {
    const existing = await supabaseRest<Array<{ hr_id: string }>>(
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

  const rows = await supabaseRest<EmployeeDbRow[]>(`employees?${params}`, {
    body: JSON.stringify(payload),
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    method: "POST",
  });

  await Promise.all([
    upsertEmployeeCompensation(payload.hr_id, input),
    upsertEmployeeResidenceLocation(input, payload.hr_id),
  ]);

  // Requirement: closeVacancyForOffer should only run after a NEW employee is created
  if (!isUpdate) {
    const managerName = payload.manager_hr_id
      ? (await loadManagerNames([payload.manager_hr_id])).get(payload.manager_hr_id) ?? null
      : null;
    const closedVacancy = await closeVacancyForOffer({
      area_id: payload.area_id,
      filled_by_hr_id: payload.hr_id,
      line_id: payload.line_id,
      manager_name: managerName,
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
          ...(!isActiveLifecycleStatus(employmentStatus) ? { payroll_eligible: false } : {}),
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

  const rows = await supabaseRest<EmployeeDbRow[]>(
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
