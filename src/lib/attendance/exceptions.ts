import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveAttendanceExceptionNotesPatch } from "@/lib/attendance/exception-notes";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";

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
  nickname: string | null;
};

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError. getAttendanceExceptionMap is called with a full company roster for
// monthly/fingerprint reports, so it must be batched.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// This read used to end in `.limit(500)`, and that cap was the dangerous kind: a truncated
// list of exceptions does not read as missing data, it reads as employees who were absent.
// An APPROVED exception EXCUSES a day — `head-office-attendance.ts` and
// `attendance-cross-check.ts` both build their excused-day set straight from this array,
// company-wide over a whole month — so row 501 onwards silently became unexcused absences,
// which is the shape that ends in a deduction against someone who was never absent. The HR
// command centre and the exceptions screen read it with `status: "all"` and no date filter
// at all, so they were capped against the whole of history.
//
// So it pages to completeness instead. The ceiling below is a runaway guard, not a page size:
// reaching it THROWS, because every caller already treats a thrown read as an unavailable
// source and says so on the page, while a silently short array is indistinguishable from the
// truth. Never turn this back into a `.limit()`.
const EXCEPTION_PAGE_SIZE = 1000;
export const MAX_ATTENDANCE_EXCEPTION_ROWS = 100_000;

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

const EXCEPTION_COLUMNS =
  "id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at";

/**
 * Page a filtered exception select until the server runs out of rows.
 *
 * The loop advances by how many rows actually came back, never by the page size it asked for,
 * so a PostgREST `max-rows` smaller than EXCEPTION_PAGE_SIZE cannot end it early — the cost of
 * that is one extra empty request at the true end, which is the right price for never
 * shortening the list by accident.
 *
 * Ordering carries an `id` tiebreak. Paging is only stable if the sort is total, and
 * (exception_date, created_at) is not: two employees can hold the same date and the same
 * creation instant, and a wobbling order across pages drops and duplicates rows.
 *
 * It takes its client as an argument so the paging rule can be exercised against a fake in
 * `tests/attendance-exception-row-cap.test.ts`, rather than pinned by a regex that would pass
 * the day someone reintroduced a `.limit()` two lines away.
 */
export async function fetchAllExceptionRows(
  supabase: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  applyFilters: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<ExceptionDbRow[]> {
  const rows: ExceptionDbRow[] = [];

  for (let offset = 0; ; ) {
    const query = applyFilters(
      supabase
        .from("attendance_exceptions")
        .select(EXCEPTION_COLUMNS)
        .order("exception_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    ).range(offset, offset + EXCEPTION_PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as ExceptionDbRow[];
    if (page.length === 0) break;

    rows.push(...page);
    offset += page.length;

    if (rows.length > MAX_ATTENDANCE_EXCEPTION_ROWS) {
      throw new Error(
        `Attendance exceptions exceeded ${MAX_ATTENDANCE_EXCEPTION_ROWS} rows; refusing to answer with a partial list.`,
      );
    }
  }

  return rows;
}

export async function getAttendanceExceptions(
  filters: GetAttendanceExceptionsFilters = {},
): Promise<AttendanceException[]> {
  const supabase = getSupabaseAdmin();

  const rows = await fetchAllExceptionRows(supabase, (query) => {
    let next = query;
    if (filters.employeeHrId) {
      const normalized = normalizeAttendanceHrId(filters.employeeHrId);
      if (normalized) next = next.eq("employee_hr_id", normalized);
    }
    if (filters.dateFrom) next = next.gte("exception_date", filters.dateFrom);
    if (filters.dateTo) next = next.lte("exception_date", filters.dateTo);
    if (filters.status && filters.status !== "all") {
      next = next.eq("status", filters.status);
    }
    return next;
  });

  const hrIds = [...new Set(rows.map((r) => normalizeAttendanceHrId(r.employee_hr_id) ?? r.employee_hr_id))];
  const nameMap = new Map<string, string>();

  for (const batch of chunk(hrIds)) {
    const { data: empData } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname")
      .in("hr_id", batch);
    for (const emp of (empData ?? []) as EmployeeNameRow[]) {
      const normalized = normalizeAttendanceHrId(emp.hr_id) ?? emp.hr_id;
      if (emp.full_name) nameMap.set(normalized, resolveEmployeeDisplayName(emp.full_name.trim(), emp.nickname, emp.hr_id));
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

  const map = new Map<string, AttendanceException>();
  if (normalized.length === 0) return map;

  for (const batch of chunk(normalized)) {
    const { data, error } = await supabase
      .from("attendance_exceptions")
      .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
      .gte("exception_date", dateFrom)
      .lte("exception_date", dateTo)
      .in("employee_hr_id", batch);

    if (error) throw error;

    for (const row of (data ?? []) as ExceptionDbRow[]) {
      const hrId = normalizeAttendanceHrId(row.employee_hr_id) ?? row.employee_hr_id;
      const key = `${hrId}|${row.exception_date}`;
      map.set(key, toException(row, new Map()));
    }
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

  const now = new Date().toISOString();

  // Spread, never a plain `notes:` key — an absent note must leave the column out of the update
  // altogether so Postgres does not touch it. See exception-notes.ts: the requester and the
  // reviewer share this one cell, and the review box starts empty on every render.
  const { data, error } = await supabase
    .from("attendance_exceptions")
    .update({
      ...resolveAttendanceExceptionNotesPatch(input.notes),
      reviewed_at: now,
      reviewed_by: input.reviewedBy,
      status: input.decision,
      updated_at: now,
    })
    .eq("id", input.id)
    .select("id,employee_hr_id,exception_date,reason,status,requested_by,reviewed_by,reviewed_at,notes,created_at")
    .single();

  if (error) throw error;
  return toException(data as ExceptionDbRow, new Map());
}

// Soft-delete: flips the exception to "rejected" (which un-suppresses any
// deduction it was excusing). Records who did it so the change is auditable —
// a silent status flip with no reviewer is a governance hole.
export async function deleteAttendanceException(id: number, reviewedBy: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("attendance_exceptions")
    .update({ reviewed_at: now, reviewed_by: reviewedBy, status: "rejected", updated_at: now })
    .eq("id", id);
  if (error) throw error;
}
