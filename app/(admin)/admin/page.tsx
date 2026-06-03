import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AdminCommandCenter } from "@/components/admin/admin-command-center";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { canAccess, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function AdminCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  const [canReadAdmin, canReadOverview, canReadEmployeeProfile] = await Promise.all([
    canAccess(access, "admin", "read"),
    canAccess(access, "overview", "read"),
    canAccess(access, "employee_profile", "read"),
  ]);

  if (!canReadAdmin && !canReadOverview) {
    if (canReadEmployeeProfile) {
      redirect("/employee-portals");
    }

    return (
      <div className="px-4 py-10 text-slate-900">
        <Card className="mx-auto max-w-xl rounded-none border-amber-200 bg-white p-6 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
          <div className="mb-4 flex items-center gap-3 text-amber-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6" />
            <h1 className="text-lg font-bold">Access unavailable</h1>
          </div>
          <p className="text-sm leading-6 text-slate-600">
            Your account is signed in, but it is not authorized for the admin workspace or employee portal yet. Ask your Phoenix admin to review your role and HR ID setup.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Admin Command Center"
          description="Preparing operational KPIs and executive attention queues."
        />
      }
    >
      <AdminCommandContent access={access} />
    </Suspense>
  );
}

async function AdminCommandContent({ access }: { access: AccessContext }) {
  const [viewer, dataResult] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getAdminCommandCenterData(access)
      .then((value) => ({ data: value, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load Admin Command Center:", error);
        return {
          data: null,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        };
      }),
  ]);
  const data = dataResult.data;
  const loadError = dataResult.error;

  const welcomeProfile = {
    fullName: viewer.displayName,
    hrId: formatHrIdForDisplay(access.hrId),
    managerName: null,
    systemRoleLabel: viewer.roleLabel,
    titleLabel: viewer.roleLabel,
  };

  return (
    data ? (
      <AdminCommandCenter data={data} welcomeProfile={welcomeProfile} />
    ) : (
      <div className="p-8">
        <Card className="mx-auto max-w-2xl rounded-none border-rose-100 bg-rose-50 p-6 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
          <div className="mb-4 flex items-center gap-3 text-rose-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6" />
            <h2 className="text-lg font-bold">Command Center Error</h2>
          </div>
          <p className="mb-4 text-sm text-rose-700">
            There was a problem loading operational data from Supabase. Please ensure your database views and tables are correctly configured.
          </p>
          <div className="border border-rose-200 bg-white/50 p-3">
            <p className="break-all font-mono text-xs text-rose-800">
              {loadError ?? "Unknown error occurred"}
            </p>
          </div>
        </Card>
      </div>
    )
  );
}
