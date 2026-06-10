import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";

export type AttendanceExceptionStatus = "approved" | "pending" | "rejected";

export type AttendanceException = {
  createdAt: string;
  employeeHrId: string;
  employeeName: string | null;
  exceptionDate: string;
  id: number;
  notes: string | null;
  reason: string;
  requestedBy: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  status: AttendanceExceptionStatus;
};

type ExceptionDbRow = {
  created_at: string;
  employee_hr_id: string;
  exception_date: string;
  id: number;
  notes: string | null;
  reason: string;
  requested_by: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  status: string;
};

type EmployeeNameRow = {
  full_name: string | null;
  hr_id: string;
};

function toException(row: ExceptionDbRow, nameMap: Map<string, string>): AttendanceException {
  const hrId = normalizeAttendanceHrId(row.employee_hr_id) ?? row.employee_hr_id;
  return {
    createdAt: row.created_at,
    employeeHrId: hrId,
    employeeName: nameMap.get(hrId) ?? null,
    exceptionDate: row.exception_date,
    id: row.id,
    notes: row.notes,
    reason: row.reason,
    requestedBy: row.requested_by,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    status: (row.status as AttendanceExceptionStatus),
  };
}

export type GetAttendanceExceptionsFilters = {
  dateFrom?: string;
  dateTo?: string;
  employeeHrId?: string;
  status?: AttendanceExceptionStatus | "all";
};

export async function getAttendanceExceptions(
  filters: GetAttendanceExceptionsFilters = {},
): Promise<AttendanceException[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("attendance_exceptions")
    .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
    .order("exception_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (filters.employeeHrId) {
    const normalized = normalizeAttendanceHrId(filters.employeeHrId);
    if (normalized) query = query.eq("employee_hr_id", normalized);
  }
  if (filters.dateFrom) query = query.gte("exception_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("exception_date", filters.dateTo);
  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as ExceptionDbRow[];
  const hrIds = [...new Set(rows.map((r) => normalizeAttendanceHrId(r.employee_hr_id) ?? r.employee_hr_id))];
  const nameMap = new Map<string, string>();

  if (hrIds.length > 0) {
    const { data: empData } = await supabase
      .from("employees")
      .select("hr_id,full_name")
      .in("hr_id", hrIds);
    for (const emp of (empData ?? []) as EmployeeNameRow[]) {
      const normalized = normalizeAttendanceHrId(emp.hr_id) ?? emp.hr_id;
      if (emp.full_name) nameMap.set(normalized, emp.full_name.trim());
    }
  }

  return rows.map((row) => toException(row, nameMap));
}

export async function getAttendanceExceptionMap(
  employeeHrIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, AttendanceException>> {
  const supabase = getSupabaseAdmin();
  const normalized = employeeHrIds.map((id) => normalizeAttendanceHrId(id) ?? id);

  let query = supabase
    .from("attendance_exceptions")
    .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
    .gte("exception_date", dateFrom)
    .lte("exception_date", dateTo);

  if (normalized.length > 0) {
    query = query.in("employee_hr_id", normalized);
  }

  const { data, error } = await query;

  if (error) throw error;

  const map = new Map<string, AttendanceException>();
  for (const row of (data ?? []) as ExceptionDbRow[]) {
    const hrId = normalizeAttendanceHrId(row.employee_hr_id) ?? row.employee_hr_id;
    const key = `${hrId}|${row.exception_date}`;
    map.set(key, toException(row, new Map()));
  }
  return map;
}

export type SaveAttendanceExceptionInput = {
  employeeHrId: string;
  exceptionDate: string;
  notes?: string | null;
  reason: string;
  requestedBy: string;
  status?: AttendanceExceptionStatus;
};

export async function saveAttendanceException(
  input: SaveAttendanceExceptionInput,
): Promise<AttendanceException> {
  const supabase = getSupabaseAdmin();
  const hrId = normalizeAttendanceHrId(input.employeeHrId) ?? input.employeeHrId;

  const { data, error } = await supabase
    .from("attendance_exceptions")
    .upsert(
      {
        employee_hr_id: hrId,
        exception_date: input.exceptionDate,
        notes: input.notes ?? null,
        reason: input.reason.trim(),
        requested_by: input.requestedBy,
        status: input.status ?? "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id,exception_date" },
    )
    .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
    .single();

  if (error) throw error;
  return toException(data as ExceptionDbRow, new Map());
}

export type ReviewAttendanceExceptionInput = {
  decision: "approved" | "rejected";
  id: number;
  notes?: string | null;
  reviewedBy: string;
};

export async function reviewAttendanceException(
  input: ReviewAttendanceExceptionInput,
): Promise<AttendanceException> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("attendance_exceptions")
    .update({
      notes: input.notes ?? null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: input.reviewedBy,
      status: input.decision,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
    .single();

  if (error) throw error;
  return toException(data as ExceptionDbRow, new Map());
}

export async function deleteAttendanceException(id: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("attendance_exceptions")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
