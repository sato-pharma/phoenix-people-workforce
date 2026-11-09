"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  buildKpisQuery,
  countActiveKpiFilters,
  hasActiveKpiFilters,
  KPI_RANGE_FIELDS,
  KPI_RANGE_LABEL,
  KPI_RANGE_UNIT,
  kpiFlagHint,
  kpiRangeFromInputs,
  toggleKpiFacet,
  type KpiFlag,
  type KpiFacetOption,
  type KpiFacets,
  type KpiFilterState,
  type KpiRangeField,
  type KpiRangeFilters,
} from "@/lib/crm/kpis-filters";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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

const LABEL = "text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500";

type FacetKey =
  | "lines"
  | "regions"
  | "areas"
  | "managers"
  | "titles"
  | "coverage"
  | "frequency"
  | "amRate"
  | "pmRate"
  | "flags";

const GROUPS: ReadonlyArray<{ key: FacetKey; title: string; hint: string }> = [
  { key: "lines", title: "Product line", hint: "From the employee record, not the CRM." },
  { key: "regions", title: "Region", hint: "The company's regions." },
  { key: "areas", title: "Area", hint: "The rep's own area." },
  { key: "managers", title: "Reports to", hint: "Any manager above the rep on the org tree." },
  { key: "titles", title: "Job title", hint: "Medical Rep, DSM, and anyone else in reach." },
  { key: "coverage", title: "Coverage band", hint: "Share of the planned list reached at all." },
  { key: "frequency", title: "Frequency band", hint: "Exact is the only pass." },
  { key: "amRate", title: "AM band", hint: "Verified morning calls against the AM target alone." },
  { key: "pmRate", title: "PM band", hint: "Verified afternoon calls against the PM target alone." },
  { key: "flags", title: "Situations", hint: "Any one of these matches — they are OR-ed." },
];

/**
 * What each report puts first. The panel never hides a filter another report would offer — "filter by
 * anything" — it only leads with the ones that belong to the measure on screen, so the Coverage report
 * opens on the coverage band and the doctor counts, Call Rate on the AM and PM bands and the call columns.
 */
const BAND_FIRST: Record<string, FacetKey[]> = {
  coverage: ["coverage"],
  frequency: ["frequency"],
  "call-rate": ["amRate", "pmRate"],
};

const RANGE_FIRST: Record<string, KpiRangeField[]> = {
  coverage: ["coverage", "planned", "visited", "missed"],
  frequency: ["frequency", "planned", "exact", "below", "above"],
  "call-rate": ["am", "pm", "calls", "campaign", "workingdays"],
};

const BAND_KEYS: readonly FacetKey[] = ["coverage", "frequency", "amRate", "pmRate"];

function groupsFor(tab: string): typeof GROUPS {
  const first = BAND_FIRST[tab] ?? [];
  const organisation = GROUPS.filter((group) => !BAND_KEYS.includes(group.key) && group.key !== "flags");
  const leading = GROUPS.filter((group) => first.includes(group.key));
  const rest = GROUPS.filter((group) => BAND_KEYS.includes(group.key) && !first.includes(group.key));
  const flags = GROUPS.filter((group) => group.key === "flags");
  return [...organisation, ...leading, ...rest, ...flags];
}

type RangeDraft = Record<KpiRangeField, { min: string; max: string }>;

function draftFrom(ranges: KpiRangeFilters): RangeDraft {
  return Object.fromEntries(
    KPI_RANGE_FIELDS.map((field) => [
      field,
      { min: ranges[field]?.min != null ? String(ranges[field]?.min) : "", max: ranges[field]?.max != null ? String(ranges[field]?.max) : "" },
    ]),
  ) as RangeDraft;
}

function rangesFrom(draft: RangeDraft): KpiRangeFilters {
  const ranges: KpiRangeFilters = {};
  for (const field of KPI_RANGE_FIELDS) {
    const range = kpiRangeFromInputs(draft[field].min, draft[field].max);
    if (range) ranges[field] = range;
  }
  return ranges;
}

/** The group hints that change once the Phoenix KPI rules score the board (phase 6). */
const GROUP_HINT_PHOENIX: Partial<Record<FacetKey, string>> = {
  frequency: "Graded doctors at their grade norm. Extra visits are fine.",
  amRate: "Submitted morning visits against the AM target alone.",
  pmRate: "Submitted afternoon visits against the PM target alone.",
};

export function KpisFilterBar({
  basePath,
  facets,
  filters,
  kpiRules,
  month,
  period,
  rep,
  tab,
  trend,
  measure,
  view,
  total,
  visible,
}: {
  basePath: string;
  facets: KpiFacets;
  filters: KpiFilterState;
  /** "phoenix" once the CRM cutover rules score the board — the frequency and rate hints change. */
  kpiRules?: "legacy" | "phoenix";
  month: string;
  period: string;
  /**
   * The rep whose doctor list is open on the Coverage tab, carried so a filter change keeps it open.
   * The server drops it again if the new filters take him off the board.
   */
  rep?: string | null;
  tab: string;
  /** The Weekly tab's two switches, carried so a filter change keeps the view it was made on. */
  trend?: string | null;
  measure?: string | null;
  /** The call-rate report's Total / AM / PM view, carried so a filter change keeps it. */
  view?: string | null;
  /** Reps in the viewer's scope, before filtering. */
  total: number;
  /** Reps left after filtering. */
  visible: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(filters.query);
  const [draft, setDraft] = useState<RangeDraft>(() => draftFrom(filters.ranges));
  const primaryRanges = RANGE_FIRST[tab] ?? [...KPI_RANGE_FIELDS];
  const otherRanges = KPI_RANGE_FIELDS.filter((field) => !primaryRanges.includes(field));

  const activeCount = countActiveKpiFilters(filters);
  const anyActive = hasActiveKpiFilters(filters);

  const push = (next: KpiFilterState) => {
    startTransition(() =>
      router.push(`${basePath}?${buildKpisQuery({ month, period, rep, tab, filters: next, trend, measure, view })}`),
    );
  };

  const toggle = (facet: FacetKey, value: string) => push(toggleKpiFacet(filters, facet, value));

  const clearAll = () => {
    setQuery("");
    setDraft(draftFrom({}));
    push({
      ...filters,
      lines: [],
      regions: [],
      areas: [],
      managers: [],
      titles: [],
      coverage: [],
      frequency: [],
      amRate: [],
      pmRate: [],
      flags: [],
      ranges: {},
      query: "",
    });
  };

  const setBound = (field: KpiRangeField, end: "min" | "max", value: string) =>
    setDraft((current) => ({ ...current, [field]: { ...current[field], [end]: value } }));

  const rangeBox = (field: KpiRangeField) => (
    <div className="min-w-0 border border-slate-200 bg-white px-3 py-3" key={field}>
      <p className={LABEL}>{KPI_RANGE_LABEL[field]}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["min", "max"] as const).map((end) => (
          <label className="block min-w-0" key={end}>
            <span className="sr-only">
              {KPI_RANGE_LABEL[field]} {end === "min" ? "from" : "up to"}
            </span>
            {/* text-base, as the search box above: under 16px iOS zooms the page on focus. */}
            <input
              className={cn(phxFieldClassName, "min-w-0 text-base tabular-nums")}
              inputMode="decimal"
              min={0}
              onChange={(event) => setBound(field, end, event.target.value)}
              placeholder={end === "min" ? "From" : "Up to"}
              step="any"
              type="number"
              value={draft[field][end]}
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-phx-xs leading-4 text-slate-400">{KPI_RANGE_UNIT[field]}</p>
    </div>
  );

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
                ? "inline-flex items-center gap-2 border border-orange-500 bg-orange-50 px-3 py-2 text-phx-md font-black uppercase tracking-[0.12em] text-orange-800"
                : "inline-flex items-center gap-2 border border-slate-300 bg-white px-3 py-2 text-phx-md font-black uppercase tracking-[0.12em] text-slate-700 transition-colors hover:border-slate-400"
            }
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span>Advanced filters</span>
            {activeCount > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center bg-orange-600 px-1 text-phx-xs font-black tabular-nums text-white">
                {activeCount}
              </span>
            ) : null}
            <span aria-hidden>{open ? "▲" : "▼"}</span>
          </button>
          {anyActive ? (
            <button
              className="border border-slate-300 bg-white px-3 py-2 text-phx-md font-bold text-slate-600 transition-colors hover:border-rose-400 hover:text-rose-700"
              disabled={pending}
              onClick={clearAll}
              type="button"
            >
              Clear all
            </button>
          ) : null}
        </div>
        <p className="text-phx-sm font-semibold text-slate-500">
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
                  className={cn(phxFieldClassName, "min-w-0 flex-1 text-base")}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Rep, line, region, area or manager"
                  type="search"
                  value={query}
                />
                <button
                  className="border border-slate-900 bg-slate-900 px-4 py-2 text-phx-md font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-slate-700"
                  disabled={pending}
                  type="submit"
                >
                  Apply
                </button>
              </span>
            </label>
          </form>

          {/* RANGES: a minimum and a maximum on any number the tables print. This report's own columns
              lead; the rest sit one click away, so nothing a manager could filter by is out of reach. */}
          <form
            className="mb-4 border border-slate-200 bg-white px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              push({ ...filters, ranges: rangesFrom(draft) });
            }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className={LABEL}>Ranges</p>
              <p className="text-phx-xs leading-4 text-slate-400">
                Leave an end blank for open. A rep with nothing to measure on a column never matches a bound on it.
              </p>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{primaryRanges.map(rangeBox)}</div>
            {otherRanges.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-phx-md font-bold text-slate-600 hover:text-slate-900">
                  More columns
                </summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{otherRanges.map(rangeBox)}</div>
              </details>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="border border-slate-900 bg-slate-900 px-4 py-2 text-phx-md font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-slate-700"
                disabled={pending}
                type="submit"
              >
                Apply ranges
              </button>
              <button
                className="border border-slate-300 bg-white px-4 py-2 text-phx-md font-bold text-slate-600 transition-colors hover:border-slate-500"
                disabled={pending}
                onClick={() => {
                  setDraft(draftFrom({}));
                  push({ ...filters, ranges: {} });
                }}
                type="button"
              >
                Clear ranges
              </button>
            </div>
          </form>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groupsFor(tab).map((group) => {
              const options = optionsFor(group.key);
              // A facet with one option is hidden, not just an empty one. Selecting the only value
              // there is cannot change a single row, and offering it implies the board holds other
              // kinds of people. Job title is normally this now that the rep rows are medical reps
              // only — it reappears by itself the day a rep turns up with no title recorded. The
              // manager rows (owner, 2026-10-20) add no options here: every facet counts reps.
              if (options.length <= 1) return null;
              const selected = selectedFor(group.key);
              return (
                <fieldset className="min-w-0 border border-slate-200 bg-white px-3 py-3" key={group.key}>
                  <legend className={`px-1 ${LABEL}`}>{group.title}</legend>
                  <p className="text-phx-xs leading-4 text-slate-400">
                    {(kpiRules === "phoenix" ? GROUP_HINT_PHOENIX[group.key] : undefined) ?? group.hint}
                  </p>
                  {/* Vertical scroll on a long list is fine; horizontal never is. */}
                  <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                    {options.map((option) => {
                      const isOn = selected.includes(option.value);
                      return (
                        <label
                          className={
                            isOn
                              ? "inline-flex cursor-pointer items-center gap-1.5 border border-orange-500 bg-orange-50 px-2 py-1 text-phx-sm font-bold text-orange-900"
                              : "inline-flex cursor-pointer items-center gap-1.5 border border-slate-200 bg-white px-2 py-1 text-phx-sm font-semibold text-slate-700 transition-colors hover:border-slate-400"
                          }
                          key={option.value}
                          title={group.key === "flags" ? kpiFlagHint(option.value as KpiFlag, kpiRules) : undefined}
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
