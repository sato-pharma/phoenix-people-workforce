import { AppShell } from "@/components/layout/app-shell";
import { GeoIntelligenceDashboard } from "@/components/geo/geo-intelligence-dashboard";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getGeoDashboardData } from "@/lib/geo-intelligence/service";

export const dynamic = "force-dynamic";

export default async function GeoIntelligencePage(
  props: PageProps<"/admin/geo-intelligence">,
) {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "geo_intelligence", "read")) {
    redirect("/employee-portals");
  }
  const searchParams = await props.searchParams;
  const data = await getGeoDashboardData(access, {
    area: typeof searchParams.area === "string" ? searchParams.area : null,
    employeeHrId:
      typeof searchParams.employeeHrId === "string" ? searchParams.employeeHrId : null,
    line: typeof searchParams.line === "string" ? searchParams.line : null,
    month: typeof searchParams.month === "string" ? searchParams.month : null,
    status: typeof searchParams.status === "string" ? searchParams.status as "" | "normal" | "review_required" | "high_risk" : "",
  });

  return (
    <AppShell navigationMode="admin">
      <GeoIntelligenceDashboard data={data} />
    </AppShell>
  );
}
