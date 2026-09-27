"use client";

// The Sales Review pack — choosing what goes in it.
//
// Owner, 2026-09-26: "he has the option to choose what metrics he wants, and then press export."
// This is the choosing half. It reads the ONE catalogue in lib/business-review/pack/metrics.ts, so
// a tick here and a section in the deck cannot drift apart.
//
// A PLAIN GET FORM, like the period filter beside it and for the same reason: every apply is a real
// navigation, so the page's server-side role gate re-runs on the new selection rather than a client
// fetch quietly reusing the gate that passed for the previous one. It also makes a chosen pack a
// URL — which is what lets one be sent to somebody, and what makes `narrowSelection` necessary when
// a district manager opens a link built at company level.
//
// Only metrics this LEVEL can answer are offered. A medical rep is never shown a line comparison or
// a rep-by-rep tick, because there are no lines to compare and nobody beneath him.

import {
  METRIC_GROUPS,
  metricsForLevel,
  type PackLevel,
  type ReviewMetricId,
} from "@/lib/business-review/pack/metrics";
import { cn } from "@/lib/utils";

import { hiddenEntries, type HiddenFields } from "./hidden-fields";

type Props = {
  /** Where the form submits — the page's own path. */
  action: string;
  /** Params that must survive the navigation: the window, the line switcher, the territory narrowing. */
  hidden?: HiddenFields;
  level: PackLevel;
  selected: readonly ReviewMetricId[];
};

/**
 * The same page with NO selection in the URL, which is how it falls back to this level's defaults.
 *
 * Built from the params that must survive rather than from the current location, so it cannot carry
 * a stale `m` back: what is not in `hidden` is not in the link.
 */
function resetHref(action: string, hidden?: HiddenFields): string {
  const params = new URLSearchParams(hiddenEntries(hidden));
  const query = params.toString();
  return query ? `${action}?${query}` : action;
}

/**
 * The pack, in the format asked for, carrying the metrics currently APPLIED.
 *
 * It deliberately carries the applied selection rather than whatever is ticked in the open form:
 * the boxes a viewer has changed but not applied are not what the page is showing, and a file that
 * disagrees with the screen it was exported from is the one outcome worth avoiding here. Apply
 * first, then export.
 *
 * The scope is NOT in this link. The route resolves it from the session — a seat or line parameter
 * here would let anyone export any district by editing a URL.
 */
function packHref(
  format: "pdf" | "pptx" | "xlsx",
  hidden: HiddenFields | undefined,
  selected: readonly string[],
): string {
  const params = new URLSearchParams(hiddenEntries(hidden));
  params.set("format", format);
  for (const id of selected) params.append("m", id);
  return `/api/business-review/pack?${params.toString()}`;
}

export function PackPicker({ action, hidden, level, selected }: Props) {
  const available = metricsForLevel(level);
  const ticked = new Set(selected);
  const groups = METRIC_GROUPS.map((group) => ({
    group,
    metrics: available.filter((metric) => metric.group === group.id),
  })).filter((entry) => entry.metrics.length > 0);

  return (
    <details className="border border-border bg-card shadow-sm">
      <summary className="cursor-pointer list-none px-4 py-3">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-words text-sm font-bold">What this review shows</span>
          <span className="min-w-0 break-words text-xs text-muted-foreground">
            {ticked.size} of {available.length} chosen · click to change
          </span>
        </span>
      </summary>

      <form action={action} className="border-t border-border px-4 py-3" method="get">
        {hiddenEntries(hidden).map(([name, value], i) => (
          <input key={`${name}:${i}`} name={name} type="hidden" value={value} />
        ))}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map(({ group, metrics }) => (
            <fieldset className="min-w-0" key={group.id}>
              <legend className="text-phx-2xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {group.label}
              </legend>
              <p className="mt-0.5 break-words text-phx-xs text-muted-foreground">{group.question}</p>
              <ul className="mt-2 space-y-1.5">
                {metrics.map((metric) => (
                  <li key={metric.id}>
                    <label className="flex min-w-0 items-start gap-2">
                      <input
                        className="mt-0.5 shrink-0"
                        defaultChecked={ticked.has(metric.id)}
                        name="m"
                        type="checkbox"
                        value={metric.id}
                      />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-semibold">
                          {metric.label}
                          {metric.needsClosingDetail && (
                            <span className="ml-1.5 border border-border px-1 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-muted-foreground">
                              extra read
                            </span>
                          )}
                        </span>
                        <span className="block break-words text-phx-xs text-muted-foreground">{metric.hint}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}
        </div>

        {/* The three marked "extra read" go to the Monthly Closing's customer-grain rows — a round
            trip per line per month. Saying so is the difference between a slow page and an
            unexplained one. */}
        <p className="mt-3 break-words text-phx-xs text-muted-foreground">
          The metrics marked <span className="font-semibold">extra read</span> ask the Monthly Closing for its
          customer-by-customer rows, which takes longer to load. Leave them unticked when you do not need them.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className={cn(
              "h-9 border border-primary bg-primary px-4 text-sm font-bold text-primary-foreground",
              "outline-none transition-colors hover:bg-primary/90",
            )}
            type="submit"
          >
            Apply
          </button>
          {/* A LINK, not a submit. Reset means "no selection in the URL at all", which is how the
              page knows to fall back to this level's defaults — and a submit button cannot remove
              the ticked checkboxes travelling beside it. */}
          <a
            className="flex h-9 items-center border border-border bg-card px-4 text-sm font-semibold hover:bg-bg-muted"
            href={resetHref(action, hidden)}
          >
            Reset to the default
          </a>

          {/* The exports carry the SAME ticks, so a manager gets the pack he is looking at. They
              are plain links, not form submits: a submit would navigate the page to a download. */}
          <a
            className="flex h-9 items-center border border-border bg-card px-4 text-sm font-semibold hover:bg-bg-muted"
            href={packHref("pdf", hidden, selected)}
          >
            Export PDF
          </a>
          <a
            className="flex h-9 items-center border border-border bg-card px-4 text-sm font-semibold hover:bg-bg-muted"
            href={packHref("xlsx", hidden, selected)}
          >
            Export Excel
          </a>
          {/* The deck. One slide per section, the cover carrying the window and the coverage note —
              the owner's own reason for this module: a sales review presented rather than typed. */}
          <a
            className="flex h-9 items-center border border-border bg-card px-4 text-sm font-semibold hover:bg-bg-muted"
            href={packHref("pptx", hidden, selected)}
          >
            Export PowerPoint
          </a>
        </div>
      </form>
    </details>
  );
}
