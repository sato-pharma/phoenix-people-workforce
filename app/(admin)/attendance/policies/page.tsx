import { redirect } from "next/navigation";

import { AttendancePoliciesManager } from "@/components/attendance/attendance-policies-manager";
import { getAttendancePolicyDashboard } from "@/lib/attendance/policies";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendancePoliciesPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/policies");
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  const canUpdate = await canAccessAttendanceSetup(access, "update");

  try {
    initialData = await getAttendancePolicyDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance policies failed to load.";
  }

  return (
    <div className="space-y-5">
      <AttendancePoliciesManager canUpdate={canUpdate} initialData={initialData} initialError={initialError} />
    </div>
  );
}
