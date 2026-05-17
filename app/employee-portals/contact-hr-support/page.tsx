import { redirect } from "next/navigation";

import { ContactHRSupportPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalContactHRSupportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll");
  }
  await assertPermission(access, "payroll", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your profile. Please try again or contact your administrator."
        title="Something Went Wrong"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Open support tickets and reach your HR team faster with the latest escalation context."
      title="Contact HR Support"
    >
      <ContactHRSupportPage data={data} />
    </EmployeePortalPageShell>
  );
}
