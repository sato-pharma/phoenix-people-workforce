import { redirect } from "next/navigation";

import { EarningsPage } from "@/components/employee-portal/employee-portal-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalEarningsPage() {
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

  if (!data || data.empty.profile) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
          <p className="text-xl font-bold">!</p>
        </div>
        <p className="mt-4 text-lg font-semibold text-slate-900">Profile Not Linked</p>
        <p className="mt-2 text-sm text-slate-600">Your employee profile is not linked yet. Please contact HR.</p>
      </div>
    );
  }

  if (data.empty.payroll) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-slate-900">Earnings</h1>
            <p className="mt-1 text-sm text-slate-500">Overview of your earnings, incentives, and deductions</p>
          </div>
        </div>
        <div className="rounded-3xl border border-slate-100 bg-white p-20 text-center shadow-sm">
          <div className="mx-auto flex max-w-md flex-col items-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 text-slate-400">
              <span className="text-2xl">?</span>
            </div>
            <h2 className="mt-6 text-xl font-semibold text-slate-900">No Earnings Data</h2>
            <p className="mt-2 text-slate-500">Payslip data has not been uploaded yet.</p>
          </div>
        </div>
      </div>
    );
  }

  return <EarningsPage data={data} />;
}
