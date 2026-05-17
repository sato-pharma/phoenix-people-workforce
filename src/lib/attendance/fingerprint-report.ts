import { getSupabaseAdmin } from "@/lib/supabase/server";

const reportTimeZone = process.env.ATTENDANCE_REPORT_TIME_ZONE || "Africa/Cairo";
const standardDayMs = 8 * 60 * 60 * 1000;

export type FingerprintReportColumnKey =
  | "deviceUserId"
  | "employeeHrId"
  | "employeeName"
  | "jobTitle"
  | "scheduledStart"
  | "scheduledEnd"
  | "graceMinutes"
  | "actualFirstPunch"
  | "actualLastPunch"
  | "lateMinutes"
  | "earlyLeaveMinutes"
  | "department"
  | "timeLong"
  | "validTime"
  | "date"
  | "status"
  | "recommendedAction"
  | "deductionDays"
  | "deductionValue";

export type FingerprintReportColumn = {
  always?: boolean;
  key: FingerprintReportColumnKey;
  label: string;
};

export type FingerprintReportRow = Record<FingerprintReportColumnKey, string> & {
  sortKey: string;
};

export type FingerprintReportData = {
  columns: FingerprintReportColumn[];
  filters: {
    dateFrom: string;
    dateTo: string;
    deduction: string;
    department: string;
    deviceUserId: string;
    employeeHrId: string;
    employeeName: string;
    jobTitle: string;
    search: string;
    status: string;
  };
  rows: FingerprintReportRow[];
  summary: {
    complete: number;
    deductions: number;
    rows: number;
    shortDays: number;
    singlePunches: number;
  };
};

type RawPunchRow = {
  device_user_id: string;
  employee_hr_id: string | null;
  punch_time: string;
};

type EmployeeRow = {
  department_id: number | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
};

type DepartmentRow = {
  id: number;
  name: string | null;
};

type PunchBucket = {
  deviceUserId: string;
  employeeHrId: string;
  punches: Date[];
  reportDate: string;
};

export const fingerprintReportColumns: FingerprintReportColumn[] = [
  { always: true, key: "deviceUserId", label: "AC-No." },
  { always: true, key: "employeeHrId", label: "Employee ID" },
  { always: true, key: "employeeName", label: "Name" },
  { always: true, key: "jobTitle", label: "Job Title" },
  { always: true, key: "scheduledStart", label: "Scheduled Start" },
  { always: true, key: "scheduledEnd", label: "Scheduled End" },
  { always: true, key: "graceMinutes", label: "Grace Minutes" },
  { always: true, key: "actualFirstPunch", label: "Actual First Punch" },
  { always: true, key: "actualLastPunch", label: "Actual Last Punch" },
  { always: true, key: "lateMinutes", label: "Late Minutes" },
  { always: true, key: "earlyLeaveMinutes", label: "Early Leave Minutes" },
  { key: "department", label: "Department" },
  { always: true, key: "timeLong", label: "Time long" },
  { always: true, key: "validTime", label: "Valid time" },
  { always: true, key: "date", label: "Date" },
  { always: true, key: "status", label: "Status" },
  { always: true, key: "recommendedAction", label: "Recommended Action" },
  { always: true, key: "deductionDays", label: "Deduction Days" },
  { always: true, key: "deductionValue", label: "Deduction Value" },
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeDateInput(value: string | undefined, fallback: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : fallback;
}

function todayKey() {
  return localDateKey(new Date());
}

function utcBoundaryForLocalDate(date: string, dayOffset = 0) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day + dayOffset).toISOString();
}

function localDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: reportTimeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: reportTimeZone,
  }).format(date);
}

function displayDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return `${pad(month)}/${pad(day)}/${year}`;
}

function durationText(milliseconds: number) {
  const safeMs = Math.max(0, milliseconds);
  const totalMinutes = Math.floor(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad(hours)}:${pad(minutes)}`;
}

function normalizeHrId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function statusFor(punches: Date[], durationMs: number) {
  if (punches.length <= 1) {
    return { deductionDays: "", deductionValue: "", recommendedAction: "Review missing punch", status: "Single punch" };
  }
  if (durationMs < standardDayMs) {
    return { deductionDays: "", deductionValue: "", recommendedAction: "Review short day", status: "Short day" };
  }
  return { deductionDays: "0", deductionValue: "0", recommendedAction: "No action", status: "Complete" };
}

function contains(value: string, filter: string) {
  return !filter || value.toLowerCase().includes(filter.toLowerCase());
}

function textMatches(row: FingerprintReportRow, filters: FingerprintReportData["filters"]) {
  const search = filters.search;
  if (
    !contains(row.deviceUserId, filters.deviceUserId) ||
    !contains(row.employeeHrId, filters.employeeHrId) ||
    !contains(row.employeeName, filters.employeeName) ||
    !contains(row.jobTitle, filters.jobTitle) ||
    !contains(row.department, filters.department) ||
    !contains(row.status, filters.status) ||
    !contains(row.deductionDays || row.deductionValue || row.recommendedAction, filters.deduction)
  ) {
    return false;
  }

  if (!search) return true;
  const haystack = [
    row.deviceUserId,
    row.employeeHrId,
    row.employeeName,
    row.jobTitle,
    row.department,
    row.date,
    row.status,
    row.recommendedAction,
    row.deductionDays,
    row.deductionValue,
  ].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export async function getFingerprintAttendanceReport(input: {
  dateFrom?: string;
  dateTo?: string;
  deduction?: string;
  department?: string;
  deviceUserId?: string;
  employeeHrId?: string;
  employeeName?: string;
  jobTitle?: string;
  search?: string;
  status?: string;
} = {}): Promise<FingerprintReportData> {
  const dateFrom = normalizeDateInput(input.dateFrom, "2026-01-01");
  const dateTo = normalizeDateInput(input.dateTo, todayKey());
  const filters = {
    dateFrom,
    dateTo,
    deduction: String(input.deduction ?? "").trim(),
    department: String(input.department ?? "").trim(),
    deviceUserId: String(input.deviceUserId ?? "").trim(),
    employeeHrId: String(input.employeeHrId ?? "").trim(),
    employeeName: String(input.employeeName ?? "").trim(),
    jobTitle: String(input.jobTitle ?? "").trim(),
    search: String(input.search ?? "").trim(),
    status: String(input.status ?? "").trim(),
  };
  const supabase = getSupabaseAdmin();

  const { data: punchData, error: punchError } = await supabase
    .from("attendance_raw_punches")
    .select("device_user_id,employee_hr_id,punch_time")
    .not("employee_hr_id", "is", null)
    .gte("punch_time", utcBoundaryForLocalDate(dateFrom))
    .lt("punch_time", utcBoundaryForLocalDate(dateTo, 1))
    .order("punch_time", { ascending: true })
    .limit(20000);

  if (punchError) throw punchError;

  const punches = (punchData ?? []) as RawPunchRow[];
  const employeeHrIds = Array.from(new Set(punches.map((row) => normalizeHrId(row.employee_hr_id)).filter((value): value is string => Boolean(value))));
  const employeeMap = new Map<string, EmployeeRow>();
  const departmentIds = new Set<number>();

  if (employeeHrIds.length > 0) {
    const { data: employeeData, error: employeeError } = await supabase
      .from("employees")
      .select("hr_id,full_name,job_title,department_id")
      .in("hr_id", employeeHrIds);

    if (employeeError) throw employeeError;

    for (const employee of (employeeData ?? []) as EmployeeRow[]) {
      const hrId = normalizeHrId(employee.hr_id);
      if (!hrId) continue;
      employeeMap.set(hrId, employee);
      if (typeof employee.department_id === "number") {
        departmentIds.add(employee.department_id);
      }
    }
  }

  const departmentMap = new Map<number, string>();
  if (departmentIds.size > 0) {
    const { data: departmentData, error: departmentError } = await supabase
      .from("departments")
      .select("id,name")
      .in("id", Array.from(departmentIds));

    if (departmentError) throw departmentError;

    for (const department of (departmentData ?? []) as DepartmentRow[]) {
      departmentMap.set(department.id, department.name?.trim() || "");
    }
  }

  const buckets = new Map<string, PunchBucket>();
  for (const punch of punches) {
    const employeeHrId = normalizeHrId(punch.employee_hr_id);
    if (!employeeHrId) continue;
    const punchDate = new Date(punch.punch_time);
    const reportDate = localDateKey(punchDate);
    const key = `${employeeHrId}\u0000${reportDate}`;
    const bucket = buckets.get(key) ?? {
      deviceUserId: punch.device_user_id,
      employeeHrId,
      punches: [],
      reportDate,
    };
    bucket.punches.push(punchDate);
    if (!bucket.deviceUserId && punch.device_user_id) {
      bucket.deviceUserId = punch.device_user_id;
    }
    buckets.set(key, bucket);
  }

  const rows = Array.from(buckets.values()).map((bucket) => {
    bucket.punches.sort((left, right) => left.getTime() - right.getTime());
    const firstPunch = bucket.punches[0];
    const lastPunch = bucket.punches[bucket.punches.length - 1];
    const durationMs = firstPunch && lastPunch && firstPunch.getTime() !== lastPunch.getTime()
      ? lastPunch.getTime() - firstPunch.getTime()
      : 0;
    const status = statusFor(bucket.punches, durationMs);
    const employee = employeeMap.get(bucket.employeeHrId);
    const department = typeof employee?.department_id === "number"
      ? departmentMap.get(employee.department_id) ?? ""
      : "";

    return {
      actualFirstPunch: firstPunch ? localTime(firstPunch) : "",
      actualLastPunch: lastPunch && durationMs > 0 ? localTime(lastPunch) : "",
      date: displayDate(bucket.reportDate),
      deductionDays: status.deductionDays,
      deductionValue: status.deductionValue,
      department,
      deviceUserId: bucket.deviceUserId,
      employeeHrId: bucket.employeeHrId,
      employeeName: employee?.full_name?.trim() || bucket.employeeHrId,
      earlyLeaveMinutes: "",
      graceMinutes: "",
      jobTitle: employee?.job_title?.trim() || "",
      lateMinutes: "",
      recommendedAction: status.recommendedAction,
      scheduledEnd: "",
      scheduledStart: "",
      sortKey: `${bucket.reportDate}\u0000${bucket.employeeHrId}`,
      status: status.status,
      timeLong: durationText(durationMs),
      validTime: durationText(durationMs),
    };
  })
    .filter((row) => textMatches(row, filters))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  return {
    columns: fingerprintReportColumns,
    filters,
    rows,
    summary: {
      complete: rows.filter((row) => row.status === "Complete").length,
      deductions: rows.filter((row) => row.recommendedAction !== "No action").length,
      rows: rows.length,
      shortDays: rows.filter((row) => row.status === "Short day").length,
      singlePunches: rows.filter((row) => row.status === "Single punch").length,
    },
  };
}
