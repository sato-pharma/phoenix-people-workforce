import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
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
  const [viewer, result] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getCeoCommandCenterData(access)
      .then((data) => ({ data, error: null as string | null }))
      .catch((error) => ({ data: null, error: error instanceof Error ? error.message : "Unknown error occurred" })),
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

  // Portrait for the identity banner. Same convention as the CEO hero: a transparent-background
  // PNG under public/people. The hero hides the portrait on load error (CeoHeroIdentity's
  // onError), so the page renders correctly whether or not the file is present — dropping the
  // asset in is all that is needed to light it up.
  const welcome = {
    fullName: viewer.displayName,
    roleLabel: "SFE Manager",
    hrId: access.hrId,
    // NOT a "-transparent" asset like the CEO's: this photo carries its own dark studio
    // background, which is why the hero masks its left and bottom edges rather than just
    // dropping it in.
    imageUrl: "/people/sfe-khaled-bedair.png",
  };
  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <CeoCommandCenter data={result.data} welcome={welcome} access={access} variant="sfe" />
      <Suspense fallback={<CeoPhaseBSkeleton variant="sfe" />}>
        <CeoPhaseBWidgets access={access} sosPrefetched={result.data.sos} adminSignalsPrefetched={result.data.adminSignals} variant="sfe" />
      </Suspense>
    </div>
  );
}
