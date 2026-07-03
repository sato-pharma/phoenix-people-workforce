import { redirect } from "next/navigation";

import { HrPatternInsightsView } from "@/components/attendance/hr-pattern-insights-view";
import { getHrPatternInsights } from "@/lib/attendance/hr-pattern-insights";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

function defaultDateFrom() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function defaultDateTo() {
  return new Date().toISOString().slice(0, 10);
}

export default async function AttendanceHrPatternInsightsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }

  let initialInsights: Awaited<ReturnType<typeof getHrPatternInsights>> | null = null;
  let initialError: string | null = null;
  try {
    initialInsights = await getHrPatternInsights(defaultDateFrom(), defaultDateTo());
  } catch (error) {
    initialError = error instanceof Error ? error.message : "HR pattern insights failed to load.";
  }

  return <HrPatternInsightsView initialError={initialError} initialInsights={initialInsights} />;
}
