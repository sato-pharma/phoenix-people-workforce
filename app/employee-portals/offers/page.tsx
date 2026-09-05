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
// Built when Talent Acquisition, a portal-shell role, was the only role that issued offers, and
// app/(admin)/layout.tsx redirects portal-shell roles out of the entire (admin) group before any
// page in it renders. That role was retired 2026-08-28 and replaced by HR Advisory, an admin-shell
// role — so this twin is now orphaned surface, reachable by nobody: see
// tests/recruitment-hub-portal-coverage.test.ts (ORPHANED_PORTAL_MIRRORS) for the full account.
// Kept on disk rather than deleted for the same reason as its six siblings there. Both pages load
// through `loadOffersWorkspace`, so there is one place a value can be wrong.
export default async function EmployeePortalOffersPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/offers");
  }

  // `delete` is asked separately because HR Advisory — the role that now holds `offers` — carries
  // read/create/update/export and not delete. See the admin page's note.
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
