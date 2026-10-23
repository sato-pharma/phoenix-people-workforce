import { redirect } from "next/navigation";

import { AttendanceAnalyticsDashboard } from "@/components/attendance/attendance-analytics-dashboard";
import { getAttendanceAnalytics } from "@/lib/attendance/analytics";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/analytics");
  if (access.role !== "Super Admin" || !await canAccess(access, "attendance", "read")) {
    redirect("/employee-portals");
  }

  let initialData = null;
  let initialError: string | null = null;
  try {
    initialData = await getAttendanceAnalytics();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Attendance analytics failed to load.";
  }

  return <AttendanceAnalyticsDashboard initialData={initialData} initialError={initialError} />;
}
