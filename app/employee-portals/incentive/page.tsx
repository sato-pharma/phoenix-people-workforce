import { redirect } from "next/navigation";

import { EmployeePortalIncentivePage } from "@/components/employee-portal/employee-portal-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalIncentivePageRoute() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  await assertPermission(access, "employee_profile", "read");

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
        <p className="mt-2 text-sm text-slate-600">Unable to load incentive data. Please try again later.</p>
      </div>
    );
  }

  return <EmployeePortalIncentivePage data={data} />;
}

