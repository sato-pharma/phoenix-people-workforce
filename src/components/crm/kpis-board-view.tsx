import Link from "next/link";

import { KpisFilterBar } from "@/components/crm/kpis-filter-bar";
import { KpisPeriodPicker, type KpiPickerOption } from "@/components/crm/kpis-period-picker";
import {
  CAPTION,
  KpiBandChip,
  KpiEmptyState,
  KpiMeter,
  KpiPodiumCard,
  KpiRepName,
  KpiSection,
  KpiSortableTh,
  KpiTile,
  NUM,
  PANEL,
  TD,
  TH,
  toneOf,
} from "@/components/crm/kpis-chrome";
import { KPI_TABS, KPI_TAB_HINT, KPI_TAB_LABEL, type KpiTab } from "@/lib/crm/kpis-tabs";
import {
  buildKpisQuery,
  callRateBandOf,
  coverageBandOf,
  EMPTY_KPI_FILTERS,
  frequencyBandOf,
  hasActiveKpiFilters,
  kpiBandOf,
  kpiFlagsOf,
  KPI_BAND_LABEL,
  KPI_FLAG_LABEL,
  nextKpiSort,
  UNASSIGNED_FACET_KEY,
  UNASSIGNED_FACET_LABEL,
  type KpiBand,
  type KpiFilterState,
  type KpiSortField,
  isTooEarlyToScore,
} from "@/lib/crm/kpis-filters";
import { ACTIVITY_LABEL } from "@/lib/crm/reps-list-activity";
import type { KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";

/**
 * The KPIs board — Summary, Call Rate, Coverage and Frequency over one rep list.
 *
 * ## The owner's vocabulary, not the code's
 *
 * The frequency buckets are `on_plan` / `under` / `over` in the domain, and the owner's own words
 * for them are EXACT, BELOW and ABOVE. The screen uses his. A manager reading "on plan" beside
 * "under" has to work out that they are the same axis; "Exact / Below / Above" is one sentence.
 *
 * ## Fits the screen
 *
 * Every table is `w-full table-fixed` over a `<colgroup>` summing to 100%, and never
 * `PortalDesktopTable` — the owner's golden rule forbids a horizontal scroll at any width, and that
 * primitive carries a min-width floor with `overflow-x-auto`, which IS the bug rather than the fix.
 * Where a column will not fit it is MERGED into its neighbour, never shrunk, and long values wrap.
 * No value is ever truncated with an ellipsis. Nothing here is `whitespace-nowrap` over content
 * that can grow, because clipped content adds nothing to `scrollWidth` and would certify a page
 * that is in fact overflowing — the Stars of the Fortnight header sat 36px past `main` that way.
 *
 * ## Mobile gets cards, desktop gets the table — inlined, NOT through the primitive
 *
 * This file has no "use client": it renders on the server. PortalResponsiveDataList does have one,
 * so handing it `getKey` / `renderCard` / `renderTable` sends three FUNCTIONS across the RSC
 * boundary. React cannot serialise a function, so the page 500s at render time with "Functions
 * cannot be passed directly to Client Components" — on every load, for everyone, not as an edge
 * case. That is not hypothetical: it is exactly what took /admin/doctor-coverage and its portal
 * twin down for about an hour on 2026-08-21.
 *
 * Adding "use client" here would also silence it, but it is the wrong trade: this board is a
 * read-only report whose only interactive parts are the period picker and the filter panel, each
 * of which carries its own directive and receives only plain data. Everything else would ship to
 * the browser to buy nothing. The `md:hidden` card list and the `hidden md:block` table wrapper
 * below ARE what the primitive emits. tests/rsc-client-function-props.test.ts guards the boundary;
 * tests/crm-mobile-table-cards.test.ts accepts this spelling because it checks for `md:hidden`,
 * not for the primitive by name.
 *
 * ## text-phx-* never goes through cn()
 *
 * tailwind-merge silently strips custom named font sizes, and only `getComputedStyle` in a real
 * browser can see that it did. Every class string here is a plain template literal, and the shared
 * ones live in kpis-chrome.tsx.
 */

/** A rate as the board prints it: two decimals, or an em dash when there is nothing to divide. */
function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/** A percentage, or a marker when the rep has no plan to be a percentage OF. */
function planPct(row: KpiRepRow, value: number): string {
  return row.hasMeasurablePlan ? `${value}%` : "No plan";
}

/** Attainment, or a marker when the rep logged nothing at all in the window. */
function ratePct(row: KpiRepRow): string {
  return row.hasCallRate && row.callRateAttainmentPct != null ? `${row.callRateAttainmentPct}%` : "No calls";
}

type ViewContext = {
  basePath: string;
  board: KpisBoard;
  tab: KpiTab;
  /** True when the current sort is a measure, so a rank disc actually means something. */
  showRank: boolean;
};

/**
 * Every link on this board goes through here.
 *
 * Two URL builders would be two answers the first time either changed, and the symptom is nasty and
 * specific: a sort link that quietly dropped the area filter would put a WIDER set of reps on
 * screen than the manager asked for, under a heading still saying the filter is on.
 */
function hrefWith(context: ViewContext, overrides: { tab?: KpiTab; filters?: KpiFilterState }): string {
  const { basePath, board } = context;
  return `${basePath}?${buildKpisQuery({
    month: board.month,
    period: board.range.periodKey,
    tab: overrides.tab ?? context.tab,
    filters: overrides.filters ?? board.filters,
  })}`;
}

function sortHref(context: ViewContext, field: KpiSortField): string {
  return hrefWith(context, { filters: nextKpiSort(context.board.filters, field) });
}

// ── The headline ──────────────────────────────────────────────────────────────────────────────

/**
 * One sentence about the whole board, in the hero.
 *
 * It is about the TEAM and the period, never about a named person. Every role that can open this
 * page sees somebody's name beside a number — a Medical Rep sees his own — so a verdict with any
 * edge to it would be a verdict on a real employee, read by their manager. The character stays on
 * the board; the rows stay factual.
 *
 * The coverage-high / frequency-low case is called out by name because it is the single most common
 * misreading of this board: production has run 68% coverage against 39% frequency in the same
 * month, and a manager who does not know the two measure different things reads that gap as a bug.
 */

function teamVerdict(board: KpisBoard): { headline: string; tone: KpiBand; standing?: string } {
  const { totals } = board;
  if (board.range.notStarted) {
    return { headline: "This period has not started. Nothing here is a score yet.", tone: "noplan" };
  }
  if (totals.reps === 0) {
    return { headline: "No reps match what you are looking at.", tone: "noplan" };
  }

  // TOO EARLY TO SCORE — the check that has to come before every verdict below.
  //
  // Coverage is doctors reached over doctors planned. Two working days into a month that has
  // twenty-two, most of the numerator has not happened yet, and the honest reading of a low
  // percentage is "it is the 3rd", not "the team is behind". Measured on production 2026-09-03:
  // the board read 39% and said "Most of the planned list has not been reached at all yet" — while
  // the SAME query over the first two working days of August read 40.1%, against a closed-August
  // 71.4%. The team was performing exactly as it had the month before. The number was right and
  // the sentence under it was an accusation the data could not support.
  //
  // This is why the board reports the position rather than suppressing the figures: the tiles and
  // the tables still show every number. What is withheld is the JUDGEMENT, which is the only part
  // that was ever wrong.
  const { workingDays, workingDaysInWindow } = board;
  const earlyInWindow = isTooEarlyToScore(workingDays, workingDaysInWindow);
  if (earlyInWindow) {
    const left = workingDaysInWindow - workingDays;
    return {
      headline:
        `${workingDays} of ${workingDaysInWindow} working days are in — ${left} still to come. ` +
        "Coverage and frequency climb as the month is worked, so treat these as a position, not a score.",
      tone: "noplan",
      // NOT "Not measurable" — every figure on this board is measured and shown. What the month is
      // too young to support is a VERDICT, and saying otherwise is the same overstatement in the
      // pill that the headline above exists to remove.
      standing: "Early days",
    };
  }

  const coverage = kpiBandOf(totals.coveragePct);
  const frequency = kpiBandOf(totals.frequencyPct);
  const call = kpiBandOf(totals.callRateAttainmentPct);

  if (coverage === "elite" && frequency === "elite" && call === "elite") {
    return { headline: "Every measure is above 90%. There is nothing on this board to fix today.", tone: "elite" };
  }
  if (totals.coveragePct >= 75 && frequency === "behind") {
    return {
      headline: "Nearly everyone was reached — far fewer were reached the right number of times.",
      tone: "steady",
    };
  }
  if (coverage === "behind") {
    return { headline: "Most of the planned list has not been reached at all yet.", tone: "behind" };
  }
  if (call === "behind") {
    return {
      headline: "Coverage is holding, but the working day is not producing the calls it should.",
      tone: "behind",
    };
  }
  if (coverage === "elite" || frequency === "elite" || call === "elite") {
    return { headline: "One measure is running well ahead of the other two. Worth knowing which.", tone: "strong" };
  }
  return { headline: "All three measures are mid-table. No emergency, no victory.", tone: "steady" };
}

// ── Hero and tabs ─────────────────────────────────────────────────────────────────────────────

/**
 * The command hero.
 *
 * Same shape as `PremiumHero` — slate-900 band, orange kicker, orange glow, accent strip — spelled
 * out here rather than imported because this one carries a tone-coloured standing pill that the
 * shared component has no prop for, and the owner's rule is to match the module's design identity,
 * which is what this does.
 */
function KpiHero({ board }: { board: KpisBoard }) {
  const verdict = teamVerdict(board);
  const tone = toneOf(verdict.tone);
  return (
    <section className="relative overflow-hidden border border-slate-800 bg-slate-900 px-5 py-6 shadow-sm sm:px-8 sm:py-7">
      {/* Decorative, and aria-hidden so a fits-the-screen measuring pass discounts them: a bleed is
          MEANT to cross the edge, and both sit inside this section's own overflow-hidden. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-12 h-48 w-48 rounded-full bg-orange-500/10 blur-2xl"
      />
      <div className="relative flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-phx-xs font-black uppercase tracking-[0.25em] text-orange-400">Field performance</p>
          <h1 className="mt-1 text-2xl font-black leading-tight text-white sm:text-[1.9rem]">KPIs</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{verdict.headline}</p>
          <p className="mt-2 text-phx-2xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
          </p>
        </div>
        <div className="min-w-0">
          <div className={`border px-3 py-2 ${tone.chip}`}>
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em]">Team standing</p>
            <p className="mt-0.5 text-sm font-black">{verdict.standing ?? KPI_BAND_LABEL[verdict.tone]}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The number each tab puts under its own label, so the strip is a summary in its own right. */
function tabHeadline(board: KpisBoard, tab: KpiTab): string {
  const { totals } = board;
  if (tab === "summary") return `${totals.reps} rep${totals.reps === 1 ? "" : "s"}`;
  if (tab === "call-rate") return `${rate(totals.amRate)} / ${rate(totals.pmRate)}`;
  if (tab === "coverage") return `${totals.coveragePct}%`;
  return `${totals.frequencyPct}%`;
}

function KpiTabStrip({ context }: { context: ViewContext }) {
  const { board, tab: active } = context;
  return (
    <div className="flex flex-wrap gap-0 border border-b-0 border-slate-200 bg-white">
      {KPI_TABS.map((tab) => {
        const current = tab === active;
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "min-w-0 flex-1 border-b-2 border-orange-500 bg-orange-50/60 px-3 py-2.5 sm:px-5"
                : "min-w-0 flex-1 border-b-2 border-transparent px-3 py-2.5 transition-colors hover:bg-slate-50 sm:px-5"
            }
            href={hrefWith(context, { tab })}
            key={tab}
          >
            <span
              className={
                current
                  ? "block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900"
                  : "block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400"
              }
            >
              {KPI_TAB_LABEL[tab]}
            </span>
            <span
              className={
                current
                  ? "mt-0.5 block text-sm font-black tabular-nums text-orange-700"
                  : "mt-0.5 block text-sm font-black tabular-nums text-slate-400"
              }
            >
              {tabHeadline(board, tab)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

// ── Active filter chips ───────────────────────────────────────────────────────────────────────

/**
 * Every live filter as a removable chip.
 *
 * These are LINKS, so removing one is a plain navigation that re-runs the server-side scope gate —
 * the same route every other control on this board takes. Their real job is to make an active
 * filter impossible to forget: the panel can be collapsed, and a narrowed board that looks like a
 * whole board is how a manager ends up reporting six reps' numbers as a district's.
 */
function ActiveFilterChips({ context }: { context: ViewContext }) {
  const { filters } = context.board;
  if (!hasActiveKpiFilters(filters)) return null;

  const chips: Array<{ key: string; label: string; next: KpiFilterState }> = [];

  const facetChips = (key: "lines" | "regions" | "areas" | "managers" | "titles", prefix: string) => {
    for (const value of filters[key]) {
      chips.push({
        key: `${key}:${value}`,
        label: `${prefix}: ${value === UNASSIGNED_FACET_KEY ? UNASSIGNED_FACET_LABEL : value}`,
        next: { ...filters, [key]: filters[key].filter((entry) => entry !== value) } as KpiFilterState,
      });
    }
  };
  facetChips("lines", "Line");
  facetChips("regions", "Region");
  facetChips("areas", "Area");
  facetChips("managers", "Manager");
  facetChips("titles", "Title");

  for (const key of ["coverage", "frequency", "callRate"] as const) {
    const prefix = key === "callRate" ? "Call rate" : key === "coverage" ? "Coverage" : "Frequency";
    for (const band of filters[key]) {
      chips.push({
        key: `${key}:${band}`,
        label: `${prefix}: ${KPI_BAND_LABEL[band]}`,
        next: { ...filters, [key]: filters[key].filter((entry) => entry !== band) } as KpiFilterState,
      });
    }
  }
  for (const flag of filters.flags) {
    chips.push({
      key: `flag:${flag}`,
      label: KPI_FLAG_LABEL[flag],
      next: { ...filters, flags: filters.flags.filter((entry) => entry !== flag) },
    });
  }
  if (filters.query.trim()) {
    chips.push({ key: "query", label: `Search: ${filters.query.trim()}`, next: { ...filters, query: "" } });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50 px-4 py-2.5 sm:px-5">
      {chips.map((chip) => (
        <Link
          className="inline-flex items-center gap-1.5 border border-orange-300 bg-white px-2 py-1 text-phx-2xs font-bold text-orange-900 transition-colors hover:border-rose-400 hover:text-rose-800"
          href={hrefWith(context, { filters: chip.next })}
          key={chip.key}
        >
          <span dir="auto">{chip.label}</span>
          <span aria-hidden>×</span>
          <span className="sr-only">Remove this filter</span>
        </Link>
      ))}
      <Link
        className="border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold text-slate-600 transition-colors hover:border-slate-500"
        href={hrefWith(context, { filters: { ...EMPTY_KPI_FILTERS, sort: filters.sort, direction: filters.direction } })}
      >
        Clear all
      </Link>
    </div>
  );
}

// ── Shared cells ──────────────────────────────────────────────────────────────────────────────

/**
 * The percentage, its meter and one line of arithmetic under it.
 *
 * `fill` is passed separately rather than parsed back out of the printed string. Reading it back
 * would make the bar depend on the text formatting — "No plan" parses to NaN, and a NaN width is
 * a silently full bar in some engines and an empty one in others.
 */
function MeasureCell({
  band,
  caption,
  fill,
  value,
}: {
  band: KpiBand;
  caption: string;
  fill: number | null;
  value: string;
}) {
  return (
    <td className={NUM}>
      <span className={`block text-base font-black ${toneOf(band).text}`}>{value}</span>
      <KpiMeter band={band} value={fill} />
      <span className="mt-1 block text-phx-3xs font-semibold leading-4 text-slate-500">{caption}</span>
    </td>
  );
}

/**
 * The rep cell — name, where they sit, and any situation flags.
 *
 * Flags are MERGED in here rather than given a column of their own, which is the golden rule's own
 * answer to a width collision: merge, never shrink. Two flags are left out because every table
 * already prints their underlying number in its own column — `below-target` beside the attainment
 * figure and `over-visiting` beside the Above count would be the same fact said twice.
 */
function RepCell({ rank, row }: { rank?: number; row: KpiRepRow }) {
  const flags = kpiFlagsOf(row).filter((flag) => flag !== "below-target" && flag !== "over-visiting");
  return (
    <td className={TD}>
      <KpiRepName
        areaName={row.areaName}
        jobTitle={row.jobTitle}
        lineName={row.lineName}
        name={row.repName}
        rank={rank}
      />
      {flags.length > 0 ? (
        <span className="mt-1 flex flex-wrap gap-1">
          {flags.map((flag) => (
            <span
              className="inline-block border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-semibold leading-4 text-slate-600"
              key={flag}
            >
              {KPI_FLAG_LABEL[flag]}
            </span>
          ))}
        </span>
      ) : null}
    </td>
  );
}

function coverageFill(row: KpiRepRow): number | null {
  return row.hasMeasurablePlan ? row.coveragePct : null;
}

function frequencyFill(row: KpiRepRow): number | null {
  return row.hasMeasurablePlan ? row.frequencyPct : null;
}

function callRateFill(row: KpiRepRow): number | null {
  return row.hasCallRate ? row.callRateAttainmentPct : null;
}

function RepNameTh({ context }: { context: ViewContext }) {
  const { filters } = context.board;
  return (
    <KpiSortableTh
      active={filters.sort === "rep"}
      direction={filters.direction}
      href={sortHref(context, "rep")}
      label="Medical rep"
      sub="Line · area"
    />
  );
}

// ── The four tables ───────────────────────────────────────────────────────────────────────────

function SummaryTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { filters } = context.board;
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "34%" }} />
        <col style={{ width: "22%" }} />
        <col style={{ width: "22%" }} />
        <col style={{ width: "22%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <RepNameTh context={context} />
          <KpiSortableTh
            active={filters.sort === "coverage"}
            direction={filters.direction}
            href={sortHref(context, "coverage")}
            label="Coverage"
            sub="Reached at all"
          />
          <KpiSortableTh
            active={filters.sort === "frequency"}
            direction={filters.direction}
            href={sortHref(context, "frequency")}
            label="Frequency"
            sub="Exact only"
          />
          <KpiSortableTh
            active={filters.sort === "callrate"}
            direction={filters.direction}
            href={sortHref(context, "callrate")}
            label="Call rate"
            sub="Against target"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} />
            <MeasureCell
              band={coverageBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? `${row.visitedDoctors} of ${row.coverageDueDoctors} due so far`
                  : "Nothing planned"
              }
              fill={coverageFill(row)}
              value={planPct(row, row.coveragePct)}
            />
            <MeasureCell
              band={frequencyBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? `${row.onPlanDoctors} exact · ${row.underDoctors} below · ${row.overDoctors} above`
                  : "Nothing planned"
              }
              fill={frequencyFill(row)}
              value={planPct(row, row.frequencyPct)}
            />
            <MeasureCell
              band={callRateBandOf(row)}
              caption={row.hasCallRate ? `${rate(row.amRate)} AM · ${rate(row.pmRate)} PM` : "No calls logged"}
              fill={callRateFill(row)}
              value={ratePct(row)}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CallRateTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { board } = context;
  const { filters } = board;
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "26%" }} />
        <col style={{ width: "10%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "12%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <RepNameTh context={context} />
          <KpiSortableTh
            active={filters.sort === "workingdays"}
            direction={filters.direction}
            href={sortHref(context, "workingdays")}
            label="Days"
            sub="Sat–Wed"
          />
          <KpiSortableTh
            active={filters.sort === "am"}
            direction={filters.direction}
            href={sortHref(context, "am")}
            label="AM"
            sub={`Target ${board.amTarget}`}
          />
          <KpiSortableTh
            active={filters.sort === "pm"}
            direction={filters.direction}
            href={sortHref(context, "pm")}
            label="PM"
            sub={`Target ${board.pmTarget}`}
          />
          <KpiSortableTh
            active={filters.sort === "callrate"}
            direction={filters.direction}
            href={sortHref(context, "callrate")}
            label="Attainment"
            sub="AM + PM vs target"
          />
          {/* Merged rather than given two columns — the golden rule resolves a width collision by
              merging, never by shrinking type. */}
          <KpiSortableTh
            active={filters.sort === "campaign"}
            direction={filters.direction}
            href={sortHref(context, "campaign")}
            label="Campaign"
            sub="Unverifiable"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} />
            <td className={NUM}>{row.workingDays}</td>
            <td className={NUM}>
              {rate(row.amRate)}
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.amVerified} verified
              </span>
            </td>
            <td className={NUM}>
              {rate(row.pmRate)}
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.pmVerified} verified
              </span>
            </td>
            <MeasureCell
              band={callRateBandOf(row)}
              caption={`${row.amVerified + row.pmVerified} of ${
                row.workingDays * (board.amTarget + board.pmTarget)
              } asked for`}
              fill={callRateFill(row)}
              value={ratePct(row)}
            />
            <td className={NUM}>
              {Math.round(row.campaignShare * 100)}%
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.campaignCalls} calls
                {row.campaignOnlyDays > 0 ? ` · ${row.campaignOnlyDays} day(s) campaign only` : ""}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CoverageTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { filters } = context.board;
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "26%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "26%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <RepNameTh context={context} />
          <KpiSortableTh
            active={filters.sort === "planned"}
            direction={filters.direction}
            href={sortHref(context, "planned")}
            label="Planned"
            sub="Whole month"
          />
          <KpiSortableTh
            active={filters.sort === "visited"}
            direction={filters.direction}
            href={sortHref(context, "visited")}
            label="Covered"
            sub="Seen once+"
          />
          <KpiSortableTh
            active={filters.sort === "missed"}
            direction={filters.direction}
            href={sortHref(context, "missed")}
            label="Not reached"
            sub="Of those due"
          />
          {/* Not sortable: off-plan doctors are a note about where the day went, not a measure the
              board ranks anybody on. A sort control on it would imply otherwise. */}
          <th className={TH} scope="col">
            Off plan
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Not on the list
            </span>
          </th>
          <KpiSortableTh
            active={filters.sort === "coverage"}
            direction={filters.direction}
            href={sortHref(context, "coverage")}
            label="Coverage"
            sub="Covered ÷ due"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} />
            <td className={NUM}>{row.plannedDoctors}</td>
            <td className={NUM}>{row.visitedDoctors}</td>
            <td className={NUM}>{row.coverageDueDoctors - row.visitedDoctors}</td>
            <td className={NUM}>{row.offPlanDoctors}</td>
            <MeasureCell
              band={coverageBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? `${row.visitedDoctors} of ${row.coverageDueDoctors} due so far`
                  : "No planned doctors to be a percentage of"
              }
              fill={coverageFill(row)}
              value={planPct(row, row.coveragePct)}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FrequencyTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { filters } = context.board;
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "26%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "26%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <RepNameTh context={context} />
          {/* THE OWNER'S THREE WORDS, read from ACTIVITY_LABEL rather than repeated here.
              "change vocab to below exact above", given verbatim on 2026-09-02. The Reps List chip
              and these column heads render the SAME computed status, and until now each file spelled
              the words itself — two boards internally consistent and free to drift apart, which is
              precisely what tests/crm-rep-doctor-lists.test.ts was written to catch. Reading one map
              makes the drift impossible instead of merely detected. `Exact` is the only pass: both
              Below and Above are deviations, so do not "improve" these into On plan / Over plan. */}
          <KpiSortableTh
            active={filters.sort === "exact"}
            direction={filters.direction}
            href={sortHref(context, "exact")}
            label={ACTIVITY_LABEL.on_plan}
            sub="The only pass"
          />
          <KpiSortableTh
            active={filters.sort === "below"}
            direction={filters.direction}
            href={sortHref(context, "below")}
            label={ACTIVITY_LABEL.under}
            sub="Short of plan"
          />
          <KpiSortableTh
            active={filters.sort === "above"}
            direction={filters.direction}
            href={sortHref(context, "above")}
            label={ACTIVITY_LABEL.over}
            sub="Also a deviation"
          />
          <KpiSortableTh
            active={filters.sort === "notdue"}
            direction={filters.direction}
            href={sortHref(context, "notdue")}
            label="Not due"
            sub="Held out"
          />
          <KpiSortableTh
            active={filters.sort === "frequency"}
            direction={filters.direction}
            href={sortHref(context, "frequency")}
            label="Frequency"
            sub="Exact ÷ due"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} />
            <td className={NUM}>{row.onPlanDoctors}</td>
            <td className={NUM}>{row.underDoctors}</td>
            <td className={NUM}>{row.overDoctors}</td>
            <td className={NUM}>{row.notDueDoctors}</td>
            <MeasureCell
              band={frequencyBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? `${row.actualCalls} of ${row.plannedCallsToDate} planned calls made`
                  : "No planned doctors to be a percentage of"
              }
              fill={frequencyFill(row)}
              value={planPct(row, row.frequencyPct)}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── The mobile card ───────────────────────────────────────────────────────────────────────────

/**
 * Every tab shows the same card on a phone. A phone has no room for four different card layouts,
 * and a manager on a phone wants the whole picture of one rep anyway — which is also why the card
 * carries all three meters rather than only the current tab's.
 */
function RepCard({ rank, row }: { rank?: number; row: KpiRepRow }) {
  const measures: Array<{ band: KpiBand; caption: string; fill: number | null; label: string; value: string }> = [
    {
      band: coverageBandOf(row),
      caption: row.hasMeasurablePlan
        ? `${row.visitedDoctors}/${row.coverageDueDoctors} due so far`
        : "Nothing planned",
      fill: coverageFill(row),
      label: "Coverage",
      value: planPct(row, row.coveragePct),
    },
    {
      band: frequencyBandOf(row),
      caption: row.hasMeasurablePlan ? `${row.onPlanDoctors} exact` : "Nothing planned",
      fill: frequencyFill(row),
      label: "Frequency",
      value: planPct(row, row.frequencyPct),
    },
    {
      band: callRateBandOf(row),
      caption: row.hasCallRate ? `${rate(row.amRate)} AM · ${rate(row.pmRate)} PM` : "No calls",
      fill: callRateFill(row),
      label: "Call rate",
      value: ratePct(row),
    },
  ];
  const flags = kpiFlagsOf(row).filter((flag) => flag !== "below-target" && flag !== "over-visiting");

  return (
    <div className="px-4 py-3">
      <KpiRepName
        areaName={row.areaName}
        jobTitle={row.jobTitle}
        lineName={row.lineName}
        name={row.repName}
        rank={rank}
      />
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        {measures.map((measure) => (
          <div className="min-w-0" key={measure.label}>
            <dt className="text-phx-3xs font-black uppercase tracking-[0.1em] text-slate-400">{measure.label}</dt>
            <dd className={`mt-0.5 text-sm font-black tabular-nums ${toneOf(measure.band).text}`}>{measure.value}</dd>
            <KpiMeter band={measure.band} value={measure.fill} />
            <dd className="mt-1 text-phx-3xs leading-4 text-slate-500">{measure.caption}</dd>
          </div>
        ))}
      </dl>
      {flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {flags.map((flag) => (
            <span
              className="inline-block border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-semibold leading-4 text-slate-600"
              key={flag}
            >
              {KPI_FLAG_LABEL[flag]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── The board ─────────────────────────────────────────────────────────────────────────────────

export function KpisBoardView({
  basePath,
  board,
  monthOptions,
  periodOptions,
  tab,
}: {
  basePath: string;
  board: KpisBoard;
  monthOptions: readonly KpiPickerOption[];
  periodOptions: readonly KpiPickerOption[];
  tab: KpiTab;
}) {
  if (board.scopeReason) {
    return (
      <div className={PANEL}>
        <div className="px-5 py-6">
          <p className="text-sm font-semibold text-slate-700">{board.scopeReason}</p>
          <p className={`mt-1 ${CAPTION}`}>
            KPIs are scoped to the reps you manage. If you believe this is wrong, ask your administrator to check
            your seat in the organogram.
          </p>
        </div>
      </div>
    );
  }

  const { filters, podium, totals } = board;
  const context: ViewContext = {
    basePath,
    board,
    tab,
    // A rank disc beside a name means nothing when the list is alphabetical, so it only appears
    // once a MEASURE is what the order is expressing.
    showRank:
      filters.sort !== "rep" && filters.sort !== "line" && filters.sort !== "area" && filters.sort !== "manager",
  };

  // Lowercased for "Whole month" ONLY, which is a common noun sitting mid-sentence. A week's label is
  // "Week 1 · 1–7 Sep" — a proper name carrying a month abbreviation — so lowercasing it printed
  // "week 1 · 1–7 sep", which reads as a typo now that a real date sits beside it in the footnote.
  const periodPhrase = board.range.isWholeMonth ? board.range.periodLabel.toLowerCase() : board.range.periodLabel;
  const filtered = hasActiveKpiFilters(filters);
  // The window is still running, so coverage and frequency are a position rather than a finished
  // score. A tile is read on its own, away from the hero, so the caveat has to travel with it.
  const partial = board.workingDays > 0 && board.workingDays < board.workingDaysInWindow;

  return (
    <div className="space-y-4">
      <KpiHero board={board} />

      <div>
        <KpiTabStrip context={context} />
        <div className={PANEL}>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">{KPI_TAB_LABEL[tab]}</p>
              <p className={`mt-0.5 leading-4 ${CAPTION}`}>{KPI_TAB_HINT[tab]}</p>
            </div>
            <p className={CAPTION}>
              {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
            </p>
          </div>

          <div className="border-t border-slate-100 px-4 py-4 sm:px-5">
            <KpisPeriodPicker
              basePath={basePath}
              filters={filters}
              month={board.month}
              monthOptions={monthOptions}
              period={board.range.periodKey}
              periodOptions={periodOptions}
              tab={tab}
            />
          </div>

          <KpisFilterBar
            basePath={basePath}
            facets={board.facets}
            filters={filters}
            month={board.month}
            period={board.range.periodKey}
            tab={tab}
            total={board.scopedReps}
            visible={board.reps.length}
          />
          <ActiveFilterChips context={context} />

          {/* THE HOLIDAY CAVEAT. When a holiday calendar could not be read the denominator may be too
              big, which makes every call rate on this board read LOW. Saying so is not decoration:
              an unexplained dip reads as the field force under-calling. */}
          {board.holidaysComplete ? null : (
            <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 sm:px-5">
              <p className="text-phx-xs font-bold text-amber-900">
                The national holiday calendar could not be read for this period.
              </p>
              <p className="mt-0.5 text-phx-2xs leading-4 text-amber-800">
                Any public holiday it did not return is still counted as a working day, so the call rates below may be
                lower than the real figure. Coverage and frequency are unaffected.
              </p>
            </div>
          )}

          {board.range.notStarted ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`${CAPTION} font-semibold`}>
                This period has not started yet, so every call rate is blank rather than zero.
              </p>
            </div>
          ) : null}

          <div className="grid gap-3 border-t border-slate-100 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
            <KpiTile
              caption={
                // "2 working days" alone reads as a footnote; "2 of 22" is the fact that makes the
                // two percentages below it legible. Same numbers, and the holiday note is kept.
                board.holidayDays > 0
                  ? `${board.workingDays} of ${board.workingDaysInWindow} working days · ${board.holidayDays} national holiday(s) removed`
                  : `${board.workingDays} of ${board.workingDaysInWindow} working days · Sat–Wed`
              }
              label={filtered ? "Medical reps shown" : "Medical reps in reach"}
              value={filtered ? `${totals.reps} of ${board.scopedReps}` : String(totals.reps)}
            />
            <KpiTile
              band={kpiBandOf(totals.callRateAttainmentPct)}
              caption={`Team average · targets ${board.amTarget} / ${board.pmTarget}`}
              label="Call rate AM / PM"
              progress={totals.callRateAttainmentPct}
              value={`${rate(totals.amRate)} / ${rate(totals.pmRate)}`}
            />
            <KpiTile
              band={kpiBandOf(totals.coveragePct)}
              caption={
                partial
                  ? `${totals.visitedDoctors} of ${totals.coverageDueDoctors} due so far · ${totals.plannedDoctors} planned all month`
                  : `${totals.visitedDoctors} of ${totals.plannedDoctors} planned doctors`
              }
              label="Coverage"
              progress={totals.coveragePct}
              value={`${totals.coveragePct}%`}
            />
            <KpiTile
              band={kpiBandOf(totals.frequencyPct)}
              caption={`${totals.onPlanDoctors} exact · ${totals.underDoctors} below · ${totals.overDoctors} above${partial ? " · so far" : ""}`}
              label="Frequency"
              progress={totals.frequencyPct}
              value={`${totals.frequencyPct}%`}
            />
          </div>

          {board.reps.length === 0 ? (
            <div className="border-t border-slate-100">
              {filtered ? (
                <KpiEmptyState
                  action={
                    <Link
                      className="inline-block border border-slate-900 bg-slate-900 px-4 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-white"
                      href={hrefWith(context, { filters: EMPTY_KPI_FILTERS })}
                    >
                      Clear the filters
                    </Link>
                  }
                  message={`No rep in your reach matches every filter you have applied. Your scope holds ${board.scopedReps} rep(s) in this period.`}
                  title="No reps match these filters."
                />
              ) : (
                <KpiEmptyState
                  message={`Nobody in your reach logged a visit or carried a plan in ${board.range.periodLabel.toLowerCase()}.`}
                  title="No reps in this period."
                />
              )}
            </div>
          ) : (
            <>
              {/* THE LEADERBOARDS. Three, never one — a single "best rep" would need a blended
                  score, and this board adds no fourth measure. They rank the FILTERED rows, so
                  filtering to one line answers "best in that line". */}
              <div className="border-t border-slate-100">
                <KpiSection
                  description="Best three on each measure, from the reps currently in view. Three separate answers — often three different people."
                  title="Standing out"
                >
                  <div className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-3">
                    {tab === "summary" || tab === "coverage" ? (
                      <KpiPodiumCard entries={podium.coverage} hint="Most of the planned list reached" title="Coverage" />
                    ) : null}
                    {tab === "summary" || tab === "frequency" ? (
                      <KpiPodiumCard
                        entries={podium.frequency}
                        hint="Most doctors seen exactly as planned"
                        title="Frequency"
                      />
                    ) : null}
                    {tab === "summary" || tab === "call-rate" ? (
                      <KpiPodiumCard
                        entries={podium.callRate}
                        hint="Most verified calls against target"
                        title="Call rate"
                      />
                    ) : null}
                  </div>
                </KpiSection>
              </div>

              <div className="border-t border-slate-100">
                <div className="divide-y divide-slate-100 md:hidden">
                  {board.reps.map((row, index) => (
                    <div key={String(row.agentCrmId ?? `${row.repName}-${index}`)}>
                      <RepCard rank={context.showRank ? index + 1 : undefined} row={row} />
                    </div>
                  ))}
                </div>
                <div className="hidden md:block">
                  {tab === "summary" ? <SummaryTable context={context} rows={board.reps} /> : null}
                  {tab === "call-rate" ? <CallRateTable context={context} rows={board.reps} /> : null}
                  {tab === "coverage" ? <CoverageTable context={context} rows={board.reps} /> : null}
                  {tab === "frequency" ? <FrequencyTable context={context} rows={board.reps} /> : null}
                </div>
              </div>
            </>
          )}

          <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
            {/* The call-rate window's own end is PRINTED, never implied. Both halves of this board stop at
              * today in a running month — repsPlansRange caps it with `dateTo = running ? todayIso : windowEnd`
              * and coverage caps its own `asOf` at the same day — so the earlier wording ("scored for
              * September 2026 to 2026-09-02. Call rate is scored over whole month.") read as though the rate
              * had spanned September's ~21 working days when it had in fact divided by 2. The two dates are
              * equal for a whole month and differ only for a week, which is exactly what the reader needs to
              * see. A `notStarted` window is the one case where dateTo sits BEFORE dateFrom, deliberately, so
              * printing it would say "week 3 · 15–21 sep to 2026-09-14" — say it has not started instead. */}
            <p className={`leading-4 ${CAPTION}`}>
              Coverage and frequency are scored for {board.monthLabel} to {board.asOf}.{" "}
              {board.range.notStarted
                ? `Call rate is not scored — ${periodPhrase} has not started.`
                : `Call rate is scored over ${periodPhrase} to ${board.range.dateTo}.`}{" "}
              Exact is the only frequency pass — visiting a doctor more often than the plan asked for is a deviation,
              not a win. The bands below are these same three measures cut into ranges; nothing on this board blends
              them into a single score.
            </p>
            <p className={`mt-1.5 flex flex-wrap items-center gap-1.5 leading-4 ${CAPTION}`}>
              <span>Bands:</span>
              <KpiBandChip band="elite" />
              <span>90% and above</span>
              <KpiBandChip band="strong" />
              <span>75–89%</span>
              <KpiBandChip band="steady" />
              <span>50–74%</span>
              <KpiBandChip band="behind" />
              <span>under 50%</span>
              <KpiBandChip band="noplan" />
              <span>nothing to measure</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
