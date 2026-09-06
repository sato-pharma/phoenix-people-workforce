import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { CeoPhaseBWidgets, CeoPhaseBSkeleton } from "@/components/admin/ceo-phase-b";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getCeoCommandCenterData } from "@/lib/ceo/command-center";
import { formatHrIdForDisplay } from "@/lib/hr-id";

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

  // THE IDENTITY IS BACK ON THIS PAGE, AS THE 92px STRIP — owner, 2026-09-06: "yes recover the ceo
  // and finance banners too."
  //
  // Three instructions in sequence, and a session holding only one of them will undo another:
  //
  //   1. 2026-09-03 — the full-bleed black band (`AdminHeroFrame` + `CeoHeroIdentity`, a photo, a
  //      greeting, a clock) went from here and from 131 other admin pages: "remove from all pages
  //      this dump block". `welcome` and its prop chain were deleted with it.
  //   2. Later the same day he asked for the identity back in the employee portal's idiom, thin —
  //      "I don't want it to be too thick... I want it to be narrow" — and set the height himself,
  //      under 96px. That is `PhoenixIdentityStrip`: 88px on a phone, 92px from `sm`, both fixed.
  //      It shipped on the HR overview (#3037) and then on /admin (#3070), and in the same breath
  //      he said the other three boards were to be left alone: "you will keep the CEO and the SFE
  //      and the finance as they are today."
  //   3. 2026-09-06 — he asked for the SFE Manager's back, then for these two. That retires the
  //      2026-09-03 exclusion COMPLETELY: all five admin landing surfaces now carry the strip, and
  //      there is no longer a board that deliberately has none.
  //
  // WHAT IS STILL FORBIDDEN, because it is a different thing: the BLACK BAND. The note in
  // ceo-command-center.tsx is about that, and it stands. A thin strip is not the band.
  //
  // MOUNTED IN THE PAGE, NOT IN `CeoCommandCenter`. That component serves three variants — CEO,
  // SFE and the Super Admin's /admin — so a strip inside it would render three times for one of
  // them and would put a second, stacked identity on any page that later reuses the component.
  // All five surfaces mount their own for exactly that reason.
  //
  // The CEO's portrait comes from `resolveViewerIdentityFromPage`, the same source as the topbar
  // chip, so the two cannot disagree — including on the JOB TITLE, which that resolver maps rather
  // than printing the permission key. /people/ceo-anwar-gaweesh-transparent.png is NOT read here;
  // it stays in public/people as his official portrait.

  return (
    <>
      <PhoenixIdentityStrip
        employeeCode={formatHrIdForDisplay(access.hrId)}
        name={viewer.displayName}
        photoSrc={viewer.imageUrl ?? null}
        title={viewer.roleLabel}
      />
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
