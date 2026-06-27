import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PayrollDashboard } from "@/components/payroll/payroll-dashboard-dynamic";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { assertPermission, getPayrollScope, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPayrollDashboard } from "@/lib/payroll/service";

export default async function PayrollPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const [sp, access] = await Promise.all([
    searchParams,
    resolveAccessContextFromPage(),
  ]);
  const scope = getPayrollScope(access);
  if (scope !== "COMPANY") {
    redirect("/payslips");
  }
  await assertPermission(access, "payroll", "read");
  if (access.role === "CEO") {
    const target = sp.batchId ? `/admin/m-payroll?batchId=${encodeURIComponent(sp.batchId)}` : "/admin/m-payroll";
    redirect(target);
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Payroll"
          description="Preparing salary batches, records, flags, and governance checks."
        />
      }
    >
      <PayrollContent access={access} batchId={sp.batchId} />
    </Suspense>
  );
}

async function PayrollContent({ access, batchId }: { access: AccessContext; batchId?: string }) {
  let data = null;
  let error: string | null = null;

  try {
    data = await getPayrollDashboard(batchId, access);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load payroll data.";
  }

  return (
    <PayrollDashboard
      initialData={data}
      initialError={error}
    />
  );
}
