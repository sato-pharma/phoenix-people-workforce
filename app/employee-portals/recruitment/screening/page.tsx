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
import { parseScreeningFilters, screeningHref, type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
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
  const filters = await searchParams;
  if (resolveNavigationMode(access) !== "employee-portal") {
    // The narrowing travels WITH the redirect. A bare `redirect("/recruitment/screening")` threw
    // the query string away, so an HR Advisory user following "the New Medical Rep CVs in Tanta I
    // have not read" — or the plain `?unseen=1` link the pool builds — landed on the whole 481-row
    // queue with every filter reset and nothing to say why. `screeningHref` is what rebuilds it,
    // rather than forwarding the raw query string, so an edited address bar cannot be bounced
    // through this redirect unvalidated.
    redirect(screeningHref("/recruitment", parseScreeningFilters(filters)));
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Recruitment tools are available to Talent Acquisition and Super Admin only."
        title="Screening Unavailable"
      />
    );
  }

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
      area={queue.area}
      areaOptions={queue.areaOptions}
      candidates={queue.candidates}
      hiringManagers={queue.hiringManagers}
      initialViews={queue.views}
      notified={queue.notified}
      openVacancies={queue.openVacancies}
      poolHref="/employee-portals/recruitment"
      positionSuggestions={queue.positionSuggestions}
      received={queue.received}
      region={queue.region}
      role={queue.role}
      seen={queue.seen}
      source={queue.source}
      sourceOptions={queue.sourceOptions}
      status={queue.status}
      totalCount={queue.candidates.length + queue.filteredOut}
    />
  );
}
