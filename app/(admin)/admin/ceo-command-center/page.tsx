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
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
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
  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read, so serialising them would put that latency in front of
  // the page's own data for nothing. `resolveViewerIdentityFromPage` is `cache()`d per request, so
  // the topbar's own call in the shell costs nothing extra. Same shape as /admin.
  const [result, viewer] = await Promise.all([
    getCeoCommandCenterData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load CEO Command Center:", error);
        return { data: null, error: error instanceof Error ? error.message : "Unknown error occurred" };
      }),
    resolveViewerIdentityFromPage(access),
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

  // THE ORIGINAL IDENTITY BANNER, restored 2026-09-06: "I WANT THE SFE AND THE FINANCE AND CEO TO
  // HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE IS ONLY FOR HRs."
  //
  // Removed 2026-09-03 with the band on 131 other pages ("remove from all pages this dump block"),
  // briefly given the thin `PhoenixIdentityStrip` on 2026-09-06, and corrected the same hour. The
  // strip belongs to the HR overview and /admin; this board wears its own band. Full history on
  // `CeoWelcomeProfile` in ceo-command-center.tsx.
  //
  // TWO BRANCHES, because this page is reachable by two different people. The CEO gets his own
  // name, title and official portrait — a fixed asset, since he is the one person on this system
  // who always has one. A Super Admin opening the CEO's board gets THEIR own name and an initials
  // medallion instead of a blank frame where a photo would be; writing the CEO's portrait into
  // that branch would put his face above someone else's session.
  const welcome = access.role === "CEO"
    ? {
        fullName: "Dr. Anwar Gaweesh",
        roleLabel: "Chief Executive Officer",
        hrId: access.hrId,
        imageUrl: "/people/ceo-anwar-gaweesh-transparent.png",
        // Only ever needed if the portrait file itself 404s (CeoHeroIdentity's onError) — the
        // medallion is the safety net, not the expected path.
        initials: viewer.initials,
      }
    : {
        fullName: viewer.displayName,
        roleLabel: viewer.roleLabel,
        hrId: access.hrId,
        imageUrl: null,
        initials: viewer.initials,
      };

  return (
    <>
      <CeoCommandCenter data={result.data} welcome={welcome} access={access} />
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
