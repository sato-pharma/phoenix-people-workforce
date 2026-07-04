import { redirect } from "next/navigation";

import { DoubleVisitAnalyticsWorkspace } from "@/components/double-visit-analytics/double-visit-analytics-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function dateParam(value: string | string[] | undefined) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export default async function DoubleVisitAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!(await canAccess(access, "double_visit_analytics", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const dashboard = await getDoubleVisitDashboardData({
    access,
    dateFrom: dateParam(params.dateFrom),
    dateTo: dateParam(params.dateTo),
  });

  return <DoubleVisitAnalyticsWorkspace dashboard={dashboard} />;
}
