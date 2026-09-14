import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { parsePhoenixCrmTab, PhoenixCrmSpace } from "@/components/employee-portal/phoenix-crm-space";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPhoenixCrmAccess } from "@/lib/crm/native-visits/phoenix-crm";

export const dynamic = "force-dynamic";

// Phoenix CRM (the owner, 2026-09-14): Visits, Planning and KPIs for the pilot reps the Super Admin picks,
// their own managers, and the Super Admin. Nobody else sees it.
export default async function PhoenixCrmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const { seat } = await getPhoenixCrmAccess(access);
  if (!seat) {
    redirect("/employee-portals/visits");
  }
  const params = await searchParams;
  const month = Array.isArray(params.month) ? params.month[0] : params.month;

  return (
    <EmployeePortalPageShell
      badge="Phoenix CRM"
      description={
        seat === "rep"
          ? "Enter your visits, plan your week and follow your KPIs, all in Phoenix."
          : seat === "manager"
            ? "Your pilot reps' visits, plans and KPIs. Confirm the visits that name you and verify the plans sent to you."
            : "Visits, plans and KPIs of every pilot rep, and the reps in the pilot."
      }
      title="Phoenix CRM"
    >
      <PhoenixCrmSpace
        access={access}
        basePath="/employee-portals/phoenix-crm"
        month={month}
        seat={seat}
        tab={parsePhoenixCrmTab(params.tab, seat)}
      />
    </EmployeePortalPageShell>
  );
}
