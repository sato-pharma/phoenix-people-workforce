"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  buildKpisQuery,
  countActiveKpiFilters,
  hasActiveKpiFilters,
  KPI_FLAG_HINT,
  toggleKpiFacet,
  type KpiFacetOption,
  type KpiFacets,
  type KpiFilterState,
} from "@/lib/crm/kpis-filters";

/**
 * The KPIs board's advanced filters.
 *
 * ## Everything a manager can narrow by, in one panel
 *
 * Five organisational facets (line, region, area, manager, job title), three performance bands
 * (coverage, frequency, call rate), a situation list, and free text over all of them. Each is a
 * query parameter, so the whole board is a shareable URL and every change re-runs the server-side
 * scope gate. A filter can only NARROW what the gate already returned — `applyKpiFilters` runs
 * after `joinKpiRows` has dropped every rep outside the viewer's reach, so no combination of
 * parameters can widen anyone's view by a single row.
 *
 * ## The options come from the data, never from a fixed list
 *
 * A District Manager is offered his own three areas, not the company's ninety. Offering a choice
 * that returns an empty board is worse than not offering it, because an empty board reads as
 * "nobody did anything" rather than as "that filter matched nobody here". Every option carries its
 * own count for the same reason.
 *
 * ## Why the panel is chips and not selects
 *
 * The owner's fits-the-screen golden rule names a native `<select>` as the one control that cannot
 * be shrunk — iOS zooms the page when a select's text is under 16px. A multi-select of ninety areas
 * would therefore either overflow at 375px or force a font size the rule forbids. Chips WRAP, which
 * is the rule's own permitted answer to a width collision, and a long list gets a vertical scroll
 * inside its own box. Vertical is allowed; horizontal never is.
 *
 * The one real input, the search box, stays at `text-base` for exactly the same iOS reason.
 *
 * ## Only plain data crosses the boundary
 *
 * This file is the board's only "use client" component besides the period picker, and it receives
 * facets, filter state and strings — no functions. A server component handing a function to a
 * client one cannot be serialised and 500s the page on every load; that took two doctor-coverage
 * routes down for about an hour on 2026-08-21, and tests/rsc-client-function-props.test.ts walks
 * the import graph to keep it from happening again.
 *
 * Its runtime imports come from kpis-filters.ts, which imports NOTHING — the same discipline
 * kpis-tabs.ts follows. Importing these from kpis-board.ts would drag the Supabase admin client and
 * `node:crypto` into the browser bundle and 500 the page, invisibly to `tsc`.
 */

const LABEL = "text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";

type FacetKey = "lines" | "regions" | "areas" | "managers" | "titles" | "coverage" | "frequency" | "callRate" | "flags";

const GROUPS: ReadonlyArray<{ key: FacetKey; title: string; hint: string }> = [
  { key: "lines", title: "Product line", hint: "From the employee record, not the CRM." },
  { key: "regions", title: "Region", hint: "The company's regions." },
  { key: "areas", title: "Area", hint: "The rep's own area." },
  { key: "managers", title: "Reports to", hint: "Direct manager on the org tree." },
  { key: "titles", title: "Job title", hint: "Medical Rep, DSM, and anyone else in reach." },
  { key: "coverage", title: "Coverage band", hint: "Share of the planned list reached at all." },
  { key: "frequency", title: "Frequency band", hint: "Exact is the only pass." },
  { key: "callRate", title: "Call-rate band", hint: "Verified calls against the AM + PM targets." },
  { key: "flags", title: "Situations", hint: "Any one of these matches — they are OR-ed." },
];

export function KpisFilterBar({
  basePath,
  facets,
  filters,
  month,
  period,
  tab,
  total,
  visible,
}: {
  basePath: string;
  facets: KpiFacets;
  filters: KpiFilterState;
  month: string;
  period: string;
  tab: string;
  /** Reps in the viewer's scope, before filtering. */
  total: number;
  /** Reps left after filtering. */
  visible: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(filters.query);

  const activeCount = countActiveKpiFilters(filters);
  const anyActive = hasActiveKpiFilters(filters);

  const push = (next: KpiFilterState) => {
    startTransition(() =>
      router.push(`${basePath}?${buildKpisQuery({ month, period, tab, filters: next })}`),
    );
  };

  const toggle = (facet: FacetKey, value: string) => push(toggleKpiFacet(filters, facet, value));

  const clearAll = () => {
    setQuery("");
    push({
      ...filters,
      lines: [],
      regions: [],
      areas: [],
      managers: [],
      titles: [],
      coverage: [],
      frequency: [],
      callRate: [],
      flags: [],
      query: "",
    });
  };

  const optionsFor = (key: FacetKey): KpiFacetOption[] => facets[key];
  const selectedFor = (key: FacetKey): string[] => filters[key] as string[];

  return (
    <div className="border-t border-slate-100">
      {/* The summary row. It always says how many reps are on screen out of how many exist, because
          a filtered board showing "12 reps" is indistinguishable from a district that has twelve
          people — and a manager who forgot a filter was on would read a partial board as the whole
          truth. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-expanded={open}
            className={
              anyActive
                ? "inline-flex items-center gap-2 border border-orange-500 bg-orange-50 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-orange-800"
                : "inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-700 transition-colors hover:border-slate-400"
            }
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span>Advanced filters</span>
            {activeCount > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center bg-orange-600 px-1 text-phx-3xs font-black tabular-nums text-white">
                {activeCount}
              </span>
            ) : null}
            <span aria-hidden>{open ? "▲" : "▼"}</span>
          </button>
          {anyActive ? (
            <button
              className="border border-slate-300 bg-white px-3 py-2 text-phx-xs font-bold text-slate-600 transition-colors hover:border-rose-400 hover:text-rose-700"
              disabled={pending}
              onClick={clearAll}
              type="button"
            >
              Clear all
            </button>
          ) : null}
        </div>
        <p className="text-phx-2xs font-semibold text-slate-500">
          Showing <span className="tabular-nums text-slate-900">{visible}</span> of{" "}
          <span className="tabular-nums text-slate-900">{total}</span> medical reps in your reach
          {pending ? " · updating…" : ""}
        </p>
      </div>

      {open ? (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-4 sm:px-5">
          <form
            className="mb-4"
            onSubmit={(event) => {
              event.preventDefault();
              push({ ...filters, query });
            }}
          >
            <label className="block">
              <span className={LABEL}>Search</span>
              {/* text-base, deliberately: under 16px iOS zooms the page on focus, which the
                  fits-the-screen rule forbids. */}
              <span className="mt-1 flex flex-wrap gap-2">
                <input
                  className="min-w-0 flex-1 border border-slate-300 bg-white px-3 py-2 text-base text-slate-900"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Rep, line, region, area or manager"
                  type="search"
                  value={query}
                />
                <button
                  className="border border-slate-900 bg-slate-900 px-4 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-slate-700"
                  disabled={pending}
                  type="submit"
                >
                  Apply
                </button>
              </span>
            </label>
          </form>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {GROUPS.map((group) => {
              const options = optionsFor(group.key);
              // A facet with one option is hidden, not just an empty one. Selecting the only value
              // there is cannot change a single row, and offering it implies the board holds other
              // kinds of people. Job title is normally this now that the page is medical reps only
              // — it reappears by itself the day a rep turns up with no title recorded.
              if (options.length <= 1) return null;
              const selected = selectedFor(group.key);
              return (
                <fieldset className="min-w-0 border border-slate-200 bg-white px-3 py-3" key={group.key}>
                  <legend className={`px-1 ${LABEL}`}>{group.title}</legend>
                  <p className="text-phx-3xs leading-4 text-slate-400">{group.hint}</p>
                  {/* Vertical scroll on a long list is fine; horizontal never is. */}
                  <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                    {options.map((option) => {
                      const isOn = selected.includes(option.value);
                      return (
                        <label
                          className={
                            isOn
                              ? "inline-flex cursor-pointer items-center gap-1.5 border border-orange-500 bg-orange-50 px-2 py-1 text-phx-2xs font-bold text-orange-900"
                              : "inline-flex cursor-pointer items-center gap-1.5 border border-slate-200 bg-white px-2 py-1 text-phx-2xs font-semibold text-slate-700 transition-colors hover:border-slate-400"
                          }
                          key={option.value}
                          title={group.key === "flags" ? KPI_FLAG_HINT[option.value as keyof typeof KPI_FLAG_HINT] : undefined}
                        >
                          <input
                            checked={isOn}
                            className="h-3 w-3 accent-orange-600"
                            disabled={pending}
                            onChange={() => toggle(group.key, option.value)}
                            type="checkbox"
                          />
                          <span dir="auto">{option.label}</span>
                          <span className="tabular-nums text-slate-400">{option.count}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
