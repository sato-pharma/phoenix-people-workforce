import { redirect } from "next/navigation";

import { SettlementDashboardView } from "@/components/attendance/settlement-dashboard-view";
import { getSettlementDashboard } from "@/lib/attendance/settlement-dashboard";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceSettlementDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }
  const canRemind = await canAccessAttendanceSetup(access, "update");

  let initialDashboard = null;
  let initialError: string | null = null;
  try {
    initialDashboard = await getSettlementDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Settlement dashboard failed to load.";
  }

  return <SettlementDashboardView canRemind={canRemind} initialDashboard={initialDashboard} initialError={initialError} />;
}
