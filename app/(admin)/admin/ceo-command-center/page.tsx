import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getCeoCommandCenterData } from "@/lib/ceo/command-center";

export const dynamic = "force-dynamic";

export default async function CeoCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // CEO + Super Admin (or system) only. The CEO lands here; Super Admin can open it for
  // review. Anyone else with admin access falls back to the generic command center.
  // Mirrors the server gate elsewhere — sidebar visibility is never the security boundary.
  const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading CEO Command Center"
          description="Preparing your executive KPIs, attention queue, and sales performance."
        />
      }
    >
      <CeoCommandContent access={access} />
    </Suspense>
  );
}

async function CeoCommandContent({ access }: { access: AccessContext }) {
  const [viewer, result] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getCeoCommandCenterData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load CEO Command Center:", error);
        return { data: null, error: error instanceof Error ? error.message : "Unknown error occurred" };
      }),
  ]);

  if (!result.data) {
    return (
      <div className="p-8">
        <Card className="mx-auto max-w-2xl rounded-none border-rose-100 bg-rose-50 p-6 shadow-[0_2px_8px_rgba(15,23,42,0.06)]">
          <div className="mb-4 flex items-center gap-3 text-rose-600">
            <AlertCircle aria-hidden="true" className="h-6 w-6" />
            <h2 className="text-lg font-bold">Command Center Error</h2>
          </div>
          <p className="mb-4 text-sm text-rose-700">
            There was a problem loading your executive data from Supabase. Please ensure the database views and
            tables are correctly configured.
          </p>
          <div className="border border-rose-200 bg-white/50 p-3">
            <p className="break-all font-mono text-xs text-rose-800">{result.error ?? "Unknown error occurred"}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <CeoCommandCenter
      data={result.data}
      welcome={{ fullName: viewer.displayName, roleLabel: viewer.roleLabel, hrId: access.hrId }}
      access={access}
    />
  );
}
