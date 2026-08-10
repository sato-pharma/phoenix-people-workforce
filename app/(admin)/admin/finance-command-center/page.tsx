import { redirect } from "next/navigation";
import { Suspense } from "react";

import { FinanceCommandCenter } from "@/components/admin/finance-command-center";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage, resolveViewerIdentityFromPage } from "@/lib/auth/server";
import { getFinanceCommandCenterData } from "@/lib/finance/command-center";

export const dynamic = "force-dynamic";

export default async function FinanceCommandPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Gated on the ROLE, exactly like the CEO and SFE command centers, and deliberately not on a
  // permission resource: the Finance Manager holds no `overview` grant at all, so a
  // permissions-based gate would lock him out of his own landing page. Super Admin keeps access
  // so the page can be supported without borrowing his account.
  const allowed = access.role === "Finance Manager" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  // Auth and redirects resolve OUTSIDE the boundary so the shell paints immediately and a
  // denied viewer is bounced before any data work starts.
  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Preparing your payroll cycle, action queues, and committed cost figures."
          title="Loading Finance Command Center"
        />
      }
    >
      <FinanceCommandContent access={access} />
    </Suspense>
  );
}

async function FinanceCommandContent({ access }: { access: AccessContext }) {
  // getFinanceCommandCenterData never throws — it degrades to named unavailable sources so a
  // single failing source cannot take down a landing page.
  const [viewer, view] = await Promise.all([
    resolveViewerIdentityFromPage(access),
    getFinanceCommandCenterData(access),
  ]);

  return (
    <FinanceCommandCenter
      view={view}
      welcome={{
        fullName: viewer.displayName,
        hrId: access.hrId,
        // B-185 has a mapped portrait (src/lib/employees/profile-images.ts); resolveViewerIdentity
        // already resolves it, and CeoHeroIdentity self-hides on a load error, so passing it
        // through costs nothing when a viewer has none.
        imageUrl: viewer.imageUrl,
        roleLabel: viewer.roleLabel,
      }}
    />
  );
}
