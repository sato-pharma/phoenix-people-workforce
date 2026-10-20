import { loadRegionCrosswalk } from "@/lib/employees/region-resolver";
import { storedPayFlagsFromRow, type StoredPayFlags } from "@/lib/employees/salary-blind-pay-flags";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isActiveImportEmployee } from "@/lib/imports/employee-lifecycle";
import { addFullNameHolder, addStoredNickname } from "@/lib/imports/employee-name-collision";
import type {
  ExistingEmployeeOrgSeat,
  ExistingImportState,
  ExistingTeamLookup,
} from "@/lib/imports/employee-import-types";
import { createOrgCode } from "@/lib/imports/org-rule-engine";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

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

async function loadCodeLookup(supabase: SupabaseClient, table: string) {
  const { data, error } = await supabase.from(table).select("id,code,name");
  if (error) {
    throw new Error(error.message);
  }

  const codes = new Set<string>();
  const idToCode = new Map<number, string>();

  for (const row of (data ?? []) as Array<{ code: string | null; id: number | null; name?: string | null }>) {
    const code = String(row.code ?? createOrgCode(row.name ?? null) ?? "").trim();
    const id = Number(row.id);

    if (!code) {
      continue;
    }

    codes.add(code);
    if (Number.isFinite(id)) {
      idToCode.set(id, code);
    }
  }

  return { codes, idToCode };
}

async function loadPositionState(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("positions").select("id,code,title");
  if (error) {
    throw new Error(error.message);
  }

  const positionCodes = new Set<string>();
  const positionIdToCode = new Map<number, string>();

  for (const row of (data ?? []) as Array<{ code: string | null; id: number | null; title: string | null }>) {
    const code = String(row.code ?? createOrgCode(row.title) ?? "").trim();
    const id = Number(row.id);

    if (!code) {
      continue;
    }

    positionCodes.add(code);
    if (Number.isFinite(id)) {
      positionIdToCode.set(id, code);
    }
  }

  return { positionCodes, positionIdToCode };
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

async function loadEmployeeState(
  supabase: SupabaseClient,
  lookups?: {
    areaIdToCode: Map<number, string>;
    lineIdToCode: Map<number, string>;
    positionIdToCode: Map<number, string>;
  },
) {
  let result = await supabase
    .from("employees")
    .select("hr_id,full_name,crm_id,crm_username,employment_status,organogram_visible,payroll_eligible,job_title,region_name,line_id,area_id,position_id");

  if (
    result.error &&
    (result.error.message.toLowerCase().includes("organogram_visible") ||
      result.error.message.toLowerCase().includes("payroll_eligible"))
  ) {
    result = await supabase.from("employees").select("hr_id,full_name,crm_id,crm_username,employment_status,job_title,region_name,line_id,area_id,position_id");
  }

  if (result.error && result.error.message.toLowerCase().includes("crm_username")) {
    result = await supabase.from("employees").select("hr_id,full_name,crm_id,employment_status,job_title,region_name,line_id,area_id,position_id");
  }

  if (result.error && result.error.message.toLowerCase().includes("crm_id")) {
    result = await supabase.from("employees").select("hr_id,full_name,employment_status,job_title,region_name,line_id,area_id,position_id");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = (result.data ?? []) as Array<{
    crm_id?: string | null;
    crm_username?: string | null;
    area_id?: number | null;
    employment_status?: string | null;
    full_name?: string | null;
    hr_id: string | null;
    job_title?: string | null;
    line_id?: number | null;
    organogram_visible?: boolean | null;
    payroll_eligible?: boolean | null;
    position_id?: number | null;
    region_name?: string | null;
  }>;
  const crmIdToHrId = new Map<string, string>();
  const crmUsernameToHrId = new Map<string, string>();
  const employeeOrgSeats: ExistingEmployeeOrgSeat[] = [];
  const employeeHrIdByCanonicalKey = new Map<string, { hrId: string }>();
  // Backs the validator's nickname guard. Built through the SAME helper the validator normalizes
  // with, so the file side and the directory side cannot disagree about what "same name" means.
  const employeeHrIdsByFullNameKey = new Map<string, string[]>();

  for (const row of rows) {
    const crmId = String(row.crm_id ?? "").trim().toLowerCase();
    const crmUsername = String(row.crm_username ?? "").trim().toLowerCase();
    const hrId = row.hr_id ? String(row.hr_id).trim().toUpperCase() : null;

    if (crmId && hrId) {
      crmIdToHrId.set(crmId, hrId);
    }

    if (crmUsername && hrId) {
      crmUsernameToHrId.set(crmUsername, hrId);
    }

    if (hrId) {
      const canonicalKey = canonicalHrIdKey(hrId);
      if (canonicalKey && !employeeHrIdByCanonicalKey.has(canonicalKey)) {
        employeeHrIdByCanonicalKey.set(canonicalKey, { hrId });
      }
    }

    addFullNameHolder(employeeHrIdsByFullNameKey, row.full_name, hrId);

    if (hrId && isActiveImportEmployee(row)) {
      employeeOrgSeats.push({
        areaCode: typeof row.area_id === "number" ? lookups?.areaIdToCode.get(row.area_id) ?? null : null,
        hrId,
        jobTitle: row.job_title ?? null,
        lineCode: typeof row.line_id === "number" ? lookups?.lineIdToCode.get(row.line_id) ?? null : null,
        positionCode: typeof row.position_id === "number" ? lookups?.positionIdToCode.get(row.position_id) ?? null : null,
        regionName: row.region_name ?? null,
      });
    }
  }

  return {
    crmIdToHrId,
    crmUsernameToHrId,
    employeeOrgSeats,
    employeeHrIdByCanonicalKey,
    employeeHrIdsByFullNameKey,
    employeeHrIds: new Set(
      rows.flatMap((row) => (row.hr_id ? [String(row.hr_id).trim().toUpperCase()] : [])),
    ),
    managerHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id && isActiveImportEmployee(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
      ),
    ),
    terminalEmployeeHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id && !isActiveImportEmployee(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
      ),
    ),
    protectedLifecycleHrIds: new Set(
      rows.flatMap((row) =>
        row.hr_id && !isActiveImportEmployee(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
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

async function loadCanonicalAreaState(
  supabase: SupabaseClient,
): Promise<{ canonicalAreas: Array<{ code: string; name: string }> }> {
  // Every area a sales-line import row is allowed to resolve to: all currently active
  // public.areas rows — the 42 canonical field-rep areas PLUS the small set of non-field
  // "kept" areas (region/office designations like Cairo, Egypt, Head office) used by
  // DSM/RSM/NSM/PM/GPM rows. This must stay in sync with assertActiveCanonicalArea() in
  // employee-directory.ts (the single-record edit path), which already accepts any active
  // area — querying au_v_canonical_areas alone (42 only) would incorrectly reject every
  // manager-tier row. If the table can't be queried, degrade to an empty list so the import
  // simply skips area-canonicalization rather than failing.
  const { data, error } = await supabase
    .from("areas")
    .select("code, name")
    .eq("is_active", true);
  if (error) {
    return { canonicalAreas: [] };
  }
  const canonicalAreas: Array<{ code: string; name: string }> = [];
  for (const row of (data ?? []) as Array<{ code: string | null; name: string | null }>) {
    if (row.code && row.name) {
      canonicalAreas.push({ code: row.code, name: row.name });
    }
  }
  return { canonicalAreas };
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

// Each employee's stored payment mode and payroll eligibility, for the salary-blind seat's rule that
// she never changes either (src/lib/employees/salary-blind-pay-flags.ts). Derived exactly as the
// directory derives them for her export, so her own export compares equal cell for cell. A failed
// read returns undefined: her two columns are then ignored unchecked and still never written — the
// validator says so once — rather than failing every importer's file over a read only she needs.
async function loadStoredPayFlags(supabase: SupabaseClient) {
  const [employees, compensation] = await Promise.all([
    supabase.from("employees").select("hr_id,employment_status,payment_mode,payroll_eligible"),
    supabase.from("employee_compensation").select("employee_hr_id,payment_mode"),
  ]);

  if (employees.error) {
    return undefined;
  }

  // The compensation row only matters where the employee row carries no mode; a missing table or
  // column there leaves the employee row's own value (or the default) — the directory's fallback.
  const compensationModeByHrId = new Map<string, string | null>();
  if (!compensation.error) {
    for (const row of (compensation.data ?? []) as Array<{ employee_hr_id: string | null; payment_mode: string | null }>) {
      if (row.employee_hr_id) compensationModeByHrId.set(row.employee_hr_id, row.payment_mode);
    }
  }

  const storedPayFlags = new Map<string, StoredPayFlags>();
  for (const row of (employees.data ?? []) as Array<{
    employment_status: string | null;
    hr_id: string | null;
    payment_mode: string | null;
    payroll_eligible: boolean | null;
  }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (!key || !row.hr_id || storedPayFlags.has(key)) continue;
    storedPayFlags.set(key, storedPayFlagsFromRow(row, compensationModeByHrId.get(row.hr_id)));
  }

  return storedPayFlags;
}

// Each employee's saved nickname, for the nickname guard's one exception (employee-name-collision.ts).
// A failed read returns an empty map, which only keeps the guard strict — the safe direction.
async function loadStoredNicknames(supabase: SupabaseClient) {
  const storedNicknames = new Map<string, string>();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,nickname")
    .not("nickname", "is", null);

  if (error) {
    return storedNicknames;
  }

  for (const row of (data ?? []) as Array<{ hr_id: string | null; nickname: string | null }>) {
    addStoredNickname(storedNicknames, row.hr_id, row.nickname);
  }

  return storedNicknames;
}

export async function loadEmployeeImportExistingState(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<ExistingImportState> {
  const [
    departmentCodes,
    areaState,
    canonicalAreaState,
    lineState,
    positionState,
    activeDepartments,
    regionCrosswalk,
    employeeNicknameKeyByCanonicalKey,
    storedPayFlagsByCanonicalKey,
  ] = await Promise.all([
    loadCodeSet(supabase, "departments"),
    loadAreaState(supabase),
    loadCanonicalAreaState(supabase),
    loadCodeLookup(supabase, "lines"),
    loadPositionState(supabase),
    loadActiveDepartments(supabase),
    // Degrade gracefully: if the au crosswalk views can't be read, skip region derivation rather
    // than failing the whole import (the validator keeps each row's free-text region_name).
    loadRegionCrosswalk(supabase).catch(() => undefined),
    loadStoredNicknames(supabase),
    loadStoredPayFlags(supabase).catch(() => undefined),
  ]);
  const employees = await loadEmployeeState(supabase, {
    areaIdToCode: areaState.areaIdToCode,
    lineIdToCode: lineState.idToCode,
    positionIdToCode: positionState.positionIdToCode,
  });
  const teamState = await loadTeamState(supabase, areaState.areaIdToCode);

  return {
    ...employees,
    employeeNicknameKeyByCanonicalKey,
    storedPayFlagsByCanonicalKey,
    areaCodes: areaState.areaCodes,
    areaCodeToId: areaState.areaCodeToId,
    departmentCodes,
    departmentCodeToName: activeDepartments.codeToName,
    departmentNameToCode: activeDepartments.nameToCode,
    lineCodes: lineState.codes,
    canonicalAreas: canonicalAreaState.canonicalAreas,
    regionCrosswalk,
    positionCodes: positionState.positionCodes,
    ...teamState,
  };
}
