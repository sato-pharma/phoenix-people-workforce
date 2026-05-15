import type { ExistingImportState } from "@/lib/imports/employee-import-types";
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
    .select("hr_id,crm_id,employment_status,organogram_visible,payroll_eligible");

  if (
    result.error &&
    (result.error.message.toLowerCase().includes("organogram_visible") ||
      result.error.message.toLowerCase().includes("payroll_eligible"))
  ) {
    result = await supabase.from("employees").select("hr_id,crm_id,employment_status");
  }

  if (result.error && result.error.message.toLowerCase().includes("crm_id")) {
    result = await supabase.from("employees").select("hr_id,employment_status");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = (result.data ?? []) as Array<{
    crm_id?: string | null;
    employment_status?: string | null;
    hr_id: string | null;
    organogram_visible?: boolean | null;
    payroll_eligible?: boolean | null;
  }>;
  const crmIdToHrId = new Map<string, string>();

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
        row.hr_id && isActiveManager(row) ? [String(row.hr_id).trim().toUpperCase()] : [],
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

export async function loadEmployeeImportExistingState(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<ExistingImportState> {
  const [
    employees,
    departmentCodes,
    lineCodes,
    areaCodes,
    teamCodes,
    positionCodes,
    activeDepartments,
  ] = await Promise.all([
    loadEmployeeState(supabase),
    loadCodeSet(supabase, "departments"),
    loadCodeSet(supabase, "lines"),
    loadCodeSet(supabase, "areas"),
    loadCodeSet(supabase, "teams"),
    loadCodeSet(supabase, "positions"),
    loadActiveDepartments(supabase),
  ]);

  return {
    ...employees,
    areaCodes,
    departmentCodes,
    departmentCodeToName: activeDepartments.codeToName,
    departmentNameToCode: activeDepartments.nameToCode,
    lineCodes,
    positionCodes,
    teamCodes,
  };
}
