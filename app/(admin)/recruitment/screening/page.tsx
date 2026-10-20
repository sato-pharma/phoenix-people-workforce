import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Lock } from "lucide-react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { PageContainer } from "@/components/layout/page-container";
import { RecruitmentEmptyState } from "@/components/recruitment/recruitment-premium";
import { WorkstationPageClient } from "@/components/recruitment/workstation/workstation-page-client";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { parseOpenCandidateId, type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import { canAttachToRequisition } from "@/lib/recruitment/requisition-attach";
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
    // The module's own empty state on a lifted panel (2026-10-19) — the same answer the portal twin
    // gives with its shell's empty state, rather than a bare boxed sentence.
    return (
      <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
        <RecruitmentEmptyState
          icon={<Lock aria-hidden="true" className="h-5 w-5" />}
          message="Screening is available to roles that can read the candidate pool."
          title="Screening Unavailable"
        />
      </div>
    );
  }

  // Sending a CV to a manager is a `recruitment: update` act — the same grant the send route
  // enforces, the same grant the notes route enforces on a write, and the same grant the WhatsApp
  // reply route enforces. A screener without it still gets the whole workspace and can still
  // shortlist, reject and read every note; they simply get no send picker, no note box and no reply
  // box, rather than ones that answer 403.
  //
  // DECIDING is `candidates: update`, not `recruitment: update`: Shortlist, Reject, the stars, the
  // bulk marks and Undo all land on /api/recruitment/candidates/** routes that assert
  // candidates:update. Until 2026-09-18 canDecide was spelled `recruitment: update` — the two are held
  // by the same seats today, so nobody saw it, but a gate spelled differently from its server
  // boundary either hides a button somebody may press or shows one that 403s. Pinned by
  // tests/screening-decide-gate.test.ts.
  const canUpdate = await canAccess(access, "recruitment", "update");
  const canDecide = await canAccess(access, "candidates", "update");
  // The one-press Attach to requisition: Admin or Talent Acquisition only (owner, 2026-10-16), and
  // only a reader who may decide at all — its route asserts candidates:update as well.
  const workspace = await loadScreeningWorkspace(access.hrId, filters, {
    // The Talent Acquisition fence (owner, 2026-10-20) is applied inside, by who is reading.
    access,
    canAttachToRequisition: canDecide && canAttachToRequisition(access),
    canSendToManagers: canUpdate,
  });

  return (
    <WorkstationPageClient
      area={workspace.area}
      areaOptions={workspace.areaOptions}
      canDecide={canDecide}
      canReply={canUpdate}
      canSendToManagers={workspace.canSendToManagers}
      canWriteNotes={canUpdate}
      counts={workspace.counts}
      decisionCounts={workspace.decisionCounts}
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
      whatsAppSearchLabel={workspace.whatsAppSearchLabel}
    />
  );
}
