import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { assertCanViewEmployeeAttendance, getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");

    const { searchParams } = new URL(request.url);
    const hrId = searchParams.get("hrId");
    if (!hrId) {
      return NextResponse.json({ error: "hrId is required" }, { status: 400 });
    }
    await assertCanViewEmployeeAttendance(access, hrId);

    const today = new Date();
    const dateTo = today.toISOString().slice(0, 10);
    const dateFrom = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())
      .toISOString()
      .slice(0, 10);

    const supabase = getSupabaseAdmin();

    const [attendanceResult, leaveResult, excusesResult] = await Promise.allSettled([
      getEmployeeAttendanceData(hrId, dateFrom, dateTo),
      supabase
        .from("v2_vacation_requests")
        .select("vacation_type, start_date, end_date, manager_decision, hr_decision")
        .eq("employee_hr_id", hrId.toUpperCase())
        .in("status", ["approved", "rejected"])
        .order("created_at", { ascending: false })
        .limit(6),
      supabase
        .from("v2_excuse_requests")
        .select("excuse_date, excuse_type, status")
        .eq("employee_hr_id", hrId.toUpperCase())
        .in("status", ["approved", "rejected"])
        .order("created_at", { ascending: false })
        .limit(6),
    ]);

    const attendance =
      attendanceResult.status === "fulfilled"
        ? { ...attendanceResult.value.summary, dateFrom, dateTo }
        : { absentDays: 0, completeDays: 0, lateDays: 0, shortDays: 0, totalRows: 0, deductionDays: 0, exceptionDays: 0, dateFrom, dateTo };

    const recentLeave =
      leaveResult.status === "fulfilled" && !leaveResult.value.error
        ? (leaveResult.value.data ?? []).map((row: Record<string, unknown>) => ({
            vacationType: String(row.vacation_type ?? ""),
            startDate: String(row.start_date ?? ""),
            endDate: String(row.end_date ?? ""),
            managerDecision: (row.manager_decision as "approved" | "rejected" | null) ?? null,
            hrDecision: (row.hr_decision as "approved" | "rejected" | null) ?? null,
          }))
        : [];

    const recentExcuses =
      excusesResult.status === "fulfilled" && !excusesResult.value.error
        ? (excusesResult.value.data ?? []).map((row: Record<string, unknown>) => ({
            excuseDate: String(row.excuse_date ?? ""),
            excuseType: String(row.excuse_type ?? "morning") as "morning" | "afternoon",
            status: String(row.status ?? ""),
          }))
        : [];

    return NextResponse.json({ attendance, recentLeave, recentExcuses });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context unavailable" },
      { status: 500 },
    );
  }
}
