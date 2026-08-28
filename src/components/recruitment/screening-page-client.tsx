"use client";

// Recruitment / ATS — the screening queue as a PAGE.
//
// WHY THIS EXISTS. Screening was a full-screen layer opened from a button inside the Recruitment
// workspace, held in a single piece of component state. That made it unreachable except by loading
// the whole Recruitment module, finding the pool tab and pressing the button — and it meant the
// thing the owner spends his screening time in had no address. It could not be bookmarked, could
// not be linked to, could not be reopened where he left it, and closing the browser lost the way
// back in.
//
// So this is the same queue, on a route. The component below is deliberately thin: it owns the way
// OUT of the queue and nothing else, because every behaviour worth having already lives in
// CandidateScreeningSession and a second copy of it would be a second thing to keep true.

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { CandidateScreeningSession } from "@/components/recruitment/candidate-screening-session";
import type { CandidateViewMap } from "@/lib/recruitment/candidate-views";
// Type-only, and it has to stay that way: hiring-manager-notify reaches the service-role client, so
// a value import would drag it into this "use client" bundle and fail the build outright.
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import type { Candidate } from "@/lib/recruitment/types";
// Type-only for the same reason: vacancy-options reads the service-role client.
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

export function ScreeningPageClient({
  candidates,
  hiringManagers,
  initialViews,
  openVacancies,
  poolHref,
  positionSuggestions,
}: {
  candidates: Candidate[];
  /** The managers a CV can be pushed to without leaving the queue. Loaded server-side by the page. */
  hiringManagers: HiringManagerOption[];
  initialViews: CandidateViewMap;
  /** The open seats a CV can be sent FOR. Same server load, same gate as the managers. */
  openVacancies: VacancyOption[];
  /** Titles and areas already used on a send, offered beside the free-typed fields. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  /**
   * Where "back to the pool" goes. Passed in rather than hard-coded because this page exists in
   * both shells — the admin one at /recruitment and the Talent Acquisition portal twin at
   * /employee-portals/recruitment — and sending a portal user to the admin route would bounce them
   * straight back out through the (admin) group's redirect.
   */
  poolHref: string;
}) {
  const router = useRouter();

  const handleClose = useCallback(
    (decidedCount: number) => {
      // Refresh only when something actually changed, matching the overlay's behaviour: leaving
      // after reading a few costs nothing, and a needless refresh of a 434-row pool is a visible
      // stall on the way out.
      if (decidedCount > 0) router.refresh();
      router.push(poolHref);
    },
    [poolHref, router],
  );

  return (
    <ScreeningPageFrame>
      <CandidateScreeningSession
        candidates={candidates}
        hiringManagers={hiringManagers}
        initialViews={initialViews}
        onClose={handleClose}
        openVacancies={openVacancies}
        positionSuggestions={positionSuggestions}
        variant="page"
      />
    </ScreeningPageFrame>
  );
}

/**
 * The queue wants the whole viewport; the shells around it want their own padding. This keeps the
 * negative-margin trick in one place rather than repeating it in both page files.
 */
function ScreeningPageFrame({ children }: { children: React.ReactNode }) {
  return <div className="-mx-2 sm:-mx-4">{children}</div>;
}
