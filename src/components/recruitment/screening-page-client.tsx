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
import { candidateStatuses, candidateStatusLabels, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { CandidateViewMap } from "@/lib/recruitment/candidate-views";
// Type-only, and it has to stay that way: hiring-manager-notify reaches the service-role client, so
// a value import would drag it into this "use client" bundle and fail the build outright.
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { screeningHref } from "@/lib/recruitment/screening-link";
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
  status,
  totalCount,
  unseenOnly,
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
  /** The status this link narrowed to, e.g. `new` — null means every status. */
  status: CandidateStatus | null;
  /** The pool size before this link's narrowing, so "42 of 434" can be said instead of just "42". */
  totalCount: number;
  /** Whether this link narrowed to CVs this viewer has never opened. */
  unseenOnly: boolean;
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

  // Changing the narrowing is a NEW link, not a live filter — same address-bar mechanism as the
  // "unseen=1" link the pool already offers, just reachable without leaving this page. Landing here
  // directly (the HR job workbook sends people straight to /recruitment/screening, no filter) used
  // to mean the only way to narrow the queue was going back to the pool, filtering there, and
  // pressing "Screen" again.
  const goTo = useCallback(
    (next: { status?: CandidateStatus | null; unseenOnly?: boolean }) => {
      router.push(
        screeningHref(poolHref, {
          status: next.status !== undefined ? next.status : status,
          unseenOnly: next.unseenOnly !== undefined ? next.unseenOnly : unseenOnly,
        }),
      );
    },
    [poolHref, router, status, unseenOnly],
  );

  return (
    <ScreeningPageFrame>
      <ScreeningFilterBar
        onChangeStatus={(next) => goTo({ status: next })}
        onClear={() => goTo({ status: null, unseenOnly: false })}
        onToggleUnseen={() => goTo({ unseenOnly: !unseenOnly })}
        queueCount={candidates.length}
        status={status}
        totalCount={totalCount}
        unseenOnly={unseenOnly}
      />
      <CandidateScreeningSession
        candidates={candidates}
        hiringManagers={hiringManagers}
        // Forces a fresh mount whenever the narrowing changes. The session's own state — which
        // candidate you're on, what has been read this sitting — is deliberately computed ONCE on
        // mount from its props (see the comments in candidate-screening-session.tsx on why the queue
        // is "a snapshot, not a live view"); without a key tied to the narrowing, pushing a new
        // filter here would hand the same mounted session a shorter `candidates` array while its
        // index and caches still pointed at the old one.
        initialViews={initialViews}
        key={`${status ?? "all"}:${unseenOnly ? "unseen" : "all-seen"}`}
        onClose={handleClose}
        openVacancies={openVacancies}
        positionSuggestions={positionSuggestions}
        variant="page"
      />
    </ScreeningPageFrame>
  );
}

/**
 * "42 of 434 CVs — New only" and the switches to change it. Deliberately its own bar above the
 * session rather than a new item in CandidateScreeningSession's header: that header already carries
 * the position, the progress bar, the name, the band chip, three running totals and three buttons,
 * and its own comments warn that a seventh item is how it starts wrapping on a laptop screen. This
 * bar exists only for the `page` variant anyway — the overlay is always fed a queue the pool has
 * already filtered, so it has nothing to switch.
 */
function ScreeningFilterBar({
  onChangeStatus,
  onClear,
  onToggleUnseen,
  queueCount,
  status,
  totalCount,
  unseenOnly,
}: {
  onChangeStatus: (next: CandidateStatus | null) => void;
  onClear: () => void;
  onToggleUnseen: () => void;
  queueCount: number;
  status: CandidateStatus | null;
  totalCount: number;
  unseenOnly: boolean;
}) {
  const narrowed = status !== null || unseenOnly;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-b-0 border-phx-line bg-white px-3 py-2 text-xs">
      <span className="font-semibold text-slate-600">
        {narrowed ? (
          <>
            {queueCount} of {totalCount} {totalCount === 1 ? "CV" : "CVs"}
          </>
        ) : (
          <>
            {totalCount} {totalCount === 1 ? "CV" : "CVs"}
          </>
        )}
      </span>
      <label className="flex items-center gap-1.5 font-semibold text-slate-600">
        Status
        <select
          className="rounded-md border border-phx-line px-2 py-1 text-xs font-semibold text-slate-700"
          onChange={(e) => onChangeStatus(e.target.value ? (e.target.value as CandidateStatus) : null)}
          value={status ?? ""}
        >
          <option value="">Any status</option>
          {candidateStatuses.map((value) => (
            <option key={value} value={value}>
              {candidateStatusLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <button
        aria-pressed={unseenOnly}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-semibold transition ${
          unseenOnly
            ? "border-phx-accent bg-orange-50 text-phx-accent-press"
            : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line hover:text-phx-accent"
        }`}
        onClick={onToggleUnseen}
        type="button"
      >
        Unseen only
      </button>
      {narrowed ? (
        <button
          className="text-xs font-semibold text-slate-500 underline-offset-2 hover:text-phx-accent hover:underline"
          onClick={onClear}
          type="button"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

/**
 * The queue wants the whole viewport; the shells around it want their own padding. This keeps the
 * negative-margin trick in one place rather than repeating it in both page files.
 */
function ScreeningPageFrame({ children }: { children: React.ReactNode }) {
  return <div className="-mx-2 sm:-mx-4">{children}</div>;
}
