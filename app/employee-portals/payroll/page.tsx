import { redirect } from "next/navigation";

import { MedicalRepPayrollPage } from "@/components/employee-portal/employee-portal-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalPayrollPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll/dashboard");
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
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-semibold text-slate-900">Portal Unavailable</p>
        <p className="mt-2 text-sm text-slate-600">Your command center is temporarily unavailable. Please try again in a moment.</p>
      </div>
    );
  }

  return <MedicalRepPayrollPage data={data} />;
}
