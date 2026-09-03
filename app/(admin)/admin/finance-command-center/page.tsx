import { redirect } from "next/navigation";
import { Suspense } from "react";

import { FinanceCommandCenter } from "@/components/admin/finance-command-center";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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
  // `welcome` IS GONE. The identity banner it fed was removed 2026-09-03 at the owner's
  // instruction — "remove from all pages this dump block" — so nothing on this page reads a viewer
  // name, role label or portrait any more. Dropping the prop rather than leaving it unread also
  // drops the `resolveViewerIdentityFromPage` round trip and, on /admin, a Storage lookup for an
  // uploaded photo. The name and role are in the shell's topbar chip, resolved once for every page.
  const view = await getFinanceCommandCenterData(access);

  return <FinanceCommandCenter view={view} />;
}
