import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { OffersManager } from "@/components/offers/offers-manager";
import { canAccess } from "@/lib/auth/permissions";
import { loadOffersWorkspace } from "@/lib/offers/workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Gated by `offers`, whose hard boundary in src/lib/auth/permissions.ts is HR-authority-only —
// and `hrAuthorityRoles` is exactly two roles, Super Admin and Talent Acquisition. No other role
// can hold any offers action, whatever the permission matrix says. The resource has existed since
// long before this module; this page is its first surface. `system-navigation.ts` hiding the link
// is UX; the gate is here and in every route under /api/offers.
//
// Three grants, not one: Super Admin holds all actions, Talent Acquisition holds
// read/create/update/export but NOT delete. `canDelete` is threaded separately so the Delete
// buttons match the routes rather than promising something that answers 403.
//
// Talent Acquisition reaches this screen through its portal twin at
// app/employee-portals/offers/page.tsx, because app/(admin)/layout.tsx redirects portal-shell roles
// out of this entire route group before any page in it renders.

export default async function OffersPage() {
  const access = await resolveAccessContextFromPage();
  const [canRead, canManage, canDelete] = await Promise.all([
    canAccess(access, "offers", "read"),
    canAccess(access, "offers", "create"),
    canAccess(access, "offers", "delete"),
  ]);

  if (!canRead) redirect("/employee-portals");

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Loading the offer letters, templates and job titles."
          title="Loading Job Offers"
        />
      }
    >
      <OffersContent canDelete={canDelete} canManage={canManage} />
    </Suspense>
  );
}

async function OffersContent({ canDelete, canManage }: { canDelete: boolean; canManage: boolean }) {
  const workspace = await loadOffersWorkspace();

  return (
    <OffersManager
      canDelete={canDelete}
      canManage={canManage}
      initialError={workspace.error}
      jobTitles={workspace.jobTitles}
      offers={workspace.offers}
      sender={workspace.sender}
      templates={workspace.templates}
    />
  );
}
