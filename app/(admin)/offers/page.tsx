import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { OffersManager } from "@/components/offers/offers-manager";
import { canAccess } from "@/lib/auth/permissions";
import { loadOffersWorkspace } from "@/lib/offers/workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Gated by `offers`, whose hard boundary in src/lib/auth/permissions.ts is HR-authority-only —
// but `hrAuthorityRoles` now lists three roles (Super Admin, HR Advisory, HR Operations), and
// listing both HR bundles there is safe only because the resource check does the discriminating:
// `offers` lives in the `recruiting` function bundle (src/lib/auth/hr-functions.ts), which only
// HR Advisory carries. No other role can hold any offers action, whatever `hrAuthorityRoles` alone
// suggests. The resource has existed since long before this module; this page is its first surface.
// `system-navigation.ts` hiding the link is UX; the gate is here and in every route under
// /api/offers.
//
// Three grants, not one: Super Admin holds all actions, HR Advisory holds
// read/create/update/export but NOT delete. `canDelete` is threaded separately so the Delete
// buttons match the routes rather than promising something that answers 403.
//
// HR Advisory reaches this screen directly — she is an admin-shell role, unlike the retired
// Talent Acquisition seat this module was first built for. Its portal twin at
// app/employee-portals/offers/page.tsx is now orphaned surface: see
// tests/recruitment-hub-portal-coverage.test.ts for the full account of why nobody who holds
// `offers` today resolves into the employee-portal shell.

export default async function OffersPage() {
  const access = await resolveAccessContextFromPage();
  // `approve` is the HR Manager's (owner, 2026-11-10): with it Send emails the candidate, without it
  // Send parks the offer for his approval. The routes enforce it; the screen only draws the buttons.
  const [canRead, canManage, canDelete, canApprove] = await Promise.all([
    canAccess(access, "offers", "read"),
    canAccess(access, "offers", "create"),
    canAccess(access, "offers", "delete"),
    canAccess(access, "offers", "approve"),
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
      <OffersContent canApprove={canApprove} canDelete={canDelete} canManage={canManage} viewerHrId={access.hrId ?? null} />
    </Suspense>
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
