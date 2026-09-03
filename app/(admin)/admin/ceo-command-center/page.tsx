import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { CeoPhaseBWidgets, CeoPhaseBSkeleton } from "@/components/admin/ceo-phase-b";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCeoCommandCenterData } from "@/lib/ceo/command-center";

export const dynamic = "force-dynamic";

export default async function CeoCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

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
  const result = await getCeoCommandCenterData(access)
    .then((data) => ({ data, error: null as string | null }))
    .catch((error) => {
      console.error("Failed to load CEO Command Center:", error);
      return { data: null, error: error instanceof Error ? error.message : "Unknown error occurred" };
    });

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

  // `welcome` IS GONE. The identity banner it fed was removed 2026-09-03 at the owner's
  // instruction — "remove from all pages this dump block" — so nothing on this page reads a viewer
  // name, role label or portrait any more. Dropping the prop rather than leaving it unread also
  // drops the `resolveViewerIdentityFromPage` round trip and, on /admin, a Storage lookup for an
  // uploaded photo. The name and role are in the shell's topbar chip, resolved once for every page.
  //
  // The CEO's own portrait went with it: /people/ceo-anwar-gaweesh-transparent.png was referenced
  // from here and nowhere else. The FILE is left in public/people — it is his official portrait,
  // not a build artefact.

  return (
    <>
      <CeoCommandCenter data={result.data} access={access} />
      <Suspense fallback={<CeoPhaseBSkeleton />}>
        <CeoPhaseBWidgets
          access={access}
          sosPrefetched={result.data.sos}
          adminSignalsPrefetched={result.data.adminSignals}
        />
      </Suspense>
    </>
  );
}
