import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { DataHealthDashboard } from "@/components/admin/data-health-dashboard";
import { RoleCoverageAuditView } from "@/components/admin/role-coverage-audit";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess } from "@/lib/auth/permissions";
import { getDataHealthStats, getSalaryFlags } from "@/lib/admin/service";
import { getRoleCoverageAudit } from "@/lib/admin/role-coverage/audit";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function DataHealthPage() {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  return (
    <div className="space-y-6">
      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading Data Health"
            description="Auditing workforce, access, sales ownership, and payroll flags."
          />
        }
      >
        <DataHealthContent />
      </Suspense>
      {/* Role Coverage streams on its own: it calls every registered module's own people list, and
          one slow module must never hold the governance queues above it. */}
      <Suspense
        fallback={
          <AppRouteLoadingState
            title="Loading Role Coverage"
            description="Reading each module's own people list and comparing it with today's roster."
          />
        }
      >
        <RoleCoverageContent />
      </Suspense>
    </div>
  );
}

async function RoleCoverageContent() {
  // Data fetch and JSX stay separated (react-hooks/error-boundaries: no JSX inside try/catch).
  let audit: Awaited<ReturnType<typeof getRoleCoverageAudit>> | null = null;
  let loadError: string | null = null;
  try {
    audit = await getRoleCoverageAudit();
  } catch (error) {
    console.error("Failed to load the Role Coverage audit:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  if (!audit) {
    return (
      <Card className="border border-rose-200 bg-white p-6">
        <h2 className="text-lg font-black tracking-tight text-rose-900">Role Coverage could not be measured</h2>
        <p className="mt-1 break-words text-sm text-rose-700">{loadError ?? "Unknown error occurred"}</p>
      </Card>
    );
  }
  return <RoleCoverageAuditView audit={audit} />;
}

async function DataHealthContent() {
  let stats = null;
  let salaryFlagsData = null;
  let loadError: string | null = null;

  try {
    [stats, salaryFlagsData] = await Promise.all([
      getDataHealthStats(),
      getSalaryFlags(false),
    ]);
  } catch (error) {
    console.error("Failed to load Data Health Dashboard:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  return (
    stats ? (
      <DataHealthDashboard salaryFlags={salaryFlagsData} stats={stats} />
    ) : (
      <div className="p-6 sm:p-8">
        <Card className="relative mx-auto max-w-2xl overflow-hidden rounded-2xl border border-rose-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-40 -top-44 h-[520px] w-[520px] rounded-full bg-rose-500/6 blur-3xl"
          />
          <div className="relative z-10">
            <div className="mb-4 flex items-center gap-3 text-rose-700">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-black tracking-tight text-rose-900">Data Governance Error</h2>
                <p className="mt-0.5 text-sm text-rose-700">
                  There was a problem loading the data health audit from Supabase. Please ensure your governance views are correctly configured.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50/30 p-4">
              <p className="break-all font-mono text-xs font-semibold text-rose-800">
                {loadError ?? "Unknown error occurred"}
              </p>
            </div>
          </div>
        </Card>
      </div>
    )
  );
}
