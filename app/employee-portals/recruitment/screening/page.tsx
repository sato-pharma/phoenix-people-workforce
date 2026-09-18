import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { WorkstationPageClient } from "@/components/recruitment/workstation/workstation-page-client";
import { canAccess, isHrAuthorityRole, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  parseOpenCandidateId,
  parseScreeningFilters,
  screeningHref,
  type ScreeningQueueFilters,
} from "@/lib/recruitment/screening-link";
import { loadScreeningWorkspace } from "@/lib/recruitment/screening-workspace";

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
    //
    // THE OPEN CV TRAVELS TOO. It is not a filter, so `parseScreeningFilters` rightly drops it, and
    // a pasted link to one CV then landed on the whole list instead of on that CV's own page.
    redirect(
      screeningHref("/recruitment", {
        ...parseScreeningFilters(filters),
        candidate: parseOpenCandidateId(filters.candidate),
      }),
    );
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Recruitment tools are available to HR Advisory and Super Admin only."
        title="Screening Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Recruitment & Hiring"
      description="One CV on screen at a time, with the decision beside it."
      errorBoundaryTitle="Screening unavailable"
      title="CV Screening"
    >
      <Suspense
        fallback={
          // A CV opened in its own tab says so while it loads — "where you left off" is the list's
          // sentence, and the list is the tab this one was opened from.
          parseOpenCandidateId(filters.candidate) ? (
            <AppRouteLoadingState description="Loading this candidate's CV and details." title="Opening the CV" />
          ) : (
            <AppRouteLoadingState
              description="Loading the CVs and where you left off."
              title="Loading Screening"
            />
          )
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

  // Same gate as the admin twin: the send picker and the note box appear only for a caller who may
  // actually write. Everything else on the workspace is readable without it.
  const canUpdate = await canAccess(access, "recruitment", "update");
  const workspace = await loadScreeningWorkspace(access.hrId, filters, { canSendToManagers: canUpdate });

  return (
    <WorkstationPageClient
      area={workspace.area}
      areaOptions={workspace.areaOptions}
      canDecide={canUpdate}
      canSendToManagers={workspace.canSendToManagers}
      canWriteNotes={canUpdate}
      counts={workspace.counts}
      filterCounts={workspace.filterCounts}
      filteredOut={workspace.filteredOut}
      hiringManagers={workspace.hiringManagers}
      notified={workspace.notified}
      openRow={workspace.openRow}
      overdueManagerFeedback={workspace.overdueManagerFeedback}
      poolHref="/employee-portals/recruitment"
      poolSize={workspace.poolSize}
      positionSuggestions={workspace.positionSuggestions}
      rating={workspace.rating}
      received={workspace.received}
      region={workspace.region}
      role={workspace.role}
      // A CV's own page draws `openRow` and nothing else, so the list is not sent to it — a
      // thousand rows the tab would throw away, on every CV opened.
      rows={parseOpenCandidateId(filters.candidate) ? [] : workspace.rows}
      seen={workspace.seen}
      source={workspace.source}
      sourceOptions={workspace.sourceOptions}
      status={workspace.status}
      throughput={workspace.throughput}
      seatLabel={workspace.seatLabel}
      vacancies={workspace.vacancies}
      vacancy={workspace.vacancy}
      vacancyStats={workspace.vacancyStats}
    />
  );
}
