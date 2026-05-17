import { redirect } from "next/navigation";

import { AttendancePoliciesManager } from "@/components/attendance/attendance-policies-manager";
import { AppShell } from "@/components/layout/app-shell";
import { getAttendancePolicyDashboard } from "@/lib/attendance/policies";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendancePoliciesPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  const canUpdate = await canAccess(access, "employees", "update");

  try {
    initialData = await getAttendancePolicyDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance policies failed to load.";
  }

  return (
    <AppShell navigationMode="admin">
      <AttendancePoliciesManager canUpdate={canUpdate} initialData={initialData} initialError={initialError} />
    </AppShell>
  );
}
