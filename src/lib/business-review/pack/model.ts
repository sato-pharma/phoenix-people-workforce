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

import { formatVisitCountSplit } from "@/lib/crm/visit-count-buckets";

import type { ConcentrationFacts } from "../concentration";
import { describeSpread } from "../concentration";
import { periodColumnLabel } from "../period-format";
import type { ReviewPersonRow } from "../sources/roles";
import { describeSpecialtyMix, type SpecialtyMix } from "../specialty-mix";
import type { AreaSummary, DmSummary } from "../types";
import { metricById, type PackSubject, type ReviewMetricId } from "./metrics";

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

  // First, because it is the slide a company or multi-line review opens on.
  if (wanted.has("line-comparison")) {
    add(lineComparison(input));
  }
  if (wanted.has("achievement") || wanted.has("sales-vs-target")) {
    add(areaPerformance(input));
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
  if (wanted.has("specialty-mix")) {
    for (const dm of input.dms) add(specialty(dm.specialityMix, dm.dm));
  }
  if (wanted.has("rep-rows")) {
    add(repRows(input));
  }
  if (wanted.has("customers-per-month")) {
    add(customersPerMonth(input));
  }
  if (wanted.has("marketing-committed") || wanted.has("outstation-claimed") || wanted.has("spend-per-point")) {
    add(spend(input));
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
    sections,
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

function channels(facts: ConcentrationFacts): PackSection {
  const share = (value: number) =>
    facts.totalValue > 0 ? `${((value / facts.totalValue) * 100).toFixed(1)}%` : "—";
  const pctOf = (value: number) => (facts.totalValue > 0 ? (value / facts.totalValue) * 100 : null);
  return {
    chart:
      facts.totalValue > 0
        ? {
            capNote: null,
            items: [
              { label: "Through distributors", note: null, value: pctOf(facts.channels.distributor) },
              { label: "Through wholesalers", note: null, value: pctOf(facts.channels.wholesaler) },
              { label: "Direct orders", note: null, value: pctOf(facts.channels.direct) },
            ],
            kind: "bars",
            reference: null,
            unit: "share",
          }
        : null,
    align: ["left", "right", "right"],
    columns: ["Channel", "Sales", "Share"],
    metric: "channel-split",
    note: "The three add up to the window's whole sales value. A direct order is direct whoever bought it; a wholesaler is a customer that sells on.",
    rows: [
      ["Through distributors", num(facts.channels.distributor), share(facts.channels.distributor)],
      ["Through wholesalers", num(facts.channels.wholesaler), share(facts.channels.wholesaler)],
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
                ? `Field visits — the ${plottedReps.length} busiest of ${visited.length} reps. This section's table holds every one, and the percentage beside a rep is his area's.`
                : "Field visits. The percentage beside a rep in the table is his AREA's, not his own.",
            countSuffix: "visits",
            items: plottedReps.map((person) => ({
              label: person.name,
              note: areaByCode.get(person.areaCode as string)?.area ?? null,
              value: person.fieldVisits,
            })),
            kind: "bars",
            reference: null,
            unit: "count",
          }
        : null,
    align: ["left", "left", "right", "right", "right"],
    columns: ["Rep", "Area he stands in", "Area achievement", "Visits", "AM · PM · Pharmacies"],
    metric: "rep-rows",
    // The single most important sentence in the pack. See the module header.
    note: "The percentage is the AREA's, shared by everyone standing in it — targets are set per area, never per rep.",
    rows: people
      .filter((person) => person.areaCode != null && person.fieldVisits > 0)
      .sort((a, b) => b.fieldVisits - a.fieldVisits)
      .map((person) => {
        const area = areaByCode.get(person.areaCode as string) ?? null;
        return [
          person.name,
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
          person.name,
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

/** Every section's metric, for a caller that wants to know what a selection would produce. */
export function sectionTitles(pack: SalesReviewPack): string[] {
  return pack.sections.map((section) => section.title);
}

/** The catalogue label for a section, for a renderer that wants the metric's own name. */
export function metricLabel(section: PackSection): string {
  return metricById(section.metric)?.label ?? section.title;
}
