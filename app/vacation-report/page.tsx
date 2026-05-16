import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { VacationReport } from "@/components/leave/vacation-report";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function VacationReportPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  return (
    <AppShell navigationMode="admin">
      <VacationReport />
    </AppShell>
  );
}
