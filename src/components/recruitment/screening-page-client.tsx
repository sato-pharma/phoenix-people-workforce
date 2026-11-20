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

import { Loader2, X } from "lucide-react";

import {
  candidateRegionCodes,
  candidateRegionLabels,
  foreignRegionLabel,
} from "@/lib/recruitment/candidate-region";
import {
  screeningRatingFilterLabels,
  screeningRatingFilters,
  type ScreeningRatingFilter,
} from "@/lib/recruitment/candidate-rating";
import { candidateRoleFamilies, candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
// Pure, and its whole import chain is — see the header of screening-filter.ts. These two fold an
// area or source the way the counts are keyed, so the bar looks a count up the same way it was
// tallied rather than by the spelling it happens to be displaying.
import { screeningAreaKey, screeningSourceKey } from "@/lib/recruitment/screening-filter";
import type { ScreeningFilterCounts } from "@/lib/recruitment/screening-filter-counts";
import { SCREENING_UNKNOWN, screeningReceivedFilterLabels, screeningReceivedFilters, type ScreeningHrefOptions, type ScreeningNotifiedFilter, type ScreeningReceivedFilter, type ScreeningRegionFilter, type ScreeningRoleFilter, type ScreeningSeenFilter } from "@/lib/recruitment/screening-link";
import { adminChipDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { cn } from "@/lib/utils";

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
 * One option, carrying what picking it would actually give him.
 *
 * ── WHY EVERY OPTION NOW WEARS ITS COUNT ────────────────────────────────────────────────────────
 *
 * Nine selects, ~68 options, and until now not one of them said whether it held 300 people or
 * nobody. Since every filter here is a URL, the only way to find out was to pick it and wait out
 * the round trip — 5 to 12 seconds against the live pool. Looking for the district manager
 * applicants meant guessing, waiting, reading the "42 of 434" pill, and guessing again. The owner,
 * 2026-09-18: "i want to reach all those easily by polished working filters".
 *
 * A DEAD OPTION IS DISABLED RATHER THAN HIDDEN, and neither is quite free:
 *
 *   • Hiding it loses information. "(0)" is the honest answer to "has anybody applied for this
 *     seat at all", and a list whose length changes between two visits is a list you re-read.
 *   • Leaving it live spends a 12-second round trip to be shown an empty queue.
 *
 * So it stays visible, says 0, and cannot be picked. The one exception is the value the select is
 * CURRENTLY on: a bookmarked link can name a filter the pool has since emptied, and a disabled
 * option that is also the selected one still has to render, or the bar would silently misreport
 * which filter is holding the list down.
 *
 * The text is plain, because an `<option>` cannot hold markup in any browser — which is also why
 * the count rides inside the label rather than in a styled pill like the rest of this bar.
 */
function FilterOption({
  count,
  label,
  selected,
  value,
}: {
  count: number | undefined;
  label: string;
  selected: boolean;
  value: string;
}) {
  const total = count ?? 0;
  return (
    <option disabled={total === 0 && !selected} value={value}>
      {label} ({total})
    </option>
  );
}

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
  filterCounts,
  notified,
  onChange,
  onClear,
  pending,
  queueCount,
  rating,
  received,
  region,
  role,
  seen,
  source,
  sourceOptions,
  totalCount,
}: {
  area: string | null;
  areaOptions: string[];
  /**
   * How many CVs each option would return, over the WHOLE pool rather than the narrowed list.
   *
   * The whole pool on purpose, and the same choice `areaOptions` makes: a dropdown whose numbers
   * all collapse to nearly zero the moment you pick one of them cannot be used to change your mind
   * about the pick. The narrowed figure is the bar's own headline pill, one line above.
   */
  filterCounts: ScreeningFilterCounts;
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
  /** The star narrowing, as "that many OR MORE" — or `unrated`. Null shows every CV. */
  rating: ScreeningRatingFilter | null;
  received: ScreeningReceivedFilter | null;
  region: ScreeningRegionFilter | null;
  role: ScreeningRoleFilter | null;
  seen: ScreeningSeenFilter;
  source: string | null;
  sourceOptions: string[];
  /**
   * The pile the bar narrows — the DECISION TAB's, never the whole pool. Status is not on this bar
   * any more: it is the tab strip above the list (candidate-decision-tab-strip.tsx), which every
   * screen that lists CVs shares, so "42 of 339" reads against the 339 "Not decided yet" CVs.
   */
  totalCount: number;
}) {
  const narrowed =
    rating !== null ||
    seen !== "any" ||
    notified !== "any" ||
    received !== null ||
    role !== null ||
    region !== null ||
    area !== null ||
    source !== null;
  return (
    // THE MODULE'S TOOLBAR TRAY (2026-10-19) — the same recessed strip every other recruitment
    // screen sets its filters in (recruitmentToolbarClassName), drawn here in the --phx-* palette
    // this bar already speaks, and closed on all four sides now that the panes below sit apart from
    // it rather than butting against its bottom edge.
    <div
      className={`flex flex-wrap items-end gap-x-3 gap-y-2 border border-phx-line bg-phx-paper px-3 py-2.5 ${adminRecessedDepthClassName}`}
    >
      {/* The size of the pile, as the headline of the bar rather than another grey word in it.
          "42 of 434" is the single fact this row exists to report — how much the switches beside it
          just took off — and as plain 12px text it read as a caption on the Status filter. The
          tabular figures stop the number jittering as it changes with each new link. */}
      <span
        className={cn(
          "inline-flex h-8 items-center gap-1 whitespace-nowrap border px-2 text-[13px] font-black tabular-nums",
          narrowed
            ? "border-phx-accent-line bg-phx-accent-soft text-phx-accent-press"
            : "border-phx-line bg-white text-phx-ink",
          adminChipDepthClassName,
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
      {/* ── STARS ───────────────────────────────────────────────
          THE "ANY" ROW CARRIES NO COUNT, on every select here. It is the escape from a narrowing
          rather than a narrowing, its number is the bar's own headline pill one line above, and
          printing it would invite reading the list below as a breakdown that sums to it — which it
          deliberately does not: the windows nest, the star ladder nests, and one candidate can sit
          in two role families.

          First on the bar since the Status select became the decision tabs (2026-09-18), because
          it is the only filter here that reads
          something a PERSON put on the CV rather than something the system worked out about it.
          Everything else narrows by fact; this one narrows to "the ones I liked".

          "1 star and up" rather than "exactly 1 star", which is what makes it a ladder instead of
          three unrelated labels — asking for your favourites and being shown only the middling ones
          because the best are rated higher would be the wrong answer to the question. */}
      <label className={filterLabelClass(rating !== null)}>
        Stars
        <select
          className={filterSelectClass(rating !== null)}
          onChange={(event) =>
            onChange({ rating: (event.target.value || null) as ScreeningRatingFilter | null })
          }
          value={rating ?? ""}
        >
          <option value="">Any stars</option>
          {screeningRatingFilters.map((value) => (
            <FilterOption
              count={filterCounts.rating[value]}
              key={value}
              label={screeningRatingFilterLabels[value]}
              selected={rating === value}
              value={value}
            />
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
          {(Object.keys(seenFilterLabels) as ScreeningSeenFilter[]).map((value) =>
            value === "any" ? (
              <option key={value} value={value}>
                {seenFilterLabels[value]}
              </option>
            ) : (
              <FilterOption
                count={filterCounts.seen[value]}
                key={value}
                label={seenFilterLabels[value]}
                selected={seen === value}
                value={value}
              />
            ),
          )}
        </select>
      </label>
      <label className={filterLabelClass(notified !== "any")}>
        Sent to manager
        <select
          className={filterSelectClass(notified !== "any")}
          onChange={(event) => onChange({ notified: event.target.value as ScreeningNotifiedFilter })}
          value={notified}
        >
          {(Object.keys(notifiedFilterLabels) as ScreeningNotifiedFilter[]).map((value) =>
            value === "any" ? (
              <option key={value} value={value}>
                {notifiedFilterLabels[value]}
              </option>
            ) : (
              <FilterOption
                count={filterCounts.notified[value]}
                key={value}
                label={notifiedFilterLabels[value]}
                selected={notified === value}
                value={value}
              />
            ),
          )}
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
            <FilterOption
              count={filterCounts.received[value]}
              key={value}
              label={screeningReceivedFilterLabels[value]}
              selected={received === value}
              value={value}
            />
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
          {/* THESE COUNTS DO NOT SUM TO THE POOL, and that is the role-mismatch fix showing through.
              Somebody who applied for a district manager seat off a senior medical rep CV is
              findable under both families, so he is counted under both — measured on production
              2026-09-18, 303 of the 649 candidates who stated a job were missing from a filter
              their own record answered, 55 of them from District Manager alone. */}
          {candidateRoleFamilies.map((family) => (
            <FilterOption
              count={filterCounts.role[family]}
              key={family}
              label={candidateRoleFamilyLabels[family]}
              selected={role === family}
              value={family}
            />
          ))}
          <FilterOption
            count={filterCounts.role[SCREENING_UNKNOWN]}
            label="No job title on file"
            selected={role === SCREENING_UNKNOWN}
            value={SCREENING_UNKNOWN}
          />
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
            <FilterOption
              count={filterCounts.region[code]}
              key={code}
              label={candidateRegionLabels[code]}
              selected={region === code}
              value={code}
            />
          ))}
          <FilterOption
            count={filterCounts.region.foreign}
            label={foreignRegionLabel}
            selected={region === "foreign"}
            value="foreign"
          />
          <FilterOption
            count={filterCounts.region[SCREENING_UNKNOWN]}
            label="No governorate on file"
            selected={region === SCREENING_UNKNOWN}
            value={SCREENING_UNKNOWN}
          />
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
          {/* Keyed through screeningAreaKey, never through the displayed spelling. These are strings
              applicants typed, the options list keeps the FIRST spelling it saw of each, and a count
              looked up by the display value would read 0 for every row that differed only by case. */}
          {areaOptions.map((value) => (
            <FilterOption
              count={filterCounts.area[screeningAreaKey(value)]}
              key={value}
              label={value}
              selected={area === value}
              value={value}
            />
          ))}
          <FilterOption
            count={filterCounts.area[SCREENING_UNKNOWN]}
            label="No area on file"
            selected={area === SCREENING_UNKNOWN}
            value={SCREENING_UNKNOWN}
          />
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
              <FilterOption
                count={filterCounts.source[screeningSourceKey(value)]}
                key={value}
                label={value}
                selected={source === value}
                value={value}
              />
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
          title="Drop every filter on this bar. The decision tab stays where it is."
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
 *
 * A COLUMN WITH AIR BETWEEN ITS PARTS (2026-10-19). The header, the filter tray and the panel used
 * to butt against each other edge to edge — the bar dropped its own bottom border to share the
 * panel's — so three surfaces read as one tall box. Each is now its own lifted object, and the gap
 * is what lets the depth on each one read.
 */
export function ScreeningPageFrame({ children }: { children: React.ReactNode }) {
  return <div className="-mx-2 flex flex-col gap-3 sm:-mx-4">{children}</div>;
}
