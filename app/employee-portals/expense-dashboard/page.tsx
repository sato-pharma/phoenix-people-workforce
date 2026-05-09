import { redirect } from "next/navigation";

import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getMedicalRepPortalData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";


export default async function EmployeePortalExpenseDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payroll/dashboard");
  }
  await assertPermission(access, "expenses", "read");

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

  if (!data.workload?.expenseRows?.length) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
          <p className="text-xl font-bold">!</p>
        </div>
        <p className="mt-4 text-lg font-semibold text-slate-900">No expense records</p>
        <p className="mt-2 text-sm text-slate-600">No expense records are linked to your profile yet.</p>
      </div>
    );
  }

  return <PersonalExpenseWorkloadDashboard data={data} />;
}
