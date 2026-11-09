import { Download } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

import { KpisDoctorFilterBar } from "@/components/crm/kpis-doctor-filter-bar";
import { KpisFilterBar } from "@/components/crm/kpis-filter-bar";
import { KpisPeriodPicker, type KpiPickerOption } from "@/components/crm/kpis-period-picker";
import { KpiTrendView } from "@/components/crm/kpis-trend-view";
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
import { awaitingValidationNote } from "@/lib/crm/call-rate";
import { kpiCallRateRepKey, kpiCallRateRepPath } from "@/lib/crm/kpis-call-rate-route";
import {
  KPI_CALL_RATE_VIEWS,
  KPI_CALL_RATE_VIEW_LABEL,
  KPI_TABS,
  KPI_TAB_HINT,
  KPI_TAB_HINT_PHOENIX,
  KPI_TAB_LABEL,
  PORTAL_KPIS_ROOT_PATH,
  PORTAL_KPI_REPORT_PATH,
  type KpiCallRateView,
  type KpiTab,
} from "@/lib/crm/kpis-tabs";
import {
  buildKpisQuery,
  amBandOf,
  coverageBandOf,
  EMPTY_KPI_FILTERS,
  frequencyBandOf,
  pmBandOf,
  hasActiveKpiFilters,
  kpiBandOf,
  kpiFlagsShownOn,
  KPI_BAND_LABEL,
  KPI_RANGE_FIELDS,
  KPI_RANGE_LABEL,
  KPI_RANGE_UNIT,
  kpiFlagLabel,
  nextKpiSort,
  UNASSIGNED_FACET_KEY,
  UNASSIGNED_FACET_LABEL,
  type KpiBand,
  type KpiFilterState,
  type KpiFlag,
  type KpiJustStarted,
  type KpiRangeFilters,
  type KpiSortField,
  isTooEarlyToScore,
} from "@/lib/crm/kpis-filters";
import { utcDate } from "@/lib/format/cairo-datetime";
import {
  buildKpiDoctorFacets,
  EMPTY_KPI_DOCTOR_FILTER,
  filterKpiDoctors,
  hasActiveKpiDoctorFilter,
  KPI_DOCTOR_NO_SPECIALITY,
  KPI_DOCTOR_NOT_VALIDATED,
  KPI_DOCTOR_SORT_LABEL,
  kpiDoctorBrickLabel,
  type KpiDoctorFilter,
  type KpiDoctorStatus,
} from "@/lib/crm/kpis-doctor-filters";
import { buildKpiBrickRows, KPI_FREQUENCY_STATUS_LABEL, kpiBrickFrequencyColumns, type KpiBrickRow } from "@/lib/crm/kpis-brick-table";
import { kpiIndexOf, type KpiIndex } from "@/lib/crm/kpi-index";
import { KPI_MANAGER_LEVEL_LABEL, type KpiManagerMeasure, type KpiManagerRow } from "@/lib/crm/kpis-manager-rows";
import { ACTIVITY_LABEL } from "@/lib/crm/reps-list-activity";
import type { KpiCoverageDetail, KpiCoverageDoctor, KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";
import { groupKpiRepsByTeam } from "@/lib/crm/kpi-coverage-teams";
import {
  KpiBrickGlance,
  KpiCoverageStanding,
  KpiTeamCoverageRollup,
  KpiTeamHeadingBand,
  KpiTeamHeadingRow,
  kpiCoverageExtraTiles,
  kpiTeamsWithCoverage,
  type KpiTeamWithCoverage,
} from "@/components/crm/kpi-coverage-panels";
import {
  KpiCoverageGroupTable,
  KpiCoverageWeekTable,
  KpiFloorPathPanel,
  KpiFloorTrack,
  KpiLateAgeingPanel,
  KpiRepCoverageTiles,
  KpiRepVisitDepth,
  type KpiCoverageGroupLinks,
} from "@/components/crm/kpi-coverage-rep-panels";
import {
  KPI_NO_SPECIALITY,
  kpiCoverageByGrade,
  kpiCoverageBySpeciality,
  kpiCoverageByWeek,
  kpiFloorPath,
  kpiLateAgeing,
  kpiRepCoverageSummary,
} from "@/lib/crm/kpi-coverage-rep-detail";
import type { DoctorFrequencyStatus } from "@/lib/crm/phoenix-kpi-rules";
import type { KpiTrend } from "@/lib/crm/kpis-trend";
import { KPI_TREND_METRICS, KPI_TREND_SCALES, type KpiTrendMetric, type KpiTrendScale } from "@/lib/crm/kpis-trend-options";

/**
 * The KPIs board — Summary, Call Rate, Coverage and Frequency over one rep list.
 *
 * ## The rep rows are medical reps; the managers sit below them, as averages
 *
 * Owner, 2026-10-20: "add manager row and every dm kpis is calculated based on his reps averag and
 * nsm based on dsms av and so on". The rep list, its tiles, podiums and bands still count medical
 * reps only. Under the rep table, on the four tabs that print one, a "Managers" section lists
 * `board.managers`: one row per manager, each figure the average of the rows directly beneath him
 * (crm/kpis-manager-rows.ts). It wears the Summary table's own columns and widths and the rep
 * card's own cells, so it is measured by the same numbers.
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
 * The column widths are set by the HEADER WORDS, not by the numbers under them. app/globals.css
 * forces every `thead th` in both shells to 0.78rem black uppercase, so a one-word head such as
 * PLANNED needs about 97px with its padding and has nowhere to wrap. The narrowest table on either
 * shell is the portal's at 1024px, sidebar open, display scale 100%: 619px wide. The four board
 * tables' colgroups were measured there on 2026-09-16, sort arrows on, so that each head fits in
 * Segoe UI, Segoe UI Variable and Aptos. The Coverage table's 12% columns (74px) had pushed Planned,
 * Covered and Not reached past their cells, and Frequency carried a sixth column for five cells.
 * tests/kpis-board-tables-fit.test.ts holds each column at its measured floor.
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

/**
 * OWNER'S RULING A1, 2026-09-21 — the marker for a rep who logged visits with no GPS check-in at all
 * from his CRM account, so none could be proved (`KpiRepRow.noGpsFeed`). Said once, so the cells, the
 * card and the flag chip cannot drift apart on the wording; the chip reads the same words from
 * KPI_FLAG_LABEL.
 */
const NO_GPS_FEED = "No GPS feed";

/**
 * A rep whose calls are all saved and all waiting on their customers' validation. Not "No calls",
 * which would be untrue of him, and not a red 0%, which would score him for his list's progress.
 */
const NOT_SCORED_YET = "Not scored yet";

/**
 * The line under an AM or PM figure. For a rep with no GPS feed it says what he REPORTED, because the
 * proved rate it would otherwise quote is blank for want of a feed, not zero.
 */
function sessionCaption(row: KpiRepRow, session: "am" | "pm", target: number, none: string): string {
  if (row.noGpsFeed) return `${session === "am" ? row.amReported : row.pmReported} reported · none provable`;
  // A started team's first weeks: the visits are saved and score nothing until the customer is
  // validated, so a bare 0 here reads as a rep who did nothing. Say what is actually true instead.
  const waiting = awaitingValidationNote(row);
  if (!row.hasCallRate) return waiting ?? none;
  const figure = `${rate(session === "am" ? row.amRate : row.pmRate)} of ${target} a day`;
  return waiting ? `${figure} · ${row.awaitingValidation} more waiting to be validated` : figure;
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
  if (row.noGpsFeed) return NO_GPS_FEED;
  if (row.hasCallRate && row.amAttainmentPct != null) return `${row.amAttainmentPct}%`;
  // "No calls" would be untrue of a rep whose every call is waiting on its customer.
  return row.awaitingValidation > 0 ? NOT_SCORED_YET : "No calls";
}

function pmPct(row: KpiRepRow): string {
  if (row.noGpsFeed) return NO_GPS_FEED;
  if (row.hasCallRate && row.pmAttainmentPct != null) return `${row.pmAttainmentPct}%`;
  return row.awaitingValidation > 0 ? NOT_SCORED_YET : "No calls";
}

/**
 * The pharmacy call rate, separate from AM/PM entirely (owner, 2026-09-05) — never a percentage,
 * because no target exists yet to be a percentage of (see PHARMACY_CALL_RATE_TARGET). Shows the
 * raw rate instead, which stays honest whether or not the owner ever sets one. Zero is a NORMAL
 * reading for a rep who logged field work — 43 of 76 in a typical month — never "No calls" the way
 * an absent AM/PM figure would be; that string is reserved for a rep with no call rate at all.
 */
function pharmacyValue(row: KpiRepRow): string {
  if (row.noGpsFeed) return NO_GPS_FEED;
  return row.hasCallRate ? rate(row.pharmacyRate) : "No calls";
}

/**
 * ONE REP'S OVERALL KPI (owner, 2026-09-17: "consolidate ... into one percentage ... let them
 * separated as they are").
 *
 * Through the SAME domain function the team figure comes from — `kpiIndexOf` in crm/kpi-index.ts —
 * so a rep's row and the panel above it can never be two different averages. The four measures on
 * the row are untouched: this reads them, it does not replace them.
 */
function repKpiIndex(row: KpiRepRow): KpiIndex {
  return kpiIndexOf({
    coveragePct: row.coveragePct,
    frequencyPct: row.frequencyPct,
    hasMeasurablePlan: row.hasMeasurablePlan,
    amAttainmentPct: row.amAttainmentPct,
    pmAttainmentPct: row.pmAttainmentPct,
    hasCallRate: row.hasCallRate,
    noGpsFeed: row.noGpsFeed,
    justStarted: Boolean(row.justStarted),
  });
}

/**
 * How far in a rep too new to judge is — "2 working days in" — printed wherever a verdict would
 * otherwise sit (owner, 2026-10-26: "show them plainly as just started, with the number of working
 * days in").
 */
function justStartedDays(justStarted: KpiJustStarted): string {
  const days = justStarted.workingDaysIn;
  if (days === 0) return "no working day in yet";
  return `${days} working day${days === 1 ? "" : "s"} in`;
}

/** A flag chip's words; "Just started" carries her working days, the rest read as the filter does. */
function repFlagLabel(row: KpiRepRow, flag: KpiFlag, rules?: KpisBoard["kpiRules"]): string {
  if (flag === "just-started" && row.justStarted) return `Just started · ${justStartedDays(row.justStarted)}`;
  return kpiFlagLabel(flag, rules);
}

/**
 * A DATE THE FOOTER PRINTS — "31 Oct", never "2026-10-31" (owner, 2026-10-26). The month label beside
 * it already carries the year. A date-only value, so the UTC formatter, as the hire date uses.
 */
function footerDay(iso: string): string {
  return utcDate(iso).replace(/\s\d{4}$/, "");
}

/**
 * The overall percentage, or the marker for a rep none of the four could be scored for.
 *
 * "No score" and never "0%", for the same reason `hasMeasurablePlan` exists: a rep the plan asked
 * nothing of and who logged nothing has no value on this axis, not a bad one.
 */
function overallValue(index: KpiIndex, row?: Pick<KpiRepRow, "justStarted">): string {
  if (row?.justStarted) return "Just started";
  return index.overallPct == null ? "No score" : `${index.overallPct}%`;
}

/** What went into a row's average, in the width a table cell has. The full arithmetic is on the
 * panel above the tiles — this says how many of the four the average could use. */
function overallCaption(index: KpiIndex, row?: Pick<KpiRepRow, "justStarted">): string {
  if (row?.justStarted) return justStartedDays(row.justStarted);
  if (index.overallPct == null) {
    const reasons = [...new Set(index.components.map((component) => component.excludedBecause).filter(Boolean))];
    return reasons.join(" · ") || "Nothing to score";
  }
  const capped = index.components.filter((component) => component.capped);
  const cappedNote =
    capped.length > 0 ? ` · ${capped.map((component) => component.label).join(" and ")} capped at 100` : "";
  return `${index.counted} of 4 measures averaged${cappedNote}`;
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
  /** The tabs the strip offers — all seven in the admin shell, the four consolidated ones on the portal's KPIs page, none on a report page. */
  tabs: readonly KpiTab[];
  /** The portal KPIs page's own address, which the per-rep call-rate drill-down hangs under whichever report page is open. */
  rootPath: string;
  /** The call-rate report's Total / AM / PM view. Meaningless off that tab. */
  callRateView: KpiCallRateView;
  /** True when the current sort is a measure, so a rank disc actually means something. */
  showRank: boolean;
  /**
   * The rep whose doctors the Coverage tab has open, carried on every link so a sort or a removed
   * filter does not close the list. Null when none is open — and on a board of ONE rep, whose list
   * opens by itself and so never needs to ride in the URL.
   */
  openRep: string | null;
  /** The Weekly tab's two switches, carried on every link so a sort or a filter keeps the view. */
  trendScale: KpiTrendScale;
  trendMetric: KpiTrendMetric;
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
  overrides: {
    tab?: KpiTab;
    filters?: KpiFilterState;
    rep?: string | null;
    trend?: KpiTrendScale;
    measure?: KpiTrendMetric;
    view?: KpiCallRateView;
  },
): string {
  const { basePath, board } = context;
  const rep = overrides.rep !== undefined ? overrides.rep : context.openRep;
  // Opening a DIFFERENT rep starts his list unfiltered: another person's doctors share no speciality
  // list or visit count with this one, and a leftover filter would open him on an empty table.
  const filters =
    overrides.filters ?? (rep !== context.openRep ? { ...board.filters, doctor: EMPTY_KPI_DOCTOR_FILTER } : board.filters);
  return `${basePath}?${buildKpisQuery({
    month: board.month,
    // The Weekly tab's board is the span its weeks cover ("1–28 Sep"), not a period anybody picked,
    // so leaving that tab opens the next one on the whole month rather than on that span.
    period: context.tab === "weekly" ? "month" : board.range.periodKey,
    tab: overrides.tab ?? context.tab,
    filters,
    rep,
    trend: overrides.trend ?? context.trendScale,
    measure: overrides.measure ?? context.trendMetric,
    view: overrides.view ?? context.callRateView,
  })}`;
}

function sortHref(context: ViewContext, field: KpiSortField): string {
  return hrefWith(context, { filters: nextKpiSort(context.board.filters, field) });
}

/**
 * The workbook export's address: the board's own month, period and filters through the one query
 * builder, so the file can never hold a wider (or different) set of reps than the screen. The Weekly
 * tab's board is a span, not a picked period, so it exports the whole month — as leaving that tab does.
 *
 * On Coverage and Frequency it also carries the tab, the open rep and his doctor filters (owner,
 * 2026-10-29: "Brick on the KPIs Excel export"), so the file adds the team's By brick sheet and the
 * open rep's doctors exactly as filtered on screen. Every other tab exports as the Summary.
 */
function kpisExportHref(context: ViewContext, weekly: boolean): string {
  const { board, tab } = context;
  const doctorsTab = tab === "coverage" || tab === "frequency";
  return `/api/crm/kpis-export?${buildKpisQuery({
    month: board.month,
    period: weekly ? "month" : board.range.periodKey,
    tab: doctorsTab ? tab : "summary",
    filters: board.filters,
    rep: doctorsTab ? context.openRep : null,
  })}`;
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

/**
 * The call rate stops at YESTERDAY in a running window (owner ruling C1, 2026-09-21), so on the day a
 * period opens its call-rate window is empty: it starts today and ends yesterday. Not "not started" —
 * coverage is already counting today's visits — and never a red 0.00 either.
 */
function callRateBeganToday(board: KpisBoard): boolean {
  return board.range.todayLeftOut && board.range.dateTo < board.range.dateFrom;
}

function teamVerdict(board: KpisBoard): { headline: string; tone: KpiBand; standing?: string } {
  const { totals } = board;
  if (board.range.notStarted) {
    return { headline: "This period has not started. Nothing here is a score yet.", tone: "noplan" };
  }
  if (totals.reps === 0) {
    return { headline: "No reps match what you are looking at.", tone: "noplan" };
  }
  // NO WORKING DAY OF THE PERIOD IS OVER YET. Since ruling C1 that is what the first day of every
  // period looks like, and isTooEarlyToScore deliberately answers false for zero worked (a window with
  // no data at all is a different case), so without this the board would judge a period that opened
  // this morning on a handful of visits against its whole plan.
  if (board.range.todayLeftOut && board.workingDays === 0) {
    return {
      headline:
        "No working day of this period is over yet. Call rates start once today is over, and coverage and frequency climb from here.",
      tone: "noplan",
      standing: "Early days",
    };
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
function KpiHero({ board, showTitle, solo }: { board: KpisBoard; showTitle: boolean; solo: boolean }) {
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
          {/* On the scale (was an off-scale 11px), and one step larger on a phone only. */}
          <p className="text-phx-sm font-semibold uppercase tracking-[0.12em] text-slate-500 sm:text-phx-xs">
            {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
          </p>
        </div>
        <div className="min-w-0">
          {/* The team-standing signal: a flat tone pip beside the verdict. Flat colour only (owner, 22 Oct
              2026: nothing may look machine-made) — `tone.chip` carries the band, and `noplan` stays the
              quietest on the board. */}
          <div className={`flex items-center gap-2.5 border px-3.5 py-2.5 ${tone.chip}`}>
            <span
              aria-hidden
              className={`h-2.5 w-2.5 shrink-0 ${tone.bar}`}
            />
            <span className="min-w-0">
              {/* A medical rep's own board has no team to stand in — the pill says "Standing". */}
              <span className="block text-phx-xs font-black uppercase tracking-[0.16em] sm:text-phx-2xs">
                {solo ? "Standing" : "Team standing"}
              </span>
              <span className="mt-0.5 block text-phx-md font-black leading-tight">
                {verdict.standing ?? KPI_BAND_LABEL[verdict.tone]}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className={pageHeaderRuleClassName} />
    </section>
  );
}

// ── The overall KPI ───────────────────────────────────────────────────────────────────────────

/**
 * THE ONE NUMBER, with the arithmetic that produced it printed beside it.
 *
 * Owner, 2026-09-17: "consolidate the result of the call rate and the coverage and the frequency
 * and the KPIs in general into one percentage or one number ... so at the end of the day I can
 * measure the KPIs overall from Phoenix. Okay, let them separated as they are and consolidate them
 * based on average and mathematical actual calculations, and you must show in a line how it is
 * calculated."
 *
 * THE FORMULA LINE IS NOT DECORATION AND MUST NEVER BE DROPPED. It carries this board's own
 * numbers, so a manager can add the four tiles up by hand and land on the figure above — which is
 * the only thing that makes one consolidated number trustworthy on a board whose whole premise is
 * that its measures disagree on purpose. `crm/kpi-index.ts` writes both sentences; this panel only
 * places them.
 *
 * It sits ABOVE the six tiles and replaces none of them. Every measure stays exactly where it was.
 */
function KpiOverallPanel({ board, partial }: { board: KpisBoard; partial: boolean }) {
  const index = board.kpiIndex;
  const band = kpiBandOf(index.overallPct);
  const tone = toneOf(band);
  return (
    <div className="border-t border-slate-100 px-4 py-4 sm:px-5">
      {/* THE ONE NUMBER, framed flat: a white face and a left rule in the overall band's own colour. No
          gradient, glow or shadow (owner, 22 Oct 2026). Every string below is unchanged. */}
      <div className="relative overflow-hidden border border-slate-200 bg-white px-4 py-4">
        <span aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 w-1 ${tone.bar}`} />
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 pl-2">
          <div className="min-w-0">
            <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Overall KPI</p>
            <p className={`mt-1 text-[2.6rem] font-black leading-none tabular-nums ${tone.text}`}>{overallValue(index)}</p>
            <div className="mt-1.5 w-44 max-w-full">
              <KpiMeter band={band} value={index.overallPct} />
            </div>
          </div>
          {/* basis-full on a phone, so the explanation gets the whole width instead of a column
              three words wide; basis-0 from `sm` up, where it shares the row with the figure. */}
          <div className="min-w-0 flex-1 basis-full sm:basis-0">
            {/* One step larger below `sm` only: at 9–10px the arithmetic was the hardest line on a
                phone to read, and it is the line the owner asked for. Desktop is unchanged. */}
            <p className="text-phx-xs font-bold leading-4 text-slate-800 sm:text-phx-2xs">{index.formula}</p>
            <p className="mt-1 text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{index.method}</p>
            {partial ? (
              // A single number is the easiest thing on this board to misread mid-month — the four
              // tiles at least carry their own counts. So the caveat travels with it.
              <p className="mt-1 text-phx-2xs font-semibold leading-4 text-slate-600 sm:text-phx-3xs">
                {board.workingDays} of {board.workingDaysInWindow} working days are in, so this is a position in the
                period rather than a finished score.
              </p>
            ) : null}
          </div>
          {/* No chip when nothing could be scored: the band would print "No plan" over a rep
              population whose reason may have been no calls at all, and the line already says. */}
          {index.overallPct == null ? null : (
            <div className="min-w-0">
              <KpiBandChip band={band} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A no-break space: holds a figure and its label on one line (see tabHeadline). */
const NBSP = "\u00a0";

/** The number each tab puts under its own label, so the strip is a summary in its own right. */
function tabHeadline(board: KpisBoard, tab: KpiTab): string {
  const { totals } = board;
  // THE OVERALL KPI is the Summary tab's own number (owner, 2026-09-17) — the one figure the whole
  // board consolidates to. The head count it replaced here is still on screen twice over: its own
  // tile, and the filter bar's "12 of 73". Falls back to the head count when not one of the four
  // measures could be scored, because "No score reps" is not a sentence.
  //
  // Every figure is tied to its own label with a NO-BREAK SPACE (NBSP), so the only place a headline
  // can wrap is at " · ". Measured at 1024px with the sidebar open, "100% AM · 100% PM" broke as
  // "…100%" over "PM" — a figure separated from the half of the day it belongs to.
  if (tab === "summary") {
    return board.kpiIndex.overallPct == null
      ? `${totals.reps}${NBSP}rep${totals.reps === 1 ? "" : "s"}`
      : `${board.kpiIndex.overallPct}%${NBSP}overall`;
  }
  // NOT "1.63 / 6.57" — a slash between two rates reads as a fraction, and the owner read it as
  // one on 2026-09-04 ("you are putting the call rate out of six. No never."). They are two
  // separate rates against two separate targets, so they are labelled, never divided.
  if (tab === "call-rate") return `${rate(totals.amRate)}${NBSP}AM · ${rate(totals.pmRate)}${NBSP}PM`;
  if (tab === "coverage") return `${totals.coveragePct}%`;
  // THE TWO REPORTS' HEADLINES read against the rep's LIST, not his plan — a different denominator
  // from the four tabs above, which is why they are computed here rather than taken from `totals`.
  // The AM and PM figures are LABELLED and never divided, for the same reason the call-rate
  // headline is: a slash between two independent measures reads as a fraction.
  if (tab === "am-pm") {
    return `${listCoverage(board, "am")}${NBSP}AM · ${listCoverage(board, "pm")}${NBSP}PM`;
  }
  // What the tab lays out rather than a number: the strip is drawn from whichever board is on screen,
  // and a figure computed here would describe that board's period, not the weeks the tab shows.
  if (tab === "weekly") return "By week & month";
  if (tab === "pharmacies") {
    const withList = board.kpiReports.filter((report) => report.pharmacies.applicable).length;
    // "Not applicable" for the whole tab is a real answer when nobody in view carries pharmacies —
    // a 0% would read as "these reps covered no pharmacies", which is the opposite of the truth.
    return withList === 0 ? "Not applicable" : `${listCoverage(board, "pharmacy")} · ${withList}${NBSP}with a list`;
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
  // A report page (Coverage, Frequency, Call Rate in the portal) is one measure, not a set of tabs.
  if (context.tabs.length === 0) return null;
  return (
    <div className="grid grid-cols-2 border border-b-0 border-slate-200 bg-white sm:grid-cols-4">
      {context.tabs.map((tab, index) => {
        const current = tab === active;
        // SEVEN tabs since 2026-09-22, on a grid built for four. The hairline between rows is a border
        // rather than a gap so the strip stays one block, and it is set PER BREAKPOINT from the tab's
        // position: two to a row on a phone, so every tab from the third starts a new row's worth of
        // border; four to a row from `sm`, so only the fifth onward sits on a second row. (The old
        // rule dropped the line for EVERY tab from `sm`, so rows two and one ran together.)
        const rowLine =
          index >= 4 ? " border-t border-t-slate-200" : index >= 2 ? " border-t border-t-slate-200 sm:border-t-0" : "";
        // An odd count leaves one cell out, and it spans both columns to close the gap. An even count
        // (the portal's four consolidated tabs) leaves none, and a span there would orphan the last cell.
        const spanLast = context.tabs.length % 2 === 1 ? " last:col-span-2" : "";
        // `last:col-span-2`: seven cells leave an odd one out at both widths — the last cell of four
        // rows of two on a phone, and three in the second row of four from `sm`. Spanning two
        // columns closes the gap instead of leaving an empty half-cell or an empty eighth slot.
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={
              current
                ? `relative min-w-0 overflow-hidden border-b-2 border-b-orange-500 bg-orange-50 px-3 py-2.5 sm:px-5${spanLast}${rowLine}`
                : `relative min-w-0 border-b-2 border-b-transparent px-3 py-2.5 transition-colors hover:bg-slate-50 sm:px-5${spanLast}${rowLine}`
            }
            href={hrefWith(context, { tab })}
            key={tab}
          >
            {current ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-orange-500"
              />
            ) : null}
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
  for (const field of KPI_RANGE_FIELDS) {
    const range = filters.ranges[field];
    if (!range || (range.min == null && range.max == null)) continue;
    const unit = KPI_RANGE_UNIT[field] === "%" ? "%" : ` ${KPI_RANGE_UNIT[field]}`;
    const bounds =
      range.min != null && range.max != null
        ? `${range.min}–${range.max}${unit}`
        : range.min != null
          ? `${range.min}${unit} or more`
          : `${range.max}${unit} or less`;
    const kept = Object.fromEntries(Object.entries(filters.ranges).filter(([key]) => key !== field)) as KpiRangeFilters;
    chips.push({ key: `range:${field}`, label: `${KPI_RANGE_LABEL[field]}: ${bounds}`, next: { ...filters, ranges: kept } });
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
 * plan to measure against — the same guard every coverage reading on this board honours. A manager
 * row hands in its averaged coverage against the same floor. */
function coverageFloorBadge(row: Pick<KpiRepRow, "meetsCoverageFloor">): React.ReactNode {
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
  report,
  row,
  rules,
}: {
  /** A control under the name — the Coverage tab's "Show doctors". */
  action?: React.ReactNode;
  rank?: number;
  /** The report the row sits on, so it leaves another report's flags to that report (`KPI_FLAGS_OFF_REPORT`). */
  report?: KpiTab;
  row: KpiRepRow;
  rules?: KpisBoard["kpiRules"];
}) {
  const flags = kpiFlagsShownOn(row, report).filter(
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
        hireDate={row.hireDate}
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
              {repFlagLabel(row, flag, rules)}
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
      {/* SIX columns since 2026-09-17, when the owner asked for the four consolidated into one
          ("let them separated as they are and consolidate them"). The four measures are untouched
          and still five columns wide with the name — AM and PM stay apart, which is the thing he
          banned merging — and Overall is added at the end, where a total belongs.

          Percentages that sum to 100 on a `table-fixed`, no min-width floor anywhere: the
          fits-the-screen rule's own answer. The 17 points Overall needs came off the other five —
          three each from the name, Coverage and Frequency, four each from AM and PM, whose one-word
          heads are the narrowest on the board — rather than any type getting smaller.

          Every one of the six sits at or above its measured floor at the portal's 619px table
          (tests/kpis-board-tables-fit.test.ts, which goes red otherwise): name 23 of 23, Coverage
          17 of 17, Frequency 19 of 19, AM and PM 12 of 11, Overall 17 of 17. Only AM and PM carry a
          spare point, so room for anything new has to come from one of those two. */}
      <colgroup>
        <col style={{ width: "23%" }} />
        <col style={{ width: "17%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "17%" }} />
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
          {/* NOT SORTABLE, deliberately. The owner asked for the four consolidated into one figure
              he can read; he did not ask for the board to be RANKED by it, and a sortable overall
              is a blended rank — the one thing kpis-board.ts and the five podiums are built not to
              produce. The four measures each keep their own sort, so every ranking on this board is
              still a ranking on something real. */}
          <th className={TH} scope="col">
            Overall
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Average of 4
            </span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell
              action={summaryReportLinks(context, row)}
              rank={context.showRank ? index + 1 : undefined}
              row={row}
              rules={context.board.kpiRules}
            />
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
              caption={sessionCaption(row, "am", context.board.amTarget, "No calls logged")}
              fill={amFill(row)}
              value={amPct(row)}
            />
            <MeasureCell
              band={pmBandOf(row)}
              caption={sessionCaption(row, "pm", context.board.pmTarget, "No calls logged")}
              fill={pmFill(row)}
              value={pmPct(row)}
            />
            <OverallCell row={row} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One rep's consolidated KPI, in the same cell shape as the four measures beside it.
 *
 * Its own cell rather than a variant of {@link MeasureCell}, because the caption it needs is about
 * the AVERAGE — how many of the four it could use, and whether any of them ran over its standard —
 * and not about a count of doctors or calls.
 */
function OverallCell({ row }: { row: KpiRepRow }) {
  const overall = repKpiIndex(row);
  const band = kpiBandOf(overall.overallPct);
  return (
    <MeasureCell
      band={band}
      caption={overallCaption(overall, row)}
      fill={overall.overallPct}
      value={overallValue(overall, row)}
    />
  );
}

function CallRateTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { board } = context;
  const { filters } = board;
  const phoenix = isPhoenix(board);
  return (
    <table className="hidden w-full table-fixed md:table">
      {/* The Attainment column is gone: it held (AM + PM) over one denominator, which is the
          average the owner banned. Each side now carries its own score in its own column. PHARMACY
          and CAMPAIGN are the longest head words here, up to 111px at the 619px table (measured
          2026-09-16), so they get the most room; AM and PM are two-letter heads over lines that
          wrap. */}
      <colgroup>
        <col style={{ width: "24%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "13%" }} />
        <col style={{ width: "13%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "19%" }} />
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
      <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {rows.map((row, index) => (
          <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <RepCell
              action={callRateVisitsLink(context, row)}
              rank={context.showRank ? index + 1 : undefined}
              row={row}
              rules={context.board.kpiRules}
            />
            <td className={NUM}>{row.workingDays}</td>
            <td className={NUM}>
              {rate(row.amRate)} <span className="text-phx-3xs font-bold text-slate-400">of {board.amTarget}</span>
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {amPct(row)} ·{" "}
                {row.noGpsFeed
                  ? `${row.amReported} reported, none provable`
                  : `${row.amVerified} of ${row.workingDays * board.amTarget} asked for`}
                {followUpText(row, "am")}
              </span>
            </td>
            <td className={NUM}>
              {rate(row.pmRate)} <span className="text-phx-3xs font-bold text-slate-400">of {board.pmTarget}</span>
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {pmPct(row)} ·{" "}
                {row.noGpsFeed
                  ? `${row.pmReported} reported, none provable`
                  : `${row.pmVerified} of ${row.workingDays * board.pmTarget} asked for`}
                {followUpText(row, "pm")}
              </span>
            </td>
            <td className={NUM}>
              {pharmacyValue(row)}
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.noGpsFeed
                  ? `${row.pharmacyReported} reported`
                  : `${row.pharmacyVerified} ${phoenix ? "visits" : "verified"}`}
              </span>
            </td>
            <td className={NUM}>
              {Math.round(row.campaignShare * 100)}%
              <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                {row.campaignCalls} calls
                {!phoenix && row.campaignOnlyDays > 0 ? ` · ${row.campaignOnlyDays} day(s) campaign only` : ""}
              </span>
              {/* Its own line with its own label, never concatenated onto the Campaign caption above —
                  rule 10 (owner, 2026-09-20) requires this identified on its own, never read as part
                  of Campaign, even though it shares this merged column. */}
              {phoenix && row.phoenix && row.phoenix.regularNoCheckin > 0 ? (
                <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                  {row.phoenix.regularNoCheckin} Regular, no check-in
                </span>
              ) : null}
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
/** The id the opened doctors panel carries, so its toggle can name it in `aria-controls`. */
function coverageDetailId(repKey: string): string {
  return `kpi-doctors-${repKey}`;
}

function coverageDoctorsToggle(context: ViewContext, row: KpiRepRow, surface: "desktop" | "mobile"): React.ReactNode {
  const key = row.coverageRepKey;
  if (!key || !row.hasMeasurablePlan || context.board.reps.length === 1) return null;
  const open = context.openRep === key;
  return (
    <Link
      {...rowDetailToggleProps(coverageDetailId(key), open)}
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

/**
 * "N doctors not validated yet" under a rep's Coverage and Frequency figures (owner, 2026-10-29), a
 * link that opens his list already narrowed to those doctors. Null when the count is 0 or was never
 * read — a failed brick read prints nothing rather than a 0 — and for a rep who has just started.
 */
function notValidatedLink(context: ViewContext, row: KpiRepRow, surface: "desktop" | "mobile"): React.ReactNode {
  const key = row.coverageRepKey;
  const count = row.notValidatedDoctors ?? 0;
  if (!key || count <= 0) return null;
  const { board } = context;
  return (
    <Link
      className="text-phx-3xs font-bold leading-4 text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-orange-700 hover:decoration-orange-500"
      href={`${hrefWith(context, {
        // A board of one rep opens that rep's list unasked, so the rep's key never rides in the URL.
        rep: board.reps.length === 1 ? null : key,
        filters: { ...board.filters, doctor: { ...EMPTY_KPI_DOCTOR_FILTER, bricks: [KPI_DOCTOR_NOT_VALIDATED] } },
      })}#${coverageAnchor(surface, key)}`}
    >
      {count} doctor{count === 1 ? "" : "s"} not validated yet
    </Link>
  );
}

/** Two notes under one figure, one above the other; null when there is neither. */
function stackExtras(first: React.ReactNode, second: React.ReactNode): React.ReactNode {
  if (!first) return second || null;
  if (!second) return first;
  return (
    <span className="flex flex-col items-start gap-1">
      {first}
      {second}
    </span>
  );
}

/**
 * "Open visits" for one rep on the Call Rate tab — the drill-down onto the very calls this row's rate
 * is made of, at /…/kpis/call-rate/[rep], scored over the same window the board is on.
 *
 * A LINK, like every control on this board, so the drill-down re-runs the server-side scope gate. Null
 * when the row has no key (neither a CRM account nor a resolved hr id) or logged nothing at all in the
 * window — there is then nothing to open. The key is the board's own call-rate identity
 * (`kpiCallRateRepKey`), which the visits page resolves back to this row.
 */
function callRateVisitsLink(context: ViewContext, row: KpiRepRow): React.ReactNode {
  if (!row.hasCallRate) return null;
  const key = kpiCallRateRepKey(row);
  if (!key) return null;
  const query = new URLSearchParams({ month: context.board.month });
  if (context.board.range.periodKey !== "month") query.set("period", context.board.range.periodKey);
  return (
    <Link
      className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold text-slate-600 transition-colors hover:border-slate-500 hover:text-slate-900"
      href={`${kpiCallRateRepPath(context.rootPath, key)}?${query.toString()}`}
    >
      <span>Open visits</span>
      <span aria-hidden>→</span>
    </Link>
  );
}

/**
 * The Summary row's way into the three reports for ONE rep: Coverage and Frequency open that rep's
 * doctor list, Call Rate opens the visits behind the rate. Portal only — the admin shell keeps its
 * tab strip, and the report pages exist only under the portal's root.
 *
 * Every one is a LINK, so each report re-runs the server-side scope gate. The doctor filters are reset
 * (another report, another person's doctors) and the month and period ride along. Null when the rep
 * has nothing to open.
 */
function summaryReportLinks(context: ViewContext, row: KpiRepRow): React.ReactNode {
  if (context.basePath !== PORTAL_KPIS_ROOT_PATH) return null;
  const key = row.coverageRepKey;
  const plan = key && row.hasMeasurablePlan;
  const visits = callRateVisitsLink(context, row);
  if (!plan && !visits) return null;
  const className =
    "inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-phx-2xs font-bold text-slate-600 transition-colors hover:border-slate-500 hover:text-slate-900";
  const reportHref = (tab: "coverage" | "frequency") =>
    `${PORTAL_KPI_REPORT_PATH[tab]}?${buildKpisQuery({
      month: context.board.month,
      period: context.board.range.periodKey,
      tab,
      filters: { ...context.board.filters, doctor: EMPTY_KPI_DOCTOR_FILTER },
      rep: key,
    })}`;
  return (
    <span className="flex flex-wrap gap-1">
      {plan ? (
        <>
          <Link className={className} href={reportHref("coverage")}>
            <span>Coverage</span>
            <span aria-hidden>→</span>
          </Link>
          <Link className={className} href={reportHref("frequency")}>
            <span>Frequency</span>
            <span aria-hidden>→</span>
          </Link>
        </>
      ) : null}
      {visits}
    </span>
  );
}

/**
 * The doctor's name with his speciality, grade and brick under it. Never his id — a missing name says
 * so. The brick prints only when it was read (see `KpiDoctorFilterable`), so a failed read never shows
 * a doctor as "not validated".
 */
function CoverageDoctorName({ doctor }: { doctor: KpiCoverageDoctor }) {
  const meta = [doctor.speciality, doctor.grade ? `Grade ${doctor.grade}` : null, kpiDoctorBrickLabel(doctor)]
    .filter(Boolean)
    .join(" · ");
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
 * The doctor filter bar for the open rep, fed the rep's WHOLE list so its options and counts do not
 * collapse onto whatever is already selected. The tiles and breakdowns above the list stay on the
 * whole list too — they add up to the numbers on his row — and only the rows printed are narrowed.
 */
function DoctorFilters({
  context,
  doctors,
  shown,
}: {
  context: ViewContext;
  doctors: readonly KpiCoverageDoctor[];
  shown: number;
}) {
  const { board } = context;
  return (
    <KpisDoctorFilterBar
      basePath={context.basePath}
      facets={buildKpiDoctorFacets(doctors)}
      filters={board.filters}
      month={board.month}
      period={board.range.periodKey}
      rep={context.openRep}
      shown={shown}
      tab={context.tab}
      total={doctors.length}
      view={context.callRateView}
    />
  );
}

/** One line saying the doctors are in the order asked for, or null while the report's own order stands. */
function doctorSortNote(filters: KpiFilterState): string | null {
  const { sort, direction } = filters.doctor;
  if (sort === "default") return null;
  const asc = direction === "asc";
  const way =
    sort === "visits" ? (asc ? "fewest first" : "most first") : sort === "last" ? (asc ? "oldest first" : "newest first") : asc ? "A to Z" : "Z to A";
  return `Ordered by ${KPI_DOCTOR_SORT_LABEL[sort].toLowerCase()}, ${way}`;
}

/** The open rep's two lists with the doctor filters applied. `default` order keeps each list's own. */
function narrowDetail(detail: KpiCoverageDetail, filters: KpiFilterState): KpiCoverageDetail {
  return {
    ...detail,
    covered: filterKpiDoctors(detail.covered, filters.doctor),
    notCovered: filterKpiDoctors(detail.notCovered, filters.doctor),
  };
}

/**
 * Both lists for the open rep. `surface` decides the shape only: two fixed-layout tables side by side
 * from `lg` inside the desktop row, stacked cards under the phone card.
 */
function CoverageDoctors({
  context,
  detail: full,
  surface,
}: {
  context: ViewContext;
  detail: KpiCoverageDetail;
  surface: "desktop" | "mobile";
}) {
  const { board } = context;
  const period = board.range.isWholeMonth ? board.monthLabel : board.range.periodLabel;
  const planned = full.covered.length + full.notCovered.length;
  // The lists below print the narrowed rows; the caption and the summary stay on the whole list.
  const narrowing = hasActiveKpiDoctorFilter(board.filters.doctor);
  const sortNote = doctorSortNote(board.filters);
  const detail = narrowDetail(full, board.filters);
  const notDue = detail.notCovered.filter((doctor) => !doctor.due).length;
  const due = detail.notCovered.length - notDue;

  const covered = (
    <CoverageListCard
      count={detail.covered.length}
      empty={narrowing ? "No covered doctor matches these filters." : "No planned doctor has been visited in this period yet."}
      hint={sortNote ?? "Seen at least once · latest visit first"}
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
          <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
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
      empty={narrowing ? "No uncovered doctor matches these filters." : "Every planned doctor has been visited at least once."}
      hint={
        sortNote ??
        (notDue > 0 ? `${due} due · ${notDue} not due yet · oldest planned day first` : "Oldest planned day first")
      }
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
          <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
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
      <CoverageSummary context={context} detail={full} />
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">
          Doctors planned in {period}
        </p>
        <p className={`mt-0.5 leading-4 ${CAPTION}`}>
          {planned === 0
            ? `No doctor was planned for ${full.repName} in this period.`
            : `${full.repName}: ${full.covered.length} of ${planned} seen at least once. Not covered means no visit in the period yet — a doctor whose planned day is still ahead is marked Not due yet.`}
        </p>
      </div>
      {planned === 0 ? null : (
        <DoctorFilters
          context={context}
          doctors={[...full.covered, ...full.notCovered]}
          shown={detail.covered.length + detail.notCovered.length}
        />
      )}
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

/** One slot in the phone list: a team's heading, or one rep with his place on the whole board. */
type CardSlot = { heading: KpiTeamWithCoverage | null; row: KpiRepRow | null; index: number };

/**
 * The phone list's slots. With two teams or more (the Coverage tab only), each team's heading and then its
 * reps; otherwise the board's rows as they come. Every rep appears exactly once, either way.
 */
function cardSlots(teams: readonly KpiTeamWithCoverage[], reps: readonly KpiRepRow[]): CardSlot[] {
  if (teams.length < 2) return reps.map((row, index) => ({ heading: null, row, index }));
  return teams.flatMap((entry) => [
    { heading: entry, row: null, index: -1 },
    ...entry.team.members.map((member) => ({ heading: null, row: member.row, index: member.boardIndex })),
  ]);
}

function CoverageTable({
  context,
  rows,
  teams,
}: {
  context: ViewContext;
  rows: KpiRepRow[];
  /** The reps filed under their region and direct manager (`groupKpiRepsByTeam`), headed from two teams up. */
  teams: readonly KpiTeamWithCoverage[];
}) {
  const { coverageDetail: detail, filters } = context.board;
  // A heading per team only when there is more than one: a single team is the board itself. Each row keeps
  // its place on the WHOLE board, so a rank disc reads the board's own number under every heading.
  const sections: ReadonlyArray<{ entry: KpiTeamWithCoverage | null; members: ReadonlyArray<{ row: KpiRepRow; boardIndex: number }> }> =
    teams.length >= 2
      ? teams.map((entry) => ({ entry, members: entry.team.members }))
      : [{ entry: null, members: rows.map((row, boardIndex) => ({ row, boardIndex })) }];
  return (
    <table className="hidden w-full table-fixed md:table">
      {/* The detail row below spans every column: its colSpan moves with this colgroup. */}
      <colgroup>
        <col style={{ width: "23%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "18%" }} />
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
      {sections.map((section) => (
        <tbody className="divide-y divide-slate-100" key={section.entry?.team.key ?? "all"}>
          {section.entry ? <KpiTeamHeadingRow columns={6} entry={section.entry} /> : null}
          {section.members.map(({ boardIndex: index, row }) => (
          <Fragment key={row.agentCrmId ?? `${row.repName}-${index}`}>
            <tr
              className="scroll-mt-20"
              id={row.coverageRepKey ? coverageAnchor("desktop", row.coverageRepKey) : undefined}
            >
              <RepCell
                action={coverageDoctorsToggle(context, row, "desktop")}
                rank={context.showRank ? index + 1 : undefined}
                report="coverage"
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
                extra={stackExtras(coverageFloorBadge(row), notValidatedLink(context, row, "desktop"))}
                fill={coverageFill(row)}
                value={planPct(row, row.coveragePct)}
              />
            </tr>
            {detail && row.coverageRepKey === detail.repKey ? (
              <TableRowDetail className="px-4 py-4 sm:px-5" colSpan={6} id={coverageDetailId(detail.repKey)}>
                  <CoverageDoctors context={context} detail={detail} surface="desktop" />
                </TableRowDetail>
            ) : null}
          </Fragment>
          ))}
        </tbody>
      ))}
    </table>
  );
}

function FrequencyTable({ context, rows }: { context: ViewContext; rows: KpiRepRow[] }) {
  const { coverageDetail: detail, filters } = context.board;
  const phoenix = isPhoenix(context.board);
  return (
    <table className="hidden w-full table-fixed md:table">
      {/* Five columns for five cells. This colgroup once carried a sixth, copied from Coverage,
          which left a blank 26% strip at the right and squeezed Frequency into 12%. */}
      <colgroup>
        <col style={{ width: "25%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "21%" }} />
        <col style={{ width: "22%" }} />
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
      <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
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
              extra={notValidatedLink(context, row, "desktop")}
              fill={frequencyFill(row)}
              value={planPct(row, row.frequencyPct)}
            />
          </tr>
          {detail && row.coverageRepKey === detail.repKey ? (
            <TableRowDetail className="px-4 py-4 sm:px-5" colSpan={5} id={coverageDetailId(detail.repKey)}>
                <FrequencyDoctors context={context} detail={detail} surface="desktop" />
              </TableRowDetail>
          ) : null}
          </Fragment>
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
  notValidated,
  pmTarget,
  rank,
  report,
  row,
  rules,
}: {
  /** A control under the card, e.g. the Coverage tab's "Show doctors". */
  action?: React.ReactNode;
  amTarget: number;
  /** The Coverage and Frequency tabs' "N doctors not validated yet" link, printed under Coverage. */
  notValidated?: React.ReactNode;
  pmTarget: number;
  rank?: number;
  /** The report the card sits on — the phone half of {@link RepCell}'s `report`, the same rule. */
  report?: KpiTab;
  row: KpiRepRow;
  rules?: KpisBoard["kpiRules"];
}) {
  const overall = repKpiIndex(row);
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
      extra: stackExtras(coverageFloorBadge(row), notValidated),
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
      // The value already says "No calls" when there are none, so the caption says nothing then.
      caption: sessionCaption(row, "am", amTarget, ""),
      fill: amFill(row),
      label: "AM call rate",
      value: amPct(row),
    },
    {
      band: pmBandOf(row),
      caption: sessionCaption(row, "pm", pmTarget, ""),
      fill: pmFill(row),
      label: "PM call rate",
      value: pmPct(row),
    },
    {
      // "noplan" here means "no target to be a percentage of" — not "no calls". kpiBandOf(null) is
      // always this band because pharmacyAttainmentPct is always null (see
      // PHARMACY_CALL_RATE_TARGET); the caption says why, so the chip does not read as a fault.
      band: kpiBandOf(row.pharmacyAttainmentPct),
      caption: row.noGpsFeed
        ? `${row.pharmacyReported} reported · none provable`
        : row.hasCallRate
          ? `${row.pharmacyVerified} ${row.phoenix ? "visits" : "verified"} · no target set yet`
          : "",
      fill: null,
      label: "Pharmacy",
      value: pharmacyValue(row),
    },
    // THE SIXTH CELL is the consolidated figure (owner, 2026-09-17), and it is LAST here for the
    // same reason it is the last column on the desktop table: a total reads after the things it
    // totals. Six measures fill the three-column grid exactly, so the card gains a row and no
    // width — the fits-the-screen rule is untouched.
    {
      band: kpiBandOf(overall.overallPct),
      caption: overallCaption(overall, row),
      fill: overall.overallPct,
      label: "Overall",
      value: overallValue(overall, row),
    },
  ];
  const flags = kpiFlagsShownOn(row, report).filter(
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
        hireDate={row.hireDate}
        jobTitle={row.jobTitle}
        lineName={row.lineName}
        name={row.repName}
        rank={rank}
      />
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        {measures.map((measure) => (
          <div className="min-w-0" key={measure.label}>
            {/* The card is phone-only (md:hidden), and at 9px its labels and captions were the
                smallest type on the board — one step up below `sm`, unchanged from `sm`. */}
            <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400 sm:text-phx-3xs">{measure.label}</dt>
            <dd className={`mt-0.5 text-sm font-black tabular-nums ${toneOf(measure.band).text}`}>{measure.value}</dd>
            <KpiMeter band={measure.band} value={measure.fill} />
            {measure.caption ? (
              <dd className="mt-1 text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{measure.caption}</dd>
            ) : null}
            {measure.extra ? <dd className="mt-1">{measure.extra}</dd> : null}
          </div>
        ))}
      </dl>
      {row.hasCallRate ? (
        <p className="mt-1.5 text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">
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
              {repFlagLabel(row, flag, rules)}
            </span>
          ))}
        </div>
      ) : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

// ── Coverage: the summary above one rep's two lists ───────────────────────────────────────────

/** A grade letter's group, with everything else (blank, unscored, "D"…) filed under one honest label. */
function gradeGroupOf(grade: string | null): string {
  const letter = (grade ?? "").trim().toUpperCase().charAt(0);
  return letter === "A" || letter === "B" || letter === "C" ? `Grade ${letter}` : "No grade";
}

type CoverageGroupRow = { label: string; planned: number; covered: number; href?: string };

/** Planned and covered doctors per group, biggest group first. A tie keeps the groups' alphabetical order. */
function coverageGroups(doctors: readonly KpiCoverageDoctor[], keyOf: (doctor: KpiCoverageDoctor) => string): CoverageGroupRow[] {
  const groups = new Map<string, CoverageGroupRow>();
  for (const doctor of doctors) {
    const label = keyOf(doctor);
    const row = groups.get(label) ?? { label, planned: 0, covered: 0 };
    row.planned += 1;
    if (doctor.visits > 0) row.covered += 1;
    groups.set(label, row);
  }
  return [...groups.values()].sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label));
}

/** A group's name, as a link into the list narrowed to that group when it has one. */
function BreakdownLabel({ row }: { row: CoverageGroupRow }) {
  if (!row.href) return <>{row.label}</>;
  return (
    <Link className="underline decoration-slate-300 underline-offset-2 hover:text-orange-700 hover:decoration-orange-500" href={row.href}>
      {row.label}
    </Link>
  );
}

/** A count in a brick line: a link into that brick's doctors with that verdict, when there are any. */
function BrickCount({ count, href }: { count: number; href?: string }) {
  if (count === 0 || !href) return <>{count}</>;
  return (
    <Link className="underline decoration-slate-300 underline-offset-2 hover:text-orange-700 hover:decoration-orange-500" href={href}>
      {count}
    </Link>
  );
}

/**
 * COVERAGE AND FREQUENCY PER BRICK of the doctors' validated live photo (owner, 2026-10-29: "filter by
 * brick, got the doctors in it, know who is covered and who is not covered", then "frequency by brick
 * … beside the coverage table"). The rows are `buildKpiBrickRows`, so the screen and the XLSX export
 * count the same way. For the open rep each brick and each count is a link into his list narrowed to
 * it; the team's table (`team`) links nowhere — no one list holds its doctors — and says how many reps
 * plan doctors in each brick instead. Five columns on a desktop, one card per brick on a phone.
 */
function BrickBreakdown({
  caption,
  context,
  rows,
  team = false,
  title,
}: {
  caption?: string;
  context: ViewContext;
  rows: readonly KpiBrickRow[];
  team?: boolean;
  title: string;
}) {
  if (rows.length === 0) return null;
  const { board } = context;
  const columns = kpiBrickFrequencyColumns(isPhoenix(board));
  const hrefFor = (row: KpiBrickRow, statuses?: KpiDoctorStatus[]) =>
    team
      ? undefined
      : hrefWith(context, {
          filters: {
            ...board.filters,
            doctor: { ...board.filters.doctor, bricks: [row.brick], ...(statuses ? { statuses } : {}) },
          },
        });
  const pctOf = (row: KpiBrickRow) => Math.round((row.covered / row.planned) * 100);
  const repsText = (row: KpiBrickRow) => `${row.reps} rep${row.reps === 1 ? "" : "s"}`;
  return (
    <div className="min-w-0 border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</p>
        {caption ? <p className="mt-0.5 text-phx-3xs leading-4 text-slate-500">{caption}</p> : null}
      </div>
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col style={{ width: "31%" }} />
          <col style={{ width: "21%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "16%" }} />
        </colgroup>
        <thead className="border-b border-slate-100">
          <tr>
            <th className={TH} scope="col">
              Brick
            </th>
            <th className={TH} scope="col">
              Coverage
              <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
                Covered ÷ planned
              </span>
            </th>
            {columns.map((column) => (
              <th className={TH} key={column.label} scope="col">
                {column.label}
                <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
                  {column.sub}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const pct = pctOf(row);
            return (
              <tr key={row.brick}>
                <td className={TD} dir="auto">
                  <BreakdownLabel row={{ label: row.label, planned: row.planned, covered: row.covered, href: hrefFor(row) }} />
                  {team ? <span className="mt-0.5 block text-phx-3xs leading-4 text-slate-500">{repsText(row)}</span> : null}
                </td>
                <td className={NUM}>
                  <span className={`block font-black ${toneOf(coverageBandOfPct(pct)).text}`}>{pct}%</span>
                  <KpiMeter band={coverageBandOfPct(pct)} value={pct} />
                  <span className="mt-1 block text-phx-3xs font-semibold leading-4 text-slate-500">
                    {row.covered} of {row.planned} seen
                  </span>
                </td>
                {columns.map((column) => (
                  <td className={NUM} key={column.label}>
                    <BrickCount count={column.count(row)} href={hrefFor(row, column.statuses)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((row) => {
          const pct = pctOf(row);
          return (
            <li className="px-3 py-2.5" key={row.brick}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm font-semibold text-slate-900" dir="auto">
                  <BreakdownLabel row={{ label: row.label, planned: row.planned, covered: row.covered, href: hrefFor(row) }} />
                </span>
                <span className={`text-sm font-black tabular-nums ${toneOf(coverageBandOfPct(pct)).text}`}>{pct}%</span>
              </div>
              <KpiMeter band={coverageBandOfPct(pct)} value={pct} />
              <span className="mt-1 block text-phx-3xs leading-4 text-slate-500">
                {row.covered} of {row.planned} planned doctors seen{team ? ` · ${repsText(row)}` : ""}
              </span>
              <span className="mt-0.5 block text-phx-3xs leading-4 text-slate-500">
                {columns.map((column) => `${column.count(row)} ${column.label.toLowerCase()}`).join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * THE TEAM'S BRICKS on the Coverage and Frequency tabs (owner, 2026-10-29: "a brick view for managers
 * across all their reps"), under the rep table. Every rep's list is counted on its own, as Planned is,
 * so its totals are the tiles'; reps who have just started are left out of both.
 */
function TeamBricksSection({ context, rows }: { context: ViewContext; rows: readonly KpiBrickRow[] }) {
  return (
    <div className="border-t border-slate-100">
      <KpiSection
        description="Every rep's planned doctors, counted by the brick of the doctor's validated live photo. A doctor two reps both plan counts once for each, as Planned does, and reps who have just started are left out, as they are from the totals. Open a rep's doctors to see who is in each brick."
        title="By brick · every rep on this board"
      >
        {context.tab === "coverage" ? <KpiBrickGlance rows={rows} /> : null}
        <div className="px-4 py-4 sm:px-5">
          <BrickBreakdown context={context} rows={rows} team title="From the validated live photo" />
        </div>
      </KpiSection>
    </div>
  );
}

/** The coverage percentage's band — the same cut-offs the rep rows use, applied to a group's own percentage. */
function coverageBandOfPct(pct: number): KpiBand {
  return kpiBandOf(pct);
}

/**
 * THE COVERAGE REPORT'S HEADER FOR ONE REP — premium pass, 9 Nov 2026. The four counts the two lists below
 * add up to; the planned list as one track against the 95% floor; the doctors to see first to clear it; how
 * late the late ones are; how often the covered ones were seen; and the same doctors by brick, by the week
 * planned, by grade and by speciality.
 *
 * Everything here is crm/kpi-coverage-rep-detail.ts counting the two lists the server already built for
 * this rep (the WHOLE lists — the doctor filters narrow only the lists below), so nothing on it can disagree
 * with the Covered and Not reached numbers on the rep's row. Every count that has doctors behind it is a
 * link into the list narrowed to exactly them, through the doctor filter's own fields.
 */
function CoverageSummary({ context, detail }: { context: ViewContext; detail: KpiCoverageDetail }) {
  const { board } = context;
  const summary = kpiRepCoverageSummary(detail, board.coverageFloorPct);
  if (!summary) return null;
  const all = [...detail.covered, ...detail.notCovered];
  const doctorHref = (patch: Partial<KpiDoctorFilter>) =>
    hrefWith(context, { filters: { ...board.filters, doctor: { ...board.filters.doctor, ...patch } } });
  const groupLinks = (patch: Partial<KpiDoctorFilter>): KpiCoverageGroupLinks => ({
    group: doctorHref({ ...patch, timing: [] }),
    late: doctorHref({ ...patch, timing: ["late"] }),
    ahead: doctorHref({ ...patch, timing: ["not-due"] }),
  });
  const lateHref = doctorHref({ timing: ["late"] });
  const aheadHref = doctorHref({ timing: ["not-due"] });
  const grades = kpiCoverageByGrade(detail).map((row) => ({ ...row, links: groupLinks({ grades: [row.label] }) }));
  const specialities = kpiCoverageBySpeciality(detail).map((row) => ({
    ...row,
    links: groupLinks({ specialities: [row.label === KPI_NO_SPECIALITY ? KPI_DOCTOR_NO_SPECIALITY : row.label] }),
  }));
  const steps = kpiFloorPath(detail, summary, board.asOf);
  const buckets = kpiLateAgeing(detail, board.asOf);
  const ageing = <KpiLateAgeingPanel asOf={board.asOf} buckets={buckets} lateHref={lateHref} />;
  const depth = <KpiRepVisitDepth summary={summary} />;
  return (
    <div className="space-y-3">
      <KpiRepCoverageTiles summary={summary} />
      <KpiFloorTrack aheadHref={aheadHref} lateHref={lateHref} summary={summary} />
      {board.isCurrentMonth ? (
        <p className={`leading-4 ${CAPTION}`}>
          The period is still running, so doctors planned for later days are counted as not covered yet.
        </p>
      ) : null}
      {steps.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <KpiFloorPathPanel steps={steps} summary={summary} />
          <div className="min-w-0 space-y-3">
            {ageing}
            {depth}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ageing}
          {depth}
        </div>
      )}
      <BrickBreakdown context={context} rows={buildKpiBrickRows([all])} title="By brick · from the validated live photo" />
      <KpiCoverageWeekTable weeks={kpiCoverageByWeek(detail, board.asOf)} />
      <div className="grid gap-3 lg:grid-cols-2">
        <KpiCoverageGroupTable groupHeading="Grade" rows={grades} title="By grade" />
        <KpiCoverageGroupTable groupHeading="Speciality" rows={specialities} title="By speciality" />
      </div>
    </div>
  );
}

// ── The Frequency report: one rep's doctors, each against what he should get ─────────────────

/** Which of the board's five tones each verdict wears, so a chip here reads like every other chip. */
const FREQUENCY_STATUS_BAND: Record<DoctorFrequencyStatus, KpiBand> = {
  exact: "elite",
  "at-norm": "elite",
  above: "steady",
  below: "behind",
  "not-visited": "behind",
  "not-due": "noplan",
  ungraded: "noplan",
};

/** Worst first: a doctor who has not been seen leads, and the ones on target sit last. */
const FREQUENCY_STATUS_ORDER: Record<DoctorFrequencyStatus, number> = {
  "not-visited": 0,
  below: 1,
  above: 2,
  "not-due": 3,
  ungraded: 4,
  exact: 5,
  "at-norm": 5,
};

function FrequencyStatusChip({ status }: { status: DoctorFrequencyStatus }) {
  const tone = toneOf(FREQUENCY_STATUS_BAND[status]);
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.1em] ${tone.chip}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 ${tone.dot}`} />
      {KPI_FREQUENCY_STATUS_LABEL[status]}
    </span>
  );
}

type FrequencyDoctorRow = { doctor: KpiCoverageDoctor; frequency: NonNullable<KpiCoverageDoctor["frequency"]> };

/**
 * How far one doctor is from where the plan or the norm puts them: negative is short, positive is extra, zero is on
 * target, null where there is nothing to compare (not graded, or not due yet).
 *
 * On the plan basis the shortfall is measured against the calls that have COME DUE and the excess
 * against the WHOLE period's calls, for the reason `frequencyStatusOf` gives: a rep who is behind
 * today's schedule can still catch up, one who has gone past the month's total cannot undo it.
 */
function frequencyGap(frequency: FrequencyDoctorRow["frequency"]): number | null {
  if (frequency.required == null || frequency.status === "not-due" || frequency.status === "ungraded") return null;
  if (frequency.basis === "plan" && frequency.actual > frequency.required) return frequency.actual - frequency.required;
  return frequency.actual - (frequency.dueSoFar ?? frequency.required);
}

function frequencyGapText(frequency: FrequencyDoctorRow["frequency"]): string {
  const gap = frequencyGap(frequency);
  if (gap == null) return "—";
  if (gap === 0) return "On target";
  if (gap < 0) return `${Math.abs(gap)} short`;
  // Ahead of the schedule but inside the month's total: still exact, so it is not "extra".
  if (frequency.basis === "plan" && frequency.required != null && frequency.actual <= frequency.required) return `${gap} ahead`;
  return `${gap} extra`;
}

/**
 * The visits made as a share of the visits the plan or the norm asks for, for the meter under the
 * Visited figure. Capped by the meter itself at a full bar, so extra visits never read as more than
 * done; null where nothing is asked, so a doctor with no grade carries no bar rather than an empty one.
 */
function visitFill(frequency: FrequencyDoctorRow["frequency"]): number | null {
  return frequency.required != null && frequency.required > 0
    ? Math.round((frequency.actual / frequency.required) * 100)
    : null;
}

function frequencyRows(detail: KpiCoverageDetail): FrequencyDoctorRow[] {
  return [...detail.covered, ...detail.notCovered]
    .flatMap((doctor) => (doctor.frequency ? [{ doctor, frequency: doctor.frequency }] : []))
    .sort((left, right) => {
      const byStatus = FREQUENCY_STATUS_ORDER[left.frequency.status] - FREQUENCY_STATUS_ORDER[right.frequency.status];
      if (byStatus !== 0) return byStatus;
      // Inside a verdict the biggest shortfall leads.
      const byGap = (frequencyGap(left.frequency) ?? 0) - (frequencyGap(right.frequency) ?? 0);
      if (byGap !== 0) return byGap;
      return (left.doctor.name ?? "~").localeCompare(right.doctor.name ?? "~");
    });
}

/** The doctor's name, his speciality and grade, and the days the plan booked him — never his id. */
function FrequencyDoctorName({ doctor }: { doctor: KpiCoverageDoctor }) {
  return (
    <span className="block min-w-0">
      <CoverageDoctorName doctor={doctor} />
      <span className="mt-0.5 block text-phx-3xs leading-4 text-slate-400">
        Planned {doctor.planDates.length > 0 ? planDaysLabel(doctor) : "on no day"}
      </span>
    </span>
  );
}

/** The visits asked for, with what has come due beside it where the plan spreads them over the month. */
function requiredText(frequency: FrequencyDoctorRow["frequency"]): string {
  return frequency.required == null ? "—" : String(frequency.required);
}

function requiredCaption(frequency: FrequencyDoctorRow["frequency"], phoenix: boolean): string {
  if (frequency.required == null) return "No grade, so no norm";
  if (phoenix || frequency.basis === "grade") return "The grade's norm";
  return frequency.dueSoFar === frequency.required
    ? "All due"
    : `${frequency.dueSoFar ?? 0} due so far`;
}

function FrequencyDoctors({
  context,
  detail,
  surface,
}: {
  context: ViewContext;
  detail: KpiCoverageDetail;
  surface: "desktop" | "mobile";
}) {
  const { board } = context;
  const phoenix = isPhoenix(board);
  const period = board.range.isWholeMonth ? board.monthLabel : board.range.periodLabel;
  const rows = frequencyRows(detail);

  if (rows.length === 0) {
    return (
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">Doctors planned in {period}</p>
        <p className={`mt-0.5 leading-4 ${CAPTION}`}>No doctor was planned for {detail.repName} in this period.</p>
      </div>
    );
  }

  // The tiles, the breakdown and the verdict counts below describe the rep's WHOLE list and add up to
  // his row; only the doctors printed in the table are narrowed by the filters.
  const rowOf = new Map(rows.map((row) => [row.doctor, row] as const));
  const visible = filterKpiDoctors(
    rows.map((row) => row.doctor),
    board.filters.doctor,
  ).flatMap((doctor) => {
    const row = rowOf.get(doctor);
    return row ? [row] : [];
  });
  const narrowing = hasActiveKpiDoctorFilter(board.filters.doctor);
  const sortNote = doctorSortNote(board.filters);

  let asked = 0;
  let due = 0;
  let made = 0;
  let owed = 0;
  const byStatus = new Map<DoctorFrequencyStatus, number>();
  for (const { frequency } of rows) {
    byStatus.set(frequency.status, (byStatus.get(frequency.status) ?? 0) + 1);
    if (frequency.required == null) continue;
    asked += frequency.required;
    due += frequency.dueSoFar ?? frequency.required;
    made += frequency.actual;
    owed += Math.max(0, (frequency.dueSoFar ?? frequency.required) - frequency.actual);
  }
  const judged = rows.filter(({ frequency }) => frequency.status !== "ungraded" && frequency.status !== "not-due");
  const passing = judged.filter(({ frequency }) => frequency.status === "exact" || frequency.status === "at-norm").length;
  const pct = judged.length > 0 ? Math.round((passing / judged.length) * 100) : null;
  const gradeGroups = coverageGroups(
    rows.map((row) => row.doctor),
    (doctor) => gradeGroupOf(doctor.grade),
  ).sort((left, right) => left.label.localeCompare(right.label));
  const gradeAsked = new Map<string, { asked: number; made: number; passing: number; judged: number }>();
  for (const { doctor, frequency } of rows) {
    const key = gradeGroupOf(doctor.grade);
    const slot = gradeAsked.get(key) ?? { asked: 0, made: 0, passing: 0, judged: 0 };
    if (frequency.required != null) {
      slot.asked += frequency.required;
      slot.made += frequency.actual;
    }
    if (frequency.status !== "ungraded" && frequency.status !== "not-due") {
      slot.judged += 1;
      if (frequency.status === "exact" || frequency.status === "at-norm") slot.passing += 1;
    }
    gradeAsked.set(key, slot);
  }

  const statusOrder = (Object.keys(FREQUENCY_STATUS_ORDER) as DoctorFrequencyStatus[])
    .filter((status) => (byStatus.get(status) ?? 0) > 0)
    .sort((left, right) => FREQUENCY_STATUS_ORDER[left] - FREQUENCY_STATUS_ORDER[right]);

  const table =
    surface === "desktop" ? (
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col style={{ width: "34%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <thead className="border-b border-slate-100">
          <tr>
            <th className={TH} scope="col">
              Doctor
            </th>
            <th className={TH} scope="col">
              Should visit
            </th>
            <th className={TH} scope="col">
              Visited
            </th>
            <th className={TH} scope="col">
              Gap
            </th>
            <th className={TH} scope="col">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
          {visible.map(({ doctor, frequency }) => (
            <tr key={doctor.contactCrmId}>
              <td className={TD}>
                <FrequencyDoctorName doctor={doctor} />
              </td>
              <td className={NUM}>
                {requiredText(frequency)}
                <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                  {requiredCaption(frequency, phoenix)}
                </span>
              </td>
              <td className={NUM}>
                {frequency.actual}
                <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                  {doctor.lastVisitDate ? `Last ${dayLabel(doctor.lastVisitDate, false)}` : "Never this period"}
                </span>
                {visitFill(frequency) == null ? null : (
                  <KpiMeter band={FREQUENCY_STATUS_BAND[frequency.status]} value={visitFill(frequency)} />
                )}
              </td>
              <td className={NUM}>{frequencyGapText(frequency)}</td>
              <td className={TD}>
                <FrequencyStatusChip status={frequency.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <ul className="divide-y divide-slate-100">
        {visible.map(({ doctor, frequency }) => (
          <li className="px-3 py-2.5 text-sm" key={doctor.contactCrmId}>
            <div className="flex items-start justify-between gap-2">
              <FrequencyDoctorName doctor={doctor} />
              <FrequencyStatusChip status={frequency.status} />
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              <div className="min-w-0">
                <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Should visit</dt>
                <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{requiredText(frequency)}</dd>
                <dd className="text-phx-2xs leading-4 text-slate-500">{requiredCaption(frequency, phoenix)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Visited</dt>
                <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{frequency.actual}</dd>
                <dd className="text-phx-2xs leading-4 text-slate-500">
                  {doctor.lastVisitDate ? `Last ${dayLabel(doctor.lastVisitDate, false)}` : "Never this period"}
                </dd>
                {visitFill(frequency) == null ? null : (
                  <dd>
                    <KpiMeter band={FREQUENCY_STATUS_BAND[frequency.status]} value={visitFill(frequency)} />
                  </dd>
                )}
              </div>
              <div className="min-w-0">
                <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Gap</dt>
                <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{frequencyGapText(frequency)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">
          How often each doctor was visited in {period}
        </p>
        <p className={`mt-0.5 leading-4 ${CAPTION}`}>
          {phoenix
            ? `${detail.repName}: each graded doctor should get the visits the doctor's grade asks for in the month — A 3, B 2, C 1. Extra visits are fine; a doctor with no grade is left out.`
            : `${detail.repName}: each doctor should be visited exactly as many times as the plan booked. Fewer is a deviation and so is more. A doctor whose booked days are all still ahead is not late.`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          band={pct == null ? "noplan" : kpiBandOf(pct)}
          caption={
            pct == null
              ? "Nothing to judge yet"
              : `${passing} of ${judged.length} judged doctors ${phoenix ? "at their norm" : "visited exactly as planned"}`
          }
          label="Frequency"
          progress={pct}
          value={pct == null ? "—" : `${pct}%`}
        />
        <KpiTile
          caption={
            due === asked ? `Across ${rows.length} planned doctors` : `${due} have come due so far, of ${asked} in the period`
          }
          label="Visits asked for"
          value={String(asked)}
        />
        <KpiTile caption="Visits made to those doctors" label="Visits made" value={String(made)} />
        <KpiTile
          band={owed > 0 ? "behind" : "elite"}
          caption={owed > 0 ? "Due so far and not yet made" : "Nothing is owed"}
          label="Visits owed"
          value={String(owed)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {statusOrder.map((status) => {
          const chosen = board.filters.doctor.statuses.includes(status);
          const statuses = chosen
            ? board.filters.doctor.statuses.filter((entry) => entry !== status)
            : [...board.filters.doctor.statuses, status];
          return (
            // Each count is a link that filters the list to that verdict (and back off again).
            <Link
              className={`inline-flex items-center gap-1.5 border px-1.5 py-1 transition-colors ${chosen ? "border-orange-500 bg-orange-50" : "border-transparent hover:border-slate-300"}`}
              href={hrefWith(context, { filters: { ...board.filters, doctor: { ...board.filters.doctor, statuses } } })}
              key={status}
            >
              <FrequencyStatusChip status={status} />
              <span className="text-phx-2xs font-black tabular-nums text-slate-700">{byStatus.get(status)}</span>
            </Link>
          );
        })}
      </div>

      {gradeGroups.length > 1 || (gradeGroups[0] && gradeGroups[0].label !== "No grade") ? (
        <div className="min-w-0 border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">By grade</p>
          </div>
          <ul className="divide-y divide-slate-100">
            {gradeGroups.map((group) => {
              const slot = gradeAsked.get(group.label) ?? { asked: 0, made: 0, passing: 0, judged: 0 };
              return (
                <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2" key={group.label}>
                  <span className="text-sm font-semibold text-slate-900">
                    {group.label} <span className="text-phx-2xs font-bold text-slate-500">· {group.planned} doctors</span>
                  </span>
                  <span className="text-phx-2xs font-semibold tabular-nums text-slate-600">
                    {slot.made} visits made of {slot.asked} asked for
                    {slot.judged > 0 ? ` · ${slot.passing} of ${slot.judged} ${phoenix ? "at norm" : "exact"}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* The rep's WHOLE list per brick, like the tiles above: the filters narrow the table only. */}
      <BrickBreakdown
        context={context}
        rows={buildKpiBrickRows([[...detail.covered, ...detail.notCovered]])}
        title="By brick · from the validated live photo"
      />

      <DoctorFilters context={context} doctors={rows.map((row) => row.doctor)} shown={visible.length} />

      <div className="min-w-0 border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
            {narrowing ? "Matching doctors" : "Every planned doctor"} ·{" "}
            <span className="tabular-nums">{visible.length}</span>
            {narrowing ? <span className="tabular-nums"> of {rows.length}</span> : null}
          </p>
          <p className="mt-0.5 text-phx-3xs leading-4 text-slate-400">{sortNote ?? "Furthest from target first"}</p>
        </div>
        {visible.length === 0 ? (
          <p className={`px-3 py-4 leading-4 ${CAPTION}`}>No doctor matches these filters. Clear a filter above to see more.</p>
        ) : (
          table
        )}
      </div>
    </div>
  );
}

// ── The Call Rate report: Total, AM and PM ────────────────────────────────────────────────────

/** The line each view prints under its name. TOTAL never forms one rate — see KPI_CALL_RATE_VIEWS. */
function callRateViewHeadline(board: KpisBoard, view: KpiCallRateView): string {
  const { totals } = board;
  if (view === "total") return `${rate(totals.amRate)}${NBSP}AM · ${rate(totals.pmRate)}${NBSP}PM`;
  if (view === "am") return `${rate(totals.amRate)}${NBSP}of${NBSP}${board.amTarget}`;
  return `${rate(totals.pmRate)}${NBSP}of${NBSP}${board.pmTarget}`;
}

function callRateViewHint(board: KpisBoard, view: KpiCallRateView): string {
  if (view === "total")
    return "The morning and the afternoon side by side, each against its own target, with the pharmacy and campaign calls beside them. They are never blended into one rate.";
  if (view === "am") return `Morning visits only, against the target of ${board.amTarget} a day.`;
  return `Afternoon visits only, against the target of ${board.pmTarget} a day.`;
}

/** Total · AM · PM — the call-rate report's three views, as links so each one re-runs the scope gate. */
function CallRateViewSwitch({ context }: { context: ViewContext }) {
  const { board, callRateView: active } = context;
  return (
    <div className="border-t border-slate-100">
      <div className="grid grid-cols-3">
        {KPI_CALL_RATE_VIEWS.map((view) => {
          const current = view === active;
          return (
            <Link
              aria-current={current ? "page" : undefined}
              className={
                current
                  ? "relative min-w-0 border-b-2 border-b-orange-500 bg-orange-50 px-3 py-2.5 sm:px-5"
                  : "relative min-w-0 border-b-2 border-b-transparent px-3 py-2.5 transition-colors hover:bg-slate-50 sm:px-5"
              }
              href={hrefWith(context, { view })}
              key={view}
            >
              <span
                className={
                  current
                    ? "block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900"
                    : "block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400"
                }
              >
                {KPI_CALL_RATE_VIEW_LABEL[view]}
              </span>
              <span
                className={
                  current
                    ? "mt-0.5 block text-sm font-black tabular-nums text-orange-700"
                    : "mt-0.5 block text-sm font-black tabular-nums text-slate-400"
                }
              >
                {callRateViewHeadline(board, view)}
              </span>
            </Link>
          );
        })}
      </div>
      <p className={`border-t border-slate-100 px-4 py-2.5 leading-4 sm:px-5 ${CAPTION}`}>
        {callRateViewHint(board, active)}
      </p>
    </div>
  );
}

/** What one session's columns read off a rep's row — one place, so the table, the card and the tiles agree. */
function sessionFigures(row: KpiRepRow, board: KpisBoard, session: "am" | "pm") {
  const am = session === "am";
  const target = am ? board.amTarget : board.pmTarget;
  const verified = am ? row.amVerified : row.pmVerified;
  const asked = row.workingDays * target;
  return {
    target,
    verified,
    reported: am ? row.amReported : row.pmReported,
    perDay: am ? row.amRate : row.pmRate,
    pct: am ? amPct(row) : pmPct(row),
    band: am ? amBandOf(row) : pmBandOf(row),
    fill: am ? amFill(row) : pmFill(row),
    asked,
    // A rep with no GPS feed has no proved calls, so there is no shortfall to state for him.
    short: row.noGpsFeed ? null : Math.max(0, asked - verified),
  };
}

/** The four tiles that replace the six on an AM or PM view: the session's own rate, ask, shortfall and head count at target. */
function CallRateSessionTiles({ board, partial, session }: { board: KpisBoard; partial: boolean; session: "am" | "pm" }) {
  const am = session === "am";
  const { totals } = board;
  const callWord = isPhoenix(board) ? "visits" : "verified";
  // A rep too new to judge is left out of the asks and the shortfall, as the team totals leave her.
  const scored = board.reps.filter((row) => !row.noGpsFeed && !row.justStarted);
  const target = am ? board.amTarget : board.pmTarget;
  const askedFor = scored.reduce((sum, row) => sum + sessionFigures(row, board, session).asked, 0);
  const short = scored.reduce((sum, row) => sum + (sessionFigures(row, board, session).short ?? 0), 0);
  const atTarget = scored.filter((row) => row.hasCallRate && (sessionFigures(row, board, session).perDay ?? 0) >= target).length;
  const attainment = am ? totals.amAttainmentPct : totals.pmAttainmentPct;
  const verified = am ? totals.amVerified : totals.pmVerified;
  const reported = am ? totals.amReported : totals.pmReported;
  return (
    <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-4 py-4 sm:px-5 lg:grid-cols-4">
      <KpiTile
        band={kpiBandOf(attainment)}
        caption={`${verified} ${callWord} over ${board.workingDays} working days${partial ? " · the period is still running" : ""}`}
        label={`${am ? "AM" : "PM"} call rate`}
        progress={attainment}
        value={`${rate(am ? totals.amRate : totals.pmRate)} of ${target}`}
      />
      <KpiTile
        caption={
          reported !== verified
            ? `${target} a day for each rep's working days · ${reported} reported`
            : `${target} a day for each rep's working days`
        }
        label="Calls asked for"
        value={String(askedFor)}
      />
      <KpiTile
        band={short > 0 ? "behind" : "elite"}
        caption={short > 0 ? "Summed over the reps who are below target" : "Nobody is below target"}
        label="Calls short"
        value={String(short)}
      />
      <KpiTile
        band={scored.length > 0 ? kpiBandOf(Math.round((atTarget / scored.length) * 100)) : "noplan"}
        caption={`At or above ${target} a day`}
        label="Reps at target"
        value={`${atTarget} of ${scored.length}`}
      />
    </div>
  );
}

/** The Total view's one line of counts — calls are counted, so they may be added; rates may not. */
function CallRateTotalCounts({ board }: { board: KpisBoard }) {
  const { totals } = board;
  const callWord = isPhoenix(board) ? "visits" : "verified calls";
  return (
    <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
      <p className={`leading-4 ${CAPTION}`}>
        <span className="font-black uppercase tracking-[0.1em] text-slate-400">Calls logged</span>{" "}
        <span className="font-bold tabular-nums text-slate-900">{totals.totalCalls}</span> — of which{" "}
        <span className="tabular-nums">{totals.amVerified}</span> AM {callWord},{" "}
        <span className="tabular-nums">{totals.pmVerified}</span> PM {callWord},{" "}
        <span className="tabular-nums">{totals.pharmacyVerified}</span> pharmacy and{" "}
        <span className="tabular-nums">{totals.campaignCalls}</span> campaign. Counts add up; the two rates above never do.
      </p>
    </div>
  );
}

/**
 * The AM or PM view of the Call Rate report: one session, one table, six columns — days, calls,
 * per day, score and what is still owed. Fits 619px the way the Call Rate table does: heads of at
 * most five letters in their own cell, the rep column merged with the line and area.
 */
function CallRateSessionTable({
  context,
  rows,
  session,
}: {
  context: ViewContext;
  rows: KpiRepRow[];
  session: "am" | "pm";
}) {
  const { board } = context;
  const { filters } = board;
  const phoenix = isPhoenix(board);
  const am = session === "am";
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "22%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "20%" }} />
        <col style={{ width: "14%" }} />
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
          <th className={TH} scope="col">
            Calls
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              {phoenix ? "Visits made" : "Verified"}
            </span>
          </th>
          <KpiSortableTh
            active={filters.sort === session}
            direction={filters.direction}
            href={sortHref(context, session)}
            label="Per day"
            sub={`Target ${am ? board.amTarget : board.pmTarget}`}
          />
          <th className={TH} scope="col">
            Score
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Of target
            </span>
          </th>
          <th className={TH} scope="col">
            Short
            <span className="mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400">
              Calls owed
            </span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {rows.map((row, index) => {
          const figures = sessionFigures(row, board, session);
          return (
            <tr key={row.agentCrmId ?? `${row.repName}-${index}`}>
              <RepCell
                action={callRateVisitsLink(context, row)}
                rank={context.showRank ? index + 1 : undefined}
                row={row}
                rules={board.kpiRules}
              />
              <td className={NUM}>{row.workingDays}</td>
              <td className={NUM}>
                {row.noGpsFeed ? "—" : figures.verified}
                <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                  {row.noGpsFeed
                    ? `${figures.reported} reported, none provable`
                    : `of ${figures.asked} asked for${figures.reported !== figures.verified ? ` · ${figures.reported} reported` : ""}`}
                </span>
              </td>
              <MeasureCell
                band={figures.band}
                caption={
                  sessionCaption(row, session, figures.target, "No calls") + followUpText(row, session)
                }
                fill={figures.fill}
                value={rate(figures.perDay)}
              />
              <td className={`${NUM} ${toneOf(figures.band).text}`}>{figures.pct}</td>
              <td className={NUM}>
                {figures.short == null ? "—" : figures.short}
                <span className="mt-0.5 block text-phx-3xs font-semibold leading-4 text-slate-500">
                  {figures.short == null ? "No GPS feed" : figures.short === 0 ? "At or above target" : "to reach the target"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One rep on a phone, AM or PM view: the session's rate on top, its three supporting figures under it. */
function SessionCard({
  action,
  rank,
  row,
  board,
  session,
}: {
  action?: React.ReactNode;
  rank?: number;
  row: KpiRepRow;
  board: KpisBoard;
  session: "am" | "pm";
}) {
  const figures = sessionFigures(row, board, session);
  return (
    <div className="px-4 py-3">
      <KpiRepName
        areaName={row.areaName}
        hireDate={row.hireDate}
        jobTitle={row.jobTitle}
        lineName={row.lineName}
        name={row.repName}
        rank={rank}
      />
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={`text-lg font-black tabular-nums ${toneOf(figures.band).text}`}>{rate(figures.perDay)}</span>
          <span className="text-phx-2xs font-black tabular-nums text-slate-500">
            of {figures.target} a day · {figures.pct}
          </span>
        </div>
        <KpiMeter band={figures.band} value={figures.fill} />
        <p className="mt-1 text-phx-2xs leading-4 text-slate-500">
          {sessionCaption(row, session, figures.target, "No calls")}
          {followUpText(row, session)}
        </p>
      </div>
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Days</dt>
          <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{row.workingDays}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Calls</dt>
          <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">
            {row.noGpsFeed ? "—" : figures.verified}
          </dd>
          <dd className="text-phx-2xs leading-4 text-slate-500">
            {row.noGpsFeed ? `${figures.reported} reported` : `of ${figures.asked} asked for`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">Short</dt>
          <dd className="mt-0.5 text-sm font-black tabular-nums text-slate-900">
            {figures.short == null ? "—" : figures.short}
          </dd>
        </div>
      </dl>
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}

// ── The managers ──────────────────────────────────────────────────────────────────────────────

/*
 * THE MANAGER ROWS — owner, 2026-10-20: "add manager row and every dm kpis is calculated based on his
 * reps averag and nsm based on dsms av and so on".
 *
 * Every figure here is an AVERAGE of the rows directly beneath the manager, and each cell says how
 * many rows it averaged, so a reader can tell a district of five from a district where four of the
 * five had anything to measure. AM and PM are two columns and two averages, exactly as on the rep
 * rows. The rows are not sortable and carry no rank: they are in tree order (each manager before the
 * managers beneath him), and a rank across levels would compare a district with a nation.
 */

/** The sub-line under a plain (unsortable) head — the Summary table's own Overall spelling. */
const HEAD_SUB = "mt-0.5 block text-phx-3xs font-bold normal-case tracking-normal text-slate-400";

/** "reps", "managers" or "rows" — what a manager's figures are averages OF. */
function averagedNoun(row: KpiManagerRow, count: number): string {
  const noun = row.directManagers === 0 ? "rep" : row.directReps === 0 ? "manager" : "row";
  return count === 1 ? noun : `${noun}s`;
}

/** "Average of 5 reps", or "Average of 4 of 5 reps" when one row beneath him had nothing to measure. */
function averagedCaption(row: KpiManagerRow, measure: KpiManagerMeasure, none: string): string {
  const measured = row.measured[measure];
  if (measured === 0) return none;
  return measured === row.averagedRows
    ? `Average of ${measured} ${averagedNoun(row, measured)}`
    : `Average of ${measured} of ${row.averagedRows} ${averagedNoun(row, row.averagedRows)}`;
}

/** An averaged percentage, or the marker when no row beneath him had one. */
function managerPct(value: number | null, none: string): string {
  return value == null ? none : `${value}%`;
}

/** The AM or PM line under a manager's attainment: the averaged rate, then what it averaged. */
function managerSessionCaption(row: KpiManagerRow, session: "am" | "pm", target: number): string {
  const measure = session === "am" ? "amAttainmentPct" : "pmAttainmentPct";
  const averaged = averagedCaption(row, measure, "No calls in this team");
  if (row.measured[measure] === 0) return averaged;
  return `${rate(session === "am" ? row.amRate : row.pmRate)} of ${target} a day · ${averaged}`;
}

/** The coverage floor, judged on the manager's averaged coverage. */
function managerFloor(board: KpisBoard, row: KpiManagerRow): React.ReactNode {
  return coverageFloorBadge({
    meetsCoverageFloor: row.coveragePct == null ? null : row.coveragePct >= board.coverageFloorPct,
  });
}

/** Who the manager is — the name in the rep name's own type, then his seat and his reach. */
function ManagerName({ row }: { row: KpiManagerRow }) {
  const seat = row.jobTitle ?? KPI_MANAGER_LEVEL_LABEL[row.level];
  const where = [row.lineName, row.regionName].filter((part): part is string => Boolean(part?.trim())).join(" · ");
  return (
    <span className="block min-w-0">
      <span className="block font-semibold leading-5 text-slate-900" dir="auto">
        {row.name}
      </span>
      <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{where ? `${seat} · ${where}` : seat}</span>
      <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">
        {row.repsBeneath} medical {row.repsBeneath === 1 ? "rep" : "reps"} beneath · averages {row.averagedRows}{" "}
        {averagedNoun(row, row.averagedRows)}
      </span>
      {row.reportsTo ? (
        <span className="block text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs" dir="auto">
          Reports to {row.reportsTo}
        </span>
      ) : null}
    </span>
  );
}

function ManagersTable({ context, rows }: { context: ViewContext; rows: KpiManagerRow[] }) {
  const { board } = context;
  const phoenix = isPhoenix(board);
  return (
    <table className="hidden w-full table-fixed md:table">
      {/* THE SUMMARY TABLE'S SIX COLUMNS, at its own measured widths (tests/kpis-board-tables-fit.test.ts
          pins those): the same heads over the same cells, the name head a shorter word than
          "Medical rep" and no head carrying a sort arrow, so every head here needs no more room than
          the one it copies. */}
      <colgroup>
        <col style={{ width: "23%" }} />
        <col style={{ width: "17%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "17%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH} scope="col">
            Manager
            <span className={HEAD_SUB}>Seat · reach</span>
          </th>
          <th className={TH} scope="col">
            Coverage
            <span className={HEAD_SUB}>Average</span>
          </th>
          <th className={TH} scope="col">
            Frequency
            <span className={HEAD_SUB}>{phoenix ? "Grade norm" : "Exact only"}</span>
          </th>
          <th className={TH} scope="col">
            AM
            <span className={HEAD_SUB}>{`Of ${board.amTarget}`}</span>
          </th>
          <th className={TH} scope="col">
            PM
            <span className={HEAD_SUB}>{`Of ${board.pmTarget}`}</span>
          </th>
          <th className={TH} scope="col">
            Overall
            <span className={HEAD_SUB}>Average</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {rows.map((row) => (
          <tr key={row.hrId}>
            <td className={TD}>
              <ManagerName row={row} />
            </td>
            <MeasureCell
              band={kpiBandOf(row.coveragePct)}
              caption={averagedCaption(row, "coveragePct", "Nothing planned in this team")}
              extra={managerFloor(board, row)}
              fill={row.coveragePct}
              value={managerPct(row.coveragePct, "No plan")}
            />
            <MeasureCell
              band={kpiBandOf(row.frequencyPct)}
              caption={averagedCaption(row, "frequencyPct", "Nothing planned in this team")}
              fill={row.frequencyPct}
              value={managerPct(row.frequencyPct, "No plan")}
            />
            <MeasureCell
              band={kpiBandOf(row.amAttainmentPct)}
              caption={managerSessionCaption(row, "am", board.amTarget)}
              fill={row.amAttainmentPct}
              value={managerPct(row.amAttainmentPct, "No calls")}
            />
            <MeasureCell
              band={kpiBandOf(row.pmAttainmentPct)}
              caption={managerSessionCaption(row, "pm", board.pmTarget)}
              fill={row.pmAttainmentPct}
              value={managerPct(row.pmAttainmentPct, "No calls")}
            />
            <MeasureCell
              band={kpiBandOf(row.overallPct)}
              caption={averagedCaption(row, "overallPct", "Nothing to score in this team")}
              fill={row.overallPct}
              value={managerPct(row.overallPct, "No score")}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The phone card: the rep card's own six cells, read off the manager's averages. */
function ManagerCard({ board, row }: { board: KpisBoard; row: KpiManagerRow }) {
  const measures: Array<{
    band: KpiBand;
    caption: string;
    extra?: React.ReactNode;
    fill: number | null;
    label: string;
    value: string;
  }> = [
    {
      band: kpiBandOf(row.coveragePct),
      caption: averagedCaption(row, "coveragePct", "Nothing planned in this team"),
      extra: managerFloor(board, row),
      fill: row.coveragePct,
      label: "Coverage",
      value: managerPct(row.coveragePct, "No plan"),
    },
    {
      band: kpiBandOf(row.frequencyPct),
      caption: averagedCaption(row, "frequencyPct", "Nothing planned in this team"),
      fill: row.frequencyPct,
      label: "Frequency",
      value: managerPct(row.frequencyPct, "No plan"),
    },
    {
      band: kpiBandOf(row.amAttainmentPct),
      caption: managerSessionCaption(row, "am", board.amTarget),
      fill: row.amAttainmentPct,
      label: "AM call rate",
      value: managerPct(row.amAttainmentPct, "No calls"),
    },
    {
      band: kpiBandOf(row.pmAttainmentPct),
      caption: managerSessionCaption(row, "pm", board.pmTarget),
      fill: row.pmAttainmentPct,
      label: "PM call rate",
      value: managerPct(row.pmAttainmentPct, "No calls"),
    },
    {
      // No pharmacy target exists (see PHARMACY_CALL_RATE_TARGET): a rate, never a percentage, and
      // the quiet band — exactly as on the rep card.
      band: "noplan",
      caption:
        row.pharmacyRate == null
          ? "No calls in this team"
          : `no target set yet · ${averagedCaption(row, "pharmacyRate", "No calls in this team")}`,
      fill: null,
      label: "Pharmacy",
      value: row.pharmacyRate == null ? "No calls" : rate(row.pharmacyRate),
    },
    {
      band: kpiBandOf(row.overallPct),
      caption: averagedCaption(row, "overallPct", "Nothing to score in this team"),
      fill: row.overallPct,
      label: "Overall",
      value: managerPct(row.overallPct, "No score"),
    },
  ];
  return (
    <div className="px-4 py-3">
      <ManagerName row={row} />
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        {measures.map((measure) => (
          <div className="min-w-0" key={measure.label}>
            <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400 sm:text-phx-3xs">{measure.label}</dt>
            <dd className={`mt-0.5 text-sm font-black tabular-nums ${toneOf(measure.band).text}`}>{measure.value}</dd>
            <KpiMeter band={measure.band} value={measure.fill} />
            {measure.caption ? (
              <dd className="mt-1 text-phx-2xs leading-4 text-slate-500 sm:text-phx-3xs">{measure.caption}</dd>
            ) : null}
            {measure.extra ? <dd className="mt-1">{measure.extra}</dd> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The Managers section, under the rep table. Nothing when the viewer has no manager in reach — a
 * medical rep's own board, or a filter that leaves none — rather than an empty frame.
 */
function ManagersSection({ context }: { context: ViewContext }) {
  const { board } = context;
  if (board.managers.length === 0) return null;
  return (
    <div className="border-t border-slate-100">
      <KpiSection
        description="One row per manager, built from the medical reps in your reach. Each figure is the simple average of the rows directly beneath that manager: a district manager's own reps, or the managers who report to a manager higher up. Every measure is averaged on its own, AM and PM apart, and a row with nothing to measure is left out of that measure rather than counted as zero."
        title="Managers"
      >
        <div className="divide-y divide-slate-100 md:hidden">
          {board.managers.map((row) => (
            <ManagerCard board={board} key={row.hrId} row={row} />
          ))}
        </div>
        <div className="hidden md:block">
          <ManagersTable context={context} rows={board.managers} />
        </div>
      </KpiSection>
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
  tabs = KPI_TABS,
  rootPath,
  callRateView = "total",
  trend = null,
  trendMetric = "am",
  trendScale = "month",
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
  /**
   * The tabs the strip offers. Omitted, all seven (the admin shell). The portal's KPIs page passes its
   * four consolidated ones, and a portal REPORT page (Coverage, Frequency, Call Rate) passes none: it
   * is one measure on a page of its own, so it draws no strip and a leaner set of tiles.
   */
  tabs?: readonly KpiTab[];
  /** The portal KPIs address the per-rep call-rate drill-down hangs under. Defaults to `basePath`. */
  rootPath?: string;
  /** The Call Rate report's Total / AM / PM view. Ignored on every other tab. */
  callRateView?: KpiCallRateView;
  /**
   * The Weekly tab's weeks and totals (crm/kpis-trend.ts). Built by the page ONLY on that tab, where
   * `board` is the trend's own anchor; every other tab leaves it null and renders exactly as before.
   */
  trend?: KpiTrend | null;
  trendMetric?: KpiTrendMetric;
  trendScale?: KpiTrendScale;
}) {
  if (board.scopeReason) {
    return (
      <div className={PANEL}>
        <div className="px-5 py-6">
          <p className="text-sm font-semibold text-slate-700">{board.scopeReason}</p>
          <p className={`mt-1 ${CAPTION}`}>
            {/* In the portal the reader is as likely to be a medical rep reading his own board as a
                manager, so the sentence does not assume he manages anyone. */}
            {chrome === "portal"
              ? "KPIs show your own visits, or the reps who report to you. If you believe this is wrong, ask your administrator to check your seat in the organogram."
              : "KPIs are scoped to the reps you manage. If you believe this is wrong, ask your administrator to check your seat in the organogram."}
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
    tabs,
    rootPath: rootPath ?? basePath,
    callRateView,
    // A rank disc beside a name means nothing when the list is alphabetical, so it only appears
    // once a MEASURE is what the order is expressing.
    showRank:
      filters.sort !== "rep" && filters.sort !== "line" && filters.sort !== "area" && filters.sort !== "manager",
    trendScale,
    trendMetric,
  };
  const weekly = tab === "weekly";
  // A portal report page: one measure on its own page, so no consolidated panel, no tab strip and only
  // the tiles that belong to it. The summary page and the admin shell keep everything.
  const reportPage = tabs.length === 0;
  const showTile = (tile: "am" | "pm" | "pharmacy" | "coverage" | "frequency"): boolean =>
    !reportPage ||
    (tab === "coverage"
      ? tile === "coverage"
      : tab === "frequency"
        ? tile === "frequency"
        : tab === "call-rate"
          ? tile === "am" || tile === "pm" || tile === "pharmacy"
          : true);
  // AM or PM view of the Call Rate report; null for Total and for every other tab.
  const sessionView: "am" | "pm" | null = tab === "call-rate" && callRateView !== "total" ? callRateView : null;

  // Lowercased for "Whole month" ONLY, which is a common noun sitting mid-sentence. A week's label is
  // "Week 1 · 1–7 Sep" — a proper name carrying a month abbreviation — so lowercasing it printed
  // "week 1 · 1–7 sep", which reads as a typo now that a real date sits beside it in the footnote.
  const periodPhrase = board.range.isWholeMonth ? board.range.periodLabel.toLowerCase() : board.range.periodLabel;
  const filtered = hasActiveKpiFilters(filters);
  // The window is still running, so coverage and frequency are a position rather than a finished
  // score. A tile is read on its own, away from the hero, so the caveat has to travel with it.
  // Zero days in counts too once the period has begun — since ruling C1 that is its first day.
  const partial =
    board.workingDays < board.workingDaysInWindow && (board.workingDays > 0 || board.range.todayLeftOut);
  const phoenix = isPhoenix(board);
  const callWord = phoenix ? "visits" : "verified";
  // THE TEAMS (owner, 9 Nov 2026: "group reps by district manager"). The Coverage tab files every rep under
  // his region and direct manager: the teams at a glance, a heading per team over the rows and the same
  // headings over the phone cards. Every other tab keeps its one list. Empty for a board of one rep.
  const coverageTeams: KpiTeamWithCoverage[] =
    tab === "coverage" && board.reps.length > 1
      ? kpiTeamsWithCoverage(groupKpiRepsByTeam(board.reps), board.kpiRules)
      : [];
  // A measure with one leaderboard (Coverage, Frequency, one half of Call Rate) draws it across the row,
  // its three names side by side, instead of one card in a row built for four.
  const lonePodium = tab === "coverage" || tab === "frequency" || (tab === "call-rate" && callRateView !== "total");
  // A MEDICAL REP'S OWN BOARD: the portal, with one rep in reach. The manager's furniture reads wrong
  // there — "Medical reps in reach: 1", an "Advanced filters" panel over a board of one, "Showing 1 of
  // 1", a "Team standing" pill — so it is relabelled or put away. The admin shell is untouched.
  const solo = chrome === "portal" && board.scopedReps <= 1;

  return (
    <div className="space-y-4">
      <KpiHero board={board} showTitle={chrome === "admin"} solo={solo} />

      {/* The tab strip and the board below it share ONE frame, flat: no shadow, no lift (owner, 22 Oct
          2026). The `shadow-none` class tells the shell's ambient `main` rule (`:not([class*="shadow"])`)
          to leave it alone rather than add a shadow of its own. */}
      <div className="shadow-none">
        <KpiTabStrip context={context} />
        <div className={PANEL}>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">{KPI_TAB_LABEL[tab]}</p>
              <p className={`mt-0.5 leading-4 ${CAPTION}`}>
                {(phoenix ? KPI_TAB_HINT_PHOENIX[tab] : undefined) ?? KPI_TAB_HINT[tab]}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p className={CAPTION}>
                {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
              </p>
              {/* The board as a house-identity workbook (owner, 2026-10-25) — the same month, period
                  and filters as on screen, so the file is what the reader is looking at. A plain link,
                  so it stays a server component; the route re-checks the gate and the scope. */}
              {board.reps.length > 0 ? (
                <a
                  className="inline-flex h-9 items-center gap-2 whitespace-nowrap border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink transition hover:border-phx-accent-line hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
                  download
                  href={kpisExportHref(context, weekly)}
                  title="Download this board as a styled Excel workbook"
                >
                  <Download aria-hidden className="h-3.5 w-3.5" />
                  Export XLSX
                </a>
              ) : null}
            </div>
          </div>

          {tab === "call-rate" ? <CallRateViewSwitch context={context} /> : null}

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
              showPeriod={!weekly}
              tab={tab}
              trend={trendScale}
              measure={trendMetric}
              view={callRateView}
            />
          </div>

          {/* Hidden on a rep's own board — unless a filter is somehow on, in which case the panel
              stays so the filter can always be seen and taken off. */}
          {solo && !filtered ? null : (
            <KpisFilterBar
              basePath={basePath}
              facets={board.facets}
              filters={filters}
              kpiRules={board.kpiRules}
              month={board.month}
              period={weekly ? "month" : board.range.periodKey}
              rep={context.openRep}
              tab={tab}
              trend={trendScale}
              measure={trendMetric}
              view={callRateView}
              total={board.scopedReps}
              visible={board.reps.length}
            />
          )}
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

          {/* OWNER'S RULING A1, 2026-09-21 — "use A1 no GPS feed for reps without check-ins", then
              "apply A1 to the KPIs board too". Before the CRM cutover only a GPS-proved call counts, so
              a rep whose account sent no check-in at all would read 0% however much he worked. He is
              listed and marked, and his calls are kept out of the team's call rates — and this says
              so, in the same banner as the holiday caveat above, because both are gaps in the DATA
              that change what the call-rate tiles mean. */}
          {board.noGpsFeedShown > 0 ? (
            <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 sm:px-5">
              <p className="text-phx-xs font-bold text-amber-900">
                {board.noGpsFeedShown} of {totals.reps} {totals.reps === 1 ? "rep" : "reps"} logged visits in{" "}
                {board.range.isWholeMonth ? board.monthLabel : board.range.periodLabel} with no GPS check-in at all from{" "}
                {board.noGpsFeedShown === 1 ? "that CRM account" : "their CRM accounts"}.
              </p>
              <p className="mt-0.5 text-phx-2xs leading-4 text-amber-800">
                No visit could be proved, so {board.noGpsFeedShown === 1 ? "the row reads" : "those rows read"}{" "}
                {NO_GPS_FEED} instead of 0%, and {board.noGpsFeedShown === 1 ? "its calls are" : "their calls are"} left
                out of the AM, PM and pharmacy call rates below. Coverage and frequency are unaffected.
              </p>
            </div>
          ) : null}

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
          ) : callRateBeganToday(board) ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`${CAPTION} font-semibold`}>
                This period began today. Call rates are scored through yesterday, so every one stays blank rather
                than zero until today is over; coverage and frequency already count today&apos;s visits.
              </p>
            </div>
          ) : null}

          {/* THE WEEKLY TAB draws its own two tables in place of the overall panel, the six tiles and
              the leaderboards: each of those describes ONE period, and this tab's whole point is
              several side by side. Every other tab renders below exactly as it did. */}
          {weekly ? null : (
            <>
          {/* THE ONE NUMBER, above the six it comes from. Added 2026-09-17 on the owner's
              instruction; the tiles below are exactly as they were. */}
          {reportPage ? null : <KpiOverallPanel board={board} partial={partial} />}

          {/* Six tiles since 2026-09-06, when pharmacy joined as its own tile — never averaged into
              AM/PM, never blended with them. See PHARMACY_CALL_RATE_TARGET in crm/call-rate.ts for
              why it carries no target yet. A combined AM+PM "visits/day" tile briefly lived here too
              (2026-09-05) and was retracted the same day (#3341): the owner's 8-12 band belongs to
              PM alone, not AM+PM summed, and that per-list model now lives entirely in
              rep-kpi-reports.ts's two-report tabs. Do not re-add a combined tile here. */}
          {/* Three across from `lg`, six only from `2xl`. At `lg` the portal's sidebar opens and the
              content drops to about 636px, so six tiles were ~89px each: a 27px "100%" was clipped by
              the tile's own overflow-hidden and "1.63 of 2" split over two lines. */}
          {sessionView ? (
            <CallRateSessionTiles board={board} partial={partial} session={sessionView} />
          ) : (
          <div className="grid gap-3 border-t border-slate-100 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 2xl:grid-cols-6">
            {solo ? (
              // A rep's own board: a head count of one is not a figure. The tile states the working
              // days instead — both numbers were already in its caption.
              <KpiTile
                caption={
                  board.holidayDays > 0
                    ? `Sat–Wed · ${board.holidayDays} national holiday(s) removed`
                    : "Sat–Wed"
                }
                label="Working days"
                value={`${board.workingDays} of ${board.workingDaysInWindow}`}
              />
            ) : (
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
            )}
            {showTile("am") ? (
            <KpiTile
              band={kpiBandOf(totals.amAttainmentPct)}
              caption={`${totals.amVerified} ${callWord} · target ${board.amTarget} a day`}
              label="AM call rate"
              progress={totals.amAttainmentPct}
              value={`${rate(totals.amRate)} of ${board.amTarget}`}
            />
            ) : null}
            {showTile("pm") ? (
            <KpiTile
              band={kpiBandOf(totals.pmAttainmentPct)}
              caption={`${totals.pmVerified} ${callWord} · target ${board.pmTarget} a day`}
              label="PM call rate"
              progress={totals.pmAttainmentPct}
              value={`${rate(totals.pmRate)} of ${board.pmTarget}`}
            />
            ) : null}
            {/* No target yet (see PHARMACY_CALL_RATE_TARGET) — the raw rate, no percentage, no
                progress bar to fill against a number that does not exist. */}
            {showTile("pharmacy") ? (
            <KpiTile
              caption={`${totals.pharmacyVerified} ${callWord} · no target set yet`}
              label="Pharmacy call rate"
              value={rate(totals.pharmacyRate)}
            />
            ) : null}
            {showTile("coverage") ? (
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
            ) : null}
            {showTile("frequency") ? (
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
            ) : null}
            {/* The Coverage report's own figures beside its tile (premium pass, 9 Nov 2026): what is left to
                reach, who clears the floor, the off-plan doctors and, when read, the doctors not validated
                yet — so the row built for six is not two tiles and white space. */}
            {reportPage && tab === "coverage" && !solo
              ? kpiCoverageExtraTiles(board).map((tile) => (
                  <KpiTile band={tile.band} caption={tile.caption} key={tile.key} label={tile.label} value={tile.value} />
                ))
              : null}
          </div>
          )}

          {/* Rules 2, 7 and 8 — the lines that sit OUTSIDE the three KPIs, said once for the team. */}
          {board.phoenixTotals ? (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
              <p className={`leading-4 ${CAPTION}`}>
                {board.phoenixTotals.campaignVisits} campaign visits, unplanned visits to a contact not on the
                rep&apos;s list included, are counted on their own line, outside call rate, coverage and frequency. {board.phoenixTotals.ungradedDoctors} planned doctors have no grade and are left
                out of frequency. {board.phoenixTotals.regularNoCheckin} regular visits have no matching GPS
                check-in — real activity, kept off the campaign line, but scored in neither call rate, coverage
                nor frequency.
              </p>
            </div>
          ) : null}
            </>
          )}

          {!weekly && tab === "call-rate" && callRateView === "total" && board.reps.length > 0 ? (
            <CallRateTotalCounts board={board} />
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
          ) : weekly ? (
            trend ? (
              <KpiTrendView
                metric={trendMetric}
                metricHrefs={
                  Object.fromEntries(
                    KPI_TREND_METRICS.map((metric) => [metric, hrefWith(context, { measure: metric })]),
                  ) as Record<KpiTrendMetric, string>
                }
                scale={trendScale}
                scaleHrefs={
                  Object.fromEntries(
                    KPI_TREND_SCALES.map((scale) => [scale, hrefWith(context, { trend: scale })]),
                  ) as Record<KpiTrendScale, string>
                }
                trend={trend}
              />
            ) : null
          ) : tab === "am-pm" || tab === "pharmacies" ? (
            /* THE TWO REPORTS. No leaderboard above them, deliberately: the podium ranks the four
               plan-based measures, and a "best on pharmacies" board would rank reps against a
               standard the owner has not set yet. The tables carry mobile cards of their own. */
            <div className="border-t border-slate-100">
              {tab === "am-pm" ? <AmPmKpiReportTables reports={board.kpiReports} reps={board.reps} /> : null}
              {tab === "pharmacies" ? <PharmacyKpiReportTables reports={board.kpiReports} reps={board.reps} /> : null}
              <div className="border-t border-slate-100">
                <OffListNote reports={board.kpiReports} />
              </div>
            </div>
          ) : (
            <>
              {/* WHERE THE TEAM STANDS (premium pass, 9 Nov 2026), on the Coverage tab with more than one rep:
                  the planned list as covered against not reached, the reps by band, and the teams side by
                  side. Every figure adds up to a tile above it. */}
              {coverageTeams.length > 0 ? (
                <div className="border-t border-slate-100">
                  <KpiSection
                    description="The planned list as covered against not reached, the reps in the bands their own chips show, and each region and district manager's team side by side. Every figure adds up to the tiles above."
                    title="Where the team stands"
                  >
                    <KpiCoverageStanding board={board} />
                    <KpiTeamCoverageRollup floorPct={board.coverageFloorPct} teams={coverageTeams} />
                  </KpiSection>
                </div>
              ) : null}

              {/* THE LEADERBOARDS. Three, never one — a single "best rep" would need a blended
                  score, and this board adds no fourth measure. They rank the FILTERED rows, so
                  filtering to one line answers "best in that line". Only when there is more than one
                  rep to rank: a board of one put a medical rep at "#1 of 1" in up to five gold-disc
                  cards, two phone screens above his own card. */}
              {board.reps.length > 1 ? (
              <div className="border-t border-slate-100">
                <KpiSection
                  description="Best three on each measure, from the reps currently in view. Separate answers — often different people. The morning and the afternoon are ranked apart, on the uncapped figure, so a rep above target can read over 100% here."
                  title="Standing out"
                >
                  <div className={lonePodium ? "px-4 py-4 sm:px-5" : "grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4"}>
                    {tab === "summary" || tab === "coverage" ? (
                      <KpiPodiumCard entries={podium.coverage} hint="Most of the planned list reached" title="Coverage" wide={lonePodium} />
                    ) : null}
                    {tab === "summary" || tab === "frequency" ? (
                      <KpiPodiumCard
                        entries={podium.frequency}
                        wide={lonePodium}
                        hint={phoenix ? "Most graded doctors at their grade norm" : "Most doctors seen exactly as planned"}
                        title="Frequency"
                      />
                    ) : null}
                    {tab === "summary" || (tab === "call-rate" && callRateView !== "pm") ? (
                      <KpiPodiumCard
                        entries={podium.amCallRate}
                        wide={lonePodium}
                        hint={`Closest to ${board.amTarget} ${phoenix ? "AM visits" : "verified AM calls"} a day`}
                        title="AM call rate"
                      />
                    ) : null}
                    {tab === "summary" || (tab === "call-rate" && callRateView !== "am") ? (
                      <KpiPodiumCard
                        entries={podium.pmCallRate}
                        wide={lonePodium}
                        hint={`Closest to ${board.pmTarget} ${phoenix ? "PM visits" : "verified PM calls"} a day`}
                        title="PM call rate"
                      />
                    ) : null}
                    {/* Ranked on the raw rate, not attainment — no pharmacy target exists yet (see
                        PHARMACY_CALL_RATE_TARGET), and a rep with zero pharmacy calls is excluded
                        from this board entirely rather than shown at 0, same as coverage/frequency
                        exclude a rep with no measurable plan. */}
                    {tab === "summary" || (tab === "call-rate" && callRateView === "total") ? (
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
              ) : null}

              <div className="border-t border-slate-100">
                <div className="divide-y divide-slate-100 md:hidden">
                  {cardSlots(coverageTeams, board.reps).map(({ heading, index, row }) => {
                    if (heading) return <KpiTeamHeadingBand entry={heading} key={`team-${heading.team.key}`} />;
                    if (!row) return null;
                    const doctorsTab = tab === "coverage" || tab === "frequency";
                    const coverageKey = doctorsTab ? row.coverageRepKey : null;
                    const detail =
                      coverageKey && board.coverageDetail?.repKey === coverageKey ? board.coverageDetail : null;
                    return (
                      <div
                        className={coverageKey ? "scroll-mt-20" : undefined}
                        id={coverageKey ? coverageAnchor("mobile", coverageKey) : undefined}
                        key={String(row.agentCrmId ?? `${row.repName}-${index}`)}
                      >
                        {sessionView ? (
                          <SessionCard
                            action={callRateVisitsLink(context, row)}
                            board={board}
                            rank={context.showRank ? index + 1 : undefined}
                            row={row}
                            session={sessionView}
                          />
                        ) : (
                          <RepCard
                            action={
                              doctorsTab
                                ? coverageDoctorsToggle(context, row, "mobile")
                                : tab === "call-rate"
                                  ? callRateVisitsLink(context, row)
                                  : tab === "summary"
                                    ? summaryReportLinks(context, row)
                                    : undefined
                            }
                            amTarget={board.amTarget}
                            notValidated={doctorsTab ? notValidatedLink(context, row, "mobile") : undefined}
                            pmTarget={board.pmTarget}
                            rank={context.showRank ? index + 1 : undefined}
                            report={tab}
                            row={row}
                            rules={board.kpiRules}
                          />
                        )}
                        {detail ? (
                          <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                            {tab === "frequency" ? (
                              <FrequencyDoctors context={context} detail={detail} surface="mobile" />
                            ) : (
                              <CoverageDoctors context={context} detail={detail} surface="mobile" />
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="hidden md:block">
                  {tab === "summary" ? <SummaryTable context={context} rows={board.reps} /> : null}
                  {tab === "call-rate" ? (
                    sessionView ? (
                      <CallRateSessionTable context={context} rows={board.reps} session={sessionView} />
                    ) : (
                      <CallRateTable context={context} rows={board.reps} />
                    )
                  ) : null}
                  {tab === "coverage" ? <CoverageTable context={context} rows={board.reps} teams={coverageTeams} /> : null}
                  {tab === "frequency" ? <FrequencyTable context={context} rows={board.reps} /> : null}
                </div>
              </div>

              {(tab === "coverage" || tab === "frequency") && board.reps.length > 1 && board.teamBricks && board.teamBricks.length > 0 ? (
                <TeamBricksSection context={context} rows={board.teamBricks} />
              ) : null}

              {/* THE MANAGER ROWS (owner, 2026-10-20), apart from the reps and after them: averages of
                  the rows beneath each manager, never counted in anything above. */}
              <ManagersSection context={context} />
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
              * printing it would say "week 3 · 15–21 sep to 2026-09-14" — say it has not started instead.
              *
              * Since ruling C1 (2026-09-21) the two ends differ in a running window too: coverage runs to
              * today and the call rate to YESTERDAY, so the rate's end is printed with the reason. On a
              * period's first day the rate's window is empty (today to yesterday), which is said in words. */}
            {/* The Weekly tab prints its own version of this note under its tables — one window's end
                dates would be wrong for five columns of them. */}
            {weekly ? null : (
            <p className={`leading-4 ${CAPTION}`}>
              Coverage and frequency are scored for {board.monthLabel} to {footerDay(board.asOf)}.{" "}
              {board.range.notStarted
                ? `Call rate is not scored — ${periodPhrase} has not started.`
                : callRateBeganToday(board)
                  ? `Call rate is not scored yet — ${periodPhrase} began today, and today is not scored until it is over.`
                  : `Call rate is scored over ${periodPhrase} to ${footerDay(board.range.dateTo)}${
                      board.range.todayLeftOut ? " — today is not scored until it is over" : ""
                    }.`}{" "}
              {phoenix
                ? "Every submitted regular visit counts toward the call rate; GPS is evidence only. PM passes at 10 a day and AM at 2, judged apart. Frequency passes when a doctor gets the visits their grade asks for (A 3, B 2, C 1) — extra visits are fine and ungraded doctors are left out."
                : "Exact is the only frequency pass — visiting a doctor more often than the plan asked for is a deviation, not a win."}{" "}
              The bands below cut each measure into ranges. The Overall KPI is the one figure that combines
              them: the average of Coverage, Frequency, AM and PM, each capped at 100% before it is averaged.
              The Standing out rankings use the uncapped figures. A rep hired inside the period who has
              worked under a third of its working days shows as just started and is not judged.
            </p>
            )}
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
