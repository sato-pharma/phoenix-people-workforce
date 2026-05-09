import { redirect } from "next/navigation";

import { ContactHRSupportPage } from "@/components/employee-portal/employee-portal-dashboard";
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

  if (!data || data.empty.profile) {
    return (
      <EmployeePortalEmptyState
        message="Your employee profile is not linked yet. Please contact HR."
        title="Profile Not Linked"
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
