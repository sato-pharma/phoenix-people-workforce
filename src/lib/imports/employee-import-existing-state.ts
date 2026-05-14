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
}) {
  return (
    activeImportManagerStatuses.has(normalizeStatus(row.employment_status)) &&
    row.organogram_visible !== false
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

async function loadEmployeeState(supabase: SupabaseClient) {
  let result = await supabase
    .from("employees")
    .select("hr_id,employment_status,organogram_visible");

  if (result.error && result.error.message.toLowerCase().includes("organogram_visible")) {
    result = await supabase.from("employees").select("hr_id,employment_status");
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  const rows = (result.data ?? []) as Array<{
    employment_status?: string | null;
    hr_id: string | null;
    organogram_visible?: boolean | null;
  }>;

  return {
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
  ] = await Promise.all([
    loadEmployeeState(supabase),
    loadCodeSet(supabase, "departments"),
    loadCodeSet(supabase, "lines"),
    loadCodeSet(supabase, "areas"),
    loadCodeSet(supabase, "teams"),
    loadCodeSet(supabase, "positions"),
  ]);

  return {
    ...employees,
    areaCodes,
    departmentCodes,
    lineCodes,
    positionCodes,
    teamCodes,
  };
}
