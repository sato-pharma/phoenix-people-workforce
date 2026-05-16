import { NextResponse } from "next/server";
import { getEmployeeBalanceSummary, parseVacationRequest, type EmployeePortalVacationEmployee, type VacationRequestRecord, type VacationBalanceSummary } from "@/lib/leave/requests";
import { normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type ProxyPayload = {
  [key: string]: unknown;
};

type EmployeeRecord = {
  full_name?: unknown;
  hire_date?: unknown;
  hireDate?: unknown;
  hr_id?: unknown;
  employee_hr_id?: unknown;
  manager_hr_id?: unknown;
  work_email?: unknown;
  workEmail?: unknown;
  area_id?: unknown;
  line_id?: unknown;
  team_id?: unknown;
  area_name?: unknown;
  areaName?: unknown;
  line_name?: unknown;
  lineName?: unknown;
  lines?: {
    name?: unknown;
  } | null;
  team_name?: unknown;
  teamName?: unknown;
  teams?: {
    name?: unknown;
  } | null;
  areas?: unknown;
  team?: unknown;
  line?: unknown;
  name?: unknown;
  area?: unknown;
};

type AppAuthUserRecord = {
  hr_id?: string | null;
  line?: string | null;
  name?: string | null;
};

const workflowPath = "/api/vacation-requests/workflow";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHrId(value: string) {
  return cleanText(value).toLowerCase();
}

function buildHrIdCandidates(value: string) {
  const normalized = normalizeHrId(value);
  return normalized.length > 0 && normalized !== value ? [value, normalized] : [value];
}

function pickText(row: EmployeeRecord, keys: Array<keyof EmployeeRecord>) {
  for (const key of keys) {
    const value = cleanText(row[key]);
    if (value) return value;
  }
  return "";
}

function pickRelationName(value: unknown) {
  if (Array.isArray(value)) {
    const first = value[0];
    if (!first || typeof first !== "object") return "";
    return cleanText((first as { name?: unknown }).name);
  }
  if (!value || typeof value !== "object") return "";
  return cleanText((value as { name?: unknown }).name);
}

function toNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasMissingColumnError(error: unknown, columnName: string) {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "42703") return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("column") && message.includes("does not exist") && message.includes(columnName.toLowerCase());
}

async function resolveLookupNameById(input: { table: "areas" | "lines" | "teams"; id: number | null }) {
  const { table, id } = input;
  if (id === null) {
    return "";
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(table)
    .select("name")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return "";
  }

  return cleanText((data as { name?: unknown } | null)?.name);
}

function pickNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toEmployee(row: EmployeeRecord): EmployeePortalVacationEmployee {
  const hrId = pickText(row, ["hr_id", "employee_hr_id"]);
  return {
    areaName: pickRelationName(row.areas) || pickRelationName(row.area) || pickText(row, ["area_name", "areaName", "area"]),
    email: pickText(row, ["work_email", "workEmail"]),
    hireDate: pickText(row, ["hire_date", "hireDate"]),
    hrId,
    lineName: pickRelationName(row.lines) || pickRelationName(row.line) || pickText(row, ["line_name", "lineName", "line"]),
    name: pickText(row, ["full_name", "name"]),
    teamName: pickRelationName(row.teams) || pickRelationName(row.team) || pickText(row, ["team_name", "teamName", "team"]),
  };
}

function makeRequestHeaders(request: Request, includeContentType = false) {
  const source = request.headers;
  const originHeader = source.get("origin") ?? new URL(request.url).origin;
  const target = new Headers();
  const cookie = source.get("cookie");
  if (cookie) {
    target.set("cookie", cookie);
  }
  const requestId = source.get("x-request-id");
  if (requestId) {
    target.set("x-request-id", requestId);
  }
  const trimmedOrigin = originHeader.trim();
  if (trimmedOrigin) {
    target.set("origin", trimmedOrigin);
    target.set("referer", source.get("referer") ?? request.url);
  }
  if (includeContentType) {
    target.set("content-type", "application/json");
  }
  return target;
}

async function callWorkflow(request: Request, method: "GET" | "POST", body?: ProxyPayload) {
  const workflowUrl = new URL(workflowPath, request.url);
  const response = await fetch(workflowUrl, {
    method,
    headers: makeRequestHeaders(request, method === "POST"),
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { payload, response };
}

function normalizeErrorPayload(payload: Record<string, unknown>) {
  if (typeof payload.error === "string") {
    return payload.error;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  return "Request failed.";
}

async function resolveEmployeeHrIdFromWorkEmail(loginId: string, supabase: ReturnType<typeof getSupabaseAdmin>) {
  const loginText = cleanText(loginId);
  if (!loginText) return null;

  const { data, error } = await supabase
    .from("employees")
    .select("hr_id")
    .ilike("work_email", loginText)
    .maybeSingle();

  if (error) {
    return null;
  }

  return (data as { hr_id: string | null } | null)?.hr_id?.trim() || null;
}

async function resolveAuthRecordByHrId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  hrId: string,
) {
  const candidates = buildHrIdCandidates(cleanText(hrId));
  for (const candidate of candidates) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("hr_id,line,name")
      .eq("hr_id", candidate)
      .maybeSingle();
    if (data) {
      return data as AppAuthUserRecord | null;
    }
  }
  return null;
}

async function resolveEmployeeByHrId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  hrId: string,
) {
  const candidates = buildHrIdCandidates(cleanText(hrId));
  for (const candidate of candidates) {
    for (const column of ["hr_id", "employee_hr_id"] as const) {
      const result = await supabase
        .from("employees")
        .select("full_name,hire_date,hr_id,work_email,area_id,line_id,team_id,areas(name),lines(name),teams(name)")
        .ilike(column, candidate)
        .limit(1)
        .maybeSingle();

      if (result.data) {
        return result;
      }

      if (result.error) {
        if (column === "employee_hr_id" && hasMissingColumnError(result.error, "employee_hr_id")) {
          continue;
        }
        return { data: null, error: result.error };
      }
    }
  }

  return { data: null, error: null };
}

const profileNotFoundError = "Your employee profile could not be resolved from the current session.";
const sessionExpiredError = "Your session has expired or is missing. Please sign in again.";

type EmployeePortalIdentity = {
  employee: EmployeePortalVacationEmployee;
  requestsIdentity: {
    employeeEmail: string;
    employeeHireDate: string;
    employeeId: string;
    employeeName: string;
  };
};

type EmployeePortalIdentityResult =
  | { ok: true; value: EmployeePortalIdentity }
  | { ok: false; reason: "session" | "profile" };

function toEmployeeFromDirectory(row: EmployeeDirectoryRow): EmployeePortalVacationEmployee {
  return {
    areaName: cleanText(row.areaName),
    email: cleanText(row.workEmail),
    hireDate: cleanText(row.hireDate),
    hrId: cleanText(row.hrId),
    lineName: cleanText(row.lineName),
    name: cleanText(row.fullName),
    teamName: cleanText(row.teamName),
  };
}

async function resolveEmployeeFromDirectory(hrId: string) {
  const normalizedHrId = normalizeHrIdForAccess(hrId);
  if (!normalizedHrId) {
    return null;
  }

  const directory = await getEmployeeDirectory({ pageSize: -1 });
  return directory.employees.find((employee) => normalizeHrIdForAccess(employee.hrId) === normalizedHrId) ?? null;
}

async function resolveAuthenticatedEmployee(access: AccessContext): Promise<EmployeePortalIdentityResult> {
  if (!access.loginId && !access.hrId) {
    return { ok: false, reason: "session" };
  }

  const supabase = getSupabaseAdmin();
  const loginId = cleanText(access.loginId);
  let rawHrId = cleanText(access.hrId);
  let authRecord: AppAuthUserRecord | null = null;
  let authLine = "";

  if (loginId) {
    const { data: authRow } = await supabase
      .from("app_auth_users")
      .select("hr_id,line,name")
      .ilike("login_id", loginId)
      .maybeSingle();
    authRecord = authRow as AppAuthUserRecord | null;
    if (!rawHrId) {
      rawHrId = authRecord?.hr_id?.trim() || "";
    }
  }

  if (!rawHrId && loginId) {
    rawHrId = await resolveEmployeeHrIdFromWorkEmail(loginId, supabase);
  }

  if (!rawHrId && access.hrId) {
    rawHrId = cleanText(access.hrId);
  }

  if (!authRecord && rawHrId) {
    authRecord = await resolveAuthRecordByHrId(supabase, rawHrId);
  }

  authLine = cleanText(authRecord?.line);
  if (!rawHrId) {
    return { ok: false, reason: "profile" };
  }
  const { data: employeeRow, error: employeeError } = await resolveEmployeeByHrId(supabase, rawHrId);

  if (employeeError) {
    return { ok: false, reason: "profile" };
  }
  let resolvedEmployee: EmployeePortalVacationEmployee | null = null;

  if (employeeRow) {
    const row = employeeRow as EmployeeRecord;
    const employee = toEmployee(row);
    const fallbackName = cleanText(
      employee.name ||
      employeeRow["full_name"] ||
      authRecord?.name ||
      access.loginId ||
      rawHrId,
    );
    const [areaNameFromId, lineNameFromId, teamNameFromId] = await Promise.all([
      resolveLookupNameById({ id: toNumber(row.area_id), table: "areas" }),
      resolveLookupNameById({ id: toNumber(row.line_id), table: "lines" }),
      resolveLookupNameById({ id: toNumber(row.team_id), table: "teams" }),
    ]);
    resolvedEmployee = {
      areaName: employee.areaName || areaNameFromId,
      email: employee.email || "",
      hireDate: employee.hireDate || "",
      hrId: employee.hrId || rawHrId,
      lineName: employee.lineName || lineNameFromId || authLine || "",
      name: fallbackName,
      teamName: employee.teamName || teamNameFromId,
    };
  } else {
    const directoryEmployee = await resolveEmployeeFromDirectory(rawHrId);
    if (!directoryEmployee) {
      return { ok: false, reason: "profile" };
    }

    resolvedEmployee = {
      ...toEmployeeFromDirectory(directoryEmployee),
      hrId: cleanText(directoryEmployee.hrId) || rawHrId,
      lineName: cleanText(directoryEmployee.lineName) || authLine || "",
      name: cleanText(directoryEmployee.fullName) || authRecord?.name?.trim() || access.loginId || rawHrId,
    };
  }

  return {
    ok: true,
    value: {
      employee: resolvedEmployee,
      requestsIdentity: {
        employeeEmail: resolvedEmployee.email,
        employeeHireDate: resolvedEmployee.hireDate,
        employeeId: resolvedEmployee.hrId,
        employeeName: resolvedEmployee.name,
      },
    },
  };
}

function buildBalance(
  requests: VacationRequestRecord[],
  identity: {
    employeeEmail: string;
    employeeHireDate: string;
    employeeId: string;
    employeeName: string;
  }
): VacationBalanceSummary {
  return getEmployeeBalanceSummary({
    currentDate: new Date(),
    employee: identity,
    records: requests,
  });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const resolved = await resolveAuthenticatedEmployee(access);
    if (resolved.ok === false) {
      return NextResponse.json(
        { error: resolved.reason === "session" ? sessionExpiredError : profileNotFoundError },
        { status: resolved.reason === "session" ? 401 : 403 },
      );
    }
    const identity = resolved.value;
    const { payload, response } = await callWorkflow(request, "GET");
    if (!response.ok) {
      return NextResponse.json({
        error: normalizeErrorPayload(payload),
      }, { status: response.status });
    }
    const rawRequests = Array.isArray(payload.requests) ? payload.requests : [];
    const parsed = rawRequests
      .map((row) => parseVacationRequest(row))
      .filter((request): request is VacationRequestRecord => request !== null)
      .filter((request) => normalizeHrIdForAccess(request.employeeId) === normalizeHrIdForAccess(identity.employee.hrId));
    const balance = buildBalance(parsed, identity.requestsIdentity);
    return NextResponse.json({
      balance,
      employee: identity.employee,
      requests: parsed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load vacation requests." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ProxyPayload;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ success: false, error: "Invalid request payload." }, { status: 400 });
    }
    const requestBody = {
      action: typeof body.action === "string" && body.action.trim().length > 0 ? body.action : "submit",
      ...body,
    };
    const { payload, response } = await callWorkflow(request, "POST", requestBody);
    const success = Boolean(payload.success);
    if (!response.ok || !success) {
      return NextResponse.json(
        {
          success,
          error: normalizeErrorPayload(payload),
          warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
        },
        { status: response.status },
      );
    }
    const requestSnapshot = (payload as Record<string, unknown>).data as
      | {
          requestSnapshot?: VacationRequestRecord;
          [key: string]: unknown;
        }
      | undefined;
    const requestRecord = requestSnapshot?.requestSnapshot;
    if (!requestRecord) {
      return NextResponse.json(
        { success: false, error: "Unable to process submit response." },
        { status: 502 },
      );
    }
    const remaining = (requestRecord as VacationRequestRecord | Record<string, unknown>).remainingPaidBalanceAtSubmission;
    return NextResponse.json({
      balance: {
        currentAvailable: pickNumber(remaining),
      },
      request: requestRecord,
      success: true,
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to submit vacation request." },
      { status: 500 },
    );
  }
}
