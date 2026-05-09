import { redirect } from "next/navigation";

import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalPayrollPage() {
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
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Employee Portal"
      description="Review payslips, salary status, and payroll timeline from one center."
      title="Payroll Center"
    >
      <MedicalRepPayrollPage data={data} />
    </EmployeePortalPageShell>
  );
}
