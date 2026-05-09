import { AppShell } from "@/components/layout/app-shell";
import { GeoIntelligenceDashboard } from "@/components/geo/geo-intelligence-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getGeoDashboardData } from "@/lib/geo-intelligence/service";

export const dynamic = "force-dynamic";

export default async function GeoIntelligencePage(
  props: PageProps<"/admin/geo-intelligence">,
) {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "geo_intelligence", "read");
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
    <AppShell showTopbar={false}>
      <GeoIntelligenceDashboard data={data} />
    </AppShell>
  );
}
