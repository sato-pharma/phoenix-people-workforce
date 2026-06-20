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
 * subject to attendance and fingerprint tracking by JOB TITLE (Medical Rep, DM,
 * RSM only). This is one of two tracking signals — see `isAttendanceTracked`.
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

/**
 * Whether an employee is subject to attendance & fingerprint tracking.
 *
 * An employee is tracked when EITHER signal is true:
 *  1. `hasDeviceMapping` — they are ACTIVELY ENROLLED on a fingerprint device.
 *     This is the authoritative, self-maintaining signal: whoever HR enrols and
 *     maps on the office device is tracked, regardless of job title. This is how
 *     office/HQ staff (HR, Finance, Marketing, NSMs, Product/Training managers,
 *     admins, …) — who actually punch the office device — get tracked.
 *  2. `jobTitle` is a field role (Medical Rep / DM / RSM). Field reps are tracked
 *     by title even before a device mapping exists.
 *
 * Previously tracking was field-role-by-title ONLY, which hid every office
 * employee that the office device actually captures. The device-mapping signal
 * fixes that without disturbing field-role behaviour.
 */
export function isAttendanceTracked(input: {
  hasDeviceMapping: boolean;
  jobTitle: string | null | undefined;
}): boolean {
  return input.hasDeviceMapping || isAttendanceTrackingEligible(input.jobTitle);
}
