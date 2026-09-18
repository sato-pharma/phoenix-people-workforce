import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { PageContainer } from "@/components/layout/page-container";
import { WorkstationPageClient } from "@/components/recruitment/workstation/workstation-page-client";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { parseOpenCandidateId, type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import { loadScreeningWorkspace } from "@/lib/recruitment/screening-workspace";

export const dynamic = "force-dynamic";

/**
 * The CV screening queue, on its own address.
 *
 * Until 2026-08-27 this was a layer inside the Recruitment workspace with no URL at all — you got
 * to it by loading the whole module, finding the candidate pool and pressing a button, and there
 * was no way to bookmark it, link it, or come back to it. `/recruitment/screening?unseen=1` is the
 * link the owner asked for: open straight into the CVs nobody has read yet.
 *
 * Deliberately NOT a card on the Recruitment & Hiring hub. A hub card drags in four unrelated CI
 * invariants — a portal twin pairing, a browser-measured sidebar label width, the mobile bottom-nav
 * registry and the hub count pinned in tests — none of which make the page any more reachable than
 * a route and a link from the pool already do. See docs and the hub list in
 * src/config/system-navigation.ts before adding one.
 *
 * Same permission gate as /recruitment itself, and that is not laziness: screening reads every
 * field on every candidate, so anything looser here would be a way around the module's own gate.
 */
export default async function RecruitmentScreeningPage({
  searchParams,
}: {
  searchParams: Promise<ScreeningQueueFilters>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
    redirect("/employee-portals");
  }

  const filters = await searchParams;

  return (
    <PageContainer>
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
    </PageContainer>
  );
}

async function ScreeningContent({
  access,
  filters,
}: {
  access: AccessContext;
  filters: ScreeningQueueFilters;
}) {
  // Reading a CV is a `candidates: read` act; the module gate above already proved this caller may
  // be here at all. A screener with no candidate read grant gets an empty queue rather than an
  // error, which is the same answer the pool gives them.
  //
  // THIS BRANCH IS REACHABLE, AND IT IS NOT REACHABLE THE WAY IT LOOKS. `recruitment` and
  // `candidates` share one hard boundary and one HR function, so no ROLE holds the first without the
  // second, and production carries a single `role_permission_overrides` row (Employee / expenses /
  // create) that is nothing to do with either. Reading only those two, this looks like dead code and
  // a later session will delete it as such.
  //
  // What makes it live is `canAccess`'s THIRD gate: a per-account module lock, checked per RESOURCE
  // (see auth/module-locks.ts). A lock on `candidates` alone leaves `recruitment: read` true, so the
  // caller passes the page gate above and lands exactly here. That is not hypothetical — hr-009 had
  // `payroll`, `payslips` and `deductions` locked over 30 Aug – 3 Sep 2026.
  const canViewCandidates = await canAccess(access, "candidates", "read");
  if (!canViewCandidates) {
    return (
      <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Screening is available to roles that can read the candidate pool.
      </p>
    );
  }

  // Sending a CV to a manager is a `recruitment: update` act — the same grant the send route
  // enforces, and the same grant the notes route enforces on a write. A screener without it still
  // gets the whole workspace and can still shortlist, reject and read every note; they simply get
  // no send picker and no note box, rather than ones that answer 403.
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
      decided={workspace.decided}
      filterCounts={workspace.filterCounts}
      filteredOut={workspace.filteredOut}
      hiringManagers={workspace.hiringManagers}
      notified={workspace.notified}
      openRow={workspace.openRow}
      overdueManagerFeedback={workspace.overdueManagerFeedback}
      poolHref="/recruitment"
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
      whatsapp={workspace.whatsapp}
      whatsAppDecided={workspace.whatsAppDecided}
      whatsAppSearchLabel={workspace.whatsAppSearchLabel}
    />
  );
}
