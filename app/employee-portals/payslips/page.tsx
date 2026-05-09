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

export default async function EmployeePortalPayslipsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payslips");
  }
  await assertPermission(access, "payslips", "read");

  let data = null;
  try {
    data = await getMedicalRepPortalData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
        title="Payslips Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Review your monthly compensation with clarity and confidence."
      title="My Earnings"
    >
      <MedicalRepPayrollPage data={data} />
    </EmployeePortalPageShell>
  );
}
