import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceWorkingWeekdays, type AttendanceWorkingWeekday } from "@/lib/attendance/work-schedule";

export type AttendancePolicyGroupDbRow = {
  effective_from: string;
  effective_to: string | null;
  grace_minutes: number | null;
  id: number;
  is_active: boolean | null;
  policy_name: string | null;
  scheduled_end: string | null;
  scheduled_start: string | null;
  target_type: string | null;
  target_value: string | null;
  working_weekdays: AttendanceWorkingWeekday[] | null;
};

const basePolicySelect = "id,policy_name,target_type,target_value,scheduled_start,scheduled_end,grace_minutes,is_active,effective_from,effective_to";
const policySelectWithWeekdays = `${basePolicySelect},working_weekdays`;

export function isMissingWorkingWeekdaysColumn(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /working_weekdays|schema cache|PGRST204|42703/i.test(text);
}

function normalizePolicyRows(rows: Array<Omit<AttendancePolicyGroupDbRow, "working_weekdays"> & { working_weekdays?: unknown }>) {
  return rows.map((row) => ({
    ...row,
    working_weekdays: normalizeAttendanceWorkingWeekdays(row.working_weekdays),
  })) satisfies AttendancePolicyGroupDbRow[];
}

export async function loadAttendancePolicyGroups(input: { activeOnly?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("attendance_policy_groups")
    .select(policySelectWithWeekdays);
  if (input.activeOnly) query = query.eq("is_active", true);

  const result = await query
    .order("target_type")
    .order("target_value")
    .order("effective_from", { ascending: false });

  if (!result.error) return normalizePolicyRows((result.data ?? []) as Array<Omit<AttendancePolicyGroupDbRow, "working_weekdays"> & { working_weekdays?: unknown }>);
  if (!isMissingWorkingWeekdaysColumn(result.error)) throw result.error;

  let fallbackQuery = supabase
    .from("attendance_policy_groups")
    .select(basePolicySelect);
  if (input.activeOnly) fallbackQuery = fallbackQuery.eq("is_active", true);

  const fallbackResult = await fallbackQuery
    .order("target_type")
    .order("target_value")
    .order("effective_from", { ascending: false });
  if (fallbackResult.error) throw fallbackResult.error;

  return normalizePolicyRows(((fallbackResult.data ?? []) as Array<Omit<AttendancePolicyGroupDbRow, "working_weekdays">>).map((row) => ({
    ...row,
    working_weekdays: null,
  })));
}
