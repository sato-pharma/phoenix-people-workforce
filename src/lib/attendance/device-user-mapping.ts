import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import {
  attendanceDeviceUserKey,
  normalizeAttendanceHrId,
  resolveDeviceMappingStatus,
  summarizeDeviceUserMappings,
} from "@/lib/attendance/metrics";

/**
 * Returns true if the employee has at least one active fingerprint device
 * mapping. Used to gate the "Fingerprint Report" tab in the employee portal nav.
 * Single-row HEAD query — does not load the full mapping list.
 */
export async function employeeHasActiveDeviceMapping(hrId: string): Promise<boolean> {
  if (!hrId) return false;
  const normalized = normalizeAttendanceHrId(hrId);
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("attendance_device_user_map")
    .select("id", { count: "exact", head: true })
    .eq("employee_hr_id", normalized)
    .eq("is_active", true)
    .limit(1);
  if (error) return false;
  return (count ?? 0) > 0;
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
  status: "active" | "inactive" | "unmapped";
  updatedAt: string;
};

export type AttendanceDeviceUserMappingDashboard = {
  employees: AttendanceEmployeeOption[];
  mappings: AttendanceDeviceUserMappingRow[];
  recentUnmapped: AttendanceDeviceUserMappingRow[];
  summary: {
    active: number;
    inactive: number;
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
  updated_at: string;
};

type EmployeeDbRow = {
  full_name: string | null;
  hr_id: string;
};

type RawPunchDbRow = {
  device_id: string;
  device_user_id: string;
  punch_time: string;
};

function normalizeHrId(value: string | null | undefined) {
  return normalizeAttendanceHrId(value);
}

export async function getAttendanceDeviceUserMappingDashboard(): Promise<AttendanceDeviceUserMappingDashboard> {
  const supabase = getSupabaseAdmin();
  const [mappingResult, employeeResult, punchResult] = await Promise.all([
    supabase
      .from("attendance_device_user_map")
      .select("id,device_id,device_user_id,employee_hr_id,is_active,last_seen_punch_at,created_at,updated_at")
      .order("last_seen_punch_at", { ascending: false, nullsFirst: false })
      .order("device_id")
      .order("device_user_id"),
    supabase
      .from("employees")
      .select("hr_id,full_name")
      .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
      .order("full_name", { ascending: true }),
    supabase
      .from("attendance_raw_punches")
      .select("device_id,device_user_id,punch_time")
      .order("punch_time", { ascending: false })
      .limit(5000),
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

  const latestPunchByDeviceUser = new Map<string, string>();
  for (const punch of (punchResult.data ?? []) as RawPunchDbRow[]) {
    const key = attendanceDeviceUserKey(punch.device_id, punch.device_user_id);
    if (!latestPunchByDeviceUser.has(key)) {
      latestPunchByDeviceUser.set(key, punch.punch_time);
    }
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
      status: "unmapped" as AttendanceDeviceUserMappingRow["status"],
      updatedAt: row.updated_at,
    };

    return {
      ...mapped,
      status: resolveDeviceMappingStatus(mapped),
    };
  });

  const recentUnmapped = mappings
    .filter((mapping) => mapping.status === "unmapped")
    .sort((left, right) => String(right.latestPunchAt ?? "").localeCompare(String(left.latestPunchAt ?? "")))
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
}) {
  const supabase = getSupabaseAdmin();
  const deviceId = input.deviceId.trim();
  const deviceUserId = input.deviceUserId.trim();
  const employeeHrId = normalizeHrId(input.employeeHrId);

  if (!deviceId) {
    throw new Error("device_id is required.");
  }
  if (!deviceUserId) {
    throw new Error("device_user_id is required.");
  }
  if (input.isActive && !employeeHrId) {
    throw new Error("employee_hr_id is required for an active mapping.");
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

  const row = {
    device_id: deviceId,
    device_user_id: deviceUserId,
    employee_hr_id: employeeHrId,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };

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
}
