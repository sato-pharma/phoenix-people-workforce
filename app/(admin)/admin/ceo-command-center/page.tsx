import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CeoCommandCenter } from "@/components/admin/ceo-command-center";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { getExecutiveDashboardSnapshot, type ExecutiveDashboardSnapshot } from "@/lib/executive/dashboard-snapshot";
import { formatHrIdForDisplay } from "@/lib/hr-id";

export const dynamic = "force-dynamic";

export default async function CeoCommandCenterPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  // Executive surface is reserved for the CEO (and Super Admin / system scope).
  // Server-side enforcement — sidebar visibility is UX only, never the boundary.
  //
  // GOVERNANCE NOTE (Phase 1): this surface intentionally uses the CEO's EXISTING
  // permission matrix unchanged and renders read-only, aggregate KPIs only. The CEO
  // governance lockdown (narrowing approve/admin grants) is deferred to Phase 2 by design.
  const isExecutive =
    access.role === "CEO" || access.role === "Super Admin" || access.scope === "system";
  if (!isExecutive) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading CEO Command Center"
          description="Preparing executive metrics, risk signals, and weekly brief."
        />
      }
    >
      <CeoCommandCenterContent access={access} />
    </Suspense>
  );
}

async function CeoCommandCenterContent({ access }: { access: AccessContext }) {
  const [snapshotResult, viewer] = await Promise.all([
    getExecutiveDashboardSnapshot(access)
      .then((value) => ({ data: value, error: null as string | null }))
      .catch((error) => {
        console.error("Failed to load CEO Command Center:", error);
        return {
          data: null as ExecutiveDashboardSnapshot | null,
          error: error instanceof Error ? error.message : "Unknown error occurred",
        };
      }),
    resolveViewerIdentityFromPage(access),
  ]);
  const snapshot = snapshotResult.data;
  const loadError = snapshotResult.error;

  const executiveProfile = {
    fullName: viewer.displayName,
    roleLabel: viewer.roleLabel,
    hrId: formatHrIdForDisplay(access.hrId) ?? "",
  };

  return (
    <CeoCommandCenter
      brief={snapshot?.brief ?? null}
      data={snapshot?.data ?? null}
      generatedAtIso={snapshot?.generatedAt ?? new Date().toISOString()}
      health={snapshot?.health ?? { available: false, coveragePct: 0, overall: null, pillars: [] }}
      loadError={loadError}
      risk={snapshot?.risk ?? { rows: [], unavailableSources: ["Executive dashboard snapshot"] }}
      viewer={executiveProfile}
    />
  );
}
