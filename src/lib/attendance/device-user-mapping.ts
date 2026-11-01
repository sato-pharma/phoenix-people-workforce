import { unstable_cache } from "next/cache.js";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { DEVICE_MAPPING_CACHE_TAG, invalidateDeviceMappingCache } from "@/lib/dashboard/invalidation";
import {
  attendanceDeviceUserKey,
  normalizeAttendanceHrId,
  resolveDeviceMappingStatus,
  summarizeDeviceUserMappings,
} from "@/lib/attendance/metrics";

// The tag is declared in src/lib/dashboard/invalidation.ts as a bare string and re-exported by its owner
// here (portal rule, 2026-10-17).
export { DEVICE_MAPPING_CACHE_TAG };

/** How long a shell may trust its memory of "enrolled / not enrolled" before counting the rows again. */
const DEVICE_MAPPING_CACHE_SECONDS = 600;

const readEmployeeHasActiveDeviceMapping = unstable_cache(
  async (normalizedHrId: string): Promise<boolean> => {
    const { count, error } = await getSupabaseAdmin()
      .from("attendance_device_user_map")
      .select("id", { count: "exact", head: true })
      .eq("employee_hr_id", normalizedHrId)
      .eq("is_active", true)
      .limit(1);
    if (error) throw error;
    return (count ?? 0) > 0;
  },
  ["employee-has-active-device-mapping"],
  { revalidate: DEVICE_MAPPING_CACHE_SECONDS, tags: [DEVICE_MAPPING_CACHE_TAG] },
);

/**
 * Returns true if the employee has at least one active fingerprint device mapping. Gates the
 * Attendance Analytics row in the employee portal sidebar, so the portal shell asks it on EVERY
 * render: remembered for ten minutes per person and busted by saveAttendanceDeviceUserMapping, the one
 * write that changes it (1 Nov 2026, the speed root cause — it was an uncached count per page view).
 * Single-row HEAD query underneath; a failed read answers false and is not remembered.
 */
export async function employeeHasActiveDeviceMapping(hrId: string): Promise<boolean> {
  if (!hrId) return false;
  const normalized = normalizeAttendanceHrId(hrId);
  if (!normalized) return false;
  try {
    return await readEmployeeHasActiveDeviceMapping(normalized);
  } catch {
    return false;
  }
}

/**
 * Returns the set of normalized HR_IDs that have at least one ACTIVE fingerprint
 * device mapping — the authoritative "who is enrolled on the device" list. Whoever
 * HR maps on the device is subject to attendance tracking regardless of job title
 * (see `isAttendanceTracked`). Bulk companion to `employeeHasActiveDeviceMapping`.
 */
export async function loadActiveDeviceMappedHrIds(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_device_user_map")
    .select("employee_hr_id")
    .eq("is_active", true)
    .not("employee_hr_id", "is", null);
  if (error) throw error;

  const result = new Set<string>();
  for (const row of (data ?? []) as Array<{ employee_hr_id: string | null }>) {
    const hrId = normalizeHrId(row.employee_hr_id);
    if (hrId) result.add(hrId);
  }
  return result;
}

export type AttendanceEmployeeOption = {
  fullName: string;
  hrId: string;
};

export type AttendanceDeviceUserMappingRow = {
  createdAt: string;
  deviceId: string;
  deviceUserId: string;
  employeeHrId: string | null;
  employeeName: string | null;
  id: number;
  isActive: boolean;
  latestPunchAt: string | null;
  nonEmployeeLabel: string | null;
  status: "active" | "inactive" | "non_employee" | "unmapped";
  updatedAt: string;
};

export type AttendanceDeviceUserMappingDashboard = {
  employees: AttendanceEmployeeOption[];
  mappings: AttendanceDeviceUserMappingRow[];
  recentUnmapped: AttendanceDeviceUserMappingRow[];
  summary: {
    active: number;
    inactive: number;
    nonEmployee: number;
    total: number;
    unmapped: number;
  };
};

type MappingDbRow = {
  created_at: string;
  device_id: string;
  device_user_id: string;
  employee_hr_id: string | null;
  id: number;
  is_active: boolean;
  last_seen_punch_at?: string | null;
  non_employee_label?: string | null;
  updated_at: string;
};

type EmployeeDbRow = {
  full_name: string | null;
  hr_id: string;
};

type LatestPunchDbRow = {
  device_id: string;
  device_user_id: string;
  latest_punch_at: string | null;
};

function normalizeHrId(value: string | null | undefined) {
  return normalizeAttendanceHrId(value);
}

/**
 * Newest punch first; a row that has never punched sorts last.
 *
 * Both lists on this screen order on the RESOLVED `latestPunchAt`, never on the stored
 * `attendance_device_user_map.last_seen_punch_at` column. That column is NULL for 15 of the 19
 * device users who actually have punches on production, so ordering on it in SQL buried live
 * users underneath rows that have no punches at all.
 */
export function compareByLatestPunchDesc(
  left: { deviceUserId: string; latestPunchAt: string | null },
  right: { deviceUserId: string; latestPunchAt: string | null },
): number {
  const byPunch = String(right.latestPunchAt ?? "").localeCompare(String(left.latestPunchAt ?? ""));
  if (byPunch !== 0) return byPunch;
  // Total order. Without a tie-break, rows sharing a punch time (or sharing no punch time at all)
  // can swap places between renders and the list looks like it is shuffling on its own.
  return left.deviceUserId.localeCompare(right.deviceUserId);
}

export async function getAttendanceDeviceUserMappingDashboard(): Promise<AttendanceDeviceUserMappingDashboard> {
  const supabase = getSupabaseAdmin();
  const [mappingResult, employeeResult, punchResult] = await Promise.all([
    supabase
      .from("attendance_device_user_map")
      .select("id,device_id,device_user_id,employee_hr_id,is_active,last_seen_punch_at,non_employee_label,created_at,updated_at")
      // Deterministic only. The DISPLAY order is applied below, on the resolved `latestPunchAt` —
      // see `compareByLatestPunchDesc` for why it cannot be `last_seen_punch_at`.
      .order("device_id")
      .order("device_user_id")
      .order("id"),
    supabase
      .from("employees")
      .select("hr_id,full_name")
      .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
      .order("full_name", { ascending: true }),
    // ONE ROW PER DEVICE USER, folded by the database. This used to pull the newest 5,000 raw
    // punches and fold them in Node: on 2026-09-23 that was 4,808 rows to derive 19 values, 192
    // rows short of the cap biting. And the cap failed in the worst possible direction — the read
    // was newest-first, so the rows that fell off were the OLDEST, meaning a device user who had
    // STOPPED punching was the first to vanish. That is precisely the row this screen exists to
    // surface, and it would not have shown as stale: it would have fallen back to the NULL stored
    // column and read as if the user had never punched at all.
    supabase
      .from("attendance_device_user_latest_punch")
      .select("device_id,device_user_id,latest_punch_at"),
  ]);

  if (mappingResult.error) throw mappingResult.error;
  if (employeeResult.error) throw employeeResult.error;
  if (punchResult.error) throw punchResult.error;

  const employees = ((employeeResult.data ?? []) as EmployeeDbRow[])
    .filter((row) => row.hr_id)
    .map((row) => ({
      fullName: row.full_name?.trim() || row.hr_id,
      hrId: row.hr_id,
    }));
  const employeeNames = new Map(employees.map((employee) => [normalizeHrId(employee.hrId), employee.fullName]));

  // The view already carries one row per (device, device user), so this is a straight index —
  // no first-wins fold, and no dependence on the order rows arrive in.
  const latestPunchByDeviceUser = new Map<string, string>();
  for (const punch of (punchResult.data ?? []) as LatestPunchDbRow[]) {
    if (!punch.latest_punch_at) continue;
    latestPunchByDeviceUser.set(
      attendanceDeviceUserKey(punch.device_id, punch.device_user_id),
      punch.latest_punch_at,
    );
  }

  const mappings: AttendanceDeviceUserMappingRow[] = ((mappingResult.data ?? []) as MappingDbRow[]).map((row) => {
    const employeeHrId = normalizeHrId(row.employee_hr_id);
    const key = attendanceDeviceUserKey(row.device_id, row.device_user_id);
    const latestPunchAt = latestPunchByDeviceUser.get(key) ?? row.last_seen_punch_at ?? null;
    const mapped = {
      createdAt: row.created_at,
      deviceId: row.device_id,
      deviceUserId: row.device_user_id,
      employeeHrId,
      employeeName: employeeHrId ? employeeNames.get(employeeHrId) ?? null : null,
      id: row.id,
      isActive: row.is_active,
      latestPunchAt,
      nonEmployeeLabel: row.non_employee_label?.trim() || null,
      status: "unmapped" as AttendanceDeviceUserMappingRow["status"],
      updatedAt: row.updated_at,
    };

    return {
      ...mapped,
      status: resolveDeviceMappingStatus(mapped),
    };
  });

  mappings.sort(compareByLatestPunchDesc);

  const recentUnmapped = mappings
    .filter((mapping) => mapping.status === "unmapped")
    .slice(0, 20);

  return {
    employees,
    mappings,
    recentUnmapped,
    summary: summarizeDeviceUserMappings(mappings),
  };
}

export async function saveAttendanceDeviceUserMapping(input: {
  deviceId: string;
  deviceUserId: string;
  employeeHrId: string | null;
  isActive: boolean;
  // OPTIONAL on purpose, and undefined is not the same as null. A caller that does not know
  // about non-employees at all - the bulk XLSX upload is one - leaves this undefined, and the
  // column is then omitted from the UPDATE so an existing label survives. Passing null is an
  // explicit "this is not a non-employee any more" and does clear it.
  nonEmployeeLabel?: string | null;
}) {
  const supabase = getSupabaseAdmin();
  const deviceId = input.deviceId.trim();
  const deviceUserId = input.deviceUserId.trim();
  const employeeHrId = normalizeHrId(input.employeeHrId);
  const nonEmployeeLabelProvided = input.nonEmployeeLabel !== undefined;
  const nonEmployeeLabel = String(input.nonEmployeeLabel ?? "").trim() || null;

  if (!deviceId) {
    throw new Error("device_id is required.");
  }
  if (!deviceUserId) {
    throw new Error("device_user_id is required.");
  }
  if (input.isActive && !employeeHrId) {
    throw new Error("employee_hr_id is required for an active mapping.");
  }
  // Mirrors attendance_device_user_map_non_employee_exclusive. Caught here so the caller gets a
  // sentence instead of a raw constraint violation.
  if (nonEmployeeLabel && employeeHrId) {
    throw new Error("A device user cannot be both an employee and a non-employee.");
  }
  if (nonEmployeeLabel && input.isActive) {
    throw new Error("A non-employee device user cannot be active - their punches are never ingested.");
  }

  if (employeeHrId) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id")
      .eq("hr_id", employeeHrId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      throw new Error(`Employee HR_ID ${employeeHrId} does not exist.`);
    }
  }

  const { data: existing, error: existingError } = await supabase
    .from("attendance_device_user_map")
    .select("id")
    .eq("device_id", deviceId)
    .eq("device_user_id", deviceUserId)
    .maybeSingle();

  if (existingError) throw existingError;

  const row: Record<string, unknown> = {
    device_id: deviceId,
    device_user_id: deviceUserId,
    employee_hr_id: employeeHrId,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };

  // Naming an employee always ends any non-employee identity, whether or not the caller said so
  // - otherwise the write would fail the exclusivity constraint. Beyond that the column is only
  // touched when the caller actually supplied it.
  if (employeeHrId) {
    row.non_employee_label = null;
  } else if (nonEmployeeLabelProvided) {
    row.non_employee_label = nonEmployeeLabel;
  }

  if (existing) {
    const { error } = await supabase
      .from("attendance_device_user_map")
      .update(row)
      .eq("id", (existing as { id: number }).id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("attendance_device_user_map")
      .insert({
        ...row,
        created_at: new Date().toISOString(),
      });
    if (error) throw error;
  }
  // The portal shell remembers "enrolled / not enrolled" for ten minutes (employeeHasActiveDeviceMapping):
  // this is the one write that changes the answer, so every shell asks again.
  invalidateDeviceMappingCache("attendance device mapping saved");
}
