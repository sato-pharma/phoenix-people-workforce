import { redirect } from "next/navigation";

import { ActivityControlDashboard } from "@/components/admin/activity-control-dashboard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessActivityControlCenter, resolveNavigationMode } from "@/lib/auth/permissions";
import { buildActivityRange, getActivityOverview } from "@/lib/activity/service";
import type { ActivityOverview } from "@/lib/activity/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ActivityControlPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canAccessActivityControlCenter(access)) {
    redirect("/admin");
  }

  const params = await searchParams;
  const range = buildActivityRange(Number(params?.days ?? "7"));

  let overview: ActivityOverview | null = null;
  let error: string | null = null;
  try {
    overview = await getActivityOverview(range);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Failed to load activity data.";
  }

  return (
    <ActivityControlDashboard initialOverview={overview} initialError={error} initialDays={range.days} />
  );
}
