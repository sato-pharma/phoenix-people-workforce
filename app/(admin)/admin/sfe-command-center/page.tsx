import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { CeoPhaseBWidgets, CeoPhaseBSkeleton } from "@/components/admin/ceo-phase-b";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import { Card } from "@/components/ui/card";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getCeoCommandCenterData } from "@/lib/ceo/command-center";
import { formatHrIdForDisplay } from "@/lib/hr-id";

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

  // THE IDENTITY IS BACK ON THIS PAGE, AS THE 92px STRIP — owner, 2026-09-06: "in the SFE manager
  // account recover his identity banner, I don't know why it disappeared."
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
  //      and the finance as they are today." So this page was excluded on purpose, and stayed the
  //      only landing surface in the app with no identity on it at all.
  //   3. 2026-09-06 — he asked for it back HERE, by name. That reverses (2) for THIS page only.
  //      THE CEO AND FINANCE BOARDS ARE NOT COVERED and must not be "brought into parity": their
  //      exclusion is still the standing instruction until he says otherwise.
  //
  // MOUNTED IN THE PAGE, NOT IN `CeoCommandCenter`. That component serves three variants — CEO,
  // SFE and the Super Admin's /admin — so a strip inside it would reach the CEO board the moment
  // the variant flags were rearranged. /admin solves it the same way, for the same reason. This
  // file is the SFE route and nothing else.
  //
  // /people/sfe-khaled-bedair.png is not read here: the portrait comes from
  // `resolveViewerIdentityFromPage`, the same source as the topbar chip, so the two cannot
  // disagree — including on the JOB TITLE, which that resolver maps rather than printing the
  // permission key.

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PhoenixIdentityStrip
        employeeCode={formatHrIdForDisplay(access.hrId)}
        name={viewer.displayName}
        photoSrc={viewer.imageUrl ?? null}
        title={viewer.roleLabel}
      />
      <CeoCommandCenter data={result.data} access={access} variant="sfe" />
      <Suspense fallback={<CeoPhaseBSkeleton variant="sfe" />}>
        <CeoPhaseBWidgets access={access} sosPrefetched={result.data.sos} adminSignalsPrefetched={result.data.adminSignals} variant="sfe" />
      </Suspense>
    </div>
  );
}
