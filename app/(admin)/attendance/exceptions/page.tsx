import { redirect } from "next/navigation";

import { AttendanceExceptionsManager } from "@/components/attendance/attendance-exceptions-manager";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type EmployeeRow = { full_name: string | null; hr_id: string };

export default async function AttendanceExceptionsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin/access");
  }

  const supabase = getSupabaseAdmin();
  const [exceptionsResult, employeesResult] = await Promise.allSettled([
    getAttendanceExceptions({ status: "all" }),
    supabase.from("employees").select("hr_id,full_name").order("full_name"),
  ]);

  const initialData = exceptionsResult.status === "fulfilled" ? exceptionsResult.value : [];
  const initialError = exceptionsResult.status === "rejected"
    ? (exceptionsResult.reason instanceof Error ? exceptionsResult.reason.message : "Failed to load exceptions.")
    : null;

  const employees = (
    employeesResult.status === "fulfilled"
      ? (employeesResult.value.data ?? []) as EmployeeRow[]
      : []
  ).map((e) => ({ fullName: e.full_name?.trim() || e.hr_id, hrId: e.hr_id }));

  return (
    <AttendanceExceptionsManager
      canReview={true}
      employees={employees}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
