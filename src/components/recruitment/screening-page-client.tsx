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
import { useCallback, useOptimistic, useTransition } from "react";
import { Loader2, X } from "lucide-react";

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
  mergeNarrowing,
  screeningShellPoolHref,
  type ScreeningHrefOptions,
  type ScreeningNotifiedFilter,
  type ScreeningReceivedFilter,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import type { Candidate } from "@/lib/recruitment/types";
import { cn } from "@/lib/utils";
// Type-only for the same reason: vacancy-options reads the service-role client.
import type { VacancyOption } from "@/lib/recruitment/vacancy-options";

/**
 * The four-way, in the words a screener would use rather than the words the URL uses.
 *
 * The last two are deliberately worded to be told apart at a glance: "I have not read" is about ME,
 * "nobody has read" is about the pair. Since screening became a two-person job the first includes
 * everything the other screener has already worked — 554 of 781 candidates on 2026-09-05 were in
 * the second pile, so the difference is most of the queue rather than an edge case.
 */
const seenFilterLabels: Record<ScreeningSeenFilter, string> = {
  any: "Seen and unseen",
  seen: "Only ones I have read",
  unseen: "Only ones I have not read",
  untouched: "Only ones nobody has read",
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
   * both shells — the admin one at /recruitment and the portal twin at /employee-portals/recruitment
   * built for the retired Talent Acquisition seat — and sending a portal user to the admin route
   * would bounce them straight back out through the (admin) group's redirect. HR Advisory, the
   * current recruiting seat, is admin-shell, so that portal twin is orphaned in practice — see
   * tests/recruitment-hub-portal-coverage.test.ts (ORPHANED_PORTAL_MIRRORS).
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
  // ── THE SAME ROUND TRIP, AND THE SAME BUG ─────────────────────────────────────────
  // This screen draws the same bar as the workstation and pushes the same URLs, so it had the same
  // defect for the same reason: a `<select>` controlled by the server’s last answer, and an answer
  // that takes seconds. See the long note in workstation-page-client.tsx. The types caught that this
  // second caller existed — a reminder that the bar has two homes and a fix to one is half a fix.
  const shownNarrowing = { area, notified, received, region, role, seen, source, status };
  const [shown, showImmediately] = useOptimistic(
    shownNarrowing,
    (current, picked: ScreeningHrefOptions) => mergeNarrowing(current, picked),
  );
  const [pending, startTransition] = useTransition();

  const goTo = useCallback(
    (next: ScreeningHrefOptions) => {
      const href = screeningHref(shellPoolHref, {
        area: next.area !== undefined ? next.area : area,
        notified: next.notified !== undefined ? next.notified : notified,
        received: next.received !== undefined ? next.received : received,
        region: next.region !== undefined ? next.region : region,
        role: next.role !== undefined ? next.role : role,
        seen: next.seen !== undefined ? next.seen : seen,
        source: next.source !== undefined ? next.source : source,
        status: next.status !== undefined ? next.status : status,
      });
      // One transition around both, or React drops the optimistic value on the next render.
      startTransition(() => {
        showImmediately(next);
        router.push(href);
      });
    },
    [area, notified, received, region, role, router, seen, shellPoolHref, showImmediately, source, status],
  );

  return (
    <ScreeningPageFrame>
      <ScreeningFilterBar
        area={shown.area}
        areaOptions={areaOptions}
        notified={shown.notified}
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
        pending={pending}
        queueCount={candidates.length}
        received={shown.received}
        region={shown.region}
        role={shown.role}
        seen={shown.seen}
        source={shown.source}
        sourceOptions={sourceOptions}
        status={shown.status}
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
// THE CORNERS ARE SQUARE, AND THAT IS THE RULE RATHER THAN AN OMISSION.
//
// This comment used to argue the opposite, and the argument is kept here because it is the exact
// mistake the square-edge rule exists to stop. It read: the class "carried no radius at all, so
// eight hard-cornered boxes sat in a product where every other control is `rounded-md`… Squaring off
// was never a decision; it was an omission." So on 2026-08-31 `rounded-md` was added to the eight
// selects, the bar, the count pill and the Clear button, to match the siblings.
//
// It was a decision. The owner ruled on 2026-09-04 that there are NO round or semi-round corners
// anywhere — cards, buttons, tags, inputs, bars, avatars, badges. The siblings this bar copied are
// not the authority; `tokens.css` is not either, and it actively misleads, because it ships
// `--phx-radius: 4px` and calls it "the default for cards, inputs and buttons". That default is the
// bug, and copying a neighbour is how it spreads: the workstation directly below this bar is square
// by the owner's own instruction, given twice, so one screen was rendering both conventions with a
// rounded bar sitting on square panes.
//
// A 4px radius is invisible in a screenshot and survives review, which is why it is checked by
// counting computed `border-radius` rather than by looking. The focus ring stays — it was the
// second half of that change and it is not a corner: `focus:border-phx-accent` alone moves one
// pixel of colour, which on a 1px hairline is very nearly invisible.
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
//
// ── THE PALETTE IS THE PRODUCT'S, NOT TAILWIND'S ────────────────────────────────────────────────
// Until 2026-09-12 this bar was painted in `slate-*` and `orange-*` — Tailwind's own ramps, not
// Phoenix's. On its own that is invisible; sitting one pixel above a workstation painted entirely in
// `--phx-*`, it is two products on one screen. `slate-200` is #e2e8f0 and carries a blue cast;
// `--phx-line` is #e0dcd4 and carries a warm one, against a paper ground that is not white. Every
// class below now names a token, so a change to `tokens.css` reaches this bar like it reaches
// everything else.
//
// AND THE LABEL HAD NO SIZE AT ALL. It was written `text-phx-xs` inside a `cn()` call, and `cn()`
// runs tailwind-merge, which silently DROPS a custom named font size — the class compiled, shipped,
// and did nothing, so eight filter labels rendered at whatever they inherited. The bracket form is
// the only safe way to say a Phoenix step inside `cn()`; see the same warning in workstation-look.
const filterLabelClass = (active: boolean) =>
  cn(
    "flex min-w-0 flex-col gap-1 text-[10px] font-bold uppercase leading-none tracking-[0.12em] transition-colors",
    active ? "text-phx-accent-press" : "text-phx-ink-faint",
  );
const filterSelectClass = (active: boolean) =>
  cn(
    "h-8 border px-2 text-[13px] transition-colors focus:outline-none focus:ring-1 focus:ring-phx-accent-line",
    active
      ? "border-phx-accent-line bg-phx-accent-soft font-semibold text-phx-accent-press hover:border-phx-accent focus:border-phx-accent"
      : "border-phx-line bg-white text-phx-ink hover:border-phx-line-strong focus:border-phx-accent",
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
export function ScreeningFilterBar({
  area,
  areaOptions,
  notified,
  onChange,
  onClear,
  pending,
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
  /**
   * Is the list currently being fetched for a filter that was just changed?
   *
   * Every filter here is a URL, so changing one is a server round trip — measured at 5 to 12
   * seconds against the live pool of 607 CVs on 2026-09-12. Without this the page gives no sign
   * at all that it heard the click, and the owner reported the filters as simply "not working".
   */
  pending: boolean;
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
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border border-b-0 border-phx-line bg-gradient-to-b from-white to-phx-surface-2 px-3 py-2.5">
      {/* The size of the pile, as the headline of the bar rather than another grey word in it.
          "42 of 434" is the single fact this row exists to report — how much the switches beside it
          just took off — and as plain 12px text it read as a caption on the Status filter. The
          tabular figures stop the number jittering as it changes with each new link. */}
      <span
        className={cn(
          "inline-flex h-8 items-center gap-1 whitespace-nowrap border px-2 text-[13px] font-black tabular-nums",
          narrowed
            ? "border-phx-accent-line bg-phx-accent-soft text-phx-accent-press"
            : "border-phx-line bg-phx-paper-2 text-phx-ink",
        )}
      >
        {narrowed ? (
          <>
            {queueCount}
            <span className="text-[11px] font-semibold opacity-80">of {totalCount}</span>
          </>
        ) : (
          <>{totalCount}</>
        )}
        <span className="text-[11px] font-semibold opacity-70">{totalCount === 1 ? "CV" : "CVs"}</span>
      </span>
      {/* ── THE PAGE HEARD YOU ────────────────────────────────────────────────────────────
          A filter change reloads the whole queue from the server, and on the live pool that takes
          seconds, not milliseconds. Silence for that long is indistinguishable from a dead control:
          reported 2026-09-12 as "the filters are not working", when every one of them was in fact
          working perfectly and slowly. Its own element rather than a suffix inside the count so the
          number beside it does not jump sideways each time it appears. */}
      {pending ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold uppercase leading-none tracking-[0.12em] text-phx-accent-press">
          <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
          Updating
        </span>
      ) : null}
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
        <Action
          className="h-8 whitespace-nowrap px-2.5"
          onClick={onClear}
          title="Drop every filter and show the whole pool"
          tone="quiet"
        >
          <X aria-hidden className="h-3 w-3" />
          Clear
        </Action>
      ) : null}
    </div>
  );
}

/**
 * The queue wants the whole viewport; the shells around it want their own padding. This keeps the
 * negative-margin trick in one place rather than repeating it in both page files.
 */
export function ScreeningPageFrame({ children }: { children: React.ReactNode }) {
  return <div className="-mx-2 sm:-mx-4">{children}</div>;
}
