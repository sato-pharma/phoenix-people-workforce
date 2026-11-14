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
  // `approve` is the HR Manager's (owner, 2026-11-10): with it Send emails the candidate, without it
  // Send parks the offer for his approval. The routes enforce it; the screen only draws the buttons.
  const [canRead, canManage, canDelete, canApprove] = await Promise.all([
    canAccess(access, "offers", "read"),
    canAccess(access, "offers", "create"),
    canAccess(access, "offers", "delete"),
    canAccess(access, "offers", "approve"),
  ]);

  if (!canRead) {
    return (
      <EmployeePortalEmptyState
        message="Job offers are available to the Talent Acquisition seat and the Super Admin only."
        title="Job Offers Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
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
        <OffersContent canApprove={canApprove} canDelete={canDelete} canManage={canManage} viewerHrId={access.hrId ?? null} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function OffersContent({
  canApprove,
  canDelete,
  canManage,
  viewerHrId,
}: {
  canApprove: boolean;
  canDelete: boolean;
  canManage: boolean;
  viewerHrId: string | null;
}) {
  const workspace = await loadOffersWorkspace({ viewerHrId });

  return (
    <OffersManager
      canApprove={canApprove}
      canDelete={canDelete}
      canManage={canManage}
      copyDirectory={workspace.copyDirectory}
      initialError={workspace.error}
      jobTitles={workspace.jobTitles}
      offers={workspace.offers}
      people={workspace.people}
      sender={workspace.sender}
      templates={workspace.templates}
      vacancies={workspace.vacancies}
      vacanciesUnread={workspace.vacanciesUnread}
    />
  );
}
