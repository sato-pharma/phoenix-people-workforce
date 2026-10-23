import { redirect } from "next/navigation";

import { DeviceUserMappingManager } from "@/components/attendance/device-user-mapping-manager";
import { getAttendanceDeviceUserMappingDashboard } from "@/lib/attendance/device-user-mapping";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceDeviceUserMappingPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/device-user-mapping");
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

  // "Run Local Agent" spawns a process on whatever machine the Next.js SERVER runs on, so it can
  // only ever do something useful in local dev (the server and the agent are the same machine).
  // "Sync Now" is different: it is called directly from the BROWSER against 127.0.0.1:8787 (see
  // DeviceUserMappingManager), so it works from the real production page too, as long as the
  // browser viewing it is on the machine the agent runs on. The token is only ever handed to a
  // caller who already passed the update-permission gate above.
  const canRunLocalAgentSpawn = process.env.NODE_ENV === "development";
  // ATTENDANCE_AGENT_BROWSER_TOKEN, never ATTENDANCE_AGENT_TOKEN. This value is a client-component
  // prop, so it is serialized into the RSC payload and readable in view-source by anyone who can
  // open this page. ATTENDANCE_AGENT_TOKEN is the sole credential on the public
  // POST /api/attendance/raw-punches (see that route's auth gate), so putting it here would let any
  // reader write arbitrary attendance straight into payroll from anywhere. The browser token only
  // unlocks the agent's /sync-now. If it is unset, the button hides and auto-sync carries on.
  const localAgentDirectToken = canUpdate ? process.env.ATTENDANCE_AGENT_BROWSER_TOKEN ?? null : null;

  return (
    <DeviceUserMappingManager
      canRunLocalAgentSpawn={canRunLocalAgentSpawn}
      canUpdate={canUpdate}
      initialData={initialData}
      initialError={initialError}
      localAgentDirectToken={localAgentDirectToken}
    />
  );
}
