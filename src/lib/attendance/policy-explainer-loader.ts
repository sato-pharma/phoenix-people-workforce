// Server-side loader for the attendance policy card.
//
// Kept out of `policy-explainer.ts` on purpose: that module is pure, so it can be
// unit-tested without a database or any env. This file is the only part that talks
// to Supabase.

import { isAttendanceTracked } from "@/lib/attendance/eligibility";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import {
  buildAttendancePolicyExplainer,
  type AttendancePolicyExplainer,
  type PolicyExplainerRuleRow,
} from "@/lib/attendance/policy-explainer";
import { resolveEmployeeDisplayName, tidyAllCapitalsName } from "@/lib/employees/display-name";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoTodayIso } from "@/lib/attendance/working-days";

type EmployeeRow = {
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  nickname: string | null;
  target_hr_id?: string;
};

/**
 * Builds the policy card for one employee, or null when there is nothing honest to
 * show — the employee is not subject to fingerprint tracking, has no active policy,
 * or the policy carries no usable schedule.
 *
 * The tracking gate is `isAttendanceTracked`, the same rule the fingerprint report
 * uses to decide who appears in it at all: an active device mapping OR a field job
 * title. Showing a deduction policy to somebody it is never applied to would be
 * worse than showing nothing.
 *
 * Never throws — a policy explainer is decoration on a page whose real job is the
 * punch history, so a failure here must not take the page down with it.
 */
export async function loadAttendancePolicyExplainer(
  hrId: string | null | undefined,
): Promise<AttendancePolicyExplainer | null> {
  const normalized = normalizeAttendanceHrId(hrId);
  if (!normalized) return null;

  try {
    const supabase = getSupabaseAdmin();

    // `ilike` with no wildcards is an exact, case-insensitive match. HR ids are stored
    // mixed-case in places, and a plain `.eq` against an uppercased value silently
    // returns nothing — which would read as "this person has no policy".
    const { data: employeeData, error: employeeError } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title")
      .ilike("hr_id", normalized)
      .maybeSingle();
    if (employeeError) throw employeeError;

    const employee = employeeData as EmployeeRow | null;
    if (!employee) return null;

    const [policies, ruleResult, deviceMappedHrIds] = await Promise.all([
      loadAttendanceFlexPolicyGroups({ activeOnly: true }),
      supabase
        .from("attendance_policy_rules")
        .select(
          "policy_id,event_type,from_minutes,to_minutes,deduction_days,is_active,sort_order,recommended_action",
        )
        .eq("is_active", true)
        .order("sort_order"),
      loadActiveDeviceMappedHrIds(),
    ]);
    if (ruleResult.error) throw ruleResult.error;

    const hasDeviceMapping = deviceMappedHrIds.has(normalized);
    if (!isAttendanceTracked({ hasDeviceMapping, jobTitle: employee.job_title })) return null;

    // Resolve against today, so the card describes the policy in force right now
    // rather than one that has since lapsed.
    const today = cairoTodayIso();
    const policy = resolveActiveAttendancePolicy(
      { hr_id: employee.hr_id, job_title: employee.job_title },
      policies,
      today,
      today,
    );

    const fullName = employee.full_name?.trim();
    return buildAttendancePolicyExplainer({
      // The portal's own display name (nickname, then full name), never the policy's stored label.
      employeeDisplayName: fullName
        ? tidyAllCapitalsName(resolveEmployeeDisplayName(fullName, employee.nickname, employee.hr_id))
        : null,
      policy,
      referenceDate: today,
      rules: (ruleResult.data ?? []) as PolicyExplainerRuleRow[],
    });
  } catch {
    return null;
  }
}
