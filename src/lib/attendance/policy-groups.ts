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

// Flexible-hours fields for the weekly-digest generator (migration
// 20260703180000). Additive to the base policy row; a separate, narrowly-scoped
// loader so the widely-used loadAttendancePolicyGroups() above is never touched.
export type AttendanceFlexPolicyGroupDbRow = AttendancePolicyGroupDbRow & {
  flex_minutes: number | null;
  required_minutes: number | null;
  half_day_split_minutes: number;
  judgment_mode: "every_working_day" | "office_days_only";
};

const flexPolicySelect = `${policySelectWithWeekdays},flex_minutes,required_minutes,half_day_split_minutes,judgment_mode`;

export function isMissingFlexColumns(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /flex_minutes|required_minutes|half_day_split_minutes|judgment_mode|schema cache|PGRST204|42703/i.test(text);
}

const flexDefaults = {
  flex_minutes: null,
  half_day_split_minutes: 780,
  judgment_mode: "every_working_day" as const,
  required_minutes: null,
};

/**
 * Same active-policy rows as loadAttendancePolicyGroups(), plus the
 * flexible-hours columns the digest generator needs. Only policies with
 * required_minutes set are usable by the flexible-hours engine — policies not
 * yet migrated to the new model return required_minutes: null and the caller
 * should skip them (they have no flexible-hours config yet).
 *
 * Falls back to the base (pre-migration-20260703180000) select if the flex
 * columns don't exist in the live schema yet, so this loader — and anything
 * built on it, including the existing Attendance Policies admin page — never
 * hard-breaks just because that migration hasn't been applied to this
 * environment. Mirrors loadAttendancePolicyGroups()'s own working_weekdays
 * fallback below.
 */
export async function loadAttendanceFlexPolicyGroups(
  input: { activeOnly?: boolean } = {},
): Promise<AttendanceFlexPolicyGroupDbRow[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("attendance_policy_groups").select(flexPolicySelect);
  if (input.activeOnly) query = query.eq("is_active", true);

  const result = await query
    .order("target_type")
    .order("target_value")
    .order("effective_from", { ascending: false });

  if (!result.error) {
    const rows = (result.data ?? []) as Array<
      Omit<AttendanceFlexPolicyGroupDbRow, "working_weekdays"> & { working_weekdays?: unknown }
    >;
    return rows.map((row) => ({
      ...row,
      working_weekdays: normalizeAttendanceWorkingWeekdays(row.working_weekdays),
    }));
  }

  if (!isMissingFlexColumns(result.error)) throw result.error;

  const baseRows = await loadAttendancePolicyGroups({ activeOnly: input.activeOnly });
  return baseRows.map((row) => ({ ...row, ...flexDefaults }));
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
