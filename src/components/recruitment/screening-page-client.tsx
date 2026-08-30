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
// OUT of the queue and the narrowing bar above it, and nothing else, because every behaviour worth
// having already lives in CandidateScreeningSession and a second copy of it would be a second thing
// to keep true.

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { CandidateScreeningSession } from "@/components/recruitment/candidate-screening-session";
import {
  candidateRegionCodes,
  candidateRegionLabels,
  foreignRegionLabel,
} from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilies, candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
import { candidateStatuses, candidateStatusLabels, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { CandidateViewMap } from "@/lib/recruitment/candidate-views";
// Type-only, and it has to stay that way: hiring-manager-notify reaches the service-role client, so
// a value import would drag it into this "use client" bundle and fail the build outright.
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import {
  SCREENING_UNKNOWN,
  screeningHref,
  screeningShellPoolHref,
  type ScreeningHrefOptions,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import type { Candidate } from "@/lib/recruitment/types";
// Type-only for the same reason: vacancy-options reads the service-role client.
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** The three-way, in the words a screener would use rather than the words the URL uses. */
const seenFilterLabels: Record<ScreeningSeenFilter, string> = {
  any: "Seen and unseen",
  seen: "Only ones I have read",
  unseen: "Only ones I have not read",
};

export function ScreeningPageClient({
  area,
  areaOptions,
  candidates,
  hiringManagers,
  initialViews,
  openVacancies,
  poolHref,
  positionSuggestions,
  region,
  role,
  seen,
  status,
  totalCount,
}: {
  /** The area this link narrowed to, or `unknown` for applicants who never named one. */
  area: string | null;
  /** The areas applicants in this pool have actually named — the only ones worth offering. */
  areaOptions: string[];
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
  /** The region this link narrowed to: a company region, `foreign`, or `unknown`. */
  region: ScreeningRegionFilter | null;
  /** The role family this link narrowed to, or `unknown` for candidates with no title on file. */
  role: ScreeningRoleFilter | null;
  /** Whether this link narrowed to what the viewer has, or has not, already opened. */
  seen: ScreeningSeenFilter;
  /** The status this link narrowed to, e.g. `new` — null means every status. */
  status: CandidateStatus | null;
  /** The pool size before this link's narrowing, so "42 of 434" can be said instead of just "42". */
  totalCount: number;
}) {
  const router = useRouter();
  // WHICH SHELL AM I ACTUALLY IN? Not always the one that rendered me — see screeningShellPoolHref.
  // Every push below goes through this, never through the server's own poolHref.
  const shellPoolHref = screeningShellPoolHref(usePathname(), poolHref);

  const handleClose = useCallback(
    (decidedCount: number) => {
      // Refresh only when something actually changed, matching the overlay's behaviour: leaving
      // after reading a few costs nothing, and a needless refresh of a 434-row pool is a visible
      // stall on the way out.
      if (decidedCount > 0) router.refresh();
      router.push(shellPoolHref);
    },
    [router, shellPoolHref],
  );

  // Changing the narrowing is a NEW link, not a live filter — same address-bar mechanism as the
  // "unseen=1" link the pool already offers, just reachable without leaving this page. That is what
  // makes "the New Medical Rep CVs in Tanta I have not read" a thing you can bookmark rather than a
  // thing you rebuild every morning. Landing here directly (the HR job workbook sends people
  // straight to /recruitment/screening, no filter) used to mean the only way to narrow the queue
  // was going back to the pool, filtering there, and pressing "Screen" again.
  const goTo = useCallback(
    (next: ScreeningHrefOptions) => {
      router.push(
        screeningHref(shellPoolHref, {
          area: next.area !== undefined ? next.area : area,
          region: next.region !== undefined ? next.region : region,
          role: next.role !== undefined ? next.role : role,
          seen: next.seen !== undefined ? next.seen : seen,
          status: next.status !== undefined ? next.status : status,
        }),
      );
    },
    [area, region, role, router, seen, shellPoolHref, status],
  );

  return (
    <ScreeningPageFrame>
      <ScreeningFilterBar
        area={area}
        areaOptions={areaOptions}
        onChange={goTo}
        onClear={() => goTo({ area: null, region: null, role: null, seen: "any", status: null })}
        queueCount={candidates.length}
        region={region}
        role={role}
        seen={seen}
        status={status}
        totalCount={totalCount}
      />
      <CandidateScreeningSession
        candidates={candidates}
        hiringManagers={hiringManagers}
        // Forces a fresh mount whenever the narrowing changes. The session's own state — which
        // candidate you're on, what has been read this sitting — is deliberately computed ONCE on
        // mount from its props (see the comments in candidate-screening-session.tsx on why the queue
        // is "a snapshot, not a live view"); without a key tied to the narrowing, pushing a new
        // filter here would hand the same mounted session a shorter `candidates` array while its
        // index and caches still pointed at the old one. Every filter has to be in the key: one
        // left out is one that silently reuses the previous queue's position.
        initialViews={initialViews}
        key={`${status ?? "all"}:${seen}:${role ?? "all"}:${region ?? "all"}:${area ?? "all"}`}
        onClose={handleClose}
        openVacancies={openVacancies}
        positionSuggestions={positionSuggestions}
        variant="page"
      />
    </ScreeningPageFrame>
  );
}

// Matches the candidate pool's own toolbar exactly — label above, small caps, the same select box.
// The two are the same job on two screens, and the owner's standing rule is that a new surface in a
// module looks like its siblings rather than inventing a look of its own.
const filterLabelClass = "flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500";
const filterSelectClass =
  "border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";

/**
 * "42 of 434 CVs" and the five switches that produced the 42.
 *
 * Deliberately its own bar above the session rather than more items in CandidateScreeningSession's
 * header: that header already carries the position, the progress bar, the name, the band chip,
 * three running totals and three buttons, and its own comments warn that a seventh item is how it
 * starts wrapping on a laptop screen. This bar exists only for the `page` variant anyway — the
 * overlay is always fed a queue the pool has already filtered, so it has nothing to switch.
 */
function ScreeningFilterBar({
  area,
  areaOptions,
  onChange,
  onClear,
  queueCount,
  region,
  role,
  seen,
  status,
  totalCount,
}: {
  area: string | null;
  areaOptions: string[];
  onChange: (next: ScreeningHrefOptions) => void;
  onClear: () => void;
  queueCount: number;
  region: ScreeningRegionFilter | null;
  role: ScreeningRoleFilter | null;
  seen: ScreeningSeenFilter;
  status: CandidateStatus | null;
  totalCount: number;
}) {
  const narrowed = status !== null || seen !== "any" || role !== null || region !== null || area !== null;
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-t-lg border border-b-0 border-phx-line bg-white px-3 py-2">
      <span className="pb-1.5 text-xs font-semibold whitespace-nowrap text-slate-600">
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
      <label className={filterLabelClass}>
        Status
        <select
          className={filterSelectClass}
          onChange={(event) => onChange({ status: event.target.value ? (event.target.value as CandidateStatus) : null })}
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
      <label className={filterLabelClass}>
        Read
        <select
          className={filterSelectClass}
          onChange={(event) => onChange({ seen: event.target.value as ScreeningSeenFilter })}
          value={seen}
        >
          {(Object.keys(seenFilterLabels) as ScreeningSeenFilter[]).map((value) => (
            <option key={value} value={value}>
              {seenFilterLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={filterLabelClass}>
        Role
        <select
          className={filterSelectClass}
          onChange={(event) => onChange({ role: (event.target.value || null) as ScreeningRoleFilter | null })}
          value={role ?? ""}
        >
          <option value="">Any role</option>
          {candidateRoleFamilies.map((family) => (
            <option key={family} value={family}>
              {candidateRoleFamilyLabels[family]}
            </option>
          ))}
          <option value={SCREENING_UNKNOWN}>No job title on file</option>
        </select>
      </label>
      <label className={filterLabelClass}>
        Region
        <select
          className={filterSelectClass}
          onChange={(event) => onChange({ region: (event.target.value || null) as ScreeningRegionFilter | null })}
          value={region ?? ""}
        >
          <option value="">Any region</option>
          {candidateRegionCodes.map((code) => (
            <option key={code} value={code}>
              {candidateRegionLabels[code]}
            </option>
          ))}
          <option value="foreign">{foreignRegionLabel}</option>
          <option value={SCREENING_UNKNOWN}>No governorate on file</option>
        </select>
      </label>
      <label className={filterLabelClass}>
        Area
        <select
          className={filterSelectClass}
          onChange={(event) => onChange({ area: event.target.value || null })}
          value={area ?? ""}
        >
          <option value="">Any area</option>
          {areaOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
          <option value={SCREENING_UNKNOWN}>No area on file</option>
        </select>
      </label>
      {narrowed ? (
        <button
          className="pb-1.5 text-xs font-semibold whitespace-nowrap text-slate-500 underline-offset-2 hover:text-phx-accent hover:underline"
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
