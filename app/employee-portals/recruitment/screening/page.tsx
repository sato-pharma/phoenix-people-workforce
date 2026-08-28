import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { ScreeningPageClient } from "@/components/recruitment/screening-page-client";
import { canAccess, isHrAuthorityRole, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import { loadScreeningQueue } from "@/lib/recruitment/screening-queue";

export const dynamic = "force-dynamic";

/**
 * Portal mirror of app/(admin)/recruitment/screening/page.tsx — same data and permission logic in
 * the employee-portal shell instead of the admin one.
 *
 * This twin is not optional. `app/(admin)/layout.tsx` redirects portal-shell roles out of the whole
 * (admin) group before any page in it renders, so without this file the screening link would be
 * dead for Talent Acquisition — the role that screens the most CVs. Kept in sync by hand, exactly
 * like the /recruitment pair it sits beside.
 */
export default async function EmployeePortalScreeningPage({
  searchParams,
}: {
  searchParams: Promise<ScreeningQueueFilters>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/recruitment/screening");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Recruitment tools are available to Talent Acquisition and Super Admin only."
        title="Screening Unavailable"
      />
    );
  }

  const filters = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="One CV on screen at a time, with the decision beside it."
      errorBoundaryTitle="Screening unavailable"
      title="CV Screening"
    >
      <Suspense
        fallback={
          <AppRouteLoadingState
            description="Loading the CVs and where you left off."
            title="Loading Screening"
          />
        }
      >
        <ScreeningContent access={access} filters={filters} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}

async function ScreeningContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: ScreeningQueueFilters;
}) {
  if (!(await canAccess(access, "candidates", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Screening is available to roles that can read the candidate pool."
        title="Screening Unavailable"
      />
    );
  }

  // Same gate as the admin twin: the picker appears only for a caller who may actually send.
  const queue = await loadScreeningQueue(access.hrId, filters, {
    canSendToManagers: await canAccess(access, "recruitment", "update"),
  });

  return (
    <ScreeningPageClient
      candidates={queue.candidates}
      hiringManagers={queue.hiringManagers}
      initialViews={queue.views}
      openVacancies={queue.openVacancies}
      poolHref="/employee-portals/recruitment"
      positionSuggestions={queue.positionSuggestions}
    />
  );
}
