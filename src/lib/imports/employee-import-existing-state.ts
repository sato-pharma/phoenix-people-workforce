import type {
  ExistingImportState,
  ExistingTeamLookup,
} from "@/lib/imports/employee-import-types";
import { createOrgCode } from "@/lib/imports/org-rule-engine";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const activeImportManagerStatuses = new Set(["active", "on_leave"]);

function normalizeStatus(value: unknown) {
  return String(value ?? "active").trim().toLowerCase() || "active";
}

function isActiveManager(row: {
  employment_status?: string | null;
  organogram_visible?: boolean | null;
  payroll_eligible?: boolean | null;
}) {
  return (
    activeImportManagerStatuses.has(normalizeStatus(row.employment_status)) &&
    row.organogram_visible !== false &&
    row.payroll_eligible !== false
  );
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

async function loadPositionTitleMap(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("positions").select("id,title");

  if (error) {
    return new Map<number, string>();
  }

  return new Map(
    ((data ?? []) as Array<{ id: number | null; title: string | null }>)
      .flatMap((row) => row.id && row.title ? [[row.id, row.title] as const] : []),
  );
}

async function loadCodeSet(supabase: SupabaseClient, table: string) {
  const { data, error } = await supabase.from(table).select("code");
  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ code: string | null }>).flatMap((row) =>
      row.code ? [String(row.code)] : [],
    ),
  );
}

function normalizeDepartmentKey(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function teamAreaKey(name: string, areaCode: string | null) {
  return `${normalizeDepartmentKey(name)}::${areaCode ?? ""}`;
}

async function loadActiveDepartments(supabase: SupabaseClient) {
  let result = await supabase.from("departments").select("code,name,is_active");

  if (result.error && result.error.message.toLowerCase().includes("is_active")) {
    result = await supabase.from("departments").select("code,name");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  const codeToName = new Map<string, string>();
  const nameToCode = new Map<string, string>();

  for (const row of (result.data ?? []) as Array<{ code: string | null; is_active?: boolean | null; name: string | null }>) {
    if (row.is_active === false || !row.name) {
      continue;
    }

    const code = String(row.code ?? row.name).trim();
    const name = String(row.name).trim();

    if (!code || !name) {
      continue;
    }

    codeToName.set(code, name);
    nameToCode.set(normalizeDepartmentKey(name), code);
    nameToCode.set(normalizeDepartmentKey(code), code);
  }

  return { codeToName, nameToCode };
}

async function loadEmployeeState(supabase: SupabaseClient) {
  let result = await supabase
    .from("employees")
    .select("hr_id,crm_id,employment_status,organogram_visible,payroll_eligible,job_title,position_id");

  if (
    result.error &&
    (result.error.message.toLowerCase().includes("organogram_visible") ||
      result.error.message.toLowerCase().includes("payroll_eligible"))
  ) {
    result = await supabase.from("employees").select("hr_id,crm_id,employment_status,job_title,position_id");
  }

  if (result.error && result.error.message.toLowerCase().includes("crm_id")) {
    result = await supabase.from("employees").select("hr_id,employment_status,job_title,position_id");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = (result.data ?? []) as Array<{
    crm_id?: string | null;
    employment_status?: string | null;
    hr_id: string | null;
    job_title?: string | null;
    organogram_visible?: boolean | null;
    payroll_eligible?: boolean | null;
    position_id?: number | null;
  }>;
  const crmIdToHrId = new Map<string, string>();
  const positionTitleById = await loadPositionTitleMap(supabase);

  for (const row of rows) {
    const crmId = String(row.crm_id ?? "").trim().toLowerCase();
    const hrId = row.hr_id ? String(row.hr_id).trim().toUpperCase() : null;

    if (crmId && hrId) {
      crmIdToHrId.set(crmId, hrId);
    }
  }

  return {
    crmIdToHrId,
    employeeHrIds: new Set(
      rows.flatMap((row) => (row.hr_id ? [String(row.hr_id).trim().toUpperCase()] : [])),
    ),
    managerHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id &&
        isActiveManager(row) &&
        isManagerialTitle(`${positionTitleById.get(Number(row.position_id)) ?? ""} ${row.job_title ?? ""}`)
          ? [String(row.hr_id).trim().toUpperCase()]
          : [],
      ),
    ),
    terminalEmployeeHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id && !isActiveManager(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
      ),
    ),
    protectedLifecycleHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id && !isActiveManager(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
      ),
    ),
  };
}

async function loadAreaState(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("areas").select("id,code,name");

  if (error) {
    throw new Error(error.message);
  }

  const areaCodes = new Set<string>();
  const areaCodeToId = new Map<string, number>();
  const areaIdToCode = new Map<number, string>();

  for (const row of (data ?? []) as Array<{ code: string | null; id: number | null; name: string | null }>) {
    const code = String(row.code ?? createOrgCode(row.name) ?? "").trim();
    const id = Number(row.id);

    if (!code || !Number.isFinite(id)) {
      continue;
    }

    areaCodes.add(code);
    areaCodeToId.set(code, id);
    areaIdToCode.set(id, code);
  }

  return { areaCodeToId, areaCodes, areaIdToCode };
}

async function loadTeamRows(supabase: SupabaseClient) {
  let result = await supabase.from("teams").select("id,code,name,area_id,is_active");

  if (
    result.error &&
    (result.error.message.toLowerCase().includes("is_active") ||
      result.error.message.toLowerCase().includes("area_id") ||
      result.error.message.toLowerCase().includes("code"))
  ) {
    result = await supabase.from("teams").select("id,name");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  return (result.data ?? []) as Array<{
    area_id?: number | null;
    code?: string | null;
    id: number | null;
    is_active?: boolean | null;
    name: string | null;
  }>;
}

async function loadTeamState(
  supabase: SupabaseClient,
  areaIdToCode: Map<number, string>,
) {
  const rows = await loadTeamRows(supabase);
  const teamCodes = new Set<string>();
  const teamCodeToTeam = new Map<string, ExistingTeamLookup>();
  const teamNameAreaToTeam = new Map<string, ExistingTeamLookup>();
  const teamNameToTeams = new Map<string, ExistingTeamLookup[]>();

  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const id = Number(row.id);

    if (!name || !Number.isFinite(id) || row.is_active === false) {
      continue;
    }

    const code = String(row.code ?? createOrgCode(name) ?? "").trim();
    const areaCode =
      typeof row.area_id === "number" ? areaIdToCode.get(row.area_id) ?? null : null;

    if (!code) {
      continue;
    }

    const team: ExistingTeamLookup = { areaCode, code, id, name };
    const normalizedName = normalizeDepartmentKey(name);
    const existingByName = teamNameToTeams.get(normalizedName) ?? [];

    teamCodes.add(code);
    teamCodeToTeam.set(code, team);
    teamNameAreaToTeam.set(teamAreaKey(name, areaCode), team);
    existingByName.push(team);
    teamNameToTeams.set(normalizedName, existingByName);
  }

  return { teamCodeToTeam, teamCodes, teamNameAreaToTeam, teamNameToTeams };
}

export async function loadEmployeeImportExistingState(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<ExistingImportState> {
  const [
    employees,
    departmentCodes,
    lineCodes,
    areaState,
    positionCodes,
    activeDepartments,
  ] = await Promise.all([
    loadEmployeeState(supabase),
    loadCodeSet(supabase, "departments"),
    loadCodeSet(supabase, "lines"),
    loadAreaState(supabase),
    loadCodeSet(supabase, "positions"),
    loadActiveDepartments(supabase),
  ]);
  const teamState = await loadTeamState(supabase, areaState.areaIdToCode);

  return {
    ...employees,
    areaCodes: areaState.areaCodes,
    areaCodeToId: areaState.areaCodeToId,
    departmentCodes,
    departmentCodeToName: activeDepartments.codeToName,
    departmentNameToCode: activeDepartments.nameToCode,
    lineCodes,
    positionCodes,
    ...teamState,
  };
}
