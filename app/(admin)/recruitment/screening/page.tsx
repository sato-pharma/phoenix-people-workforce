import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { PageContainer } from "@/components/layout/page-container";
import { ScreeningPageClient } from "@/components/recruitment/screening-page-client";
import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import { loadScreeningQueue } from "@/lib/recruitment/screening-queue";

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
          <AppRouteLoadingState
            description="Loading the CVs and where you left off."
            title="Loading Screening"
          />
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
  const canViewCandidates = await canAccess(access, "candidates", "read");
  if (!canViewCandidates) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Screening is available to roles that can read the candidate pool.
      </p>
    );
  }

  const queue = await loadScreeningQueue(access.hrId, filters);

  return (
    <ScreeningPageClient candidates={queue.candidates} initialViews={queue.views} poolHref="/recruitment" />
  );
}
