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
import { X } from "lucide-react";

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
  screeningReceivedFilterLabels,
  screeningReceivedFilters,
  screeningShellPoolHref,
  type ScreeningHrefOptions,
  type ScreeningNotifiedFilter,
  type ScreeningReceivedFilter,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import type { Candidate } from "@/lib/recruitment/types";
import { cn } from "@/lib/utils";
// Type-only for the same reason: vacancy-options reads the service-role client.
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/** The three-way, in the words a screener would use rather than the words the URL uses. */
const seenFilterLabels: Record<ScreeningSeenFilter, string> = {
  any: "Seen and unseen",
  seen: "Only ones I have read",
  unseen: "Only ones I have not read",
};

/** The other three-way, in the words a screener would use. */
const notifiedFilterLabels: Record<ScreeningNotifiedFilter, string> = {
  any: "Sent and not sent",
  sent: "Already sent to a manager",
  unsent: "Not sent to a manager yet",
};

export function ScreeningPageClient({
  area,
  areaOptions,
  candidates,
  hiringManagers,
  initialViews,
  notified,
  openVacancies,
  poolHref,
  positionSuggestions,
  received,
  region,
  role,
  seen,
  source,
  sourceOptions,
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
  /** Whether this link narrowed to CVs already pushed to a manager, or never pushed to one. */
  notified: ScreeningNotifiedFilter;
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
  /** How long ago this link narrowed the CV to have arrived — null means any time. */
  received: ScreeningReceivedFilter | null;
  /** The region this link narrowed to: a company region, `foreign`, or `unknown`. */
  region: ScreeningRegionFilter | null;
  /** The role family this link narrowed to, or `unknown` for candidates with no title on file. */
  role: ScreeningRoleFilter | null;
  /** Whether this link narrowed to what the viewer has, or has not, already opened. */
  seen: ScreeningSeenFilter;
  /** The source channel this link narrowed to, verbatim — e.g. `WhatsApp`. */
  source: string | null;
  /** The source labels this pool actually has — the only ones worth offering. */
  sourceOptions: string[];
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
          notified: next.notified !== undefined ? next.notified : notified,
          received: next.received !== undefined ? next.received : received,
          region: next.region !== undefined ? next.region : region,
          role: next.role !== undefined ? next.role : role,
          seen: next.seen !== undefined ? next.seen : seen,
          source: next.source !== undefined ? next.source : source,
          status: next.status !== undefined ? next.status : status,
        }),
      );
    },
    [area, notified, received, region, role, router, seen, shellPoolHref, source, status],
  );

  return (
    <ScreeningPageFrame>
      <ScreeningFilterBar
        area={area}
        areaOptions={areaOptions}
        notified={notified}
        onChange={goTo}
        onClear={() =>
          goTo({
            area: null,
            notified: "any",
            received: null,
            region: null,
            role: null,
            seen: "any",
            source: null,
            status: null,
          })
        }
        queueCount={candidates.length}
        received={received}
        region={region}
        role={role}
        seen={seen}
        source={source}
        sourceOptions={sourceOptions}
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
        key={`${status ?? "all"}:${seen}:${notified}:${role ?? "all"}:${region ?? "all"}:${area ?? "all"}:${received ?? "all"}:${source ?? "all"}`}
        onClose={handleClose}
        openVacancies={openVacancies}
        positionSuggestions={positionSuggestions}
        variant="page"
      />
    </ScreeningPageFrame>
  );
}

// Matches the candidate pool's own toolbar — label above, small caps, the same select box. The two
// are the same job on two screens, and the owner's standing rule is that a new surface in a module
// looks like its siblings rather than inventing a look of its own.
//
// The corners are the one thing that was NOT matched. This class carried no radius at all, so eight
// hard-cornered boxes sat in a product where every other control is `rounded-md` — visible at a
// glance against the picker directly below them and against the pool's own toolbar. Squaring off
// was never a decision; it was an omission, and it is the sort that survives because nobody can
// name what looks wrong. The focus ring is the second half: `focus:border-orange-400` alone moves
// one pixel of colour, which on a 1px slate border is very nearly invisible.
//
// ── AND WHICH OF THE EIGHT IS DOING IT ──────────────────────────────────────────────────────────
// The bar reports that 42 of 434 CVs survived, and until now it did not say WHICH switch took the
// other 392. Eight dropdowns rendered identically, one of them holding "Pedia" and the other seven
// holding "Any" — and the one that matters looks exactly like the seven that do not. That is the
// question a screener actually asks when the queue is unexpectedly short ("why am I only seeing
// four?"), and answering it meant reading all eight boxes one at a time.
//
// So a filter that is HOLDING something wears it: orange label, orange border, orange text, a tinted
// field. Not decoration — it is the difference between spotting a stale Region filter in a glance
// and hunting for it. The `narrowed` flag that already drives the count pill and the Clear button is
// the same idea; this just moves it from the summary onto the control responsible.
const filterLabelClass = (active: boolean) =>
  cn(
    "flex min-w-0 flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide transition-colors",
    active ? "text-orange-600" : "text-slate-500",
  );
const filterSelectClass = (active: boolean) =>
  cn(
    "h-8 rounded-md border px-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-orange-100",
    active
      ? "border-orange-300 bg-orange-50/70 font-semibold text-orange-900 hover:border-orange-400 focus:border-orange-400"
      : "border-slate-200 bg-white text-slate-800 hover:border-slate-300 focus:border-orange-400",
  );

/**
 * "42 of 434 CVs" and the switches that produced the 42.
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
  notified,
  onChange,
  onClear,
  queueCount,
  received,
  region,
  role,
  seen,
  source,
  sourceOptions,
  status,
  totalCount,
}: {
  area: string | null;
  areaOptions: string[];
  notified: ScreeningNotifiedFilter;
  onChange: (next: ScreeningHrefOptions) => void;
  onClear: () => void;
  queueCount: number;
  received: ScreeningReceivedFilter | null;
  region: ScreeningRegionFilter | null;
  role: ScreeningRoleFilter | null;
  seen: ScreeningSeenFilter;
  source: string | null;
  sourceOptions: string[];
  status: CandidateStatus | null;
  totalCount: number;
}) {
  const narrowed =
    status !== null ||
    seen !== "any" ||
    notified !== "any" ||
    received !== null ||
    role !== null ||
    region !== null ||
    area !== null ||
    source !== null;
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-t-lg border border-b-0 border-phx-line bg-gradient-to-b from-white to-slate-50/70 px-3 py-2.5">
      {/* The size of the pile, as the headline of the bar rather than another grey word in it.
          "42 of 434" is the single fact this row exists to report — how much the switches beside it
          just took off — and as plain 12px text it read as a caption on the Status filter. The
          tabular figures stop the number jittering as it changes with each new link. */}
      <span
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold tabular-nums ${
          narrowed ? "bg-orange-50 text-orange-700 ring-1 ring-orange-200/70" : "bg-slate-100 text-slate-700"
        }`}
      >
        {narrowed ? (
          <>
            {queueCount}
            <span className="font-semibold text-orange-500/80">of {totalCount}</span>
          </>
        ) : (
          <>{totalCount}</>
        )}
        <span className="font-semibold opacity-70">{totalCount === 1 ? "CV" : "CVs"}</span>
      </span>
      <label className={filterLabelClass(status !== null)}>
        Status
        <select
          className={filterSelectClass(status !== null)}
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
      <label className={filterLabelClass(seen !== "any")}>
        Read
        <select
          className={filterSelectClass(seen !== "any")}
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
      <label className={filterLabelClass(notified !== "any")}>
        Sent to manager
        <select
          className={filterSelectClass(notified !== "any")}
          onChange={(event) => onChange({ notified: event.target.value as ScreeningNotifiedFilter })}
          value={notified}
        >
          {(Object.keys(notifiedFilterLabels) as ScreeningNotifiedFilter[]).map((value) => (
            <option key={value} value={value}>
              {notifiedFilterLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={filterLabelClass(received !== null)}>
        Received
        <select
          className={filterSelectClass(received !== null)}
          onChange={(event) =>
            onChange({ received: (event.target.value || null) as ScreeningReceivedFilter | null })
          }
          value={received ?? ""}
        >
          <option value="">Any time</option>
          {screeningReceivedFilters.map((value) => (
            <option key={value} value={value}>
              {screeningReceivedFilterLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={filterLabelClass(role !== null)}>
        Role
        <select
          className={filterSelectClass(role !== null)}
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
      <label className={filterLabelClass(region !== null)}>
        Region
        <select
          className={filterSelectClass(region !== null)}
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
      <label className={filterLabelClass(area !== null)}>
        Area
        <select
          className={filterSelectClass(area !== null)}
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
      {sourceOptions.length > 1 ? (
        <label className={filterLabelClass(source !== null)}>
          Source
          <select
            className={filterSelectClass(source !== null)}
            onChange={(event) => onChange({ source: event.target.value || null })}
            value={source ?? ""}
          >
            <option value="">Any source</option>
            {sourceOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {/* Only ever shown when there is something to clear, so it doubles as the answer to "is this
          list narrowed?" — the question a screener asks when the queue is unexpectedly short. Now a
          real target rather than a 12px underline: this is the undo for a filter that hid the CVs
          somebody is looking for, and it was the smallest hit area on the bar. */}
      {narrowed ? (
        <button
          className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
          onClick={onClear}
          title="Drop every filter and show the whole pool"
          type="button"
        >
          <X className="h-3 w-3" />
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
