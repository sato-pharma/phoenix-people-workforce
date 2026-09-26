"use client";

// Business Review — narrowing the review to part of your own scope.
//
// Owner, 2026-09-26: "I want everyone to be able to export as he is filtered or as his scope … if a
// district manager wants to export for only one area, he can filter on the area and export, or
// export for his total region. Super Admin … CNS line only, or Pedia line only for the region of
// Dr. Hany Saad only."
//
// And the reason it matters beyond export, in his words the same day: the portal page "is not
// structured at all … the pages are very long and impossible for anyone to be able to extract
// data." Measured on production that day: 10,676px — 10.1 screens — of which the 144-row area table
// alone was 7,376px. This control is what turns 144 areas into the five a district manager actually
// runs.
//
// A PLAIN GET FORM, exactly like the period filter beside it and for the same reason: every apply is
// a real navigation, so the page's server-side role gate re-runs on the new selection instead of a
// client fetch quietly reusing the gate that passed for the previous one. It also makes a narrowed
// review a URL, which is what lets one be sent to somebody — and what makes the server-side
// narrowing in `scope-filter.ts` load-bearing rather than decorative.
//
// 🔴 THE OPTIONS ARE NEVER WIDER THAN THE VIEWER. They come from `filterChoices()`, which is derived
// from the scoped territory list and nothing else, so a district manager is offered his own line,
// his own region and his own areas — never a colleague's. Offering a choice that would be refused on
// submit is the "a picker is never wider than its viewer" defect the CEO/district rule already names.
//
// A select with ONE option is not rendered at all. A district manager has exactly one line, and a
// dropdown that can only say what it already says is furniture, not a control.

import type { AppliedReviewFilter, ReviewFilterChoices } from "@/lib/business-review/scope-filter";

type Props = {
  /** Where the form submits — the page's own path. */
  action: string;
  choices: ReviewFilterChoices;
  applied: AppliedReviewFilter;
  /** Params that must survive the navigation: the window. */
  hidden?: Record<string, string>;
  /**
   * The metrics currently applied, carried through as hidden inputs.
   *
   * Without this, narrowing to a district would silently reset the chosen metrics back to that
   * level's defaults — the viewer would lose his selection by using a different control, which is
   * the kind of thing nobody reports and everybody works around.
   */
  metrics: readonly string[];
  /** Anything asked for and refused, so a forwarded link does not lie about what it shows. */
  dropped?: readonly string[];
};

const FIELD =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm font-semibold text-foreground " +
  "outline-none focus:border-primary";

const LABEL = "flex items-center gap-1.5 text-sm font-medium text-muted-foreground";

export function ReviewScopeFilter({ action, applied, choices, dropped = [], hidden, metrics }: Props) {
  const { areas, districts, lines, regions } = choices;

  // Nothing to narrow — a rep with one area, say. Rendering four empty dropdowns would look broken.
  const anything = lines.length > 1 || regions.length > 1 || districts.length > 1 || areas.length > 1;
  if (!anything) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <form action={action} className="flex flex-wrap items-center gap-2" method="get">
        {Object.entries(hidden ?? {}).map(([name, value]) => (
          <input key={name} name={name} type="hidden" value={value} />
        ))}
        {/* The chosen metrics ride along, so narrowing the territory does not reset what is shown. */}
        {metrics.map((metric) => (
          <input key={metric} name="m" type="hidden" value={metric} />
        ))}

        {lines.length > 1 && (
          <label className={LABEL}>
            <span className="whitespace-nowrap">Line</span>
            <select className={FIELD} defaultValue={applied.line ?? ""} name="line">
              <option value="">All lines</option>
              {lines.map((line) => (
                <option key={line.value} value={line.value}>
                  {line.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {regions.length > 1 && (
          <label className={LABEL}>
            <span className="whitespace-nowrap">Region</span>
            <select className={FIELD} defaultValue={applied.region ?? ""} name="region">
              <option value="">All regions</option>
              {regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </label>
        )}

        {districts.length > 1 && (
          <label className={LABEL}>
            <span className="whitespace-nowrap">District</span>
            {/* Names, never seat codes — the owner's standing rule. The VALUE is the seat id, which
                is what the server narrows on; the label is the manager a human recognises. */}
            <select className={FIELD} defaultValue={applied.dmSeatId ?? ""} name="dm">
              <option value="">All districts</option>
              {districts.map((district) => (
                <option key={district.seatId} value={district.seatId}>
                  {district.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {areas.length > 1 && (
          <label className={LABEL}>
            <span className="whitespace-nowrap">Area</span>
            <select className={FIELD} defaultValue={applied.areaCode ?? ""} name="area">
              <option value="">All areas</option>
              {areas.map((area) => (
                <option key={`${area.line}:${area.code}`} value={area.code}>
                  {area.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          className="h-9 whitespace-nowrap rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          type="submit"
        >
          Apply
        </button>
        {/* A LINK, not a submit: clearing means "no filter in the URL at all", and a submit button
            cannot remove the values sitting in the selects beside it. */}
        <a
          className="h-9 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-[7px] text-sm font-semibold text-muted-foreground transition-colors hover:bg-bg-muted hover:text-foreground"
          href={action}
        >
          Clear
        </a>
      </form>

      {/* A forwarded link may name a territory this viewer cannot see. The server drops it rather
          than refusing — but it must never do so silently, or the page claims a scope it is not
          showing. */}
      {dropped.length > 0 && (
        <p className="min-w-0 break-words text-phx-xs text-muted-foreground">
          {dropped.join(" ")}
        </p>
      )}
    </div>
  );
}
