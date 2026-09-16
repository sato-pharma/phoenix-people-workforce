import Link from "next/link";
import { Fragment } from "react";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

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
import {
  AmPmKpiReportTables,
  OffListNote,
  PharmacyKpiReportTables,
} from "@/components/crm/kpi-reports-tables";
import { KPI_TABS, KPI_TAB_HINT, KPI_TAB_HINT_PHOENIX, KPI_TAB_LABEL, type KpiTab } from "@/lib/crm/kpis-tabs";
import {
  buildKpisQuery,
  amBandOf,
  coverageBandOf,
  EMPTY_KPI_FILTERS,
  frequencyBandOf,
  pmBandOf,
  hasActiveKpiFilters,
  kpiBandOf,
  kpiFlagsOf,
  KPI_BAND_LABEL,
  kpiFlagLabel,
  nextKpiSort,
  UNASSIGNED_FACET_KEY,
  UNASSIGNED_FACET_LABEL,
  type KpiBand,
  type KpiFilterState,
  type KpiSortField,
  isTooEarlyToScore,
} from "@/lib/crm/kpis-filters";
import { ACTIVITY_LABEL } from "@/lib/crm/reps-list-activity";
import type { KpiCoverageDetail, KpiCoverageDoctor, KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";

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

/**
 * AM attainment and PM attainment, each against its own target — or a marker when the rep logged
 * nothing at all in the window.
 *
 * Two functions rather than one taking a slice, so that no call site can accidentally be handed a
 * blended figure. The owner's rule of 2026-09-04 is that these two numbers never meet: "this two
 * and this ten. Don't never get average."
 */
function amPct(row: KpiRepRow): string {
  return row.hasCallRate && row.amAttainmentPct != null ? `${row.amAttainmentPct}%` : "No calls";
}

function pmPct(row: KpiRepRow): string {
  return row.hasCallRate && row.pmAttainmentPct != null ? `${row.pmAttainmentPct}%` : "No calls";
}

/**
 * The pharmacy call rate, separate from AM/PM entirely (owner, 2026-09-05) — never a percentage,
 * because no target exists yet to be a percentage of (see PHARMACY_CALL_RATE_TARGET). Shows the
 * raw rate instead, which stays honest whether or not the owner ever sets one. Zero is a NORMAL
 * reading for a rep who logged field work — 43 of 76 in a typical month — never "No calls" the way
 * an absent AM/PM figure would be; that string is reserved for a rep with no call rate at all.
 */
function pharmacyValue(row: KpiRepRow): string {
  return row.hasCallRate ? rate(row.pharmacyRate) : "No calls";
}

/** True once the CRM cutover makes the Phoenix KPI rules score this board (phase 6). */
function isPhoenix(board: KpisBoard): boolean {
  return board.kpiRules === "phoenix";
}

/** Rule 3's daily follow-up for one session — tracked, never a pass or a fail. Empty under the old rules. */
function followUpText(row: KpiRepRow, session: "am" | "pm"): string {
  const followUp = row.phoenix?.followUp?.[session];
  if (!followUp) return "";
  if (followUp.reached) return " · month target reached";
  return followUp.neededPerDay == null ? "" : ` · needs ${followUp.neededPerDay.toFixed(2)} a day`;
}

type ViewContext = {
  basePath: string;
  board: KpisBoard;
  tab: KpiTab;
  /** True when the current sort is a measure, so a rank disc actually means something. */
  showRank: boolean;
  /**
   * The rep whose doctors the Coverage tab has open, carried on every link so a sort or a removed
   * filter does not close the list. Null when none is open — and on a board of ONE rep, whose list
   * opens by itself and so never needs to ride in the URL.
   */
  openRep: string | null;
};

/**
 * Every link on this board goes through here.
 *
 * Two URL builders would be two answers the first time either changed, and the symptom is nasty and
 * specific: a sort link that quietly dropped the area filter would put a WIDER set of reps on
 * screen than the manager asked for, under a heading still saying the filter is on.
 */
function hrefWith(
  context: ViewContext,
  overrides: { tab?: KpiTab; filters?: KpiFilterState; rep?: string | null },
): string {
  const { basePath, board } = context;
  return `${basePath}?${buildKpisQuery({
    month: board.month,
    period: board.range.periodKey,
    tab: overrides.tab ?? context.tab,
    filters: overrides.filters ?? board.filters,
    rep: overrides.rep !== undefined ? overrides.rep : context.openRep,
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
  // Both call-rate bands, and BOTH must be elite. A morning that hit 2 does not buy an afternoon
  // that missed 10 — which is precisely the sentence the blended score used to write for us.
  const am = kpiBandOf(totals.amAttainmentPct);
  const pm = kpiBandOf(totals.pmAttainmentPct);

  if (coverage === "elite" && frequency === "elite" && am === "elite" && pm === "elite") {
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
  if (am === "behind" || pm === "behind") {
    // NAMED, never merged. A morning that misses 2 and an afternoon that misses 10 are different
    // failures with different conversations behind them, so the sentence says which one it is.
    const half =
      am === "behind" && pm === "behind"
        ? "neither half of the day is producing"
        : am === "behind"
          ? "the morning is not producing"
          : "the afternoon is not producing";
    return {
      headline: `Coverage is holding, but ${half} the calls it should.`,
      tone: "behind",
    };
  }
  if (coverage === "elite" || frequency === "elite" || am === "elite" || pm === "elite") {
    return { headline: "One measure is running well ahead of the others. Worth knowing which.", tone: "strong" };
  }
  return { headline: "Every measure is mid-table. No emergency, no victory.", tone: "steady" };
}

// ── Hero and tabs ─────────────────────────────────────────────────────────────────────────────

/**
 * The page header.
 *
 * NO DARK BAND. Flattened 2026-09-03 at the owner's instruction — "remove from all pages this
 * dump block" — in step with `PremiumHero`, `AdminPageHero` and the command centres the same
 * day. It was a hand-spelled copy of `PremiumHero`'s slate-900 band (that copy exists because of
 * the tone-coloured standing pill, which the shared component has no prop for), so it had to be
 * flattened here too or this one page would have kept the band every other page just lost.
 *
 * The standing pill keeps its own tone colours: `tone.chip` was always a light-surface class set
 * — it sat on a dark band and looked out of place there, and reads correctly here.
 */
function KpiHero({ board, showTitle }: { board: KpisBoard; showTitle: boolean }) {
  const verdict = teamVerdict(board);
  const tone = toneOf(verdict.tone);
  return (
    // POLISHED 2026-09-03 (second pass): this page spells its own header out rather than calling
    // `AdminPageHero`, so it did not inherit the accent rail and fading rule when those landed.
    // It pulls the same four tokens now, so a hand-rolled header and a component one are the same
    // object on screen. Zero height added - the rail lives in the text block's own left padding
    // and the rule takes the 1px the border-b took.
    <section className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4 sm:gap-6">
        {/* THE TITLE IS THE SHELL'S IN THE PORTAL, NOT THIS BLOCK'S. Inside the employee portal the
            page already carries the navy command header every sibling in the Field Activity group
            carries — CRM badge, "KPIs", the module sentence — so drawing the rail, kicker and h1
            here as well printed the word KPIs twice on one screen under two different type scales.
            The VERDICT stays in both shells: it changes with the month and the period, so it
            belongs beside the numbers rather than in a shell header that is written once. */}
        <div className={`relative min-w-0 flex-1 space-y-1.5 ${showTitle ? "pl-3.5" : ""}`}>
          {showTitle ? (
            <>
              <span aria-hidden="true" className={pageHeaderRailClassName} />
              <p className={pageHeaderKickerClassName}>Field performance</p>
              <h1 className={pageHeaderTitleClassName}>KPIs</h1>
            </>
          ) : null}
          <p className={pageHeaderDescriptionClassName}>{verdict.headline}</p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
          </p>
        </div>
        <div className="min-w-0">
          <div className={`border px-3 py-2 ${tone.chip}`}>
            <p className="text-[10px] font-black uppercase tracking-[0.14em]">Team standing</p>
            <p className="mt-0.5 text-[13px] font-black">{verdict.standing ?? KPI_BAND_LABEL[verdict.tone]}</p>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

/** The number each tab puts under its own label, so the strip is a summary in its own right. */
function tabHeadline(board: KpisBoard, tab: KpiTab): string {
  const { totals } = board;
  if (tab === "summary") return `${totals.reps} rep${totals.reps === 1 ? "" : "s"}`;
  // NOT "1.63 / 6.57" — a slash between two rates reads as a fraction, and the owner read it as
  // one on 2026-09-04 ("you are putting the call rate out of six. No never."). They are two
  // separate rates against two separate targets, so they are labelled, never divided.
  if (tab === "call-rate") return `${rate(totals.amRate)} AM · ${rate(totals.pmRate)} PM`;
  if (tab === "coverage") return `${totals.coveragePct}%`;
  // THE TWO REPORTS' HEADLINES read against the rep's LIST, not his plan — a different denominator
  // from the four tabs above, which is why they are computed here rather than taken from `totals`.
  // The AM and PM figures are LABELLED and never divided, for the same reason the call-rate
  // headline is: a slash between two independent measures reads as a fraction.
  if (tab === "am-pm") {
    return `${listCoverage(board, "am")} AM · ${listCoverage(board, "pm")} PM`;
  }
  if (tab === "pharmacies") {
    const withList = board.kpiReports.filter((report) => report.pharmacies.applicable).length;
    // "Not applicable" for the whole tab is a real answer when nobody in view carries pharmacies —
    // a 0% would read as "these reps covered no pharmacies", which is the opposite of the truth.
    return withList === 0 ? "Not applicable" : `${listCoverage(board, "pharmacy")} · ${withList} with a list`;
  }
  return `${totals.frequencyPct}%`;
}

/**
 * One list's coverage across every rep in view: contacts seen at least once, over contacts on the
 * list. Summed over reps rather than averaged over their percentages — a rep with 4 pharmacies
 * would otherwise weigh as much as one with 90.
 */
function listCoverage(board: KpisBoard, list: "am" | "pm" | "pharmacy"): string {
  let panel = 0;
  let visited = 0;
  for (const report of board.kpiReports) {
    const block =
      list === "am" ? report.ampm.am : list === "pm" ? report.ampm.pm : report.pharmacies.pharmacies;
    panel += block.coverage.panel;
    visited += block.coverage.visited;
  }
  return panel === 0 ? "—" : `${Math.round((visited / panel) * 100)}%`;
}

/**
 * The four tabs: TWO BY TWO on a phone, four across from `sm` up.
 *
 * Four tabs on one 375px row gave each 87px, and `px-3` leaves 63px of that for the word. FREQUENCY
 * needs 78. The overflow is INVISIBLE to the usual guard — the owner's fits-the-screen rule is
 * measured as `scrollWidth > clientWidth` on `main`, and clipped text contributes nothing to
 * `scrollWidth`, so the page measured a clean 375/375 while the label ran out of its own box. What
 * did fit wrapped instead: CALL RATE broke across two lines and its "1.63 / 6.57" across two more,
 * making a 97px-tall ragged strip. The owner saw it before any measurement did (2026-09-04: "look
 * how it is written and look at the frequency — never happen this").
 *
 * So the grid, not narrower type. The rule says fit by re-laying-out and never by shrinking text,
 * and wrapping is the permitted answer — here the wrapping IS the defect, and two columns give each
 * tab ~175px, enough for the longest label and the longest value on one line each.
 *
 * DESKTOP IS UNCHANGED ON PURPOSE. `grid-cols-4` renders the same equal widths the old
 * `flex-1` items did, so the board this strip sits on keeps its identity and only the phone layout
 * moves. Both the admin board and the employee portal's render this one component, so both surfaces
 * are fixed by it — verify on both, they are separate shells.
 *
 * ONE MEASUREMENT NOTE for whoever changes this next: a rect read from a hidden Browser pane is
 * ZERO, not stale. Take a screenshot first to force the paint, then read.
 */
function KpiTabStrip({ context }: { context: ViewContext }) {
  const { board, tab: active } = context;
  return (
    <div className="grid grid-cols-2 border border-b-0 border-slate-200 bg-white sm:grid-cols-4">
      {KPI_TABS.map((tab, index) => {
        const current = tab === active;
        // The hairline between the two phone rows. It is a border rather than a gap so the strip
        // stays one block, and it goes at `sm` because from there the four sit on a single row.
        const rowTwo = index >= 2 ? " border-t border-t-slate-200 sm:border-t-0" : "";
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={
              current
                ? `min-w-0 border-b-2 border-b-orange-500 bg-orange-50/60 px-3 py-2.5 sm:px-5${rowTwo}`
                : `min-w-0 border-b-2 border-b-transparent px-3 py-2.5 transition-colors hover:bg-slate-50 sm:px-5${rowTwo}`
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

  const BAND_CHIP_PREFIX = {
    coverage: "Coverage",
    frequency: "Frequency",
    amRate: "AM rate",
    pmRate: "PM rate",
  } as const;
  for (const key of ["coverage", "frequency", "amRate", "pmRate"] as const) {
    const prefix = BAND_CHIP_PREFIX[key];
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
      label: kpiFlagLabel(flag, context.board.kpiRules),
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
  extra,
  fill,
  value,
}: {
  band: KpiBand;
  caption: string;
  /** An extra badge under the caption — used for the coverage floor, which is a DIFFERENT
   * threshold (95%) from the five-value band's own 90% "elite" cutoff, so a rep can read elite
   * here and still miss the floor. Keeping it a separate element rather than folding it into
   * `band` is what keeps the two readable side by side instead of one overwriting the other. */
  extra?: React.ReactNode;
  fill: number | null;
  value: string;
}) {
  return (
    <td className={NUM}>
      <span className={`block text-base font-black ${toneOf(band).text}`}>{value}</span>
      <KpiMeter band={band} value={fill} />
      <span className="mt-1 block text-phx-3xs font-semibold leading-4 text-slate-500">{caption}</span>
      {extra ? <span className="mt-1 block">{extra}</span> : null}
    </td>
  );
}

/** The coverage-floor badge (owner, 2026-09-05: "coverage no less than 95%"). Null when there is no
 * plan to measure against — the same guard every coverage reading on this board honours. */
function coverageFloorBadge(row: KpiRepRow): React.ReactNode {
  if (row.meetsCoverageFloor == null) return null;
  // Reuses the SAME tokens as the five-value band — "elite" green when it clears, "behind" rose
  // when it does not — rather than a one-off pair of colours, per the shared-chrome rule at the
  // top of kpis-chrome.tsx.
  const chip = toneOf(row.meetsCoverageFloor ? "elite" : "behind").chip;
  return (
    <span className={`inline-block border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.1em] ${chip}`}>
      {row.meetsCoverageFloor ? "Floor met · 95%" : "Below floor · 95%"}
    </span>
  );
}

/**
 * The rep cell — name, where they sit, and any situation flags.
 *
 * Flags are MERGED in here rather than given a column of their own, which is the golden rule's own
 * answer to a width collision: merge, never shrink. Four flags are left out because every table
 * already prints their underlying number in its own column — the two below-target flags beside the
 * AM and PM figures, `over-visiting` beside the Above count, and `below-coverage-floor` beside the
 * coverage percentage — would each be the same fact said twice.
 */
function RepCell({
  action,
  rank,
  row,
  rules,
}: {
  /** A control under the name — the Coverage tab's "Show doctors". */
  action?: React.ReactNode;
  rank?: number;
  row: KpiRepRow;
  rules?: KpisBoard["kpiRules"];
}) {
  const flags = kpiFlagsOf(row).filter(
    (flag) =>
      flag !== "below-am-target" &&
      flag !== "below-pm-target" &&
      flag !== "over-visiting" &&
      flag !== "below-coverage-floor",
  );
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
              {kpiFlagLabel(flag, rules)}
            </span>
          ))}
        </span>
      ) : null}
      {action ? <span className="mt-2 block">{action}</span> : null}
    </td>
  );
}

function coverageFill(row: KpiRepRow): number | null {
  return row.hasMeasurablePlan ? row.coveragePct : null;
}

function frequencyFill(row: KpiRepRow): number | null {
  return row.hasMeasurablePlan ? row.frequencyPct : null;
}

function amFill(row: KpiRepRow): number | null {
  return row.hasCallRate ? row.amAttainmentPct : null;
}

function pmFill(row: KpiRepRow): number | null {
  return row.hasCallRate ? row.pmAttainmentPct : null;
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
      {/* Five columns, because the call rate is two measures and merging them back into one is
          the thing the owner banned. Fixed widths, no min-width floor — the fits-the-screen rule. */}
      <colgroup>
        <col style={{ width: "30%" }} />
        <col style={{ width: "17%" }} />
        <col style={{ width: "17%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "18%" }} />
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
            sub={isPhoenix(context.board) ? "Grade norm" : "Exact only"}
          />
          <KpiSortableTh
            active={filters.sort === "am"}
            direction={filters.direction}
            href={sortHref(context, "am")}
            label="AM"
            sub={`Of ${context.board.amTarget}`}
          />
          <KpiSortableTh
            active={filters.sort === "pm"}
            direction={filters.direction}
            href={sortHref(context, "pm")}
            label="PM"
            sub={`Of ${context.board.pmTarget}`}
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} rules={context.board.kpiRules} />
            <MeasureCell
              band={coverageBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? `${row.visitedDoctors} of ${row.plannedDoctors} planned doctors`
                  : "Nothing planned"
              }
              extra={coverageFloorBadge(row)}
              fill={coverageFill(row)}
              value={planPct(row, row.coveragePct)}
            />
            <MeasureCell
              band={frequencyBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? isPhoenix(context.board)
                    ? `${row.onPlanDoctors} at norm · ${row.underDoctors} below norm`
                    : `${row.onPlanDoctors} exact · ${row.underDoctors} below · ${row.overDoctors} above`
                  : "Nothing planned"
              }
              fill={frequencyFill(row)}
              value={planPct(row, row.frequencyPct)}
            />
            <MeasureCell
              band={amBandOf(row)}
              caption={row.hasCallRate ? `${rate(row.amRate)} of ${context.board.amTarget} a day` : "No calls logged"}
              fill={amFill(row)}
              value={amPct(row)}
            />
            <MeasureCell
              band={pmBandOf(row)}
              caption={row.hasCallRate ? `${rate(row.pmRate)} of ${context.board.pmTarget} a day` : "No calls logged"}
              fill={pmFill(row)}
              value={pmPct(row)}
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
  const phoenix = isPhoenix(board);
  return (
    <table className="hidden w-full table-fixed md:table">
      {/* The Attainment column is gone: it held (AM + PM) over one denominator, which is the
          average the owner banned. Each side now carries its own score in its own column. Pharmacy
          (2026-09-05) is narrower than AM/PM because it carries no "of target" sub-line. */}
      <colgroup>
        <col style={{ width: "24%" }} />
        <col style={{ width: "9%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "15%" }} />
        <col style={{ width: "14%" }} />
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
          {/* Separate from AM/PM entirely (owner, 2026-09-05) — no target yet, so "Not set" rather
              than a target number. See PHARMACY_CALL_RATE_TARGET. */}
          <KpiSortableTh
            active={filters.sort === "pharmacy"}
            direction={filters.direction}
            href={sortHref(context, "pharmacy")}
            label="Pharmacy"
            sub="Not set"
          />
          {/* Merged rather than given two columns — the golden rule resolves a width collision by
              merging, never by shrinking type. */}
          <KpiSortableTh
            active={filters.sort === "campaign"}
            direction={filters.direction}
            href={sortHref(context, "campaign")}
            label="Campaign"
            sub={phoenix ? "Outside the plan" : "Unverifiable"}
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} rules={context.board.kpiRules} />
            <td className={NUM}>{row.workingDays}</td>
            <td className={NUM}>
              {rate(row.amRate)} <span className="text-phx-3xs font-bold text-slate-400">of {board.amTarget}</span>
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {amPct(row)} · {row.amVerified} of {row.workingDays * board.amTarget} asked for
                {followUpText(row, "am")}
              </span>
            </td>
            <td className={NUM}>
              {rate(row.pmRate)} <span className="text-phx-3xs font-bold text-slate-400">of {board.pmTarget}</span>
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {pmPct(row)} · {row.pmVerified} of {row.workingDays * board.pmTarget} asked for
                {followUpText(row, "pm")}
              </span>
            </td>
            <td className={NUM}>
              {pharmacyValue(row)}
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.pharmacyVerified} {phoenix ? "visits" : "verified"}
              </span>
            </td>
            <td className={NUM}>
              {Math.round(row.campaignShare * 100)}%
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.campaignCalls} calls
                {!phoenix && row.campaignOnlyDays > 0 ? ` · ${row.campaignOnlyDays} day(s) campaign only` : ""}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Coverage: one rep's doctors ───────────────────────────────────────────────────────────────

/*
 * THE COVERAGE TAB'S DOCTOR LISTS — owner, 2026-09-16: "when i press on coverage tab covered dr
 * appear with the last visit date and not covered appears".
 *
 * One rep at a time, opened from his own row. The lists are built on the server for the rep the URL
 * names, and only when he is already on this viewer's board (`selectKpiCoverageRep` in
 * crm/kpis-board.ts), so a doctor list never reaches a browser for anybody outside that reach. Both
 * lists come out of the computation that produced the Covered and Not reached counts on the same
 * row, so they always add up to them.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "3 Sep 2026", or "3 Sep" without the year — the spelling reps-list-vacant-areas.tsx prints, by
 * string arithmetic on the ISO day. No Date parsing, so no server time zone can move the day.
 *
 * NO-BREAK SPACES inside the date, so a wrapped line breaks between two dates and never inside one.
 * With plain spaces a doctor planned on fifteen days wrapped as "3 Sep · 5" over "Sep · 7 Sep" in
 * the side-by-side lists at 1024px, where the "5" and the "Sep" read as two different days.
 */
function dayLabel(iso: string | null, withYear = true): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  const day = `${Number(match[3])}\u00A0${MONTHS[Number(match[2]) - 1]}`;
  return withYear ? `${day}\u00A0${match[1]}` : day;
}

/**
 * The element a toggle scrolls back to after its navigation. Separate ids for the desktop row and
 * the phone card: both are in the page, one of them hidden, and a hidden element cannot be scrolled
 * to.
 */
function coverageAnchor(surface: "desktop" | "mobile", repKey: string): string {
  return `kpi-doctors-${surface}-${repKey.replace(/[^a-z0-9]+/gi, "-")}`;
}

/**
 * "Show doctors" / "Hide doctors" for one rep, or null where there is nothing to toggle: a rep with
 * no planned doctor has no list, and a board of one rep shows his list without being asked.
 *
 * A LINK, like every other control on this board, so opening a list re-runs the server-side scope
 * gate. The fragment brings the rep's own row back into view once the page has re-rendered.
 */
function coverageDoctorsToggle(context: ViewContext, row: KpiRepRow, surface: "desktop" | "mobile"): React.ReactNode {
  const key = row.coverageRepKey;
  if (!key || !row.hasMeasurablePlan || context.board.reps.length === 1) return null;
  const open = context.openRep === key;
  return (
    <Link
      aria-expanded={open}
      className={
        open
          ? "inline-flex items-center gap-1.5 border border-orange-300 bg-orange-50 px-2 py-1 text-phx-2xs font-bold text-orange-900 transition-colors hover:border-orange-400"
          : "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold text-slate-600 transition-colors hover:border-slate-500 hover:text-slate-900"
      }
      href={`${hrefWith(context, { rep: open ? null : key })}#${coverageAnchor(surface, key)}`}
    >
      <span>{open ? "Hide doctors" : "Show doctors"}</span>
      <span aria-hidden>{open ? "▴" : "▾"}</span>
    </Link>
  );
}

/** The doctor's name with his speciality and grade under it. Never his id — a missing name says so. */
function CoverageDoctorName({ doctor }: { doctor: KpiCoverageDoctor }) {
  const meta = [doctor.speciality, doctor.grade ? `Grade ${doctor.grade}` : null].filter(Boolean).join(" · ");
  return (
    <span className="block min-w-0">
      {doctor.name ? (
        <span className="block font-semibold leading-5 text-slate-900" dir="auto">
          {doctor.name}
        </span>
      ) : (
        <span className="block font-semibold leading-5 text-slate-500">Name not on the plan</span>
      )}
      {meta ? <span className="block text-phx-3xs leading-4 text-slate-500">{meta}</span> : null}
    </span>
  );
}

function CoverageNotDueChip() {
  return (
    <span className="inline-block border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-semibold leading-4 text-slate-600">
      Not due yet
    </span>
  );
}

/**
 * The days the plan booked him, without the year — the board's header already names the month. The
 * space before each separator is a no-break one too, so a wrapped line ends on "·" and the next line
 * starts on a day, never on a stray dot.
 */
function planDaysLabel(doctor: KpiCoverageDoctor): string {
  const days = doctor.planDates.map((day) => dayLabel(day, false)).filter((day): day is string => Boolean(day));
  return days.length > 0 ? days.join("\u00A0· ") : "No day on the plan";
}

/** One of the two lists: the podium card's frame and header, holding a desktop table or phone rows. */
function CoverageListCard({
  children,
  count,
  empty,
  hint,
  title,
}: {
  children: React.ReactNode;
  count: number;
  empty: string;
  hint: string;
  title: string;
}) {
  return (
    <div className="min-w-0 border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
          {title} · <span className="tabular-nums">{count}</span>
        </p>
        <p className="mt-0.5 text-phx-3xs leading-4 text-slate-400">{hint}</p>
      </div>
      {count === 0 ? <p className="px-3 py-3 text-phx-2xs text-slate-500">{empty}</p> : children}
    </div>
  );
}

/**
 * Both lists for the open rep. `surface` decides the shape only: two fixed-layout tables side by side
 * from `lg` inside the desktop row, stacked cards under the phone card.
 */
function CoverageDoctors({
  context,
  detail,
  surface,
}: {
  context: ViewContext;
  detail: KpiCoverageDetail;
  surface: "desktop" | "mobile";
}) {
  const { board } = context;
  const period = board.range.isWholeMonth ? board.monthLabel : board.range.periodLabel;
  const planned = detail.covered.length + detail.notCovered.length;
  const notDue = detail.notCovered.filter((doctor) => !doctor.due).length;
  const due = detail.notCovered.length - notDue;

  const covered = (
    <CoverageListCard
      count={detail.covered.length}
      empty="No planned doctor has been visited in this period yet."
      hint="Seen at least once · latest visit first"
      title="Covered"
    >
      {surface === "desktop" ? (
        <table className="hidden w-full table-fixed md:table">
          <colgroup>
            <col style={{ width: "60%" }} />
            <col style={{ width: "40%" }} />
          </colgroup>
          <thead className="border-b border-slate-100">
            <tr>
              <th className={TH} scope="col">
                Doctor
              </th>
              <th className={TH} scope="col">
                Last visit
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.covered.map((doctor) => (
              <tr key={doctor.contactCrmId}>
                <td className={TD}>
                  <CoverageDoctorName doctor={doctor} />
                </td>
                <td className={TD}>
                  <span className="block font-semibold tabular-nums text-slate-900">
                    {dayLabel(doctor.lastVisitDate) ?? "—"}
                  </span>
                  <span className="block text-phx-3xs leading-4 text-slate-500">
                    {doctor.visits} visit{doctor.visits === 1 ? "" : "s"} in the period
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="divide-y divide-slate-100">
          {detail.covered.map((doctor) => (
            <li className="px-3 py-2.5 text-sm" key={doctor.contactCrmId}>
              <CoverageDoctorName doctor={doctor} />
              <span className="mt-1 block text-phx-3xs leading-4 text-slate-500">
                Last visit{" "}
                <span className="font-bold tabular-nums text-slate-900">{dayLabel(doctor.lastVisitDate) ?? "—"}</span> ·{" "}
                {doctor.visits} visit{doctor.visits === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CoverageListCard>
  );

  const notCovered = (
    <CoverageListCard
      count={detail.notCovered.length}
      empty="Every planned doctor has been visited at least once."
      hint={notDue > 0 ? `${due} due · ${notDue} not due yet · oldest planned day first` : "Oldest planned day first"}
      title="Not covered"
    >
      {surface === "desktop" ? (
        <table className="hidden w-full table-fixed md:table">
          <colgroup>
            <col style={{ width: "55%" }} />
            <col style={{ width: "45%" }} />
          </colgroup>
          <thead className="border-b border-slate-100">
            <tr>
              <th className={TH} scope="col">
                Doctor
              </th>
              <th className={TH} scope="col">
                Planned for
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.notCovered.map((doctor) => (
              <tr key={doctor.contactCrmId}>
                <td className={TD}>
                  <CoverageDoctorName doctor={doctor} />
                </td>
                <td className={TD}>
                  <span className="block tabular-nums text-slate-900">{planDaysLabel(doctor)}</span>
                  {doctor.due ? null : (
                    <span className="mt-1 block">
                      <CoverageNotDueChip />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="divide-y divide-slate-100">
          {detail.notCovered.map((doctor) => (
            <li className="px-3 py-2.5 text-sm" key={doctor.contactCrmId}>
              <CoverageDoctorName doctor={doctor} />
              <span className="mt-1 block text-phx-3xs leading-4 text-slate-500">
                Planned for <span className="font-bold tabular-nums text-slate-900">{planDaysLabel(doctor)}</span>
              </span>
              {doctor.due ? null : (
                <span className="mt-1 block">
                  <CoverageNotDueChip />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </CoverageListCard>
  );

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">
          Doctors planned in {period}
        </p>
        <p className={`mt-0.5 leading-4 ${CAPTION}`}>
          {planned === 0
            ? `No doctor was planned for ${detail.repName} in this period.`
            : `${detail.repName}: ${detail.covered.length} of ${planned} seen at least once. Not covered means no visit in the period yet — a doctor whose planned day is still ahead is marked Not due yet.`}
        </p>
      </div>
      {planned === 0 ? null : surface === "desktop" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {covered}
          {notCovered}
        </div>
      ) : (
        <>
          {covered}
          {notCovered}
        </>
      )}
    </div>
  );
}

function CoverageTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { coverageDetail: detail, filters } = context.board;
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
            sub="Of the whole list"
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
            sub="Covered ÷ planned"
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <Fragment key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <tr
              className="scroll-mt-20"
              id={row.coverageRepKey ? coverageAnchor("desktop", row.coverageRepKey) : undefined}
            >
              <RepCell
                action={coverageDoctorsToggle(context, row, "desktop")}
                rank={context.showRank ? index + 1 : undefined}
                row={row}
                rules={context.board.kpiRules}
              />
              <td className={NUM}>{row.plannedDoctors}</td>
              <td className={NUM}>{row.visitedDoctors}</td>
              <td className={NUM}>{row.missedDoctors}</td>
              <td className={NUM}>{row.offPlanDoctors}</td>
              <MeasureCell
                band={coverageBandOf(row)}
                caption={
                  row.hasMeasurablePlan
                    ? `${row.visitedDoctors} of ${row.plannedDoctors} planned doctors`
                    : "No planned doctors to be a percentage of"
                }
                extra={coverageFloorBadge(row)}
                fill={coverageFill(row)}
                value={planPct(row, row.coveragePct)}
              />
            </tr>
            {detail && row.coverageRepKey === detail.repKey ? (
              <tr>
                <td className="bg-slate-50/60 px-4 py-4 sm:px-5" colSpan={6}>
                  <CoverageDoctors context={context} detail={detail} surface="desktop" />
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function FrequencyTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { filters } = context.board;
  const phoenix = isPhoenix(context.board);
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
          {/* Under the Phoenix rules the same two columns judge the grade norm, not the plan (rule 7),
              so they carry the norm's words; the old rules keep the owner's three words above. */}
          {phoenix ? (
            <KpiSortableTh
              active={filters.sort === "exact"}
              direction={filters.direction}
              href={sortHref(context, "exact")}
              label="At norm"
              sub="The pass"
            />
          ) : (
            <KpiSortableTh
              active={filters.sort === "exact"}
              direction={filters.direction}
              href={sortHref(context, "exact")}
              label={ACTIVITY_LABEL.on_plan}
              sub="The only pass"
            />
          )}
          {phoenix ? (
            <KpiSortableTh
              active={filters.sort === "below"}
              direction={filters.direction}
              href={sortHref(context, "below")}
              label="Below norm"
              sub="Fewer than the grade asks"
            />
          ) : (
            <KpiSortableTh
              active={filters.sort === "below"}
              direction={filters.direction}
              href={sortHref(context, "below")}
              label={ACTIVITY_LABEL.under}
              sub="Short of plan"
            />
          )}
          {/* Under the Phoenix rules an extra visit is fine (rule 7), so this column shows the
              ungraded doctors left out instead — nothing to rank anyone on, so not sortable. */}
          {phoenix ? (
            <th className={TH} scope="col">
              Ungraded
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
                Left out
              </span>
            </th>
          ) : (
            <KpiSortableTh
              active={filters.sort === "above"}
              direction={filters.direction}
              href={sortHref(context, "above")}
              label={ACTIVITY_LABEL.over}
              sub="Also a deviation"
            />
          )}
          <KpiSortableTh
            active={filters.sort === "frequency"}
            direction={filters.direction}
            href={sortHref(context, "frequency")}
            label="Frequency"
            sub={phoenix ? "At norm ÷ graded" : "Exact ÷ planned"}
          />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell rank={context.showRank ? index + 1 : undefined} row={row} rules={context.board.kpiRules} />
            <td className={NUM}>{row.onPlanDoctors}</td>
            <td className={NUM}>{row.underDoctors}</td>
            <td className={NUM}>{row.phoenix ? row.phoenix.frequency.ungraded : row.overDoctors}</td>
            <MeasureCell
              band={frequencyBandOf(row)}
              caption={
                row.hasMeasurablePlan
                  ? row.phoenix
                    ? `${row.phoenix.frequency.met} of ${row.phoenix.frequency.judged} graded doctors at norm`
                    : `${row.actualCalls} of ${row.plannedCalls} planned calls made`
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
function RepCard({
  action,
  amTarget,
  pmTarget,
  rank,
  row,
  rules,
}: {
  /** A control under the card, e.g. the Coverage tab's "Show doctors". */
  action?: React.ReactNode;
  amTarget: number;
  pmTarget: number;
  rank?: number;
  row: KpiRepRow;
  rules?: KpisBoard["kpiRules"];
}) {
  const measures: Array<{
    band: KpiBand;
    caption: string;
    extra?: React.ReactNode;
    fill: number | null;
    label: string;
    value: string;
  }> = [
    {
      band: coverageBandOf(row),
      caption: row.hasMeasurablePlan
        ? `${row.visitedDoctors}/${row.plannedDoctors} planned`
        : "Nothing planned",
      extra: coverageFloorBadge(row),
      fill: coverageFill(row),
      label: "Coverage",
      value: planPct(row, row.coveragePct),
    },
    {
      band: frequencyBandOf(row),
      caption: row.hasMeasurablePlan ? (row.phoenix ? `${row.onPlanDoctors} at norm` : `${row.onPlanDoctors} exact`) : "Nothing planned",
      fill: frequencyFill(row),
      label: "Frequency",
      value: planPct(row, row.frequencyPct),
    },
    {
      band: amBandOf(row),
      caption: row.hasCallRate ? `${rate(row.amRate)} of ${amTarget} a day` : "No calls",
      fill: amFill(row),
      label: "AM call rate",
      value: amPct(row),
    },
    {
      band: pmBandOf(row),
      caption: row.hasCallRate ? `${rate(row.pmRate)} of ${pmTarget} a day` : "No calls",
      fill: pmFill(row),
      label: "PM call rate",
      value: pmPct(row),
    },
    {
      // "noplan" here means "no target to be a percentage of" — not "no calls". kpiBandOf(null) is
      // always this band because pharmacyAttainmentPct is always null (see
      // PHARMACY_CALL_RATE_TARGET); the caption says why, so the chip does not read as a fault.
      band: kpiBandOf(row.pharmacyAttainmentPct),
      caption: row.hasCallRate
        ? `${row.pharmacyVerified} ${row.phoenix ? "visits" : "verified"} · no target set yet`
        : "No calls",
      fill: null,
      label: "Pharmacy",
      value: pharmacyValue(row),
    },
  ];
  const flags = kpiFlagsOf(row).filter(
    (flag) =>
      flag !== "below-am-target" &&
      flag !== "below-pm-target" &&
      flag !== "over-visiting" &&
      flag !== "below-coverage-floor",
  );

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
            {measure.extra ? <dd className="mt-1">{measure.extra}</dd> : null}
          </div>
        ))}
      </dl>
      {row.hasCallRate ? (
        <p className="mt-1.5 text-phx-3xs leading-4 text-slate-500">
          <span className="font-black uppercase tracking-[0.1em] text-slate-400">Reported</span>{" "}
          <span className="tabular-nums">
            {rate(row.amReportedRate)} AM · {rate(row.pmReportedRate)} PM
          </span>
        </p>
      ) : null}
      {flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {flags.map((flag) => (
            <span
              className="inline-block border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-semibold leading-4 text-slate-600"
              key={flag}
            >
              {kpiFlagLabel(flag, rules)}
            </span>
          ))}
        </div>
      ) : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

// ── The board ─────────────────────────────────────────────────────────────────────────────────

export function KpisBoardView({
  basePath,
  board,
  chrome = "admin",
  monthOptions,
  periodOptions,
  tab,
}: {
  basePath: string;
  board: KpisBoard;
  /**
   * WHICH SHELL is drawing the page around this board.
   *
   * `admin` (the default, so the admin twin is unchanged by this prop existing) means the board
   * owns its own page header. `portal` means EmployeePortalPageShell has already drawn one, and
   * this board must not draw a second — see the note in KpiHero.
   */
  chrome?: "admin" | "portal";
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
    // Only a rep the server actually built a list for. A board of one rep opens his list without a
    // `rep` in the URL, so there is nothing to carry for him.
    openRep: board.reps.length > 1 ? (board.coverageDetail?.repKey ?? null) : null,
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
  const phoenix = isPhoenix(board);
  const callWord = phoenix ? "visits" : "verified";

  return (
    <div className="space-y-4">
      <KpiHero board={board} showTitle={chrome === "admin"} />

      <div>
        <KpiTabStrip context={context} />
        <div className={PANEL}>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">{KPI_TAB_LABEL[tab]}</p>
              <p className={`mt-0.5 leading-4 ${CAPTION}`}>
                {(phoenix ? KPI_TAB_HINT_PHOENIX[tab] : undefined) ?? KPI_TAB_HINT[tab]}
              </p>
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
              monthEnd={board.range.monthEnd}
              monthOptions={monthOptions}
              monthStart={`${board.month}-01`}
              period={board.range.periodKey}
              periodOptions={periodOptions}
              rangeFrom={board.range.dateFrom}
              rangeTo={board.range.windowEnd}
              rep={context.openRep}
              tab={tab}
            />
          </div>

          <KpisFilterBar
            basePath={basePath}
            facets={board.facets}
            filters={filters}
            kpiRules={board.kpiRules}
            month={board.month}
            period={board.range.periodKey}
            rep={context.openRep}
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

          {board.kpiRulesNote ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`${CAPTION} font-semibold`}>{board.kpiRulesNote}</p>
            </div>
          ) : null}

          {board.range.notStarted ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`${CAPTION} font-semibold`}>
                This period has not started yet, so every call rate is blank rather than zero.
              </p>
            </div>
          ) : null}

          {/* Six tiles since 2026-09-06, when pharmacy joined as its own tile — never averaged into
              AM/PM, never blended with them. See PHARMACY_CALL_RATE_TARGET in crm/call-rate.ts for
              why it carries no target yet. A combined AM+PM "visits/day" tile briefly lived here too
              (2026-09-05) and was retracted the same day (#3341): the owner's 8-12 band belongs to
              PM alone, not AM+PM summed, and that per-list model now lives entirely in
              rep-kpi-reports.ts's two-report tabs. Do not re-add a combined tile here. */}
          <div className="grid gap-3 border-t border-slate-100 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-6">
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
              band={kpiBandOf(totals.amAttainmentPct)}
              caption={`${totals.amVerified} ${callWord} · target ${board.amTarget} a day`}
              label="AM call rate"
              progress={totals.amAttainmentPct}
              value={`${rate(totals.amRate)} of ${board.amTarget}`}
            />
            <KpiTile
              band={kpiBandOf(totals.pmAttainmentPct)}
              caption={`${totals.pmVerified} ${callWord} · target ${board.pmTarget} a day`}
              label="PM call rate"
              progress={totals.pmAttainmentPct}
              value={`${rate(totals.pmRate)} of ${board.pmTarget}`}
            />
            {/* No target yet (see PHARMACY_CALL_RATE_TARGET) — the raw rate, no percentage, no
                progress bar to fill against a number that does not exist. */}
            <KpiTile
              caption={`${totals.pharmacyVerified} ${callWord} · no target set yet`}
              label="Pharmacy call rate"
              value={rate(totals.pharmacyRate)}
            />
            <KpiTile
              band={kpiBandOf(totals.coveragePct)}
              caption={`${totals.visitedDoctors} of ${totals.plannedDoctors} planned doctors${
                partial ? " · the period is still running" : ""
              }${
                totals.meetsCoverageFloor == null
                  ? ""
                  : totals.meetsCoverageFloor
                    ? ` · clears the ${board.coverageFloorPct}% floor`
                    : ` · below the ${board.coverageFloorPct}% floor`
              }`}
              label="Coverage"
              progress={totals.coveragePct}
              value={`${totals.coveragePct}%`}
            />
            <KpiTile
              band={kpiBandOf(totals.frequencyPct)}
              caption={
                phoenix
                  ? `${totals.onPlanDoctors} at norm · ${totals.underDoctors} below norm${partial ? " · so far" : ""}`
                  : `${totals.onPlanDoctors} exact · ${totals.underDoctors} below · ${totals.overDoctors} above${partial ? " · so far" : ""}`
              }
              label="Frequency"
              progress={totals.frequencyPct}
              value={`${totals.frequencyPct}%`}
            />
          </div>

          {/* Rules 2, 7 and 8 — the lines that sit OUTSIDE the three KPIs, said once for the team. */}
          {board.phoenixTotals ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`leading-4 ${CAPTION}`}>
                {board.phoenixTotals.campaignVisits} campaign visits, unplanned visits to a contact not on the
                rep&apos;s list included, are counted on their own line, outside call rate, coverage and frequency. {board.phoenixTotals.ungradedDoctors} planned doctors have no grade and are left
                out of frequency.
              </p>
            </div>
          ) : null}

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
          ) : tab === "am-pm" || tab === "pharmacies" ? (
            /* THE TWO REPORTS. No leaderboard above them, deliberately: the podium ranks the four
               plan-based measures, and a "best on pharmacies" board would rank reps against a
               standard the owner has not set yet. The tables carry mobile cards of their own. */
            <div className="border-t border-slate-100">
              {tab === "am-pm" ? <AmPmKpiReportTables reports={board.kpiReports} /> : null}
              {tab === "pharmacies" ? <PharmacyKpiReportTables reports={board.kpiReports} /> : null}
              <div className="border-t border-slate-100">
                <OffListNote reports={board.kpiReports} />
              </div>
            </div>
          ) : (
            <>
              {/* THE LEADERBOARDS. Three, never one — a single "best rep" would need a blended
                  score, and this board adds no fourth measure. They rank the FILTERED rows, so
                  filtering to one line answers "best in that line". */}
              <div className="border-t border-slate-100">
                <KpiSection
                  description="Best three on each measure, from the reps currently in view. Separate answers — often different people. The morning and the afternoon are ranked apart."
                  title="Standing out"
                >
                  <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
                    {tab === "summary" || tab === "coverage" ? (
                      <KpiPodiumCard entries={podium.coverage} hint="Most of the planned list reached" title="Coverage" />
                    ) : null}
                    {tab === "summary" || tab === "frequency" ? (
                      <KpiPodiumCard
                        entries={podium.frequency}
                        hint={phoenix ? "Most graded doctors at their grade norm" : "Most doctors seen exactly as planned"}
                        title="Frequency"
                      />
                    ) : null}
                    {tab === "summary" || tab === "call-rate" ? (
                      <KpiPodiumCard
                        entries={podium.amCallRate}
                        hint={`Closest to ${board.amTarget} ${phoenix ? "AM visits" : "verified AM calls"} a day`}
                        title="AM call rate"
                      />
                    ) : null}
                    {tab === "summary" || tab === "call-rate" ? (
                      <KpiPodiumCard
                        entries={podium.pmCallRate}
                        hint={`Closest to ${board.pmTarget} ${phoenix ? "PM visits" : "verified PM calls"} a day`}
                        title="PM call rate"
                      />
                    ) : null}
                    {/* Ranked on the raw rate, not attainment — no pharmacy target exists yet (see
                        PHARMACY_CALL_RATE_TARGET), and a rep with zero pharmacy calls is excluded
                        from this board entirely rather than shown at 0, same as coverage/frequency
                        exclude a rep with no measurable plan. */}
                    {tab === "summary" || tab === "call-rate" ? (
                      <KpiPodiumCard
                        entries={podium.pharmacyCallRate}
                        hint={`Most ${phoenix ? "pharmacy visits" : "verified pharmacy calls"} a day — no target set yet`}
                        suffix=""
                        title="Pharmacy"
                      />
                    ) : null}
                  </div>
                </KpiSection>
              </div>

              <div className="border-t border-slate-100">
                <div className="divide-y divide-slate-100 md:hidden">
                  {board.reps.map((row, index) => {
                    const coverageKey = tab === "coverage" ? row.coverageRepKey : null;
                    const detail =
                      coverageKey && board.coverageDetail?.repKey === coverageKey ? board.coverageDetail : null;
                    return (
                      <div
                        className={coverageKey ? "scroll-mt-20" : undefined}
                        id={coverageKey ? coverageAnchor("mobile", coverageKey) : undefined}
                        key={String(row.agentCrmId ?? `${row.repName}-${index}`)}
                      >
                        <RepCard
                          action={tab === "coverage" ? coverageDoctorsToggle(context, row, "mobile") : undefined}
                          amTarget={board.amTarget}
                          pmTarget={board.pmTarget}
                          rank={context.showRank ? index + 1 : undefined}
                          row={row}
                          rules={board.kpiRules}
                        />
                        {detail ? (
                          <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                            <CoverageDoctors context={context} detail={detail} surface="mobile" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
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
              {phoenix
                ? "Every submitted regular visit counts toward the call rate; GPS is evidence only. PM passes at 10 a day and AM at 2, judged apart. Frequency passes when a doctor gets the visits his grade asks for (A 3, B 2, C 1) — extra visits are fine and ungraded doctors are left out."
                : "Exact is the only frequency pass — visiting a doctor more often than the plan asked for is a deviation, not a win."}{" "}
              The bands below are these same three measures cut into ranges; nothing on this board blends
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
