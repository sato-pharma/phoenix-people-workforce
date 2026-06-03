import crypto from "crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { invalidateExecutiveDashboardCache } from "@/lib/dashboard/invalidation";
import { assertOfferWorkflowTransition } from "@/lib/employee-lifecycle/workflow";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { sendJobOfferEmail } from "@/lib/offers/email";
import { getOfferTemplate } from "@/lib/offers/templates";
import { pickDepartmentSafeVacancy } from "@/lib/offers/vacancy-matching";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import { summarizeOfferLifecycleRows } from "@/lib/recruitment/onboarding-metrics";

export type OfferStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "hired"
  | "withdrawn"
  | "cancelled"
  | "voided";

export type OfferCompensationLine = {
  category: "earning" | "deduction";
  id: string;
  label: string;
  notes: string | null;
  value: string;
  valueType: "amount";
};

export type OfferLifecycleInput = {
  areaId?: number | null;
  areaScope?: string | null;
  baseSalary?: number | null;
  compensationLines?: unknown;
  compensationNotes?: string | null;
  candidateEmail: string;
  candidateName: string;
  candidatePhone?: string | null;
  createdByHrId?: string | null;
  departmentId?: number | null;
  expiresInDays?: number | null;
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
  jobTitle: string;
  lineId?: number | null;
  managerHrId?: string | null;
  socialInsurance?: number | null;
  positionId?: number | null;
  salaryAmount?: number | null;
  startDate?: string | null;
  taxes?: number | null;
  templateKey?: string | null;
  vacancyId?: number | null;
};

type OfferDbRow = {
  accepted_at: string | null;
  accepted_terms_snapshot?: Record<string, unknown> | null;
  access_provisioning_error?: string | null;
  access_provisioning_status?: string | null;
  approval_repair_error?: string | null;
  approval_repair_status?: string | null;
  area_id: number | null;
  area_scope: string | null;
  base_salary?: number | null;
  basic_salary?: number | null;
  candidate_email: string;
  candidate_name: string;
  candidate_phone: string | null;
  cancelled_at?: string | null;
  compensation_lines?: unknown;
  compensation_notes?: string | null;
  created_at: string;
  department_id: number | null;
  employee_hr_id: string | null;
  expires_at: string;
  extra_cost_of_living?: number | null;
  fuel_allowance?: number | null;
  gross_salary?: number | null;
  id: string;
  job_title: string;
  line_id: number | null;
  manager_hr_id: string | null;
  net_salary?: number | null;
  offer_code: string;
  onboarding_status: string;
  position_id: number | null;
  rejected_at: string | null;
  reserved_employee_hr_id?: string | null;
  resend_count?: number | null;
  revoked_at?: string | null;
  salary_amount: number | null;
  social_insurance?: number | null;
  start_date: string | null;
  status: OfferStatus;
  taxes?: number | null;
  template_key: string | null;
  updated_at: string;
  vacancy_id?: number | null;
  withdrawn_at?: string | null;
  void_reason?: string | null;
  voided_at?: string | null;
  voided_reserved_employee_hr_id?: string | null;
};

type LookupRow = {
  full_name?: string | null;
  hr_id?: string;
  id?: number;
  name?: string | null;
};

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

export type OfferLookupData = {
  areas: Array<{
    label: string;
    value: string;
    lineId: number | null;
    positionId: number | null;
    managerHrId: string | null;
    departmentId: number | null;
  }>;
  departments: Array<{ label: string; value: string }>;
  lines: Array<{ label: string; value: string }>;
  managers: Array<{ label: string; value: string }>;
  positions: Array<{ label: string; value: string }>;
  openVacancies: VacancyLookupRow[];
  medicalRepVacancies: VacancyLookupRow[];
};

export type OfferLifecycleRow = {
  acceptedAt: string | null;
  accessProvisioningStatus?: string | null;
  approvalRepairStatus?: string | null;
  areaId: number | null;
  areaScope: string | null;
  baseSalary?: number | null;
  basicSalary?: number | null;
  candidateEmail: string;
  candidateName: string;
  candidatePhone: string | null;
  cancelledAt?: string | null;
  compensationLines?: OfferCompensationLine[];
  compensationNotes?: string | null;
  createdAt: string;
  departmentId: number | null;
  departmentName: string | null;
  employeeHrId: string | null;
  expiresAt: string;
  extraCostOfLiving?: number | null;
  fuelAllowance?: number | null;
  grossSalary?: number | null;
  id: string;
  jobTitle: string;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  netSalary?: number | null;
  offerCode: string;
  onboardingStatus: string;
  positionId: number | null;
  rejectedAt: string | null;
  reservedEmployeeHrId?: string | null;
  revokedAt?: string | null;
  salaryAmount: number | null;
  socialInsurance?: number | null;
  startDate: string | null;
  status: OfferStatus;
  taxes?: number | null;
  templateKey: string | null;
  updatedAt: string;
  vacancyId?: number | null;
  withdrawnAt?: string | null;
  voidReason?: string | null;
  voidedAt?: string | null;
  voidedReservedEmployeeHrId?: string | null;
};

export type OfferDashboardData = {
  rows: OfferLifecycleRow[];
  summary: {
    acceptanceRate: number;
    acceptedOffers: number;
    acceptedToEmployeeConversions: number;
    acceptedToEmployeeConversionRate: number;
    averageHoursToAccept: number;
    expiredOffers: number;
    pendingHrApprovalOffers: number;
    pendingOffers: number;
    rejectedOffers: number;
    totalOffers: number;
    vacancyLinkedOffers: number;
    vacancyLinkageRate: number;
  };
  lookups: OfferLookupData;
};

export type OfferActionResult = {
  alreadyFinal: boolean;
  message: string;
  offer: OfferLifecycleRow | null;
  status: "accepted" | "rejected" | "expired" | "invalid";
};

export type OfferDecisionPreview = {
  canSubmit: boolean;
  message: string;
  offer: OfferLifecycleRow | null;
  status: "accepted" | "pending" | "rejected" | "expired" | "invalid";
};

type OfferDecisionContext = {
  ip?: string | null;
  userAgent?: string | null;
};

const databaseQueryTimeoutMs = 15000;
const databaseQueryRetryMs = 30000;
const databaseQueryMaxAttempts = 2;

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function offerErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isOfferEnvMissing(error: unknown) {
  const message = offerErrorMessage(error);
  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

export function isOfferPublicUrlMissing(error: unknown) {
  const message = offerErrorMessage(error);
  return (
    message.includes("APP_URL or NEXT_PUBLIC_APP_URL is required") ||
    message.includes("APP_URL or NEXT_PUBLIC_APP_URL must be a public URL")
  );
}

export function isOfferSchemaMissing(error: unknown) {
  const message = offerErrorMessage(error).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export function isOfferTimeout(error: unknown) {
  return offerErrorMessage(error).toLowerCase().includes("timed out");
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

function dateOrNull(value: string | null | undefined) {
  const text = compact(value);
  return text ? text : null;
}

const terminalOfferStatuses = new Set<OfferStatus>([
  "cancelled",
  "expired",
  "hired",
  "rejected",
  "voided",
  "withdrawn",
]);

function isTerminalOfferStatus(status: OfferStatus | string | null | undefined) {
  return terminalOfferStatuses.has(status as OfferStatus);
}

const offerSelectColumns = [
  "id",
  "offer_code",
  "candidate_name",
  "candidate_email",
  "candidate_phone",
  "job_title",
  "template_key",
  "area_scope",
  "area_id",
  "department_id",
  "line_id",
  "manager_hr_id",
  "position_id",
  "salary_amount",
  "base_salary",
  "basic_salary",
  "gross_salary",
  "net_salary",
  "fuel_allowance",
  "extra_cost_of_living",
  "social_insurance",
  "taxes",
  "compensation_notes",
  "compensation_lines",
  "vacancy_id",
  "start_date",
  "expires_at",
  "status",
  "accepted_at",
  "accepted_terms_snapshot",
  "rejected_at",
  "revoked_at",
  "withdrawn_at",
  "cancelled_at",
  "voided_at",
  "void_reason",
  "voided_reserved_employee_hr_id",
  "employee_hr_id",
  "reserved_employee_hr_id",
  "resend_count",
  "onboarding_status",
  "access_provisioning_status",
  "access_provisioning_error",
  "approval_repair_status",
  "approval_repair_error",
  "created_at",
  "updated_at",
].join(",");

function positiveNumberOrNull(value: unknown) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeOfferCompensationLines(value: unknown): OfferCompensationLine[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const label = compact(String(record.label ?? ""));
    const amount = numberOrNull(record.value ?? record.amount);
    const category = String(record.category ?? "").toLowerCase() === "deduction" ? "deduction" : "earning";
    if (!label || amount === null || amount <= 0) return [];

    return [{
      category,
      id: compact(String(record.id ?? "")) ?? `offer-line-${index + 1}`,
      label: label.slice(0, 120),
      notes: compact(String(record.notes ?? "")),
      value: String(Math.round((amount + Number.EPSILON) * 100) / 100),
      valueType: "amount" as const,
    }];
  });
}

function compensationLineTotals(lines: OfferCompensationLine[]) {
  return lines.reduce(
    (totals, line) => {
      const value = Math.max(0, Number(line.value) || 0);
      if (line.category === "deduction") {
        totals.deductions += value;
      } else {
        totals.earnings += value;
      }
      return totals;
    },
    { deductions: 0, earnings: 0 },
  );
}

function resolveOfferCompensation(input: {
  baseSalary?: unknown;
  basicSalary?: unknown;
  compensationLines?: unknown;
  extraCostOfLiving?: unknown;
  fuelAllowance?: unknown;
  grossSalary?: unknown;
  jobTitle?: string | null;
  netSalary?: unknown;
  socialInsurance?: unknown;
  taxes?: unknown;
}) {
  const baseSalary = positiveNumberOrNull(input.baseSalary);
  const explicitExtraCostOfLiving = numberOrNull(input.extraCostOfLiving);
  const explicitFuelAllowance = numberOrNull(input.fuelAllowance);
  const socialInsurance = numberOrNull(input.socialInsurance);
  const taxes = numberOrNull(input.taxes);
  const compensationLines = normalizeOfferCompensationLines(input.compensationLines);
  const lineTotals = compensationLineTotals(compensationLines);
  const standardAllowances = resolveStandardSalaryAllowances({
    jobTitle: input.jobTitle,
  });
  const extraCostOfLiving = explicitExtraCostOfLiving ?? standardAllowances.extraCostOfLiving;
  const fuelAllowance = explicitFuelAllowance ?? standardAllowances.fuelAllowance;
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary,
    basicSalary: numberOrNull(input.basicSalary),
    employmentIncomeTax: taxes,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: numberOrNull(input.grossSalary),
    netSalary: numberOrNull(input.netSalary),
    socialInsurance,
  });

  if (fixedSalary.baseSalary <= 0) {
    return {
      baseSalary: null,
      basicSalary: null,
      extraCostOfLiving,
      fuelAllowance,
      grossSalary: null,
      netSalary: null,
      socialInsurance,
      taxes,
      compensationLines,
      customDeductions: lineTotals.deductions,
      customEarnings: lineTotals.earnings,
    };
  }

  return {
    baseSalary: fixedSalary.baseSalary,
    basicSalary: fixedSalary.basicSalary,
    compensationLines,
    customDeductions: lineTotals.deductions,
    customEarnings: lineTotals.earnings,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: fixedSalary.grossSalary,
    netSalary: Math.max(0, Math.round((fixedSalary.netSalary + lineTotals.earnings - lineTotals.deductions + Number.EPSILON) * 100) / 100),
    socialInsurance,
    taxes,
  };
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPublicSignal(value: string | null | undefined) {
  const text = compact(value);
  return text ? crypto.createHash("sha256").update(text).digest("hex") : null;
}

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function offerCode() {
  return `OFF-${new Date().getFullYear()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function publicBaseUrl() {
  const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

  if (!base) {
    return null;
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(base)) {
    return null;
  }

  return base;
}

function daysFromNow(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
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
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : `Supabase request failed with ${response.status}.`,
        );
      }

      return payload as T;
    } catch (error) {
      lastError = error;
      const message = offerErrorMessage(error).toLowerCase();
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

async function supabaseRpc<T>(fn: string, input: Record<string, unknown>): Promise<T> {
  return supabaseRest<T>(`rpc/${fn}`, {
    body: JSON.stringify(input),
    method: "POST",
  });
}

function textInFilter(values: string[]) {
  return `in.(${values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`;
}

function idInFilter(values: number[]) {
  return `in.(${values.join(",")})`;
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

async function loadAllOptions(table: string, label = "name") {
  const rows = await supabaseRest<LookupRow[]>(
    `${table}?${new URLSearchParams({ order: `${label}.asc`, select: `id,${label}` })}`,
  );

  return rows.map((row) => ({
    label: String(label === "title" ? row.name ?? "" : row.name ?? ""),
    value: String(row.id),
  }));
}

async function getOpenVacancies(): Promise<VacancyLookupRow[]> {
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
      const message = offerErrorMessage(error).toLowerCase();
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
    const message = offerErrorMessage(error).toLowerCase();
    if (
      message.includes("timed out") ||
      message.includes("relationship") ||
      message.includes("schema cache") ||
      message.includes("could not find")
    ) {
      return [];
    }

    throw error;
  }
}

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

export async function closeVacancyForOffer(input: {
  area_id?: number | null;
  department_id?: number | null;
  filled_by_hr_id?: string | null;
  line_id?: number | null;
  manager_name?: string | null;
  manager_hr_id?: string | null;
  position_id?: number | null;
  vacancy_id?: number | null;
}) {
  const compactManagerHrId = compact(input.manager_hr_id);
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
  // src/lib/offers/vacancy-matching.ts (see pickDepartmentSafeVacancy below).

  const findMatches = async (params: URLSearchParams) => {
    try {
      return await supabaseRest<VacancyCloseMatch[]>(
        `position_vacancies?${params}`,
      );
    } catch (error) {
      const message = offerErrorMessage(error).toLowerCase();
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

  if (!explicitVacancyId && compactManagerHrId) {
    const params = baseMatchParams("id,replacement_for_hr_id,department_id");
    params.set("manager_hr_id", `eq.${compactManagerHrId}`);
    matches = matches.length > 0 ? matches : await findMatches(params);
  }

  const resolvedManagerName =
    normalizeManagerName(input.manager_name) ??
    normalizeManagerName(await loadEmployeeFullName(compactManagerHrId));

  if (matches.length === 0 && resolvedManagerName && !explicitVacancyId) {
    const params = baseMatchParams("id,replacement_for_hr_id,department_id,manager_hr_id,manager_name");
    params.set("manager_hr_id", "is.null");
    const managerNameMatches = await findMatches(params);
    matches = managerNameMatches.filter(
      (vacancy) => normalizeManagerName(vacancy.manager_name) === resolvedManagerName,
    );
  }

  if (matches.length === 0 && compactManagerHrId === null && !explicitVacancyId) {
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
    const message = offerErrorMessage(error).toLowerCase();
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

export async function getOfferLookups(): Promise<OfferLookupData> {
  const [departments, employees, lines, areas, positions, openVacancies] = await Promise.all([
    loadAllOptions("departments"),
    supabaseRest<LookupRow[]>(
      `employees?${new URLSearchParams({ order: "full_name.asc", select: "hr_id,full_name" })}`,
    ),
    loadAllOptions("lines"),
    loadAllOptions("areas"),
    supabaseRest<LookupRow[]>(
      `positions?${new URLSearchParams({ order: "title.asc", select: "id,title" })}`,
    ),
    getOpenVacancies(),
  ]);
  const medicalRepVacancies = openVacancies.filter((vacancy) => {
    const normalizedTitle = `${vacancy.jobTitle ?? ""} ${vacancy.positionTitle ?? ""}`.toLowerCase();
    return (
      normalizedTitle.includes("medical representative") ||
      normalizedTitle.includes("medical rep") ||
      (normalizedTitle.includes("medical") && normalizedTitle.includes("representative"))
    );
  });

  return {
    areas: areas.map((a) => ({
      departmentId: null,
      label: a.label,
      lineId: null,
      managerHrId: null,
      positionId: null,
      value: a.value,
    })),
    departments,
    lines,
    managers: employees.map((row) => ({
      label: `${row.full_name ?? row.hr_id ?? ""}${row.hr_id ? ` (${row.hr_id})` : ""}`,
      value: String(row.hr_id ?? ""),
    })),
    medicalRepVacancies,
    openVacancies,
    positions: positions.map((row) => ({
      label: String((row as { title?: string }).title ?? row.name ?? ""),
      value: String(row.id),
    })),
  };
}

async function insertAudit(
  offerId: string,
  action: string,
  actorType: string,
  details: Record<string, unknown> = {},
  actorReference?: string | null,
) {
  await supabaseRest("job_offer_audit_logs", {
    body: JSON.stringify({
      action,
      actor_reference: actorReference ?? null,
      actor_type: actorType,
      details,
      offer_id: offerId,
    }),
    method: "POST",
  });
}

async function loadLookupMaps(rows: OfferDbRow[]) {
  const departmentIds = Array.from(
    new Set(rows.map((row) => row.department_id).filter((value): value is number => typeof value === "number")),
  );
  const lineIds = Array.from(
    new Set(rows.map((row) => row.line_id).filter((value): value is number => typeof value === "number")),
  );
  const managerHrIds = Array.from(
    new Set(rows.map((row) => row.manager_hr_id).filter((value): value is string => Boolean(value))),
  );

  const [departments, lines, managers] = await Promise.all([
    departmentIds.length
      ? supabaseRest<LookupRow[]>(`departments?${new URLSearchParams({ id: idInFilter(departmentIds), select: "id,name" })}`)
      : Promise.resolve([]),
    lineIds.length
      ? supabaseRest<LookupRow[]>(`lines?${new URLSearchParams({ id: idInFilter(lineIds), select: "id,name" })}`)
      : Promise.resolve([]),
    managerHrIds.length
      ? supabaseRest<LookupRow[]>(`employees?${new URLSearchParams({ hr_id: textInFilter(managerHrIds), select: "hr_id,full_name" })}`)
      : Promise.resolve([]),
  ]);

  return {
    departments: new Map(departments.map((row) => [Number(row.id), row.name ?? ""])),
    lines: new Map(lines.map((row) => [Number(row.id), row.name ?? ""])),
    managers: new Map(managers.map((row) => [String(row.hr_id), row.full_name ?? ""])),
  };
}

async function hydrateOffers(rows: OfferDbRow[]): Promise<OfferLifecycleRow[]> {
  const lookups = await loadLookupMaps(rows);

  return rows.map((row) => ({
    acceptedAt: row.accepted_at,
    accessProvisioningStatus: row.access_provisioning_status ?? null,
    approvalRepairStatus: row.approval_repair_status ?? null,
    areaId: row.area_id,
    areaScope: row.area_scope,
    baseSalary: row.base_salary ?? null,
    basicSalary: row.basic_salary ?? null,
    candidateEmail: row.candidate_email,
    candidateName: row.candidate_name,
    candidatePhone: row.candidate_phone,
    cancelledAt: row.cancelled_at ?? null,
    compensationLines: normalizeOfferCompensationLines(row.compensation_lines),
    compensationNotes: row.compensation_notes ?? null,
    createdAt: row.created_at,
    departmentId: row.department_id,
    departmentName: row.department_id ? lookups.departments.get(row.department_id) ?? null : null,
    employeeHrId: row.employee_hr_id,
    expiresAt: row.expires_at,
    extraCostOfLiving: row.extra_cost_of_living ?? null,
    fuelAllowance: row.fuel_allowance ?? null,
    grossSalary: row.gross_salary ?? null,
    id: row.id,
    jobTitle: row.job_title,
    lineId: row.line_id,
    lineName: row.line_id ? lookups.lines.get(row.line_id) ?? null : null,
    managerHrId: row.manager_hr_id,
    managerName: row.manager_hr_id ? lookups.managers.get(row.manager_hr_id) ?? null : null,
    netSalary: row.net_salary ?? null,
    offerCode: row.offer_code,
    onboardingStatus: row.onboarding_status,
    positionId: row.position_id,
    rejectedAt: row.rejected_at,
    reservedEmployeeHrId: row.reserved_employee_hr_id ?? null,
    revokedAt: row.revoked_at ?? null,
    salaryAmount: row.salary_amount,
    socialInsurance: row.social_insurance ?? null,
    startDate: row.start_date,
    status: row.status,
    taxes: row.taxes ?? null,
    templateKey: row.template_key,
    updatedAt: row.updated_at,
    vacancyId: row.vacancy_id ?? null,
    withdrawnAt: row.withdrawn_at ?? null,
    voidReason: row.void_reason ?? null,
    voidedAt: row.voided_at ?? null,
    voidedReservedEmployeeHrId: row.voided_reserved_employee_hr_id ?? null,
  }));
}

async function getOfferByToken(token: string) {
  const params = new URLSearchParams({
    secure_token_hash: `eq.${hashToken(token)}`,
    select: offerSelectColumns,
  });
  const rows = await supabaseRest<OfferDbRow[]>(`job_offers?${params}`);
  return rows[0] ?? null;
}

export async function getOfferDecisionPreview(token: string): Promise<OfferDecisionPreview> {
  const offer = await getOfferByToken(token);
  if (!offer) {
    return {
      canSubmit: false,
      message: "This offer link is invalid.",
      offer: null,
      status: "invalid",
    };
  }

  const hydratedOffer = (await hydrateOffers([offer]))[0] ?? null;

  if (offer.status === "accepted") {
    return {
      canSubmit: false,
      message: "This offer was already accepted.",
      offer: hydratedOffer,
      status: "accepted",
    };
  }

  if (offer.status === "rejected") {
    return {
      canSubmit: false,
      message: "This offer was already rejected.",
      offer: hydratedOffer,
      status: "rejected",
    };
  }

  if (offer.status === "hired" || offer.onboarding_status === "approved_hired") {
    return {
      canSubmit: false,
      message: "This offer has already been approved by HR.",
      offer: hydratedOffer,
      status: "accepted",
    };
  }

  if (offer.status === "withdrawn" || offer.status === "cancelled" || offer.status === "voided") {
    return {
      canSubmit: false,
      message: "This offer is closed. Please contact HR for next steps.",
      offer: hydratedOffer,
      status: "invalid",
    };
  }

  if (offer.status === "expired" || new Date(offer.expires_at).getTime() < Date.now()) {
    return {
      canSubmit: false,
      message: "This offer has expired. Please contact HR for next steps.",
      offer: hydratedOffer,
      status: "expired",
    };
  }

  return {
    canSubmit: true,
    message: "Please confirm your response below.",
    offer: hydratedOffer,
    status: "pending",
  };
}

async function updateOffer(id: string, payload: Record<string, unknown>) {
  const params = new URLSearchParams({ id: `eq.${id}` });
  const rows = await supabaseRest<OfferDbRow[]>(`job_offers?${params}`, {
    body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
    headers: { Prefer: "return=representation" },
    method: "PATCH",
  });
  return rows[0];
}

async function reserveOfferEmployeeHrId(offerId: string) {
  const result = await supabaseRpc<{ employee_hr_id: string; offer_id: string }>(
    "phx_reserve_offer_employee_hr_id",
    { p_offer_id: offerId },
  );
  return compact(result.employee_hr_id);
}

async function recordOfferDecisionEvent(input: {
  action: "accepted" | "rejected";
  details?: Record<string, unknown>;
  ipHash?: string | null;
  offerId: string;
  result: "blocked" | "recorded" | "rate_limited" | "terminal";
  userAgent?: string | null;
}) {
  await supabaseRest("job_offer_decision_events", {
    body: JSON.stringify({
      action: input.action,
      details: input.details ?? {},
      ip_hash: input.ipHash ?? null,
      offer_id: input.offerId,
      result: input.result,
      user_agent: input.userAgent?.slice(0, 500) ?? null,
    }),
    method: "POST",
  });
}

async function assertOfferDecisionRateLimit(input: {
  action: "accepted" | "rejected";
  ipHash: string | null;
  offerId: string;
}) {
  if (!input.ipHash) return;

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    action: `eq.${input.action}`,
    created_at: `gte.${since}`,
    ip_hash: `eq.${input.ipHash}`,
    offer_id: `eq.${input.offerId}`,
    select: "id",
  });
  const attempts = await supabaseRest<Array<{ id: number }>>(`job_offer_decision_events?${params}`);
  if (attempts.length >= 12) {
    await recordOfferDecisionEvent({
      action: input.action,
      ipHash: input.ipHash,
      offerId: input.offerId,
      result: "rate_limited",
    });
    throw new Error("Too many offer response attempts. Please try again later.");
  }
}

async function validateSelectedOfferVacancy(input: OfferLifecycleInput) {
  const vacancyId = numberOrNull(input.vacancyId);
  if (!vacancyId) {
    throw new Error("An explicit open vacancy must be selected before sending an offer.");
  }

  const params = new URLSearchParams({
    id: `eq.${vacancyId}`,
    select: "id,department_id,position_id,line_id,area_id,manager_hr_id,status",
  });
  const vacancy = (await supabaseRest<Array<{
    area_id: number | null;
    department_id: number | null;
    id: number;
    line_id: number | null;
    manager_hr_id: string | null;
    position_id: number | null;
    status: string;
  }>>(`position_vacancies?${params}`))[0];

  if (!vacancy || vacancy.status !== "open") {
    throw new Error("Selected vacancy is no longer open.");
  }

  const checks: Array<[string, unknown, unknown]> = [
    ["department", input.departmentId, vacancy.department_id],
    ["position", input.positionId, vacancy.position_id],
    ["line", input.lineId, vacancy.line_id],
    ["area", input.areaId, vacancy.area_id],
  ];
  for (const [label, selected, actual] of checks) {
    if (numberOrNull(selected) !== numberOrNull(actual)) {
      throw new Error(`Selected vacancy does not match the ${label}.`);
    }
  }

  const selectedManager = compact(input.managerHrId);
  const vacancyManager = compact(vacancy.manager_hr_id);
  if (selectedManager && vacancyManager && selectedManager.toLowerCase() !== vacancyManager.toLowerCase()) {
    throw new Error("Selected vacancy does not match the manager.");
  }
}

export async function markOfferPostApprovalStatus(
  offerId: string,
  input: {
    accessProvisioningError?: string | null;
    accessProvisioningStatus: "failed" | "skipped" | "succeeded";
  },
) {
  const repairFailed = input.accessProvisioningStatus === "failed";
  await updateOffer(offerId, {
    access_provisioning_error: input.accessProvisioningError ?? null,
    access_provisioning_status: input.accessProvisioningStatus,
    approval_repair_error: repairFailed ? input.accessProvisioningError ?? "Access provisioning failed." : null,
    approval_repair_status: repairFailed ? "needs_repair" : "complete",
  });
}

export async function expireOutstandingOffers() {
  const now = new Date().toISOString();
  const params = new URLSearchParams({
    expires_at: `lt.${now}`,
    select: "id,status",
    status: "eq.sent",
  });
  const expired = await supabaseRest<Array<{ id: string }>>(`job_offers?${params}`);
  if (expired.length === 0) return 0;
  await assertOfferWorkflowTransition({
    action: "expire",
    expectedNextStatus: "offer_expired",
    status: "sent",
  });

  const updateParams = new URLSearchParams({
    expires_at: `lt.${now}`,
    status: "eq.sent",
  });
  await supabaseRest(`job_offers?${updateParams}`, {
    body: JSON.stringify({ expired_at: now, status: "expired", updated_at: now }),
    method: "PATCH",
  });
  await Promise.all(
    expired.map((offer) => insertAudit(offer.id, "offer_expired", "system", { expiredAt: now })),
  );
  return expired.length;
}

export async function getOfferDashboard(): Promise<OfferDashboardData> {
  await expireOutstandingOffers();
  const params = new URLSearchParams({
    order: "created_at.desc",
    select: offerSelectColumns,
  });
  const rows = await hydrateOffers(await supabaseRest<OfferDbRow[]>(`job_offers?${params}`));
  const summary = summarizeOfferLifecycleRows(rows);

  return {
    rows,
    summary,
    lookups: await getOfferLookups(),
  };
}

export async function createOffer(input: OfferLifecycleInput, access?: Pick<AccessContext, "role">) {
  const token = createToken();
  const template = getOfferTemplate(input.templateKey);
  const requestedExpiry = Number(input.expiresInDays ?? 7);
  if (!Number.isFinite(requestedExpiry) || requestedExpiry < 1 || requestedExpiry > 60) {
    throw new Error("Offer expiry must be between 1 and 60 days.");
  }
  const expiresInDays = requestedExpiry;
  const compensation = resolveOfferCompensation({
    baseSalary: input.baseSalary,
    compensationLines: input.compensationLines,
    extraCostOfLiving: input.extraCostOfLiving,
    fuelAllowance: input.fuelAllowance,
    jobTitle: input.jobTitle || template?.label,
    socialInsurance: input.socialInsurance,
    taxes: input.taxes,
  });
  await assertOfferWorkflowTransition({
    access,
    action: "create",
    expectedNextStatus: "offer_sent",
    status: "draft",
  });
  await validateSelectedOfferVacancy(input);
  if (!dateOrNull(input.startDate)) {
    throw new Error("Hiring date is required before sending an offer.");
  }
  if (!compensation.baseSalary || compensation.baseSalary <= 0) {
    throw new Error("Base salary must be greater than zero.");
  }
  const payload = {
    area_scope: compact(input.areaScope),
    area_id: numberOrNull(input.areaId),
    base_salary: compensation.baseSalary,
    basic_salary: compensation.basicSalary,
    candidate_email: input.candidateEmail.trim().toLowerCase(),
    candidate_name: input.candidateName.trim(),
    candidate_phone: compact(input.candidatePhone),
    compensation_lines: compensation.compensationLines,
    compensation_notes: compact(input.compensationNotes),
    created_by_hr_id: compact(input.createdByHrId),
    department_id: numberOrNull(input.departmentId),
    expires_at: daysFromNow(expiresInDays),
    extra_cost_of_living: compensation.extraCostOfLiving,
    fuel_allowance: compensation.fuelAllowance,
    gross_salary: compensation.grossSalary,
    job_title: input.jobTitle.trim() || template?.label || "Job Offer",
    line_id: numberOrNull(input.lineId),
    manager_hr_id: compact(input.managerHrId),
    net_salary: compensation.netSalary,
    offer_code: offerCode(),
    position_id: numberOrNull(input.positionId),
    salary_amount: compensation.netSalary ?? numberOrNull(input.salaryAmount) ?? template?.monthlyPackage ?? null,
    secure_token_hash: hashToken(token),
    social_insurance: compensation.socialInsurance,
    start_date: dateOrNull(input.startDate),
    status: "sent",
    taxes: compensation.taxes,
    template_key: template?.value ?? null,
    token_last_four: token.slice(-4),
    vacancy_id: numberOrNull(input.vacancyId),
  };

  const rows = await supabaseRest<OfferDbRow[]>("job_offers", {
    body: JSON.stringify(payload),
    headers: { Prefer: "return=representation" },
    method: "POST",
  });
  const offer = rows[0];
  await insertAudit(offer.id, "offer_sent", "hr", { expiresInDays }, input.createdByHrId);

  const baseUrl = publicBaseUrl();
  const reviewUrl = baseUrl ? `${baseUrl}/offers/${token}/details` : "#";
  const acceptUrl = baseUrl ? `${baseUrl}/offers/${token}/accept` : "#";
  const rejectUrl = baseUrl ? `${baseUrl}/offers/${token}/reject` : "#";
  const hydratedOffer = (await hydrateOffers([offer]))[0];
  const offerEmailResult = await sendJobOfferEmail({
    acceptUrl,
    actionLinksEnabled: Boolean(baseUrl),
    baseSalary: offer.base_salary,
    basicSalary: offer.basic_salary,
    candidateEmail: offer.candidate_email,
    candidateName: offer.candidate_name,
    declineUrl: rejectUrl,
    expiresAt: offer.expires_at,
    jobTitle: offer.job_title,
    offerCode: offer.offer_code,
    reportingManager:
      hydratedOffer.managerName ||
      template?.defaultReportingTo ||
      "the assigned manager",
    issuedAt: offer.created_at,
    netSalary: offer.net_salary,
    reportingLine: hydratedOffer.lineName,
    reviewUrl,
    territoryName: offer.area_scope,
    salaryAmount: offer.salary_amount,
    startDate: offer.start_date,
    template,
    territory: offer.area_scope,
  });
  invalidateExecutiveDashboardCache("offer created", ["offers", "recruitment"]);

  return {
    acceptUrl,
    dashboard: await getOfferDashboard(),
    email: offerEmailResult,
    offer: hydratedOffer,
    rejectUrl,
    reviewUrl,
  };
}

export async function runOfferAdminAction(
  id: string,
  action: "cancel" | "resend" | "void" | "withdraw",
  actorHrId?: string | null,
  input: { reason?: string | null } = {},
) {
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: offerSelectColumns,
  });
  const offer = (await supabaseRest<OfferDbRow[]>(`job_offers?${params}`))[0];
  if (!offer) throw new Error("Offer not found.");

  if (action === "resend") {
    if (offer.status !== "sent") {
      throw new Error("Only sent offers can be resent.");
    }
    const token = createToken();
    const updated = await updateOffer(offer.id, {
      last_sent_at: new Date().toISOString(),
      resend_count: Number(offer.resend_count ?? 0) + 1,
      revoked_at: null,
      secure_token_hash: hashToken(token),
      token_last_four: token.slice(-4),
    });
    await insertAudit(offer.id, "offer_resent", "hr", { tokenLastFour: token.slice(-4) }, actorHrId);

    const baseUrl = publicBaseUrl();
    const hydratedOffer = (await hydrateOffers([updated]))[0];
    const template = getOfferTemplate(updated.template_key);
    const reviewUrl = baseUrl ? `${baseUrl}/offers/${token}/details` : "#";
    const acceptUrl = baseUrl ? `${baseUrl}/offers/${token}/accept` : "#";
    const rejectUrl = baseUrl ? `${baseUrl}/offers/${token}/reject` : "#";
    const email = await sendJobOfferEmail({
      acceptUrl,
      actionLinksEnabled: Boolean(baseUrl),
      baseSalary: updated.base_salary,
      basicSalary: updated.basic_salary,
      candidateEmail: updated.candidate_email,
      candidateName: updated.candidate_name,
      declineUrl: rejectUrl,
      expiresAt: updated.expires_at,
      jobTitle: updated.job_title,
      offerCode: updated.offer_code,
      reportingManager: hydratedOffer.managerName || template?.defaultReportingTo || "the assigned manager",
      issuedAt: updated.created_at,
      netSalary: updated.net_salary,
      reportingLine: hydratedOffer.lineName,
      reviewUrl,
      salaryAmount: updated.salary_amount,
      startDate: updated.start_date,
      template,
      territory: updated.area_scope,
      territoryName: updated.area_scope,
    });

    invalidateExecutiveDashboardCache("offer resent", ["offers", "recruitment"]);
    return {
      acceptUrl,
      dashboard: await getOfferDashboard(),
      email,
      offer: hydratedOffer,
      rejectUrl,
      reviewUrl,
    };
  }

  if (action === "void") {
    if (offer.status !== "accepted" || offer.onboarding_status === "approved_hired" || compact(offer.employee_hr_id)) {
      throw new Error("Only accepted offers pending HR approval can be voided.");
    }
    const reason = compact(input.reason);
    if (!reason) {
      throw new Error("A void reason is required.");
    }
    const now = new Date().toISOString();
    const updated = await updateOffer(offer.id, {
      onboarding_status: "not_started",
      reserved_employee_hr_id: null,
      revoked_at: now,
      secure_token_hash: hashToken(`${offer.id}:voided:${now}`),
      status: "voided",
      void_reason: reason,
      voided_at: now,
      voided_reserved_employee_hr_id: compact(offer.reserved_employee_hr_id),
    });
    await insertAudit(offer.id, "offer_voided", "hr", {
      reason,
      revokedAt: now,
      voidedReservedEmployeeHrId: offer.reserved_employee_hr_id ?? null,
    }, actorHrId);

    invalidateExecutiveDashboardCache("offer voided", ["offers", "recruitment"]);
    return {
      dashboard: await getOfferDashboard(),
      offer: (await hydrateOffers([updated]))[0],
    };
  }

  if (offer.status !== "sent" && offer.status !== "draft") {
    throw new Error("Only draft or sent offers can be closed by HR.");
  }

  const now = new Date().toISOString();
  const status = action === "withdraw" ? "withdrawn" : "cancelled";
  const updated = await updateOffer(offer.id, {
    cancelled_at: action === "cancel" ? now : null,
    onboarding_status: "not_started",
    revoked_at: now,
    secure_token_hash: `${hashToken(`${offer.id}:${status}:${now}`)}`,
    status,
    withdrawn_at: action === "withdraw" ? now : null,
  });
  await insertAudit(offer.id, `offer_${status}`, "hr", { revokedAt: now }, actorHrId);

  invalidateExecutiveDashboardCache("offer admin action", ["offers", "recruitment"]);
  return {
    dashboard: await getOfferDashboard(),
    offer: (await hydrateOffers([updated]))[0],
  };
}

export async function decideOffer(
  token: string,
  decision: "accepted" | "rejected",
  context: OfferDecisionContext = {},
): Promise<OfferActionResult> {
  const offer = await getOfferByToken(token);
  if (!offer) {
    return {
      alreadyFinal: false,
      message: "This offer link is invalid.",
      offer: null,
      status: "invalid",
    };
  }

  const hydrated = (row: OfferDbRow) => hydrateOffers([row]).then((rows) => rows[0]);
  const ipHash = hashPublicSignal(context.ip);
  const userAgent = compact(context.userAgent);
  await assertOfferDecisionRateLimit({ action: decision, ipHash, offerId: offer.id });

  if (isTerminalOfferStatus(offer.status) || offer.status === "accepted") {
    await recordOfferDecisionEvent({
      action: decision,
      details: { status: offer.status },
      ipHash,
      offerId: offer.id,
      result: "terminal",
      userAgent,
    });
    const finalStatus: OfferActionResult["status"] =
      offer.status === "hired" || offer.status === "accepted"
        ? "accepted"
        : offer.status === "rejected" || offer.status === "expired"
        ? offer.status
        : "invalid";

    return {
      alreadyFinal: true,
      message:
        offer.status === "hired"
          ? "This offer has already been approved by HR."
          : offer.status === "accepted"
          ? "This offer was already accepted."
          : offer.status === "rejected"
          ? "This offer was already rejected."
          : "This offer is closed. Please contact HR.",
      offer: await hydrated(offer),
      status: finalStatus,
    };
  }

  if (offer.status === "expired" || new Date(offer.expires_at).getTime() < Date.now()) {
    if (offer.status !== "expired") {
      await assertOfferWorkflowTransition({
        access: { role: "Employee" },
        action: "expire",
        expectedNextStatus: "offer_expired",
        status: offer.status,
      });
    }
    const expiredOffer =
      offer.status === "expired"
        ? offer
        : await updateOffer(offer.id, { expired_at: new Date().toISOString(), status: "expired" });
    await insertAudit(offer.id, "offer_expired_on_click", "candidate", { decision });
    await recordOfferDecisionEvent({
      action: decision,
      details: { status: "expired" },
      ipHash,
      offerId: offer.id,
      result: "blocked",
      userAgent,
    });
    return {
      alreadyFinal: false,
      message: "This offer has expired. Please contact HR for next steps.",
      offer: await hydrated(expiredOffer),
      status: "expired",
    };
  }

  const now = new Date().toISOString();
  await assertOfferWorkflowTransition({
    access: { role: "Employee" },
    action: decision === "accepted" ? "candidate_accept" : "candidate_reject",
    expectedNextStatus: decision === "accepted" ? "offer_accepted" : "offer_rejected",
    status: offer.status,
  });
  const reservedEmployeeHrId =
    decision === "accepted" ? await reserveOfferEmployeeHrId(offer.id) : null;
  const updated = await updateOffer(offer.id, {
    accepted_at: decision === "accepted" ? now : null,
    accepted_terms_snapshot:
      decision === "accepted"
        ? {
            areaId: offer.area_id,
            areaScope: offer.area_scope,
            baseSalary: offer.base_salary ?? null,
            basicSalary: offer.basic_salary ?? null,
            candidateEmail: offer.candidate_email,
            candidateName: offer.candidate_name,
            compensationLines: normalizeOfferCompensationLines(offer.compensation_lines),
            extraCostOfLiving: offer.extra_cost_of_living ?? null,
            fuelAllowance: offer.fuel_allowance ?? null,
            grossSalary: offer.gross_salary ?? null,
            jobTitle: offer.job_title,
            netSalary: offer.net_salary ?? offer.salary_amount,
            offerCode: offer.offer_code,
            socialInsurance: offer.social_insurance ?? null,
            startDate: offer.start_date,
            taxes: offer.taxes ?? null,
            vacancyId: offer.vacancy_id ?? null,
          }
        : null,
    decision_ip_hash: ipHash,
    decision_user_agent: userAgent,
    onboarding_status: decision === "accepted" ? "pending_hr_approval" : "not_started",
    rejected_at: decision === "rejected" ? now : null,
    reserved_employee_hr_id: reservedEmployeeHrId,
    status: decision,
  });

  await insertAudit(offer.id, `offer_${decision}`, "candidate", {
    ipHash,
    occurredAt: now,
    userAgent,
  });
  await recordOfferDecisionEvent({
    action: decision,
    details: { reservedEmployeeHrId },
    ipHash,
    offerId: offer.id,
    result: "recorded",
    userAgent,
  });

  if (decision === "accepted") {
    await Promise.all([
      safeSendNotificationEmail({
        candidateEmail: offer.candidate_email,
        metrics: [
          { label: "Role", value: offer.job_title },
          { label: "Area", value: offer.area_scope ?? "To be assigned" },
          { label: "Employee HR ID", value: reservedEmployeeHrId ?? "Pending" },
          { label: "Offer ID", value: offer.offer_code },
          { label: "Status", value: "Accepted" },
        ],
        notificationType: "offer",
        recipientMode: "candidate",
        subject: `Offer accepted: ${offer.job_title}`,
        summary: `Thank you ${offer.candidate_name}. Your acceptance has been confirmed and HR will contact you shortly.`,
        title: "Offer accepted successfully",
        tone: "success",
      }),
      safeSendNotificationEmail({
        ctaHref: "/offers",
        ctaLabel: "Open offers",
        metrics: [
          { label: "Candidate", value: offer.candidate_name },
          { label: "Role", value: offer.job_title },
          { label: "Area", value: offer.area_scope ?? "To be assigned" },
          { label: "Employee HR ID", value: reservedEmployeeHrId ?? "Pending" },
          { label: "Offer ID", value: offer.offer_code },
          { label: "Approval", value: "Pending HR approval" },
        ],
        notificationType: "offer",
        recipientMode: "hr_notifications",
        subject: `${offer.candidate_name} accepted ${offer.job_title}`,
        summary: "The candidate accepted the offer. Phoenix moved the record into the hired pipeline and prepared onboarding.",
        title: "Offer accepted",
        tone: "success",
      }),
    ]);
  } else {
    await safeSendNotificationEmail({
      ctaHref: "/offers",
      ctaLabel: "Open offers",
      metrics: [
        { label: "Candidate", value: offer.candidate_name },
        { label: "Role", value: offer.job_title },
        { label: "Area", value: offer.area_scope ?? "To be assigned" },
        { label: "Offer ID", value: offer.offer_code },
      ],
      notificationType: "offer",
      recipientMode: "hr_notifications",
      subject: `${offer.candidate_name} rejected ${offer.job_title}`,
      summary: "The candidate rejected the offer. The offer lifecycle record has been closed for reporting.",
      title: "Offer rejected",
      tone: "warning",
    });
  }

  invalidateExecutiveDashboardCache("offer candidate decision", ["offers", "recruitment"]);
  return {
    alreadyFinal: false,
    message:
      decision === "accepted"
        ? `Offer accepted successfully. Your HR ID is ${reservedEmployeeHrId ?? "pending HR assignment"}. HR will contact you shortly.`
        : "Your response has been recorded. Thank you.",
    offer: await hydrated(updated),
    status: decision,
  };
}

export async function approveAcceptedOffer(
  id: string,
  approvedByHrId?: string | null,
  manualHrId?: string | null,
  access?: Pick<AccessContext, "role">,
) {
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select: offerSelectColumns,
  });
  const offer = (await supabaseRest<OfferDbRow[]>(`job_offers?${params}`))[0];

  if (!offer) throw new Error("Offer not found.");
  if (offer.status === "hired" || offer.onboarding_status === "approved_hired") {
    const employeeHrId = compact(offer.employee_hr_id);
    if (!employeeHrId) {
      throw new Error("Offer is marked hired but does not have an employee HR ID.");
    }
    return {
      dashboard: await getOfferDashboard(),
      employeeHrId,
      offer: (await hydrateOffers([offer]))[0],
    };
  }
  if (offer.status !== "accepted") throw new Error("Only accepted offers can be approved.");
  await assertOfferWorkflowTransition({
    access,
    action: "hire_approve",
    expectedNextStatus: "offer_hired",
    onboardingStatus: offer.onboarding_status,
    status: offer.status,
  });

  const compensation = resolveOfferCompensation({
    baseSalary: offer.base_salary,
    basicSalary: offer.basic_salary,
    compensationLines: offer.compensation_lines,
    extraCostOfLiving: offer.extra_cost_of_living,
    fuelAllowance: offer.fuel_allowance,
    grossSalary: offer.gross_salary,
    jobTitle: offer.job_title,
    netSalary: offer.net_salary ?? offer.salary_amount,
    socialInsurance: offer.social_insurance,
    taxes: offer.taxes,
  });

  const rpcResult = await supabaseRpc<{
    already_hired?: boolean;
    employee_hr_id: string;
    offer_id: string;
    vacancy_id?: number | null;
  }>("phx_approve_accepted_offer", {
    p_approved_by_hr_id: approvedByHrId ?? null,
    p_base_salary: compensation.baseSalary,
    p_basic_salary: compensation.basicSalary,
    p_compensation_lines: compensation.compensationLines,
    p_employee_hr_id: manualHrId ?? offer.reserved_employee_hr_id ?? offer.employee_hr_id ?? null,
    p_extra_cost_of_living: compensation.extraCostOfLiving,
    p_fuel_allowance: compensation.fuelAllowance,
    p_gross_salary: compensation.grossSalary,
    p_net_salary: compensation.netSalary,
    p_offer_id: offer.id,
    p_social_insurance: compensation.socialInsurance,
    p_taxes: compensation.taxes,
  });
  const employeeHrId = String(rpcResult.employee_hr_id);

  const refreshedOffer = (await supabaseRest<OfferDbRow[]>(`job_offers?${params}`))[0];
  if (!refreshedOffer) {
    throw new Error("Offer approval succeeded but the updated offer could not be reloaded.");
  }

  await safeSendNotificationEmail({
    ctaHref: "/employees",
    ctaLabel: "Open employee record",
    employeeHrId,
    metrics: [
      { label: "Candidate", value: offer.candidate_name },
      { label: "Role", value: offer.job_title },
      { label: "Employee HR ID", value: employeeHrId },
      { label: "Start date", value: offer.start_date ?? "Not set" },
    ],
    notificationType: "offer",
    recipientMode: "hr_notifications",
    subject: `${offer.candidate_name} approved as hired`,
    summary: "The accepted offer has been approved. Employee, organogram, compensation, and probation views are now fed from the approved record.",
    title: "Hire approved",
    tone: "success",
  });
  invalidateExecutiveDashboardCache("accepted offer approved", ["offers", "recruitment", "employees", "vacancies", "payroll", "probation"]);

  return {
    dashboard: await getOfferDashboard(),
    employeeHrId,
    offer: (await hydrateOffers([refreshedOffer]))[0],
  };
}
