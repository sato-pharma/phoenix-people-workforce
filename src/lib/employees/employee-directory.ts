import {
  normalizePayrollPaymentMode,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";
import { googleGeocodeAddress } from "@/lib/geo-intelligence/google";
import { generateNextHrIdForLine } from "./hr-id-helper";

export type EmployeeDirectoryRow = {
  areaId: number | null;
  areaName: string | null;
  birthDate: string | null;
  createdAt: string;
  crmId: string | null;
  crmUsername: string | null;
  comprehensiveWage: number | null;
  departmentId: number | null;
  departmentName: string | null;
  education: string | null;
  employmentStatus: string | null;
  extraCostOfLiving: number | null;
  fullName: string;
  fuelAllowance: number | null;
  grossSalary: number | null;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  medicalInsurance: number | null;
  mobileNumber: string | null;
  nameAr: string | null;
  netSalary: number | null;
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
  subscriptionWage: number | null;
  teamId: number | null;
  taxes: number | null;
  updatedAt: string;
  workEmail: string | null;
  // Phase 1: New employee data fields
  nationalIdNumber: string | null;
  addressFromIdCard: string | null;
  personalEmail: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  employeeType: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
};

import { closeVacancyForOffer, getOpenMedicalRepVacancies, type VacancyLookupRow } from "@/lib/offers/service";

export type EmployeeLookupOption = {
  id?: number;
  label: string;
  value: string;
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
    statuses: EmployeeLookupOption[];
    medicalRepVacancies: VacancyLookupRow[];
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
  employmentStatus?: string | null;
  fullName?: string | null;
  hireDate?: string | null;
  hrId?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  mobileNumber?: string | null;
  nameAr?: string | null;
  positionId?: number | null;
  residenceAddress?: string | null;
  residenceArea?: string | null;
  residenceCity?: string | null;
  salaryPaymentMode?: string | null;
  workEmail?: string | null;
  // Phase 1: New employee data fields
  birthDate?: string | null;
  nationalIdNumber?: string | null;
  idCardExpiryDate?: string | null;
  addressFromIdCard?: string | null;
  personalEmail?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  employeeType?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
};

type EmployeeDbRow = {
  area_id: number | null;
  birth_date?: string | null;
  created_at: string;
  crm_id: string | null;
  crm_username: string | null;
  department_id: number | null;
  education: string | null;
  employment_status: string | null;
  full_name: string;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
  mobile_number: string | null;
  name_ar: string | null;
  position_id: number | null;
  region_name?: string | null;
  team_id: number | null;
  updated_at: string;
  work_email: string | null;
  // Phase 1: New employee data fields
  national_id_number?: string | null;
  address_from_id_card?: string | null;
  personal_email?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  employee_type?: string | null;
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
  comprehensive_wage: number | null;
  employee_hr_id: string;
  extra_cost_of_living: number | null;
  fuel_allowance: number | null;
  gross_salary: number | null;
  medical_insurance: number | null;
  net_salary: number | null;
  payment_mode?: string | null;
  social_insurance: number | null;
  subscription_wage: number | null;
  taxes: number | null;
  // Phase 1: New compensation fields
  bank_account_number?: string | null;
  bank_name?: string | null;
  account_holder_name?: string | null;
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
};

const databaseQueryTimeoutMs = 15000;
const databaseQueryRetryMs = 30000;
const DATABASE_QUERY_MAX_ATTEMPTS = 2;

let directoryCache: {
  data: EmployeeDirectoryData;
  timestamp: number;
} | null = null;

const CACHE_TTL = 30000; // 30 seconds
const statusOptions = ["active", "inactive", "on_leave", "terminated", "resigned"];

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
  const select = table === "areas" ? `id,${label},line_id` : `id,${label}`;
  const params = new URLSearchParams({
    select,
    order: `${label}.asc`,
  });
  const rows = await supabaseRest<LookupRow[]>(`${table}?${params}`);

  return rows.map((row) => ({
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
  const rows = await supabaseRest<LookupRow[]>(`employees?${params}`);

  return new Map(
    rows.map((row) => [String(row.hr_id), String(row.full_name ?? "")]),
  );
}

async function loadCompensationByHrId(hrIds: string[]) {
  if (hrIds.length === 0) {
    return new Map<string, EmployeeCompensationDbRow>();
  }

  const params = new URLSearchParams({
    select:
      "employee_hr_id,net_salary,social_insurance,taxes,medical_insurance,comprehensive_wage,subscription_wage,fuel_allowance,extra_cost_of_living,gross_salary,payment_mode",
    employee_hr_id: textInFilter(hrIds),
  });

  try {
    const rows = await supabaseRest<EmployeeCompensationDbRow[]>(
      `employee_compensation?${params}`,
    );

    return new Map(rows.map((row) => [row.employee_hr_id, row]));
  } catch (error) {
    const message = employeeDirectoryErrorMessage(error).toLowerCase();

    if (message.includes("payment_mode") || message.includes("schema cache")) {
      const fallbackParams = new URLSearchParams({
        select:
          "employee_hr_id,net_salary,social_insurance,taxes,medical_insurance,comprehensive_wage,subscription_wage,fuel_allowance,extra_cost_of_living,gross_salary",
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
    "hr_id,full_name,name_ar,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,created_at,updated_at";

  // Try to join compensation and other lookups in a single query to reduce N+1 and massive IN filters
  const joinedSelect = `${baseEmployeeSelect},region_name,birth_date,
    employee_compensation(net_salary,social_insurance,taxes,medical_insurance,comprehensive_wage,subscription_wage,fuel_allowance,extra_cost_of_living,gross_salary,payment_mode),
    departments(name),
    lines(name),
    areas(name),
    positions(title)`;

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

  if (hasJoinedData) {
    // Extract lookups from joined data to avoid extra requests
    departmentNames = new Map();
    lineNames = new Map();
    areaNames = new Map();
    positionTitles = new Map();
    compensationByHrId = new Map();

    employeeRows.forEach(row => {
      if (row.departments && row.department_id !== null) departmentNames.set(row.department_id, row.departments.name ?? "");
      if (row.lines && row.line_id !== null) lineNames.set(row.line_id, row.lines.name ?? "");
      if (row.areas && row.area_id !== null) areaNames.set(row.area_id, row.areas.name ?? "");
      if (row.positions && row.position_id !== null) positionTitles.set(row.position_id, row.positions.title ?? "");
      if (row.employee_compensation) {
        const comp = Array.isArray(row.employee_compensation) ? row.employee_compensation[0] : row.employee_compensation;
        if (comp) compensationByHrId.set(row.hr_id, comp);
      }
    });

    // Still need these for the filter dropdowns, but these are small tables usually
    const [managerNamesResult, departmentsResult, linesResult, areasResult, positionsResult, medicalRepVacancies] = await Promise.all([
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      getOpenMedicalRepVacancies(),
    ]);

    managerNames = managerNamesResult;
    departments = departmentsResult;
    lines = linesResult;
    areas = areasResult;
    positions = positionsResult;

    const employeesData = employeeRows.map((row) => {
      const compensation = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        birthDate: row.birth_date ?? null,
        comprehensiveWage: compensation?.comprehensive_wage ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName: row.department_id ? departmentNames.get(row.department_id) ?? null : null,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: compensation?.extra_cost_of_living ?? null,
        fullName: row.full_name,
        fuelAllowance: compensation?.fuel_allowance ?? null,
        grossSalary: compensation?.gross_salary ?? null,
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lineId: row.line_id,
        lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
        managerHrId: row.manager_hr_id,
        managerName: row.manager_hr_id ? managerNames.get(row.manager_hr_id) ?? null : null,
        medicalInsurance: compensation?.medical_insurance ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        netSalary: compensation?.net_salary ?? null,
        salaryPaymentMode: normalizePayrollPaymentMode(compensation?.payment_mode),
        positionId: row.position_id,
        positionTitle: row.position_id ? positionTitles.get(row.position_id) ?? null : null,
        residenceAddress: residence?.residence_address ?? null,
        residenceArea: residence?.residence_area ?? null,
        residenceCity: residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        socialInsurance: compensation?.social_insurance ?? null,
        subscriptionWage: compensation?.subscription_wage ?? null,
        taxes: compensation?.taxes ?? null,
        teamId: row.team_id,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
        // Phase 1: New employee data fields
        nationalIdNumber: row.national_id_number ?? null,
        addressFromIdCard: row.address_from_id_card ?? null,
        personalEmail: row.personal_email ?? null,
        emergencyContactName: row.emergency_contact_name ?? null,
        emergencyContactPhone: row.emergency_contact_phone ?? null,
        employeeType: row.employee_type ?? null,
        bankAccountNumber: compensation?.bank_account_number ?? null,
        bankName: compensation?.bank_name ?? null,
      };
    });

    const activeEmployees = employeesData.filter((employee) => (employee.employmentStatus ?? "active") === "active");

    return {
      employees: employeesData,
      lookups: {
        areas,
        departments,
        lines,
        managers: employeesData
          .map((employee) => ({
            label: employee.fullName,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: statusOptions.map((status) => ({
          label: status.replace(/_/g, " "),
          value: status,
        })),
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: employeesData.filter((employee) => !employee.managerHrId).length,
        totalEmployees: employeesData.length,
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
      managerNamesRes,
      compensationByHrIdRes,
      departmentsRes,
      linesRes,
      areasRes,
      positionsRes,
      medicalRepVacancies
    ] = await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
      loadCompensationByHrId(uniqueTextValues(employeeRows, "hr_id")),
      loadAllOptions("departments"),
      loadAllOptions("lines"),
      loadAllOptions("areas"),
      loadAllOptions("positions", "title"),
      getOpenMedicalRepVacancies(),
    ]);

    departmentNames = departmentNamesRes;
    lineNames = lineNamesRes;
    areaNames = areaNamesRes;
    positionTitles = positionTitlesRes;
    managerNames = managerNamesRes;
    compensationByHrId = compensationByHrIdRes;
    departments = departmentsRes;
    lines = linesRes;
    areas = areasRes;
    positions = positionsRes;

    const employeesData = employeeRows.map((row) => {
      const comp = compensationByHrId.get(row.hr_id);
      const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());
      return {
        areaId: row.area_id,
        areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
        birthDate: row.birth_date ?? null,
        comprehensiveWage: comp?.comprehensive_wage ?? null,
        createdAt: row.created_at,
        crmId: row.crm_id,
        crmUsername: row.crm_username,
        departmentId: row.department_id,
        departmentName: row.department_id ? departmentNames.get(row.department_id) ?? null : null,
        education: row.education,
        employmentStatus: row.employment_status,
        extraCostOfLiving: comp?.extra_cost_of_living ?? null,
        fullName: row.full_name,
        fuelAllowance: comp?.fuel_allowance ?? null,
        grossSalary: comp?.gross_salary ?? null,
        hireDate: row.hire_date,
        hrId: row.hr_id,
        jobTitle: row.job_title,
        lineId: row.line_id,
        lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
        managerHrId: row.manager_hr_id,
        managerName: row.manager_hr_id ? managerNames.get(row.manager_hr_id) ?? null : null,
        medicalInsurance: comp?.medical_insurance ?? null,
        mobileNumber: row.mobile_number,
        nameAr: row.name_ar,
        netSalary: comp?.net_salary ?? null,
        salaryPaymentMode: normalizePayrollPaymentMode(comp?.payment_mode),
        positionId: row.position_id,
        positionTitle: row.position_id ? positionTitles.get(row.position_id) ?? null : null,
        residenceAddress: residence?.residence_address ?? null,
        residenceArea: residence?.residence_area ?? null,
        residenceCity: residence?.residence_city ?? null,
        residenceGeocodeStatus: residence?.geocode_status ?? null,
        residenceLatitude: residence?.residence_latitude ?? null,
        residenceLongitude: residence?.residence_longitude ?? null,
        regionName: row.region_name ?? null,
        socialInsurance: comp?.social_insurance ?? null,
        subscriptionWage: comp?.subscription_wage ?? null,
        taxes: comp?.taxes ?? null,
        teamId: row.team_id,
        updatedAt: row.updated_at,
        workEmail: row.work_email,
        // Phase 1: New employee data fields
        nationalIdNumber: row.national_id_number ?? null,
        addressFromIdCard: row.address_from_id_card ?? null,
        personalEmail: row.personal_email ?? null,
        emergencyContactName: row.emergency_contact_name ?? null,
        emergencyContactPhone: row.emergency_contact_phone ?? null,
        employeeType: row.employee_type ?? null,
        bankAccountNumber: comp?.bank_account_number ?? null,
        bankName: comp?.bank_name ?? null,
      };
    });

    const activeEmployees = employeesData.filter((employee) => (employee.employmentStatus ?? "active") === "active");

    return {
      employees: employeesData,
      lookups: {
        areas,
        departments,
        lines,
        managers: employeesData
          .map((employee) => ({
            label: employee.fullName,
            value: employee.hrId,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        medicalRepVacancies,
        positions,
        statuses: statusOptions.map((status) => ({
          label: status.replace(/_/g, " "),
          value: status,
        })),
      },
      summary: {
        activeEmployees: activeEmployees.length,
        employeesWithoutManagers: employeesData.filter((employee) => !employee.managerHrId).length,
        totalEmployees: employeesData.length,
        uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
        uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
      },
    };
  }

  const employees = employeeRows.map((row) => {
    const compensation = compensationByHrId.get(row.hr_id);
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      birthDate: row.birth_date ?? null,
      comprehensiveWage: compensation?.comprehensive_wage ?? null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.department_id
        ? departmentNames.get(row.department_id) ?? null
        : null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: compensation?.extra_cost_of_living ?? null,
      fullName: row.full_name,
      fuelAllowance: compensation?.fuel_allowance ?? null,
      grossSalary: compensation?.gross_salary ?? null,
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_hr_id
        ? managerNames.get(row.manager_hr_id) ?? null
        : null,
      medicalInsurance: compensation?.medical_insurance ?? null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      netSalary: compensation?.net_salary ?? null,
      salaryPaymentMode: normalizePayrollPaymentMode(compensation?.payment_mode),
      positionId: row.position_id,
      positionTitle: row.position_id
        ? positionTitles.get(row.position_id) ?? null
        : null,
      residenceAddress: residence?.residence_address ?? null,
      residenceArea: residence?.residence_area ?? null,
      residenceCity: residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      socialInsurance: compensation?.social_insurance ?? null,
      subscriptionWage: compensation?.subscription_wage ?? null,
      taxes: compensation?.taxes ?? null,
      teamId: row.team_id,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
      // Phase 1: New employee data fields
      nationalIdNumber: row.national_id_number ?? null,
      addressFromIdCard: row.address_from_id_card ?? null,
      personalEmail: row.personal_email ?? null,
      emergencyContactName: row.emergency_contact_name ?? null,
      emergencyContactPhone: row.emergency_contact_phone ?? null,
      employeeType: row.employee_type ?? null,
      bankAccountNumber: compensation?.bank_account_number ?? null,
      bankName: compensation?.bank_name ?? null,
    };
  });
  const activeEmployees = employees.filter(
    (employee) => (employee.employmentStatus ?? "active") === "active",
  );

  return {
    employees,
    lookups: {
      areas,
      departments,
      lines,
      managers: employees
        .map((employee) => ({
          label: employee.fullName,
          value: employee.hrId,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      medicalRepVacancies: [],
      positions,
      statuses: statusOptions.map((status) => ({
        label: status.replace(/_/g, " "),
        value: status,
      })),
    },
    summary: {
      activeEmployees: activeEmployees.length,
      employeesWithoutManagers: employees.filter(
        (employee) => !employee.managerHrId,
      ).length,
      totalEmployees: employees.length,
      uniqueAreas: new Set(activeEmployees.map((employee) => employee.areaId).filter(Boolean)).size,
      uniqueLines: new Set(activeEmployees.map((employee) => employee.lineId).filter(Boolean)).size,
    },
  };
}

export async function getEmployeeDirectoryRows(): Promise<EmployeeDirectoryRow[]> {
  const baseEmployeeSelect =
    "hr_id,full_name,name_ar,crm_id,crm_username,work_email,mobile_number,job_title,hire_date,employment_status,education,manager_hr_id,department_id,line_id,area_id,team_id,position_id,created_at,updated_at";
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

  const [departmentNames, lineNames, areaNames, positionTitles, managerNames] =
    await Promise.all([
      loadLookup("departments", uniqueNumberValues(employeeRows, "department_id")),
      loadLookup("lines", uniqueNumberValues(employeeRows, "line_id")),
      loadLookup("areas", uniqueNumberValues(employeeRows, "area_id")),
      loadLookup("positions", uniqueNumberValues(employeeRows, "position_id"), "title"),
      loadManagerNames(uniqueTextValues(employeeRows, "manager_hr_id")),
    ]);

  const residenceByHrId = await loadResidenceByHrId(uniqueTextValues(employeeRows, "hr_id"));

  return employeeRows.map((row) => {
    const residence = residenceByHrId.get(row.hr_id.trim().toUpperCase());

    return {
      areaId: row.area_id,
      areaName: row.area_id ? areaNames.get(row.area_id) ?? null : null,
      birthDate: row.birth_date ?? null,
      comprehensiveWage: null,
      createdAt: row.created_at,
      crmId: row.crm_id,
      crmUsername: row.crm_username,
      departmentId: row.department_id,
      departmentName: row.department_id
        ? departmentNames.get(row.department_id) ?? null
        : null,
      education: row.education,
      employmentStatus: row.employment_status,
      extraCostOfLiving: null,
      fullName: row.full_name,
      fuelAllowance: null,
      grossSalary: null,
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_hr_id
        ? managerNames.get(row.manager_hr_id) ?? null
        : null,
      medicalInsurance: null,
      mobileNumber: row.mobile_number,
      nameAr: row.name_ar,
      netSalary: null,
      salaryPaymentMode: "one_part",
      positionId: row.position_id,
      positionTitle: row.position_id
        ? positionTitles.get(row.position_id) ?? null
        : null,
      residenceAddress: residence?.residence_address ?? null,
      residenceArea: residence?.residence_area ?? null,
      residenceCity: residence?.residence_city ?? null,
      residenceGeocodeStatus: residence?.geocode_status ?? null,
      residenceLatitude: residence?.residence_latitude ?? null,
      residenceLongitude: residence?.residence_longitude ?? null,
      regionName: row.region_name ?? null,
      socialInsurance: null,
      subscriptionWage: null,
      taxes: null,
      teamId: row.team_id,
      updatedAt: row.updated_at,
      workEmail: row.work_email,
      // Phase 1: New employee data fields
      nationalIdNumber: row.national_id_number ?? null,
      addressFromIdCard: row.address_from_id_card ?? null,
      personalEmail: row.personal_email ?? null,
      emergencyContactName: row.emergency_contact_name ?? null,
      emergencyContactPhone: row.emergency_contact_phone ?? null,
      employeeType: row.employee_type ?? null,
      bankAccountNumber: null,
      bankName: null,
    };
  });
}

async function employeePayload(input: EmployeeMutationInput, isUpdate: boolean) {
  const fullName = compact(input.fullName);
  if (!fullName) {
    throw new Error("Full name is required.");
  }

  const lineId = numberOrNull(input.lineId);
  let hrId = compact(input.hrId)?.toUpperCase();

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

  return {
    area_id: numberOrNull(input.areaId),
    crm_id: compact(input.crmId),
    crm_username: compact(input.crmUsername),
    department_id: numberOrNull(input.departmentId),
    education: compact(input.education),
    employment_status: compact(input.employmentStatus) ?? "active",
    full_name: fullName,
    hire_date: compact(input.hireDate),
    hr_id: hrId,
    job_title: compact(input.jobTitle),
    line_id: lineId,
    manager_hr_id: compact(input.managerHrId),
    mobile_number: compact(input.mobileNumber),
    name_ar: compact(input.nameAr),
    organogram_visible: true, // Requirement: Ensure employee appears in organogram
    payroll_eligible: true, // Requirement: Ensure employee is payroll eligible
    position_id: numberOrNull(input.positionId),
    updated_at: new Date().toISOString(),
    work_email: compact(input.workEmail)?.toLowerCase(),
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

export async function upsertEmployee(input: EmployeeMutationInput) {
  const hrId = compact(input.hrId)?.toUpperCase();
  let isUpdate = false;

  if (hrId) {
    const existing = await supabaseRest<Array<{ hr_id: string }>>(
      `employees?hr_id=eq.${hrId}&select=hr_id`,
    );
    isUpdate = existing.length > 0;
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

  const actions: Promise<unknown>[] = [
    upsertEmployeePaymentMode(payload.hr_id, input.salaryPaymentMode),
    upsertEmployeeResidenceLocation(input, payload.hr_id),
  ];

  // Requirement: closeVacancyForOffer should only run after a NEW employee is created
  if (!isUpdate) {
    actions.push(
      closeVacancyForOffer({
        area_id: payload.area_id,
        line_id: payload.line_id,
        manager_hr_id: payload.manager_hr_id,
        position_id: payload.position_id,
      }),
    );
  }

  await Promise.all(actions);

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

  const payload = {
    ...(values.areaId !== undefined ? { area_id: numberOrNull(values.areaId) } : {}),
    ...(values.departmentId !== undefined
      ? { department_id: numberOrNull(values.departmentId) }
      : {}),
    ...(values.employmentStatus !== undefined
      ? { employment_status: compact(values.employmentStatus) }
      : {}),
    ...(values.lineId !== undefined ? { line_id: numberOrNull(values.lineId) } : {}),
    ...(values.managerHrId !== undefined
      ? { manager_hr_id: compact(values.managerHrId) }
      : {}),
    ...(values.positionId !== undefined
      ? { position_id: numberOrNull(values.positionId) }
      : {}),
    updated_at: new Date().toISOString(),
  };

  return supabaseRest<EmployeeDbRow[]>(
    `employees?hr_id=${encodeURIComponent(textInFilter(cleanedHrIds))}`,
    {
      body: JSON.stringify(payload),
      headers: {
        Prefer: "return=representation",
      },
      method: "PATCH",
    },
  );
}
