import { redirect } from "next/navigation";

import { AttendancePoliciesManager } from "@/components/attendance/attendance-policies-manager";
import { DigestSettingsPanel } from "@/components/attendance/digest-settings-panel";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";
import { getAttendancePolicyDashboard } from "@/lib/attendance/policies";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendancePoliciesPage() {
  const access = await resolveAccessContextFromPage();
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

  const digestSettings = await getDigestSettings().catch(() => null);

  return (
    <div className="space-y-5">
      <AttendancePoliciesManager canUpdate={canUpdate} initialData={initialData} initialError={initialError} />
      <DigestSettingsPanel canUpdate={canUpdate} employees={initialData?.employees ?? []} initialSettings={digestSettings} />
    </div>
  );
}
