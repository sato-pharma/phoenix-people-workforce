import { redirect } from "next/navigation";

import { DeviceUserMappingManager } from "@/components/attendance/device-user-mapping-manager";
import { AppShell } from "@/components/layout/app-shell";
import { getAttendanceDeviceUserMappingDashboard } from "@/lib/attendance/device-user-mapping";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDeviceUserMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "employees", "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  const canUpdate = await canAccess(access, "employees", "update");

  try {
    initialData = await getAttendanceDeviceUserMappingDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Device user mappings failed to load.";
  }

  return (
    <AppShell navigationMode="admin">
      <DeviceUserMappingManager
        canUpdate={canUpdate}
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
