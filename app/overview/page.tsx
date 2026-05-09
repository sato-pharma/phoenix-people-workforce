import { AppShell } from "@/components/layout/app-shell";
import { OverviewDashboard } from "@/components/overview/overview-dashboard";
import { getOverviewDashboard } from "@/lib/overview/service";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  await assertPermission(access, "overview", "read");
  const data = await getOverviewDashboard(access);

  return (
    <AppShell>
      <OverviewDashboard data={data} />
    </AppShell>
  );
}
