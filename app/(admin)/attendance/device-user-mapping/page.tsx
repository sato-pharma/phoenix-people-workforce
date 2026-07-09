import { redirect } from "next/navigation";

import { DeviceUserMappingManager } from "@/components/attendance/device-user-mapping-manager";
import { getAttendanceDeviceUserMappingDashboard } from "@/lib/attendance/device-user-mapping";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDeviceUserMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  const canUpdate = await canAccessAttendanceSetup(access, "update");

  try {
    initialData = await getAttendanceDeviceUserMappingDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Device user mappings failed to load.";
  }

  const agentIsRemotelyReachable = process.env.NODE_ENV === "development";

  return (
    <DeviceUserMappingManager
      agentIsRemotelyReachable={agentIsRemotelyReachable}
      canUpdate={canUpdate}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
