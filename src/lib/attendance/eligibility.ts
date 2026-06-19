import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import type { PhoenixRole } from "@/lib/auth/permissions";

/**
 * Attendance & Fingerprint Tracking eligibility.
 *
 * Only field-based roles that do NOT punch in at the office are subject to
 * attendance and fingerprint tracking: Medical Reps, District Managers (DMs),
 * and Regional Sales Managers (RSMs). All other roles — NSMs, Marketing,
 * Training, SFE, Finance, HR, office/admin — are excluded.
 *
 * This is a non-security business rule (who appears in attendance reports and
 * deduction calculations). Never use it to grant or deny permissions.
 */

const ATTENDANCE_ELIGIBLE_TITLES = new Set<string>([
  "medical representative",
  "medical rep",
  "employee medical rep",
  "district sales manager",
  "district manager",
  "dsm",
  "regional sales manager",
  "regional manager",
  "rsm",
]);

const ATTENDANCE_ELIGIBLE_ROLES = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
]);

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Returns true when ANY of the provided title fields identifies an employee
 * subject to attendance and fingerprint tracking (Medical Rep, DM, RSM only).
 */
export function isAttendanceTrackingEligible(
  ...titles: Array<string | null | undefined>
): boolean {
  for (const title of titles) {
    const normalized = normalizeTitle(title);
    if (!normalized) continue;
    if (ATTENDANCE_ELIGIBLE_TITLES.has(normalized)) return true;
    if (ATTENDANCE_ELIGIBLE_ROLES.has(resolveJobFunctionRole(title))) return true;
  }
  return false;
}
