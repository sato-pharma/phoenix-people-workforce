import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { RetentionRiskBandSection, RetentionRiskBandSkeleton } from "@/components/admin/retention-risk-band";
import { CeoPhaseBWidgets, CeoPhaseBSkeleton } from "@/components/admin/ceo-phase-b";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getCeoCommandCenterData } from "@/lib/ceo/command-center";

export const dynamic = "force-dynamic";

export default async function SfeCommandPage() {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "SFE Manager") redirect("/admin");

  return (
    <Suspense fallback={<AppRouteLoadingState title="Loading SFE Manager Overview" description="Preparing sales, workforce, and performance signals." />}>
      <SfeCommandContent access={access} />
    </Suspense>
  );
}

async function SfeCommandContent({ access }: { access: Awaited<ReturnType<typeof resolveAccessContextFromPage>> }) {
  // Both in parallel: neither needs the other, and the identity is a Storage lookup for the
  // uploaded photo on top of one row read, so serialising them would put that latency in front of
  // the page's own data for nothing. `resolveViewerIdentityFromPage` is `cache()`d per request, so
  // the topbar's own call in the shell costs nothing extra. Same shape as /admin.
  const [result, viewer] = await Promise.all([
    getCeoCommandCenterData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => ({ data: null, error: error instanceof Error ? error.message : "Unknown error occurred" })),
    resolveViewerIdentityFromPage(access),
  ]);

  if (!result.data) {
    return (
      <div className="p-8">
        <Card className="mx-auto max-w-2xl border-rose-100 bg-rose-50 p-6">
          <div className="flex items-center gap-3 text-rose-600"><AlertCircle className="h-6 w-6" /><h2 className="text-lg font-bold">SFE Overview Error</h2></div>
          <p className="mt-4 text-sm text-rose-700">The SFE Manager overview could not load its sales and workforce data.</p>
          <p className="mt-3 break-all border border-rose-200 bg-white/50 p-3 font-mono text-xs text-rose-800">{result.error ?? "Unknown error occurred"}</p>
        </Card>
      </div>
    );
  }

  // THE ORIGINAL IDENTITY BANNER, restored 2026-09-06: "I WANT THE SFE AND THE FINANCE AND CEO TO
  // HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE IS ONLY FOR HRs."
  //
  // Four instructions sit on this block and a session holding any three will undo the fourth:
  //
  //   1. 2026-09-03 — the full-bleed band (`AdminHeroFrame` + `CeoHeroIdentity`) went from here
  //      and from 131 other admin pages: "remove from all pages this dump block". `welcome` and
  //      its prop chain were deleted with it, which is why this rebuilds the object rather than
  //      un-commenting one.
  //   2. Later the same day — the identity back, THIN, under 96px. That is
  //      `PhoenixIdentityStrip`, and it went to the HR overview and /admin.
  //   3. 2026-09-06 — he reported this page had no identity at all ("I don't know why it
  //      disappeared"): it had been excluded on 2026-09-03 and was the only landing surface in
  //      the app greeting nobody. It was given the STRIP, which was the wrong one.
  //   4. Same day, immediately: the strip is HR's, this board wears its own band again.
  //
  // So the split is: CEO / SFE / Finance wear the band; the HR overview and /admin wear the strip.
  // Do not "unify" them — that has now been got wrong in both directions inside four days, and
  // tests/admin-landing-identity-strip.test.ts pins each surface to its own.
  //
  // The portrait is the bundled file, not the Storage lookup. `CeoHeroIdentity` hides it on a load
  // error, so the page renders whether or not it is present, and `viewer.initials` is the medallion
  // behind it. This photo carries its own dark studio background — it is NOT a "-transparent"
  // asset like the CEO's — which is why the hero masks its left and bottom edges.
  const welcome = {
    fullName: viewer.displayName,
    roleLabel: "SFE Manager",
    hrId: access.hrId,
    imageUrl: "/people/sfe-khaled-bedair.png",
    initials: viewer.initials,
  };

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <CeoCommandCenter
        data={result.data}
        welcome={welcome}
        access={access}
        variant="sfe"
        // Owner instruction 2026-09-06: this board and the System Administrator Overview, and no
        // other. Suspended on its own because the band scans the CRM visits mirror — the tiles
        // above must not wait on it.
        topBands={
          <Suspense fallback={<RetentionRiskBandSkeleton />}>
            <RetentionRiskBandSection />
          </Suspense>
        }
      />
      <Suspense fallback={<CeoPhaseBSkeleton variant="sfe" />}>
        <CeoPhaseBWidgets access={access} sosPrefetched={result.data.sos} adminSignalsPrefetched={result.data.adminSignals} variant="sfe" />
      </Suspense>
    </div>
  );
}
