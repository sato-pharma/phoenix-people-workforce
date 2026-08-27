import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { OffersManager } from "@/components/offers/offers-manager";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { loadOffersWorkspace } from "@/lib/offers/workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/offers/page.tsx.
//
// Not duplication for its own sake: Talent Acquisition is a portal-shell role, and
// app/(admin)/layout.tsx redirects portal-shell roles out of the entire (admin) group before any
// page in it renders. Without this twin the only role that actually issues offers could not open
// the screen — see tests/recruitment-hub-portal-coverage.test.ts, which fails if the hub card and
// this route ever drift apart. Both pages load through `loadOffersWorkspace`, so there is one
// place a value can be wrong.
export default async function EmployeePortalOffersPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/offers");
  }

  // `delete` is asked separately because Talent Acquisition — the role this twin exists for —
  // holds read/create/update/export on `offers` and not delete. See the admin page's note.
  const [canRead, canManage, canDelete] = await Promise.all([
    canAccess(access, "offers", "read"),
    canAccess(access, "offers", "create"),
    canAccess(access, "offers", "delete"),
  ]);

  if (!canRead) {
    return (
      <EmployeePortalEmptyState
        message="Job offers are available to Talent Acquisition and Super Admin only."
        title="Job Offers Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Compose, design and send official offers of employment as Sato Pharmaceuticals."
      errorBoundaryTitle="Job offers unavailable"
      title="Job Offers"
    >
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
    </EmployeePortalPageShell>
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
