import crypto from "crypto";

import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { sendJobOfferEmail } from "@/lib/offers/email";
import { getOfferTemplate } from "@/lib/offers/templates";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";

export type OfferStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

export type OfferLifecycleInput = {
  areaId?: number | null;
  areaScope?: string | null;
  candidateEmail: string;
  candidateName: string;
  candidatePhone?: string | null;
  createdByHrId?: string | null;
  departmentId?: number | null;
  expiresInDays?: number | null;
  jobTitle: string;
  lineId?: number | null;
  managerHrId?: string | null;
  positionId?: number | null;
  salaryAmount?: number | null;
  startDate?: string | null;
  templateKey?: string | null;
};

type OfferDbRow = {
  accepted_at: string | null;
  area_id: number | null;
  area_scope: string | null;
  candidate_email: string;
  candidate_name: string;
  candidate_phone: string | null;
  created_at: string;
  department_id: number | null;
  employee_hr_id: string | null;
  expires_at: string;
  id: string;
  job_title: string;
  line_id: number | null;
  manager_hr_id: string | null;
  offer_code: string;
  onboarding_status: string;
  position_id: number | null;
  rejected_at: string | null;
  salary_amount: number | null;
  start_date: string | null;
  status: OfferStatus;
  template_key: string | null;
  updated_at: string;
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
  medicalRepVacancies: VacancyLookupRow[];
};

export type OfferLifecycleRow = {
  acceptedAt: string | null;
  areaId: number | null;
  areaScope: string | null;
  candidateEmail: string;
  candidateName: string;
  candidatePhone: string | null;
  createdAt: string;
  departmentId: number | null;
  departmentName: string | null;
  employeeHrId: string | null;
  expiresAt: string;
  id: string;
  jobTitle: string;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  offerCode: string;
  onboardingStatus: string;
  positionId: number | null;
  rejectedAt: string | null;
  salaryAmount: number | null;
  startDate: string | null;
  status: OfferStatus;
  templateKey: string | null;
  updatedAt: string;
};

export type OfferDashboardData = {
  rows: OfferLifecycleRow[];
  summary: {
    acceptanceRate: number;
    acceptedOffers: number;
    averageHoursToAccept: number;
    pendingOffers: number;
    rejectedOffers: number;
    totalOffers: number;
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

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOrNull(value: string | null | undefined) {
  const text = compact(value);
  return text ? text : null;
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
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
  filled_by_hr_id?: string | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  position_id?: number | null;
}) {
  const compactManagerHrId = compact(input.manager_hr_id);
  if (
    input.area_id === null || input.area_id === undefined ||
    input.line_id === null || input.line_id === undefined ||
    input.position_id === null || input.position_id === undefined ||
    !compactManagerHrId
  ) {
    return null;
  }

  const matchParams = (select: string) =>
    new URLSearchParams({
      area_id: `eq.${input.area_id}`,
      line_id: `eq.${input.line_id}`,
      manager_hr_id: `eq.${compactManagerHrId}`,
      order: "created_at.asc",
      position_id: `eq.${input.position_id}`,
      select,
      status: "eq.open",
    });

  let matches: Array<{ id: number; replacement_for_hr_id?: string | null }>;
  try {
    matches = await supabaseRest(
      `position_vacancies?${matchParams("id,replacement_for_hr_id")}`,
    );
  } catch (error) {
    const message = offerErrorMessage(error).toLowerCase();
    if (!message.includes("replacement_for_hr_id") && !message.includes("schema cache")) {
      throw error;
    }
    matches = await supabaseRest(`position_vacancies?${matchParams("id")}`);
  }

  const vacancy = matches[0];
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
    if (!message.includes("filled_by_hr_id") && !message.includes("filled_at") && !message.includes("schema cache")) {
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
  const [departments, employees, lines, areas, positions, medicalRepVacancies] = await Promise.all([
    loadAllOptions("departments"),
    supabaseRest<LookupRow[]>(
      `employees?${new URLSearchParams({ order: "full_name.asc", select: "hr_id,full_name" })}`,
    ),
    loadAllOptions("lines"),
    loadAllOptions("areas"),
    supabaseRest<LookupRow[]>(
      `positions?${new URLSearchParams({ order: "title.asc", select: "id,title" })}`,
    ),
    getOpenMedicalRepVacancies(),
  ]);

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
    areaId: row.area_id,
    areaScope: row.area_scope,
    candidateEmail: row.candidate_email,
    candidateName: row.candidate_name,
    candidatePhone: row.candidate_phone,
    createdAt: row.created_at,
    departmentId: row.department_id,
    departmentName: row.department_id ? lookups.departments.get(row.department_id) ?? null : null,
    employeeHrId: row.employee_hr_id,
    expiresAt: row.expires_at,
    id: row.id,
    jobTitle: row.job_title,
    lineId: row.line_id,
    lineName: row.line_id ? lookups.lines.get(row.line_id) ?? null : null,
    managerHrId: row.manager_hr_id,
    managerName: row.manager_hr_id ? lookups.managers.get(row.manager_hr_id) ?? null : null,
    offerCode: row.offer_code,
    onboardingStatus: row.onboarding_status,
    positionId: row.position_id,
    rejectedAt: row.rejected_at,
    salaryAmount: row.salary_amount,
    startDate: row.start_date,
    status: row.status,
    templateKey: row.template_key,
    updatedAt: row.updated_at,
  }));
}

async function getOfferByToken(token: string) {
  const params = new URLSearchParams({
    secure_token_hash: `eq.${hashToken(token)}`,
    select:
      "id,offer_code,candidate_name,candidate_email,candidate_phone,job_title,template_key,area_scope,area_id,department_id,line_id,manager_hr_id,position_id,salary_amount,start_date,expires_at,status,accepted_at,rejected_at,employee_hr_id,onboarding_status,created_at,updated_at",
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

export async function expireOutstandingOffers() {
  const now = new Date().toISOString();
  const params = new URLSearchParams({
    expires_at: `lt.${now}`,
    select: "id,status",
    status: "eq.sent",
  });
  const expired = await supabaseRest<Array<{ id: string }>>(`job_offers?${params}`);
  if (expired.length === 0) return 0;

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
    select:
      "id,offer_code,candidate_name,candidate_email,candidate_phone,job_title,template_key,area_scope,area_id,department_id,line_id,manager_hr_id,position_id,salary_amount,start_date,expires_at,status,accepted_at,rejected_at,employee_hr_id,onboarding_status,created_at,updated_at",
  });
  const rows = await hydrateOffers(await supabaseRest<OfferDbRow[]>(`job_offers?${params}`));
  const accepted = rows.filter((row) => row.status === "accepted");
  const final = rows.filter((row) => row.status === "accepted" || row.status === "rejected");
  const averageHoursToAccept =
    accepted.length === 0
      ? 0
      : accepted.reduce((sum, row) => {
          if (!row.acceptedAt) return sum;
          return sum + (new Date(row.acceptedAt).getTime() - new Date(row.createdAt).getTime()) / 36e5;
        }, 0) / accepted.length;

  return {
    rows,
    summary: {
      acceptanceRate: final.length ? accepted.length / final.length : 0,
      acceptedOffers: accepted.length,
      averageHoursToAccept,
      pendingOffers: rows.filter((row) => row.status === "sent").length,
      rejectedOffers: rows.filter((row) => row.status === "rejected").length,
      totalOffers: rows.length,
    },
    lookups: await getOfferLookups(),
  };
}

export async function createOffer(input: OfferLifecycleInput) {
  const token = createToken();
  const template = getOfferTemplate(input.templateKey);
  const expiresInDays = Math.max(1, Math.min(60, Number(input.expiresInDays ?? 7)));
  const payload = {
    area_scope: compact(input.areaScope),
    area_id: numberOrNull(input.areaId),
    candidate_email: input.candidateEmail.trim().toLowerCase(),
    candidate_name: input.candidateName.trim(),
    candidate_phone: compact(input.candidatePhone),
    created_by_hr_id: compact(input.createdByHrId),
    department_id: numberOrNull(input.departmentId),
    expires_at: daysFromNow(expiresInDays),
    job_title: input.jobTitle.trim() || template?.label || "Job Offer",
    line_id: numberOrNull(input.lineId),
    manager_hr_id: compact(input.managerHrId),
    offer_code: offerCode(),
    position_id: numberOrNull(input.positionId),
    salary_amount: numberOrNull(input.salaryAmount) ?? template?.monthlyPackage ?? null,
    secure_token_hash: hashToken(token),
    start_date: dateOrNull(input.startDate),
    status: "sent",
    template_key: template?.value ?? null,
    token_last_four: token.slice(-4),
  };

  const rows = await supabaseRest<OfferDbRow[]>("job_offers", {
    body: JSON.stringify(payload),
    headers: { Prefer: "return=representation" },
    method: "POST",
  });
  const offer = rows[0];
  await insertAudit(offer.id, "offer_sent", "hr", { expiresInDays }, input.createdByHrId);

  const baseUrl = publicBaseUrl();
  const acceptUrl = baseUrl ? `${baseUrl}/offers/${token}/accept` : "#";
  const rejectUrl = baseUrl ? `${baseUrl}/offers/${token}/reject` : "#";
  const hydratedOffer = (await hydrateOffers([offer]))[0];
  const offerEmailResult = await sendJobOfferEmail({
    acceptUrl,
    actionLinksEnabled: Boolean(baseUrl),
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
    reportingLine: hydratedOffer.lineName,
    territoryName: offer.area_scope,
    salaryAmount: offer.salary_amount,
    startDate: offer.start_date,
    template,
    territory: offer.area_scope,
  });

  return {
    acceptUrl,
    dashboard: await getOfferDashboard(),
    email: offerEmailResult,
    offer: hydratedOffer,
    rejectUrl,
  };
}

export async function decideOffer(token: string, decision: "accepted" | "rejected"): Promise<OfferActionResult> {
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

  if (offer.status === "accepted" || offer.status === "rejected") {
    return {
      alreadyFinal: true,
      message:
        offer.status === "accepted"
          ? "This offer was already accepted."
          : "This offer was already rejected.",
      offer: await hydrated(offer),
      status: offer.status,
    };
  }

  if (offer.status === "expired" || new Date(offer.expires_at).getTime() < Date.now()) {
    const expiredOffer =
      offer.status === "expired"
        ? offer
        : await updateOffer(offer.id, { expired_at: new Date().toISOString(), status: "expired" });
    await insertAudit(offer.id, "offer_expired_on_click", "candidate", { decision });
    return {
      alreadyFinal: false,
      message: "This offer has expired. Please contact HR for next steps.",
      offer: await hydrated(expiredOffer),
      status: "expired",
    };
  }

  const now = new Date().toISOString();
  const updated = await updateOffer(offer.id, {
    accepted_at: decision === "accepted" ? now : null,
    onboarding_status: decision === "accepted" ? "pending_hr_approval" : "not_started",
    rejected_at: decision === "rejected" ? now : null,
    status: decision,
  });

  await insertAudit(offer.id, `offer_${decision}`, "candidate", {
    occurredAt: now,
  });

  if (decision === "accepted") {
    await Promise.all([
      safeSendNotificationEmail({
        candidateEmail: offer.candidate_email,
        metrics: [
          { label: "Role", value: offer.job_title },
          { label: "Area", value: offer.area_scope ?? "To be assigned" },
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

  return {
    alreadyFinal: false,
    message:
      decision === "accepted"
        ? "Offer accepted successfully. HR will contact you shortly."
        : "Your response has been recorded. Thank you.",
    offer: await hydrated(updated),
    status: decision,
  };
}

export async function approveAcceptedOffer(
  id: string,
  approvedByHrId?: string | null,
  manualHrId?: string | null,
) {
  const params = new URLSearchParams({
    id: `eq.${id}`,
    select:
      "id,offer_code,candidate_name,candidate_email,candidate_phone,job_title,template_key,area_scope,area_id,department_id,line_id,manager_hr_id,position_id,salary_amount,start_date,expires_at,status,accepted_at,rejected_at,employee_hr_id,onboarding_status,created_at,updated_at",
  });
  const offer = (await supabaseRest<OfferDbRow[]>(`job_offers?${params}`))[0];

  if (!offer) throw new Error("Offer not found.");
  if (offer.status !== "accepted") throw new Error("Only accepted offers can be approved.");

  const template = getOfferTemplate(offer.template_key);
  const monthlyPackage = Number(offer.salary_amount ?? template?.monthlyPackage ?? 0);
  const standardAllowances = resolveStandardSalaryAllowances({
    jobTitle: offer.job_title,
  });
  const extraCostOfLiving = standardAllowances.extraCostOfLiving;
  const fuelAllowance = standardAllowances.fuelAllowance;

  const rpcResult = await supabaseRpc<{
    employee_hr_id: string;
    offer_id: string;
  }>("phx_approve_accepted_offer", {
    p_approved_by_hr_id: approvedByHrId ?? null,
    p_employee_hr_id: manualHrId ?? offer.employee_hr_id ?? null,
    p_extra_cost_of_living: extraCostOfLiving,
    p_fuel_allowance: fuelAllowance,
    p_gross_salary: monthlyPackage,
    p_offer_id: offer.id,
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

  return {
    dashboard: await getOfferDashboard(),
    offer: (await hydrateOffers([refreshedOffer]))[0],
  };
}
