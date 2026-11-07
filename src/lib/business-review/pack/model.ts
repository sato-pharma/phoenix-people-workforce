// The Sales Review pack — what is IN it, before anything decides how to draw it.
//
// Owner, 2026-09-26: a manager ticks his metrics, presses export, and gets a corporate pack instead
// of building slides by hand. This module turns the page's own data into an ordered list of titled
// tables. The PDF renderer and the workbook renderer both read THIS — neither computes a figure,
// and neither decides what a section is called.
//
// That separation is the whole design. A renderer that derived its own numbers would be a second
// opinion about achievement, and the two files a manager exports five minutes apart would disagree
// in front of his own manager.
//
// EVERY HONESTY RULE THE SCREEN CARRIES TRAVELS WITH THE SECTION, as its `note`:
//
//   * the achievement beside a rep's name is his AREA's, shared by everyone standing in it —
//     targets are set per area and there is no per-rep achievement in this system;
//   * unique customers per month do NOT sum to the window, because each month is its own union;
//   * a source with no rows for the window says so in words rather than showing 0, which would read
//     as "nobody did anything";
//   * El Qema is already masked out upstream, in the loader — never here.
//
// A section with nothing to say is DROPPED rather than exported empty. A deck with a blank slide
// headed "Brick spread" tells the room the district sold through no bricks.

import {
  emptyVisitCountSplit,
  formatVisitCountSplit,
  mergeVisitCountSplits,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";

import type { ConcentrationFacts, ReviewSalesDetail } from "../concentration";
import { describeSpread } from "../concentration";
import type { FieldLinkFacts } from "../field-link";
import type { ReviewKpiMonth } from "../sources/crm-kpis";
import { isResignedStatus, leaverLabel } from "../employment-status";
import { REVIEW_FLOOR } from "../period";
import { periodColumnLabel, periodLabel, windowLabel } from "../period-format";
import { comparisonBasisFor, deltaPct, deltaPoints, formatDelta } from "../previous-window";
import type { ReviewPersonRow } from "../sources/roles";
import { describeSpecialtyMix, type SpecialtyMix } from "../specialty-mix";
import type { AreaSummary, DmSummary, Slice } from "../types";
import {
  areaWorkSection,
  awarenessSection,
  brickWorkSection,
  buildLinkContext,
  classAMissedSection,
  costToServeSection,
  directOrdersSection,
  dvFocusSections,
  pharmacyCell,
  plainForRep,
  requestsSection,
  summarySection,
  teamScorecardSection,
  withPharmacyNote,
} from "./link-sections";
import { crmKpiSection } from "./kpi-sections";
import { metricById, type PackSubject, type ReviewMetricId } from "./metrics";
import { sumSlices } from "./slices";

export { sumSlices };

/**
 * An area, plus the line it sits on when the pack spans more than one.
 *
 * "Alex Center" is a CNS territory AND a Pedia one, with different managers and different numbers.
 * A company pack that listed the name twice with no line would be unreadable, so the line becomes a
 * column — and null when there is only one line, because a column of one repeated value is noise.
 */
export type PackArea = AreaSummary & { lineLabel?: string | null };
export type PackDm = DmSummary & { lineLabel?: string | null };

export type PackCell = string | number | null;
export type PackAlign = "left" | "right";

/** One bar. `value` is null when the figure is not gradeable — the bar is then drawn as absent, never 0. */
export type PackChartItem = { label: string; value: number | null; note?: string | null };

/**
 * A chart drawn above a section's table.
 *
 * 🔴 IT CARRIES NO FIGURE THE SECTION DOES NOT ALREADY HOLD. The model builds it from the very rows
 * the table lists, so a reader cannot find a bar that disagrees with the line under it — the same
 * reason `lineComparison` rolls up from this pack's own areas. The renderers DRAW it and compute
 * nothing, exactly as they draw the rows.
 */
export type PackChart = {
  kind: "bars";
  /**
   * What a bar's length means. `pct` is achievement, always scaled against 100 so a bad month cannot
   * flatter itself; `share` is a share of the window's value; `count` is a plain tally or an amount
   * in EGP, scaled to its own largest bar.
   *
   * 🔴 A `count` chart may only plot figures that genuinely ADD — a visit belongs to one rep, a
   * claim to one district. Customers and visiting reps are UNIONS, and a chart of them summed would
   * count one doctor twice. That is why "Unique customers per month" carries no chart.
   */
  unit: "pct" | "share" | "count";
  /** Appended after a `count` bar's figure — "EGP", "visits". Never used for a percentage. */
  countSuffix?: string | null;
  /** A dotted rule across the plot — the 90% earner mark, where achievement is the unit. */
  reference?: { value: number; label: string } | null;
  /** Said ON the chart when it plots fewer items than the table holds — never a silent truncation. */
  capNote?: string | null;
  items: PackChartItem[];
};

export type PackSection = {
  metric: ReviewMetricId;
  title: string;
  /** One line under the title: what it means, or what it deliberately cannot say. */
  note: string;
  columns: string[];
  /** Per column, so the workbook and the PDF align the same way. */
  align: PackAlign[];
  rows: PackCell[][];
  /** Drawn above the table by the PDF and the deck. Absent where a picture would say nothing. */
  chart?: PackChart | null;
  /**
   * Relative column widths for the PDF, for the one case its alignment rule misjudges: a column of
   * whole SENTENCES beside a short label (the one-page summary), which the rule would split 50/50.
   * Absent everywhere else, so every other section lays out exactly as before. The deck sizes its
   * columns by their content and needs no hint.
   */
  weights?: number[];
};

export type SalesReviewPack = {
  subject: PackSubject;
  /** ISO instant. The renderers format it in Africa/Cairo, which is the only time the owner reads. */
  generatedAt: string;
  /** What the window holds and what is held out of it, in the coverage layer's own words. */
  coverageNote: string;
  /** In catalogue order. Only metrics that had something to say. */
  sections: PackSection[];
};

export type PackInput = {
  subject: PackSubject;
  selection: readonly ReviewMetricId[];
  coverageNote: string;
  generatedAt?: string;
  months: readonly string[];
  areas: readonly PackArea[];
  dms: readonly PackDm[];
  people: readonly ReviewPersonRow[];
  /** Null when the customer-grain metrics were not ticked, or the read failed. */
  concentration: ConcentrationFacts | null;
  /** False when the CRM holds no rows for this window — then activity says so, never 0. */
  visitsAvailable: boolean;
  /**
   * The linked field facts — the reps' lists, visits, ride days, direct orders, marketing requests
   * and awareness activities, read for THIS viewer's scope. Null (or absent) when no linked metric
   * was ticked or the read failed; every linked section is then dropped, never drawn as zero.
   */
  fieldLink?: FieldLinkFacts | null;
  /**
   * The scope's own Monthly Closing customer rows — its lines and its areas, El Qema already masked
   * — for the brick table. Null when the closing's detail was not read.
   */
  brickSales?: readonly Pick<ReviewSalesDetail, "brickId" | "brickName" | "channel" | "value">[] | null;
  /**
   * The CRM KPIs board's own rows for the pack's reps, one board per month of the figure window —
   * coverage and frequency against each rep's plan, and his AM · PM · pharmacy call rate. Null (or
   * absent) when the metric was not ticked or the read failed; the section is then dropped.
   */
  crmKpis?: readonly ReviewKpiMonth[] | null;
};

const NO_VISIT_DATA = "no CRM rows in this window";
const num = (value: number) => (Number.isFinite(value) ? value : 0);
const pct = (value: number | null) => (value == null ? "not gradeable" : `${value.toFixed(1)}%`);

/** Build the pack. Pure — every figure is read, none is recomputed. */
export function buildSalesReviewPack(input: PackInput): SalesReviewPack {
  const wanted = new Set(input.selection);
  const sections: PackSection[] = [];
  const add = (section: PackSection | null) => {
    if (section && section.rows.length > 0) sections.push(section);
  };
  // The linked facts, computed ONCE, so the one-page summary and the tables after it read the same
  // builder results and cannot disagree (owner, 2026-10-01). Null when none was read.
  const link = buildLinkContext(input);

  // The period in plain sentences opens every pack — for a rep it is the page he reads first.
  if (wanted.has("review-summary")) {
    add(summarySection(input, link));
  }
  // Then the slide a company or multi-line review opens on.
  if (wanted.has("line-comparison")) {
    add(lineComparison(input));
  }
  if (wanted.has("achievement") || wanted.has("sales-vs-target")) {
    add(areaPerformance(input));
  }
  if (wanted.has("achievement-ex-vacant")) {
    add(achievementExVacant(input));
  }
  if (wanted.has("per-product")) {
    add(perProduct(input));
  }
  if (wanted.has("per-family")) {
    add(perFamily(input));
  }
  if (wanted.has("month-by-month")) {
    add(monthByMonth(input));
  }
  if (wanted.has("vs-previous-window")) {
    add(vsPrevious(input));
  }
  if (wanted.has("brick-spread") && input.concentration) {
    add(spread(input.concentration.bricks, "brick-spread", "Bricks", "Brick"));
  }
  if (wanted.has("customer-concentration") && input.concentration) {
    add(spread(input.concentration.customers, "customer-concentration", "Customers", "Customer"));
  }
  if (wanted.has("channel-split") && input.concentration) {
    add(channels(input.concentration));
  }
  // The work laid beside the money (owner, 2026-10-01): bricks, areas, and the class A to-do list.
  if (wanted.has("brick-work")) {
    add(brickWorkSection(input, link));
  }
  if (wanted.has("area-work")) {
    add(areaWorkSection(input, link));
  }
  if (wanted.has("class-a-missed")) {
    add(classAMissedSection(input, link));
  }
  // The CRM's own KPIs head the field activity (owner, 2026-10-01: "add all three").
  if (wanted.has("crm-kpis")) {
    add(crmKpiSection(input));
  }
  if (wanted.has("visits-split")) {
    add(visitsSplit(input));
  }
  if (wanted.has("specialty-mix")) {
    for (const dm of input.dms) add(specialty(dm.specialityMix, dm.dm));
  }
  if (wanted.has("coverage-frequency")) {
    add(coverageFrequency(input));
  }
  if (wanted.has("double-visits")) {
    add(doubleVisitsByArea(input));
    add(doubleVisitsByManager(input));
  }
  if (wanted.has("dv-focus")) {
    for (const section of dvFocusSections(input, link)) add(section);
  }
  if (wanted.has("rep-rows")) {
    add(repRows(input));
  }
  if (wanted.has("role-activity")) {
    add(roleActivity(input));
  }
  if (wanted.has("team-scorecard")) {
    add(teamScorecardSection(input, link));
  }
  if (wanted.has("customers-per-month")) {
    add(customersPerMonth(input));
  }
  if (wanted.has("marketing-committed") || wanted.has("outstation-claimed") || wanted.has("spend-per-point")) {
    // A district pack reads the districts; a rep's pack holds no district row (the route withholds
    // it — his manager's whole district is not his territory), so his cost is read off his area.
    add(input.dms.length > 0 ? spend(input) : areaSpend(input));
  }
  if (wanted.has("marketing-vs-trend")) {
    add(marketingVsTrend(input));
  }
  if (wanted.has("direct-orders")) {
    add(directOrdersSection(input, link));
  }
  if (wanted.has("requests-return")) {
    add(requestsSection(input, link));
  }
  if (wanted.has("awareness")) {
    add(awarenessSection(input, link));
  }
  if (wanted.has("cost-to-serve")) {
    add(costToServeSection(input, link));
  }

  // Catalogue order, whatever order the caller ticked them in — so two people exporting the same
  // metrics get the same document.
  const order = new Map<ReviewMetricId, number>();
  let i = 0;
  for (const section of sections) {
    if (!order.has(section.metric)) order.set(section.metric, i++);
  }
  sections.sort((a, b) => (order.get(a.metric) ?? 0) - (order.get(b.metric) ?? 0));

  return {
    coverageNote: input.coverageNote,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    // "Built on maturity level" (owner, 2026-10-01): a medical rep reads every figure his territory
    // answers, in his own voice — the same numbers, plainer words. See link-sections.ts.
    sections: input.subject.level === "rep" ? sections.map(plainForRep) : sections,
    subject: input.subject,
  };
}

/**
 * Bars a reader can actually take in. Above this the chart says on its own face what it plotted, and
 * the table under it still holds every row. The PDF gives a chart this tall a page of its own.
 */
const CHART_BARS = 12;
/** The earner mark every achievement table in this system is read against. */
const EARNER = { label: "90% earner", value: 90 };

/**
 * A person's name in the pack, marked when he has left — owner's ruling, 2026-09-28.
 *
 * He keeps his rows: a Jul–Aug review is about Jul–Aug, and seventeen reps and two district
 * managers who worked those months have since resigned. Dropping them would leave their visits and
 * their areas' sales with nobody who did the work. What the pack must not do is print them exactly
 * like people who are still here.
 */
function personName(person: ReviewPersonRow): string {
  return isResignedStatus(person.employmentStatus)
    ? leaverLabel(person.name, person.lastWorkingDate)
    : person.name;
}

function areaPerformance({ areas, visitsAvailable }: PackInput): PackSection {
  const withLine = areas.some((area) => area.lineLabel);
  // Graded areas only: an ungradeable one has no percentage to draw, and a 0% bar would accuse a
  // territory of failing when the truth is that it carried no target.
  const ranked = areas
    .filter((area) => area.allProducts.ach != null)
    .sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));
  const plotted = ranked.slice(0, CHART_BARS);
  return {
    chart:
      plotted.length >= 2
        ? {
            capNote:
              ranked.length > plotted.length
                ? `The ${plotted.length} highest of ${ranked.length} graded areas — this section's table holds every one.`
                : null,
            items: plotted.map((area) => ({
              label: area.area,
              note: area.dm,
              value: area.allProducts.ach,
            })),
            kind: "bars",
            reference: EARNER,
            unit: "pct",
          }
        : null,
    align: withLine
      ? ["left", "left", "left", "right", "right", "right", "right"]
      : ["left", "left", "right", "right", "right", "right"],
    columns: withLine
      ? ["Area", "Line", "District manager", "Achievement", "Sales", "Target", "Customers"]
      : ["Area", "District manager", "Achievement", "Sales", "Target", "Customers"],
    metric: "achievement",
    note: "Achievement is sales in targeted months over target — the Monthly Closing's own rule, never an average of percentages. It is period to date over the window shown, not a settled semester payout.",
    rows: areas.map((area) => [
      area.area,
      ...(withLine ? [area.lineLabel ?? "—"] : []),
      area.dm,
      pct(area.allProducts.ach),
      num(area.allProducts.sales),
      num(area.allProducts.target),
      visitsAvailable ? num(area.customersTotal) : NO_VISIT_DATA,
    ]),
    title: "Areas",
  };
}

/**
 * The lines side by side — the slide a company review opens on.
 *
 * 🔴 ROLLED UP FROM THE VERY AREAS THIS PACK HOLDS, not from the line rollup the page loaded. Two
 * sources for one figure is how a deck's opening slide comes to disagree with its own second slide
 * in front of a room. Because both read the same list, they cannot.
 *
 * sum(sales) / sum(target), never an average of the areas' percentages — the Monthly Closing's rule.
 *
 * Returns null below two lines: a "comparison" of one line is a slide that compares nothing, and the
 * caller drops a section with no rows anyway.
 */
function lineComparison({ areas }: PackInput): PackSection | null {
  const byLine = new Map<string, { areas: number; sales: number; target: number }>();
  for (const area of areas) {
    const line = area.lineLabel;
    if (!line) continue;
    const row = byLine.get(line) ?? { areas: 0, sales: 0, target: 0 };
    row.areas += 1;
    row.sales += num(area.allProducts.sales);
    row.target += num(area.allProducts.target);
    byLine.set(line, row);
  }
  if (byLine.size < 2) return null;
  return {
    chart: {
      capNote: null,
      items: [...byLine.entries()].map(([line, row]) => ({
        label: line,
        note: `${row.areas} areas`,
        value: row.target > 0 ? (row.sales / row.target) * 100 : null,
      })),
      kind: "bars",
      reference: EARNER,
      unit: "pct",
    },
    align: ["left", "right", "right", "right", "right"],
    columns: ["Line", "Achievement", "Sales", "Target", "Areas"],
    metric: "line-comparison",
    note: "Each line's own sales over its own target — sum(sales)/sum(target), never an average of the areas' percentages. Rolled up from the areas listed in this same pack, so the two cannot disagree.",
    rows: [...byLine.entries()].map(([line, row]) => [
      line,
      row.target > 0 ? `${((row.sales / row.target) * 100).toFixed(1)}%` : "not gradeable",
      row.sales,
      row.target,
      row.areas,
    ]),
    title: "Line comparison",
  };
}

function spread(
  facts: ConcentrationFacts["bricks"],
  metric: ReviewMetricId,
  title: string,
  noun: string,
): PackSection {
  return {
    // Share of the window's value, largest first — the shape of "is it spread or is it one".
    chart:
      facts.top.length >= 2
        ? {
            capNote: facts.count > facts.top.length ? `The ${facts.top.length} largest of ${facts.count}.` : null,
            items: facts.top.map((row) => ({ label: row.label, note: null, value: row.share })),
            kind: "bars",
            reference: null,
            unit: "share",
          }
        : null,
    align: ["left", "right", "right"],
    columns: [noun, "Sales", "Share"],
    metric,
    note: describeSpread(facts, noun.toLowerCase()),
    rows: facts.top.map((row) => [row.label, num(row.value), `${row.share.toFixed(1)}%`]),
    title,
  };
}

// 🔴 NULL WHEN THE WINDOW CARRIES NO CUSTOMER-GRAIN SALES — a page of "0 · 0 · 0" under "How it
// reached the market" reads as a channel that sold nothing, beside a summary that says it sold.
// That is the page a rep's Jul–Sep pack printed on 2026-10-29 (EGP 222,448 of sales on page 1).
function channels(facts: ConcentrationFacts): PackSection | null {
  if (!(facts.totalValue > 0)) return null;
  const share = (value: number) => `${((value / facts.totalValue) * 100).toFixed(1)}%`;
  const pctOf = (value: number) => (value / facts.totalValue) * 100;
  return {
    chart: {
      capNote: null,
      items: [
        { label: "Through distributors", note: null, value: pctOf(facts.channels.distributor) },
        { label: "Through stores", note: null, value: pctOf(facts.channels.wholesaler) },
        { label: "Direct orders", note: null, value: pctOf(facts.channels.direct) },
      ],
      kind: "bars",
      reference: null,
      unit: "share",
    },
    align: ["left", "right", "right"],
    columns: ["Channel", "Sales", "Share"],
    metric: "channel-split",
    note: "The three add up to the window's whole sales value. A direct order is direct whoever bought it; a store is a customer that sells on.",
    rows: [
      ["Through distributors", num(facts.channels.distributor), share(facts.channels.distributor)],
      ["Through stores", num(facts.channels.wholesaler), share(facts.channels.wholesaler)],
      ["Direct orders", num(facts.channels.direct), share(facts.channels.direct)],
    ],
    title: "How it reached the market",
  };
}

function specialty(mix: SpecialtyMix, districtName: string): PackSection | null {
  if (mix.customersTotal === 0 && mix.visitsTotal === 0) return null;
  return {
    align: ["left", "left", "right", "right"],
    columns: ["Speciality", "Counts as", "Customers", "Visits"],
    metric: "specialty-mix",
    note: describeSpecialtyMix(mix),
    rows: mix.specialities.map((row) => [
      row.label,
      row.kind === "sp" ? "Doctor" : row.kind === "hcp" ? "Pharmacy, hospital or account" : "Not classified by the vendor",
      row.customers,
      row.visits,
    ]),
    title: `What the list is made of — ${districtName}`,
  };
}

function repRows({ areas, people, visitsAvailable }: PackInput): PackSection {
  const areaByCode = new Map(areas.filter((a) => a.areaCode).map((a) => [a.areaCode as string, a]));
  // Visits, never the percentage beside them: the achievement on a rep's row is his AREA's, shared
  // with everyone standing in it, so a bar per rep would read as a personal score it is not. A visit
  // belongs to exactly one rep, so these bars are his own and they genuinely add.
  const visited = people
    .filter((person) => person.areaCode != null && person.fieldVisits > 0)
    .sort((a, b) => b.fieldVisits - a.fieldVisits);
  const plottedReps = visited.slice(0, CHART_BARS);
  return {
    chart:
      visitsAvailable && plottedReps.length >= 2
        ? {
            capNote:
              visited.length > plottedReps.length
                ? `Field visits — the ${plottedReps.length} busiest of ${visited.length} reps. This section's table holds every one, and the percentage beside a rep is their area's.`
                : "Field visits. The percentage beside a rep in the table is their AREA's, not their own.",
            countSuffix: "visits",
            items: plottedReps.map((person) => ({
              label: personName(person),
              note: areaByCode.get(person.areaCode as string)?.area ?? null,
              value: person.fieldVisits,
            })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: ["left", "left", "right", "right", "right"],
    columns: ["Rep", "Area they stand in", "Area achievement", "Visits", "AM · PM · Pharmacies"],
    metric: "rep-rows",
    // The single most important sentence in the pack. See the module header.
    note: "The percentage is the AREA's, shared by everyone standing in it — targets are set per area, never per rep.",
    rows: people
      .filter((person) => person.areaCode != null && person.fieldVisits > 0)
      .sort((a, b) => b.fieldVisits - a.fieldVisits)
      .map((person) => {
        const area = areaByCode.get(person.areaCode as string) ?? null;
        return [
          personName(person),
          area?.area ?? "Area not resolved",
          pct(area?.allProducts.ach ?? null),
          visitsAvailable ? person.fieldVisits : NO_VISIT_DATA,
          visitsAvailable ? formatVisitCountSplit(person.visitSplit) : NO_VISIT_DATA,
        ];
      }),
    title: "Rep by rep",
  };
}

function customersPerMonth({ months, people, visitsAvailable }: PackInput): PackSection {
  const shown = people.filter((person) => person.customers > 0);
  const monthList = [...months];
  return {
    align: ["left", "right", ...monthList.map((): PackAlign => "right")],
    columns: ["Person", "Window", ...monthList.map((month) => periodColumnLabel(month, monthList))],
    metric: "customers-per-month",
    note: "Each month is its own union — a doctor seen twice is one customer in each — so the months do NOT add up to the window.",
    rows: visitsAvailable
      ? shown.map((person) => [
          personName(person),
          person.customers,
          ...monthList.map((month) => person.customersByMonth[month] ?? 0),
        ])
      : [],
    title: "Unique customers per month",
  };
}

function spend({ dms }: PackInput): PackSection {
  const withLine = dms.some((dm) => dm.lineLabel);
  // Total spend, not spend per point: on that measure a LONGER bar is a WORSE result, and a chart
  // whose winner is its shortest bar is read backwards in a room. Marketing plus outstation is money
  // committed, each pound belonging to exactly one district, so the bars add.
  const spenders = dms
    .map((dm) => ({ label: dm.dm, note: dm.lineLabel ?? null, value: dm.marketingCost + dm.outstationCost }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const plottedDms = spenders.slice(0, CHART_BARS);
  return {
    chart:
      plottedDms.length >= 2
        ? {
            capNote:
              (spenders.length > plottedDms.length
                ? `Marketing plus outstation, EGP — the ${plottedDms.length} largest of ${spenders.length} districts. `
                : "Marketing plus outstation, EGP. ") +
              "What it bought is the achievement beside it in the table; the bar is a cost, never a score.",
            countSuffix: "EGP",
            items: plottedDms,
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: withLine
      ? ["left", "left", "right", "right", "right", "right"]
      : ["left", "right", "right", "right", "right"],
    columns: withLine
      ? ["District", "Line", "Marketing", "Outstation claimed", "Achievement", "Spend per point"]
      : ["District", "Marketing", "Outstation claimed", "Achievement", "Spend per point"],
    metric: "marketing-committed",
    note: "Spend per point is marketing plus outstation divided by points of achievement — LOWER IS BETTER, and it is a cost rather than a score.",
    rows: dms.map((dm) => {
      const ach = dm.allProducts.ach;
      const total = dm.marketingCost + dm.outstationCost;
      return [
        dm.dm,
        ...(withLine ? [dm.lineLabel ?? "—"] : []),
        num(dm.marketingCost),
        num(dm.outstationCost),
        pct(ach),
        ach != null && ach > 0 ? Math.round(total / ach) : "—",
      ];
    }),
    title: "Cost",
  };
}

// ── The sections the catalogue promised and this file never drew (owner, 2026-09-28) ──────────────
//
// 🔴 THE PICKER OFFERED 22 METRICS AND THIS FILE DREW 9. Achievement excluding vacant, per product,
// per family, month by month, against the previous window, visits, coverage and frequency, double
// visits, marketing against the trend and by role were all ticked in a fresh pack and silently
// produced nothing, so a medical rep's pack came out as five sections with every field KPI missing.
// The owner: "show the full data … as he filters, the pack is exported." Every builder below reads
// data this scope already loaded; none recomputes a figure the engine owns.

// `sumSlices` — the one rule for totalling achievement — lives in ./slices.ts so the linked
// sections read it without importing this file; it is re-exported at the top of this module.

/** A Line cell only when the pack spans more than one line; a column of one repeated value is noise. */
function lineCells(withLine: boolean, label: string | null | undefined): PackCell[] {
  return withLine ? [label ?? "—"] : [];
}

function achievementExVacant({ areas }: PackInput): PackSection | null {
  const vacant = areas.filter((area) => area.vacant);
  // Nothing to take out, or nothing left after taking it out: either way there is no comparison.
  if (vacant.length === 0 || vacant.length === areas.length) return null;
  const inPost = areas.filter((area) => !area.vacant);
  const every = sumSlices(areas.map((area) => area.allProducts));
  const held = sumSlices(inPost.map((area) => area.allProducts));
  const empty = sumSlices(vacant.map((area) => area.allProducts));
  const row = (label: string, slice: Slice, count: number): PackCell[] => [
    label,
    pct(slice.ach),
    num(slice.sales),
    num(slice.target),
    count,
  ];
  return {
    chart: {
      capNote: null,
      items: [
        { label: "Every area", note: `${areas.length} areas`, value: every.ach },
        { label: "Areas with someone in post", note: `${inPost.length} areas`, value: held.ach },
      ],
      kind: "bars",
      reference: EARNER,
      unit: "pct",
    },
    align: ["left", "right", "right", "right", "right"],
    columns: ["Areas", "Achievement", "Sales", "Target", "Count"],
    metric: "achievement-ex-vacant",
    note: "The Monthly Closing's rule with vacant territories taken out of both halves — what the people in post delivered. A vacant area's sales are real; they are simply nobody's work yet.",
    rows: [
      row("Every area", every, areas.length),
      row("Areas with someone in post", held, inPost.length),
      row("Vacant areas", empty, vacant.length),
    ],
    title: "Achievement excluding vacant",
  };
}

function perProduct({ areas }: PackInput): PackSection | null {
  const names = [...new Set(areas.flatMap((area) => Object.keys(area.products ?? {})))];
  const products = names
    .map((name) => ({ name, slice: sumSlices(areas.map((area) => area.products?.[name])) }))
    .filter((row) => row.slice.sales !== 0 || row.slice.target !== 0)
    .sort((a, b) => b.slice.sales - a.slice.sales);
  if (products.length === 0) return null;
  const graded = products
    .filter((row) => row.slice.ach != null)
    .sort((a, b) => (b.slice.ach ?? -1) - (a.slice.ach ?? -1));
  const plotted = graded.slice(0, CHART_BARS);
  return {
    chart:
      plotted.length >= 2
        ? {
            capNote:
              graded.length > plotted.length
                ? `The ${plotted.length} highest of ${graded.length} graded products — this section's table holds every one.`
                : null,
            items: plotted.map((row) => ({ label: row.name, note: null, value: row.slice.ach })),
            kind: "bars",
            reference: EARNER,
            unit: "pct",
          }
        : null,
    align: ["left", "right", "right", "right"],
    columns: ["Product", "Achievement", "Sales", "Target"],
    metric: "per-product",
    // Value, never units: two products' units are never added, and one product across areas is still
    // one product, so its money sums.
    note: "Include products — the ones the scheme counts. Each product's own sales in targeted months over its own target, summed across the areas in this pack in money, never as an average of their percentages.",
    rows: products.map((row) => [row.name, pct(row.slice.ach), num(row.slice.sales), num(row.slice.target)]),
    title: "Per product",
  };
}

function perFamily({ dms }: PackInput): PackSection | null {
  const withLine = dms.some((dm) => dm.lineLabel);
  const rows: PackCell[][] = [];
  for (const dm of dms) {
    const families = Object.entries(dm.familyAch ?? {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [family, ach] of families) {
      rows.push([dm.dm, ...lineCells(withLine, dm.lineLabel), family, pct(ach)]);
    }
  }
  if (rows.length === 0) return null;
  return {
    align: withLine ? ["left", "left", "left", "right"] : ["left", "left", "right"],
    columns: withLine
      ? ["District manager", "Line", "Family", "Achievement"]
      : ["District manager", "Family", "Achievement"],
    metric: "per-family",
    note: "Each product family's achievement inside each district, as the district rollup computes it. A percentage does not add, so families are not totalled across districts here.",
    rows,
    title: "Per family",
  };
}

function monthByMonth({ areas, months, visitsAvailable }: PackInput): PackSection | null {
  if (months.length === 0) return null;
  const monthRows = months.map((month) => ({
    label: periodColumnLabel(month, months),
    slice: sumSlices(areas.map((area) => area.byMonth?.[month])),
    visits: areas.reduce((sum, area) => sum + num(area.visitsByMonth?.[month] ?? 0), 0),
  }));
  if (monthRows.every((row) => row.slice.sales === 0 && row.slice.target === 0 && row.visits === 0)) return null;
  const graded = monthRows.filter((row) => row.slice.ach != null);
  return {
    chart:
      graded.length >= 2
        ? {
            capNote: null,
            items: graded.map((row) => ({ label: row.label, note: null, value: row.slice.ach })),
            kind: "bars",
            reference: EARNER,
            unit: "pct",
          }
        : null,
    align: ["left", "right", "right", "right", "right"],
    columns: ["Month", "Achievement", "Sales", "Target", "Field visits"],
    metric: "month-by-month",
    note: "Each month graded on its own sales over its own target. Field visits add across areas; unique customers do not, so they have a section of their own.",
    rows: monthRows.map((row) => [
      row.label,
      pct(row.slice.ach),
      num(row.slice.sales),
      num(row.slice.target),
      visitsAvailable ? row.visits : NO_VISIT_DATA,
    ]),
    title: "Month by month",
  };
}

/**
 * This window against the one before it — or, while the review floor forbids that, the last month
 * against the month before it. `comparisonBasisFor` decides, and its label travels with the figures.
 */
function vsPrevious({ areas, months }: PackInput): PackSection | null {
  const basis = comparisonBasisFor(months, REVIEW_FLOOR);
  if (basis.kind === "none" || months.length === 0) return null;
  const nowPeriods = basis.kind === "previous-month" ? [months[months.length - 1]] : [...months];
  // A previous WINDOW sits outside what was loaded. Its months must actually be here, or this would
  // compare the window against zeros and print the difference as a collapse.
  const loaded = (period: string) => areas.some((area) => area.byMonth?.[period] != null);
  if (!basis.periods.every(loaded) || !nowPeriods.every(loaded)) return null;

  const nowLabel =
    nowPeriods.length === 1
      ? periodLabel(nowPeriods[0])
      : windowLabel(nowPeriods[0], nowPeriods[nowPeriods.length - 1]);
  const withLine = areas.some((area) => area.lineLabel);
  const compared = areas
    .map((area) => ({
      area,
      before: sumSlices(basis.periods.map((p) => area.byMonth?.[p])),
      now: sumSlices(nowPeriods.map((p) => area.byMonth?.[p])),
    }))
    .filter((row) => row.now.sales !== 0 || row.before.sales !== 0)
    .sort((a, b) => b.now.sales - a.now.sales);
  if (compared.length === 0) return null;

  const cells = (label: string, lineLabel: string | null | undefined, now: Slice, before: Slice): PackCell[] => [
    label,
    ...lineCells(withLine, lineLabel),
    pct(now.ach),
    pct(before.ach),
    formatDelta(deltaPoints(now.ach, before.ach), "pts"),
    num(now.sales),
    num(before.sales),
    formatDelta(deltaPct(now.sales, before.sales), "%"),
  ];
  const totalNow = sumSlices(compared.map((row) => row.now));
  const totalBefore = sumSlices(compared.map((row) => row.before));
  return {
    align: withLine
      ? ["left", "left", "right", "right", "right", "right", "right", "right"]
      : ["left", "right", "right", "right", "right", "right", "right"],
    columns: [
      "Area",
      ...(withLine ? ["Line"] : []),
      "Achievement now",
      "Achievement before",
      "Points",
      "Sales now",
      "Sales before",
      "Sales change",
    ],
    metric: "vs-previous-window",
    note:
      basis.kind === "previous-month"
        ? `Now is ${nowLabel}, before is ${basis.label}. The review reads nothing before ${periodLabel(REVIEW_FLOOR)}, so no earlier window of the same length exists to compare with — the month before, inside this window, is the honest comparison.`
        : `Now is ${nowLabel}, before is ${basis.label} — the same span immediately before it.`,
    rows: [
      ...compared.map((row) => cells(row.area.area, row.area.lineLabel, row.now, row.before)),
      cells("Every area in this pack", withLine ? "—" : null, totalNow, totalBefore),
    ],
    title: "Against the previous window",
  };
}

function visitsSplit({ people, visitsAvailable }: PackInput): PackSection | null {
  if (!visitsAvailable) return null;
  const active = people.filter((person) => person.fieldVisits > 0).sort((a, b) => b.fieldVisits - a.fieldVisits);
  if (active.length === 0) return null;
  const plotted = active.slice(0, CHART_BARS);
  const total = active.reduce(
    (sum, person) => ({
      am: sum.am + num(person.visitSplit.am),
      campaign: sum.campaign + num(person.campaignVisits),
      pharmacies: sum.pharmacies + num(person.visitSplit.pharmacies),
      pm: sum.pm + num(person.visitSplit.pm),
      regular: sum.regular + num(person.regularVisits),
      visits: sum.visits + num(person.fieldVisits),
    }),
    { am: 0, campaign: 0, pharmacies: 0, pm: 0, regular: 0, visits: 0 },
  );
  // The same three figures merged by the golden-rule helper, so the total row knows how many of its
  // visits were Phoenix CRM's (which logs no pharmacy visit) and never prints that figure as 0.
  const totalSplit = active.reduce((sum, person) => mergeVisitCountSplits(sum, person.visitSplit), emptyVisitCountSplit());
  return {
    chart:
      plotted.length >= 2
        ? {
            capNote:
              active.length > plotted.length
                ? `Field visits — the ${plotted.length} busiest of ${active.length}. This section's table holds every one.`
                : "Field visits.",
            countSuffix: "visits",
            items: plotted.map((person) => ({
              label: personName(person),
              note: person.jobTitle || person.role || null,
              value: person.fieldVisits,
            })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: ["left", "right", "right", "right", "right", "right", "right"],
    columns: ["Person", "Field visits", "AM", "PM", "Pharmacies", "Planned", "Unplanned"],
    metric: "visits-split",
    // The owner's golden rule, carried with the figures that obey it.
    note: withPharmacyNote(
      "AM · PM · Pharmacies are three figures kept apart — a pharmacy is never counted inside PM or AM, and there is no combined call rate. A visit belongs to exactly one person, so these rows add.",
      [[totalSplit], ...active.map((person) => [person.visitSplit] as const)],
    ),
    rows: [
      ...active.map((person): PackCell[] => [
        personName(person),
        num(person.fieldVisits),
        num(person.visitSplit.am),
        num(person.visitSplit.pm),
        pharmacyCell(person.visitSplit),
        num(person.regularVisits),
        num(person.campaignVisits),
      ]),
      ...(active.length > 1
        ? [["Everyone above", total.visits, total.am, total.pm, pharmacyCell(totalSplit), total.regular, total.campaign]]
        : []),
    ],
    title: "Visits",
  };
}

/** A person's distinct customers as a split — judged by the visits they were counted from. */
const customerSplitOf = (person: ReviewPersonRow): VisitCountSplit => ({
  am: num(person.customersAm),
  pm: num(person.customersPm),
  pharmacies: num(person.customersPharmacy),
});

function coverageFrequency({ people, visitsAvailable }: PackInput): PackSection | null {
  if (!visitsAvailable) return null;
  const reached = people.filter((person) => person.customers > 0).sort((a, b) => b.customers - a.customers);
  if (reached.length === 0) return null;
  return {
    align: ["left", "right", "right", "right", "right", "right", "right"],
    columns: ["Person", "Customers reached", "AM", "PM", "Pharmacies", "Planned visits", "Planned visits per customer"],
    metric: "coverage-frequency",
    note: withPharmacyNote(
      "From the visits themselves: the distinct customers each person saw, AM · PM · Pharmacies apart, and the planned visits each received on average. Coverage and frequency against each rep's PLAN are the CRM KPIs board's, in \"Coverage, frequency and call rate\". Customers are unions, so these rows are never totalled.",
      reached.map((person) => [customerSplitOf(person), person.customerVisitSplit ?? person.visitSplit] as const),
    ),
    rows: reached.map((person) => [
      personName(person),
      num(person.customers),
      num(person.customersAm),
      num(person.customersPm),
      pharmacyCell(customerSplitOf(person), person.customerVisitSplit ?? person.visitSplit),
      num(person.regularVisits),
      person.customers > 0 ? (num(person.regularVisits) / person.customers).toFixed(1) : "—",
    ]),
    title: "Customers reached",
  };
}

function doubleVisitsByArea({ areas }: PackInput): PackSection | null {
  const withLine = areas.some((area) => area.lineLabel);
  const ridden = areas.filter((area) => num(area.doubleVisits) > 0).sort((a, b) => b.doubleVisits - a.doubleVisits);
  if (ridden.length === 0) return null;
  const plotted = ridden.slice(0, CHART_BARS);
  return {
    chart:
      plotted.length >= 2
        ? {
            capNote: ridden.length > plotted.length ? `The ${plotted.length} most ridden of ${ridden.length} areas.` : null,
            countSuffix: "rides",
            items: plotted.map((area) => ({ label: area.area, note: area.dm, value: area.doubleVisits })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: withLine ? ["left", "left", "left", "right"] : ["left", "left", "right"],
    columns: withLine
      ? ["Area", "Line", "District manager", "Double visits"]
      : ["Area", "District manager", "Double visits"],
    metric: "double-visits",
    note: "Visits a manager rode along on, counted in the area where they happened — the rides the people there RECEIVED.",
    rows: ridden.map((area) => [area.area, ...lineCells(withLine, area.lineLabel), area.dm, num(area.doubleVisits)]),
    title: "Double visits — received, by area",
  };
}

function doubleVisitsByManager({ people }: PackInput): PackSection | null {
  const riders = people.filter((person) => person.ridesLed > 0).sort((a, b) => b.ridesLed - a.ridesLed);
  if (riders.length === 0) return null;
  return {
    align: ["left", "left", "right", "right"],
    columns: ["Manager", "Role", "Rides led", "Reps ridden with"],
    metric: "double-visits",
    note: "Rides each manager LED, and how many different reps they rode with in the window.",
    rows: riders.map((person) => [
      personName(person),
      person.jobTitle || person.role || "—",
      num(person.ridesLed),
      num(person.repsCoached),
    ]),
    title: "Double visits — led, by manager",
  };
}

/**
 * Activity by job function. Everything here ADDS — a visit, a ride or a claim belongs to one person.
 * Customers are not in this table: they are unions, and the same doctor seen by a rep and by his
 * manager is one customer, so a per-role total would count him twice.
 */
function roleActivity({ people, visitsAvailable }: PackInput): PackSection | null {
  type Tally = {
    people: number;
    visits: number;
    am: number;
    pm: number;
    pharmacies: number;
    /** Of those visits, Phoenix CRM's own — it logs no pharmacy visit (visit-count-buckets.ts). */
    phoenix: number;
    rides: number;
    outstation: number;
    marketing: number;
  };
  const byRole = new Map<string, Tally>();
  for (const person of people) {
    const role = person.role || person.jobTitle || "No role on record";
    const tally =
      byRole.get(role) ?? { am: 0, marketing: 0, outstation: 0, people: 0, pharmacies: 0, phoenix: 0, pm: 0, rides: 0, visits: 0 };
    tally.people += 1;
    tally.visits += num(person.fieldVisits);
    tally.am += num(person.visitSplit.am);
    tally.pm += num(person.visitSplit.pm);
    tally.pharmacies += num(person.visitSplit.pharmacies);
    tally.phoenix += num(person.visitSplit.phoenix ?? 0);
    tally.rides += num(person.ridesLed);
    tally.outstation += num(person.outstationClaimed);
    tally.marketing += num(person.marketingRequests);
    byRole.set(role, tally);
  }
  // One role is not a comparison; that is the rep-by-rep section's job.
  if (byRole.size < 2) return null;
  const roles = [...byRole.entries()].sort((a, b) => b[1].visits - a[1].visits);
  const plotted = roles.filter(([, tally]) => tally.visits > 0);
  return {
    chart:
      visitsAvailable && plotted.length >= 2
        ? {
            capNote: "Field visits by role.",
            countSuffix: "visits",
            items: plotted.slice(0, CHART_BARS).map(([role, tally]) => ({
              label: role,
              note: `${tally.people} ${tally.people === 1 ? "person" : "people"}`,
              value: tally.visits,
            })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: ["left", "right", "right", "left", "right", "right", "right"],
    columns: ["Role", "People", "Field visits", "AM · PM · Pharmacies", "Rides led", "Outstation claimed", "Marketing requests"],
    metric: "role-activity",
    note: "Everything here adds — a visit, a ride or a claim belongs to one person. Customers are left out on purpose: the same doctor seen by a rep and by their manager is one customer, so a total per role would count them twice.",
    rows: roles.map(([role, tally]) => [
      role,
      tally.people,
      visitsAvailable ? tally.visits : NO_VISIT_DATA,
      visitsAvailable
        ? formatVisitCountSplit({ am: tally.am, pharmacies: tally.pharmacies, pm: tally.pm, ...(tally.phoenix > 0 ? { phoenix: tally.phoenix } : {}) })
        : NO_VISIT_DATA,
      tally.rides,
      tally.outstation,
      tally.marketing,
    ]),
    title: "By role",
  };
}

/**
 * Cost read off the AREAS, for a pack that holds no district row — a medical rep's.
 *
 * 🔴 The route gives a rep's pack no district row on purpose: his manager's whole district is not his
 * territory, and the district row carries the whole district's marketing and outstation. His own
 * area carries its own, so that is what is shown.
 */
function areaSpend({ areas }: PackInput): PackSection | null {
  const withLine = areas.some((area) => area.lineLabel);
  const spenders = areas.filter((area) => num(area.marketingCommitted) + num(area.outstationClaimed) > 0);
  if (spenders.length === 0) return null;
  return {
    align: withLine
      ? ["left", "left", "right", "right", "right", "right", "right", "right"]
      : ["left", "right", "right", "right", "right", "right", "right"],
    columns: [
      "Area",
      ...(withLine ? ["Line"] : []),
      "Marketing committed",
      "Requests",
      "Outstation claimed",
      "Outstation approved",
      "Achievement",
      "Spend per point",
    ],
    metric: "marketing-committed",
    note: "Marketing committed and outstation claimed in this area. Spend per point is the two together over points of achievement — LOWER IS BETTER, and it is a cost rather than a score.",
    rows: spenders.map((area) => {
      const ach = area.allProducts.ach;
      const total = num(area.marketingCommitted) + num(area.outstationClaimed);
      return [
        area.area,
        ...lineCells(withLine, area.lineLabel),
        num(area.marketingCommitted),
        num(area.marketingRequests),
        num(area.outstationClaimed),
        num(area.outstationApproved),
        pct(ach),
        ach != null && ach > 0 ? Math.round(total / ach) : "—",
      ];
    }),
    title: "Cost",
  };
}

/**
 * What each area costs, read against which way its own sales are moving.
 *
 * Direction is the area's sales in the LAST month of the figure window against the FIRST — read off
 * `byMonth` over the months the figures answer, never `trend`, which walks the REQUESTED window and
 * would put a held-out month in as a zero and call it a fall.
 */
function marketingVsTrend({ areas, months }: PackInput): PackSection | null {
  if (months.length < 2) return null;
  const first = months[0];
  const last = months[months.length - 1];
  const firstLabel = periodColumnLabel(first, months);
  const lastLabel = periodColumnLabel(last, months);
  const withLine = areas.some((area) => area.lineLabel);
  const rows = areas
    .filter((area) => num(area.marketingCommitted) > 0)
    .map((area) => {
      const before = num(area.byMonth?.[first]?.sales ?? 0);
      const after = num(area.byMonth?.[last]?.sales ?? 0);
      return { after, area, before, change: deltaPct(after, before) };
    })
    .sort((a, b) => num(b.area.marketingCommitted) - num(a.area.marketingCommitted));
  if (rows.length === 0) return null;
  return {
    align: withLine
      ? ["left", "left", "right", "right", "right", "right", "right"]
      : ["left", "right", "right", "right", "right", "right"],
    columns: [
      "Area",
      ...(withLine ? ["Line"] : []),
      "Marketing committed",
      "Requests",
      `Sales ${firstLabel}`,
      `Sales ${lastLabel}`,
      "Direction",
    ],
    metric: "marketing-vs-trend",
    note: `Marketing committed in each area, beside the area's own sales in ${lastLabel} against ${firstLabel}. A reading, not a verdict — a falling area may be falling less than it would have without the money.`,
    rows: rows.map((row) => [
      row.area.area,
      ...lineCells(withLine, row.area.lineLabel),
      num(row.area.marketingCommitted),
      num(row.area.marketingRequests),
      row.before,
      row.after,
      formatDelta(row.change, "%"),
    ]),
    title: "Marketing against the trend",
  };
}

/** Every section's metric, for a caller that wants to know what a selection would produce. */
export function sectionTitles(pack: SalesReviewPack): string[] {
  return pack.sections.map((section) => section.title);
}

/** The catalogue label for a section, for a renderer that wants the metric's own name. */
export function metricLabel(section: PackSection): string {
  return metricById(section.metric)?.label ?? section.title;
}
