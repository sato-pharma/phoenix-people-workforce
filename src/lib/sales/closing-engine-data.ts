/**
 * Project the monthly closing onto the owner's .xlsm engine.
 *
 * This module answers one question: given the closing objects the route already loads, what goes in
 * every cell of the engine? It does no database work and no formatting beyond the captions — it is a
 * projection, so that what the workbook shows and what the Closing screens show cannot drift.
 *
 * Two rules run through the whole file and are worth reading before changing anything here:
 *
 *  1. **Units are never added across products.** Every total that spans more than one product code is
 *     a VALUE. The Data sheet carries units per area x product, which is one product code, so the
 *     Rep Card and the Units Matrix pivot can show them honestly; nothing else may sum them. See
 *     AGENTS.md §4 and the Rep Card's own footnote, which the engine prints on the sheet.
 *  2. **Achievement is ALL sales over target value** — the whole area's money over the target it was
 *     given, which is what `closingAchievement` in monthly-closing-matrix-cells.ts computes and
 *     therefore what the Closing Matrix, the closing screen and the auditor's workbook all print.
 *     The static sheets, the pivots' `Ach` field and the Rep Card must use it too, or the premium
 *     workbook disagrees with the Monthly Closing it is a second view of.
 *
 *     THIS RULE WAS THE OTHER WAY ROUND UNTIL 2026-09-05, and the reason it changed is worth the
 *     paragraph. The engine divided only the sales that sat on a product WITH a target, on the
 *     stated grounds that this "is the arithmetic the Closing Matrix uses". It is not, and never
 *     was: the matrix divides `salesValue / targetValue` at every level, untargeted money included.
 *     So the premise was false and the two files disagreed wherever an area sold something nobody
 *     had targeted — August's Anti Infective read 29.95% here beside 31.78% on the closing, 1.83
 *     points apart on 27,529.80 EGP of real sales spread over 24 area x product pairs. Put to the
 *     owner on 2026-09-05 with both numbers, he ruled: "THE OLD CLOSING IS THE CORRECT ONE."
 *
 *     A target of zero or none still yields NO percentage rather than 0% — only the numerator moved.
 *     An untargeted area therefore stays unranked and unscored, exactly as before.
 *
 *     Note this is deliberately NOT the rule Business Review and the Targets pages follow. Those
 *     grade a person against their own target and were moved to covered-actual on purpose; the
 *     closing states a line's total money against the line's total target. Do not "align" them.
 */

import { closingAreaOf } from "./closing-row-area";
import { countsInClosingHeadline } from "./closing-headline";
import { EPDA_SHARE_LABEL, MAIN_STORES_LABEL } from "./closing-main-stores";
import { PERFORMANCE_REVIEW_FIRST_PERIOD } from "./closing-performance-review";
import type { ClosingEngineFill, EngineValue } from "./closing-engine-fill";
import type { ClosingPerformanceReview } from "./closing-performance-review";
import type { ClosingDetailRow } from "./monthly-closing-details";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "./monthly-distributor-import";
import type { MonthlySourceCoverage } from "./source-coverage";

export type ClosingEngineDataInput = {
  /**
   * Which sources actually fed this month, or null when the check could not run.
   *
   * WHY THIS IS HERE (2026-09-03). This is the workbook people are meant to send round, and it had
   * no completeness surface at all: the closing screen shows a coverage banner and the old export
   * carries a Source Coverage sheet, but the premium workbook carried neither. August 2026 was
   * built on 4 of its 18 sources — 84% of the month's value absent — and every tab still rendered
   * immaculately, Rep Cards and rank stars included, because the arithmetic over what HAD arrived
   * was exact. That is the same failure `source-coverage.ts` was written for in July, arriving by
   * a different door.
   *
   * Null is "we could not tell", not "it is complete", and prints nothing either way — the note is
   * only ever added when a source is provably missing.
   */
  coverage?: MonthlySourceCoverage | null;
  /** Every invoice line the viewer may see, unpaged. Omitted only when the load failed. */
  details?: ClosingDetailRow[] | null;
  /** "Cairo and Delta (1) only" — appended to every sheet title so a filtered export says so. */
  filterNote?: string;
  matrix: MonthlyClosingMatrix;
  /**
   * The month before `matrix.period`, or null when it was never uploaded.
   *
   * Null is a real answer and must stay distinguishable from zero: an area that sold nothing last
   * month and an area whose last month does not exist look identical in a number column, and only
   * one of them is a fact. Every prior-month cell here is left empty rather than zeroed, and the
   * captions say "no <month> figure" instead of naming a total that was never read.
   */
  priorMatrix?: MonthlyClosingMatrix | null;
  review: ClosingPerformanceReview;
};

const UP = "▲";
const DOWN = "▼";
/** Prefixes the completeness note. The card already ships ★, so the glyph set is house style. */
const WARN = "⚠";
/**
 * Prefixes the completeness note when the month is COMPLETE and only says which books are not
 * coming. A different glyph on purpose: ⚠ next to "COMPLETE" is the same mixed signal the quiet
 * carve-out exists to remove.
 */
const NOTE = "·";
const DOT = "·";
const DASH = "—";
const GAP = "   ";
const SEP = `${GAP}${DOT}${GAP}`;

/**
 * The arrow turns at target. Owner's decision, 2026-09-03: "fix the arrow to only show above target".
 *
 * It used to turn at half, which is what the owner's own engine carried — `IF(G17>=0.5,"▲","▼")` in
 * the Rep Card. The effect was that a row at 60% of target was decorated with the same up arrow as a
 * row at 140%, and the Watch List — a page that by definition holds nothing but shortfalls — printed
 * an up arrow beside every line on it. An arrow that is true of almost every row says nothing.
 *
 * Yes, a month that runs behind now shows a lot of down arrows. That is the month, not the mark.
 *
 * The Rep Card's arrow is a FORMULA inside the engine rather than a value this module writes, so
 * `fillRepCard` rewrites the threshold in the workbook from this same constant. Change it here and
 * the static sheets and the live card move together; they cannot drift apart again.
 */
export const ACHIEVEMENT_ARROW_AT = 1;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthParts(period: string | null | undefined): { name: string; label: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return { name: "", label: String(period ?? "") };
  const name = MONTHS[Number(match[2]) - 1] ?? "";
  return { name, label: name ? `${name} ${match[1]}` : String(period) };
}

function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return Math.round(value).toLocaleString("en-US");
}

/** "1 area" / "15 areas" — the footnotes read as sentences, so they cannot say "1 areas". */
function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatInt(value)} ${value === 1 ? singular : plural}`;
}

/** Subject-verb agreement, because the footnotes are sentences and are read as sentences. */
function agree(value: number, singular: string, plural: string): string {
  return value === 1 ? singular : plural;
}

function arrowFor(achievement: number | null): string {
  if (achievement == null) return "";
  return achievement >= ACHIEVEMENT_ARROW_AT ? UP : DOWN;
}

/**
 * The arrow beside a growth column turns at zero, not at half.
 *
 * Growth and achievement are different questions, and each arrow turns where its own answer turns:
 * achievement at the target that was set, growth at flat. The Family by Month sheet's own colour
 * rules are written to the same threshold — green at or above zero, amber below — so the arrow and
 * the fill behind it can never point opposite ways.
 */
function growthArrow(growth: number | null): string {
  if (growth == null) return "";
  return growth >= 0 ? UP : DOWN;
}

/**
 * The one achievement in this workbook: every pound the area sold, over the target it was given.
 *
 * Deliberately the same shape as `closingAchievement` in monthly-closing-matrix-cells.ts, which is
 * what the Closing Matrix and the auditor's workbook divide — same numerator, same null when there
 * is no target to divide by. Keep the two together: the premium workbook is a second view of that
 * closing, not a second opinion on it.
 */
function achievementOf(salesValue: number, targetValue: number | null): number | null {
  if (targetValue == null || targetValue === 0) return null;
  return salesValue / targetValue;
}

function growthOf(current: number, prior: number | null): number | null {
  if (prior == null || prior === 0) return null;
  return (current - prior) / prior;
}

/**
 * The `Status` column behind the Data sheet's slicer.
 *
 * Order matters. "No sales" is asked first because a zero row is a zero whatever its target says,
 * and a reader filtering for it wants the areas that sold nothing — not a subset of them that also
 * happened to be given a target.
 */
function statusOf(salesValue: number, targetValue: number | null, achievement: number | null): string {
  if (salesValue <= 0) return "No sales";
  if (targetValue == null || targetValue === 0) return "No target";
  return achievement != null && achievement >= 1 ? "On target" : "Behind";
}

// The owner's own words for the three absences, taken from his workbook. "Vacant seat" is a seat
// that exists and is empty; "No rep seat" is a territory the seat model has nobody for at all.
const NO_REP = "No rep seat";
const NO_MANAGER = "No manager seat";
const NO_TARGET = "no target";

/** What a row's client code reads when the distributor reported the sale without naming a buyer. */
const NO_CLIENT_CODE = "no code";

function repLabelOf(repName: string | null, repIsVacant: boolean): string {
  if (repName) return repName;
  return repIsVacant ? "Vacant seat" : NO_REP;
}

/**
 * What a target or an achievement column shows when there is no target.
 *
 * The owner writes the words, not a blank: a blank reads as a number nobody filled in, and a zero
 * would score the area as having failed. His conditional formatting is built for it — every rule on
 * these columns is guarded by `ISNUMBER()` precisely so the cell can hold text.
 *
 * Only the presentation sheets do this. The Data sheet stays strictly numeric or empty, because
 * that is what the pivot tables read.
 */
function orNoTarget(value: number | null): EngineValue {
  return value == null ? NO_TARGET : value;
}

type AreaAggregate = {
  achievement: number | null;
  areaCode: string;
  areaName: string;
  cells: MonthlyClosingCell[];
  managerName: string;
  priorValue: number | null;
  rank: number;
  regionCode: string;
  regionName: string;
  repName: string;
  salesValue: number;
  targetValue: number | null;
  targetedSales: number;
};

const cellKey = (areaCode: string, productCode: string) => `${areaCode}\u0000${productCode}`;

/** Prior-month value per area x product, and per area. Empty when the month was never uploaded. */
function priorIndex(priorMatrix: MonthlyClosingMatrix | null | undefined) {
  const byCell = new Map<string, number>();
  const byArea = new Map<string, number>();
  if (!priorMatrix) return { byArea, byCell };

  for (const region of priorMatrix.regions) {
    for (const area of region.areas) {
      let areaTotal = 0;
      area.cells.forEach((cell, index) => {
        const column = priorMatrix.columns[index];
        if (!column) return;
        areaTotal += cell.salesValue;
        byCell.set(cellKey(area.areaCode, column.productCode), cell.salesValue);
      });
      byArea.set(area.areaCode, (byArea.get(area.areaCode) ?? 0) + areaTotal);
    }
  }
  return { byArea, byCell };
}

/**
 * One row per area, carrying the person on the seat and the area's own arithmetic.
 *
 * The numbers come from the matrix (the closing's own grid) and the names from the review, joined on
 * the area code. Both are already scoped and filtered by the caller, so this never widens what a
 * viewer may see.
 */
function buildAreas(input: ClosingEngineDataInput): AreaAggregate[] {
  const { matrix, review } = input;
  const prior = priorIndex(input.priorMatrix);

  const seats = new Map(review.areas.map((row) => [row.areaCode, row]));
  const rows: AreaAggregate[] = [];

  for (const region of matrix.regions) {
    for (const area of region.areas) {
      const seat = seats.get(area.areaCode);
      let salesValue = 0;
      let targetValue: number | null = null;
      let targetedSales = 0;

      for (const cell of area.cells) {
        salesValue += cell.salesValue;
        if (cell.targetValue != null) {
          targetValue = (targetValue ?? 0) + cell.targetValue;
          targetedSales += cell.salesValue;
        }
      }

      rows.push({
        // All of the area's money over its target — the Closing Matrix's own division. `targetedSales`
        // is still carried and still written to the Data sheet, but as an "of which was targeted"
        // fact about the month rather than as the numerator of anything.
        achievement: achievementOf(salesValue, targetValue),
        areaCode: area.areaCode,
        areaName: area.areaName,
        cells: area.cells,
        managerName: seat?.managerName || NO_MANAGER,
        priorValue: prior.byArea.get(area.areaCode) ?? null,
        rank: 0,
        regionCode: area.regionCode,
        regionName: area.regionName,
        repName: repLabelOf(seat?.repName ?? null, seat?.repIsVacant ?? false),
        salesValue,
        targetValue,
        targetedSales,
      });
    }
  }

  // Ranked by achievement, best first. An area with no target has no achievement and cannot be
  // ranked against one that has — those sort last, in value order, rather than being dropped.
  rows.sort((a, b) => {
    if (a.achievement != null && b.achievement != null) return b.achievement - a.achievement;
    if (a.achievement != null) return -1;
    if (b.achievement != null) return 1;
    return b.salesValue - a.salesValue;
  });
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}

/** The Data sheet's SalesData block — one row per area x product, the grain every pivot reads. */
function buildSalesData(input: ClosingEngineDataInput, areas: AreaAggregate[]): EngineValue[][] {
  const prior = priorIndex(input.priorMatrix);
  const columns = input.matrix.columns;
  const rows: EngineValue[][] = [];

  // In the MATRIX's order — region by region, area by area — not the rank order `buildAreas`
  // returns. Nothing reads these rows by position, but the pivot cache pools each column's values
  // in the order it first meets them and the pivots' axes then follow that pool, so rank order put
  // the Closing Matrix's regions in order of how well they did: an order that changes every month
  // and agrees with no other sheet in the file. An area the matrix does not carry sorts last.
  const matrixOrder = new Map<string, number>();
  for (const region of input.matrix.regions) {
    for (const area of region.areas) matrixOrder.set(area.areaCode.trim().toUpperCase(), matrixOrder.size);
  }
  const positionOf = (code: string): number =>
    matrixOrder.get(code.trim().toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...areas].sort((a, b) => positionOf(a.areaCode) - positionOf(b.areaCode));

  for (const area of ordered) {
    area.cells.forEach((cell, index) => {
      const column = columns[index];
      if (!column) return;
      // An area x product with no sales, no units and no target is not a fact about the month —
      // it is the absence of one. Writing it would put ~24 empty rows per line into every pivot.
      if (cell.salesValue === 0 && cell.salesUnits === 0 && cell.targetValue == null && cell.targetUnits == null) {
        return;
      }
      const achievement = cell.targetValue ? cell.salesValue / cell.targetValue : null;
      rows.push([
        area.regionName,
        area.areaName,
        area.areaCode,
        area.repName,
        area.managerName,
        column.productName,
        cell.salesUnits,
        cell.targetUnits,
        // "Targeted" units and sales are the ones that HAVE a target. They are no longer the
        // numerator of any achievement — the pivots' `Ach` field divides the plain Sales Value
        // column, as the closing does — but they stay as an honest "of which was targeted" fact a
        // reader can pivot on. Null, never zero: an untargeted product is absent from them, not nil.
        cell.targetUnits == null ? null : cell.salesUnits,
        cell.salesValue,
        cell.targetValue,
        cell.targetValue == null ? null : cell.salesValue,
        prior.byCell.get(cellKey(area.areaCode, column.productCode)) ?? null,
        statusOf(cell.salesValue, cell.targetValue, achievement),
      ]);
    });
  }
  return rows;
}

/** The Data sheet's AreaBook block — one row per area, which is what the Rep Card indexes into. */
function buildAreaBook(areas: AreaAggregate[]): EngineValue[][] {
  return areas.map((area) => [
    `${area.repName} ${DASH} ${area.areaName}`,
    area.areaCode,
    area.areaName,
    area.regionName,
    area.repName,
    area.managerName,
    area.salesValue,
    area.targetValue,
    area.targetedSales,
    area.achievement,
    area.rank,
    area.priorValue,
  ]);
}

type CustomerRow = {
  areaName: string;
  clientCode: string;
  clientName: string;
  regionName: string;
  salesValue: number;
};

/**
 * What the closing itself calls an area: the human name, the region above it, and the person on
 * the seat. Keyed by area CODE, because that is the only thing a distributor row and the closing
 * matrix reliably share.
 */
type AreaBookEntry = { areaName: string; regionName: string; repName: string };

type DetailGroup = {
  areaName: string;
  channel: string;
  clientAddress: string;
  clientCode: string;
  clientName: string;
  effectiveUnits: number;
  factoryPrice: number;
  family: string;
  invoiceLines: number;
  productCode: string;
  productName: string;
  qty: number;
  bonusQty: number;
  regionName: string;
  repName: string;
  salesValue: number;
};

/**
 * Fold the invoice lines into one row per area x customer x product x channel.
 *
 * The distributor sends many lines for the same customer and product in a month; a reader wants the
 * month, not the delivery schedule. The line count rides along in its own column so nothing about
 * the folding is hidden.
 */
function buildDetailGroups(rows: ClosingDetailRow[], areaBook: Map<string, AreaBookEntry>): DetailGroup[] {
  const groups = new Map<string, DetailGroup>();

  for (const row of rows) {
    const channel = row.isDirect ? "Direct" : "Retail";
    // The area the CLOSING books this row in, never the one the customer physically sits in. Every
    // closing RPC groups by the fact area, so this sheet has to as well or it disagrees with the
    // Overview and the Rep Ranking printed beside it. The two are identical on every row in
    // production except a hand-apportioned customer, where a human wrote the split onto the fact
    // rows and deliberately left the brick alone -- and there the resolved area names the WRONG
    // REP, crediting the sale to whoever owns the shop's location rather than to whoever the
    // closing actually paid for it.
    const areaCode = closingAreaOf(row);
    // The area as the CLOSING names it, never as the distributor's sheet spelt it. A direct-order
    // row arrives carrying the raw code -- "UE2", "D16" -- and printing that is the one thing the
    // house rule forbids: human names, never raw codes. Every other sheet in this workbook already
    // reads the name off the matrix, so this reads it off the same place and the columns agree.
    const seat = areaBook.get(areaCode.trim().toUpperCase());
    // A Main Stores row carries no client CODE, so keying on the code alone would let it merge
    // with a genuinely unnamed row in the same area, product and channel — and whichever of the
    // two the map reached first would name the other. Keyed on the LABEL here, which no real
    // customer can carry, so the two can never become one group. No other row's grouping moves.
    // An EPDA share row (rule 2) is keyed on its label for the same reason.
    const clientKey = row.clientName === MAIN_STORES_LABEL || (row.clientName === EPDA_SHARE_LABEL && !row.clientCode)
      ? row.clientName
      : row.clientCode;
    const key = `${areaCode}\u0000${clientKey}\u0000${row.productCode}\u0000${channel}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        areaName: seat?.areaName || row.sheetAreaName || row.areaName,
        bonusQty: 0,
        channel,
        clientAddress: row.clientAddress,
        clientCode: row.clientCode || NO_CLIENT_CODE,
        clientName: row.clientName || "Buyer not named by the distributor",
        effectiveUnits: 0,
        factoryPrice: row.factoryPrice,
        family: row.family,
        invoiceLines: 0,
        productCode: row.productCode,
        productName: row.productName,
        qty: 0,
        // The ORGANOGRAM region, not the geographic one — the same basis the Closing Matrix, the
        // Overview and the Rep Ranking in this workbook are grouped by. On Anti Infective the two
        // genuinely differ: the distributor sheet carries one "UE" for all of Upper Egypt while
        // the Matrix carries UE-1 and UE-2, so reading the geographic pair here would file a row
        // under a region no other sheet in the same file has heard of. Equal to the geographic
        // pair on every line and area the organogram does not re-own, which is most of them.
        regionName: seat?.regionName || row.operationalRegionName || row.regionName,
        repName: seat?.repName ?? NO_REP,
        salesValue: 0,
      };
      groups.set(key, group);
    }
    group.bonusQty += row.bonusQty;
    group.effectiveUnits += row.effectiveUnits;
    group.invoiceLines += 1;
    group.qty += row.qty;
    group.salesValue += row.salesValue;
    if (!group.clientAddress && row.clientAddress) group.clientAddress = row.clientAddress;
  }

  return [...groups.values()].sort((a, b) => b.salesValue - a.salesValue);
}

/**
 * The customer ranking, and an honest account of what it could not rank.
 *
 * A distributor reports a good share of its value without naming the buyer. Those rows are real
 * money and are counted in every total in this workbook — they simply cannot be ranked, because
 * there is no customer to put on a row. Ranking them as one giant anonymous "customer" would put a
 * fiction at the top of the sheet, so they come out of the ranking and are stated underneath it.
 *
 * A customer is keyed by code AND area: the same pharmacy buying in two areas is two rows, because
 * the sale belongs to the area that made it.
 */
function buildCustomers(groups: DetailGroup[]): {
  epdaShareValue: number;
  mainStoresValue: number;
  namedValue: number;
  rows: CustomerRow[];
  unnamedCount: number;
  unnamedValue: number;
} {
  const customers = new Map<string, CustomerRow>();
  let unnamedCount = 0;
  let unnamedValue = 0;
  let mainStoresValue = 0;
  let epdaShareValue = 0;

  for (const group of groups) {
    // 🔴 MAIN STORES IS NOT AN UNNAMED CUSTOMER, AND THIS BRANCH IS WHY IT NEEDS SAYING.
    //
    // A Main Stores row carries no client CODE, because a share of a warehouse has no single buyer.
    // Falling through to the branch below therefore counted all 76 of them as rows whose buyer the
    // distributor failed to name, and the footnote then published the exact figure this whole rule
    // exists to hide: "76 rows worth 2,367,360 EGP carry no client code". It shipped that way for
    // one build, on the very change that was supposed to close that leak.
    //
    // It is also simply untrue. These rows ARE named — the name is Main Stores, and the owner chose
    // it. What they are not is a CUSTOMER, so they stay out of a customer ranking rather than
    // standing at the top of one as a 2.4 million EGP buyer that does not exist.
    // Keyed on the NAME, never on the code being empty: by the time a row becomes a group its
    // empty code has already been replaced by the `NO_CLIENT_CODE` sentinel, so a test for a
    // blank code here is never true. That is exactly how this branch shipped inert once.
    if (group.clientName === MAIN_STORES_LABEL) {
      mainStoresValue += group.salesValue;
      continue;
    }
    // An area's share of the EPDA books (rule 2) reaches an area, not one outlet — out of the ranking
    // for the same reason as Main Stores. Its code is the NO_CLIENT_CODE sentinel by now, hence the name.
    if (group.clientName === EPDA_SHARE_LABEL && group.clientCode === NO_CLIENT_CODE) {
      epdaShareValue += group.salesValue;
      continue;
    }
    if (group.clientCode === NO_CLIENT_CODE) {
      unnamedCount += group.invoiceLines;
      unnamedValue += group.salesValue;
      continue;
    }
    const key = `${group.clientCode}\u0000${group.areaName}`;
    const existing = customers.get(key);
    if (existing) {
      existing.salesValue += group.salesValue;
      continue;
    }
    customers.set(key, {
      areaName: group.areaName,
      clientCode: group.clientCode,
      clientName: group.clientName,
      regionName: group.regionName,
      salesValue: group.salesValue,
    });
  }
  const rows = [...customers.values()].sort((a, b) => b.salesValue - a.salesValue);
  return {
    epdaShareValue,
    mainStoresValue,
    namedValue: rows.reduce((sum, row) => sum + row.salesValue, 0),
    rows,
    unnamedCount,
    unnamedValue,
  };
}

export function buildClosingEngineFill(input: ClosingEngineDataInput): ClosingEngineFill {
  const { matrix, review } = input;
  const line = matrix.line ?? review.line ?? "";
  const period = matrix.period ?? review.period ?? "";
  const month = monthParts(period);
  const prior = monthParts(previousPeriod(period));
  const filterNote = input.filterNote?.trim() ?? "";

  const built = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());

  /**
   * The completeness note, in two lengths, or null when nothing is provably missing.
   *
   * Two lengths because the sheets have two different amounts of room. Every sheet but the card
   * runs its caption along A1 and lets `clearTitleEmblem` slide the logo aside, so the long form
   * costs nothing there. The card cannot do that, so it gets a form short enough to sit inside its
   * own 798px.
   *
   * Null is silence, deliberately. A month with nothing missing says nothing — a workbook that
   * announced its own completeness on every tab would train the reader to stop reading the line,
   * which is the one thing this note cannot afford.
   */
  const coverageNote = ((): { full: string; terse: string } | null => {
    const coverage = input.coverage;
    if (!coverage?.hasPrevData) return null;
    const missing = coverage.missingSources ?? [];
    const regions = coverage.missingDirectRegions ?? [];
    // Declared quiet by the owner is not INCOMPLETE — the workbook must not stamp a red warning on
    // twelve sheets of a month he has said is finished (owner, 2026-10-09). It still says which
    // books are not coming, because a reader comparing two months deserves that, but as a plain
    // note with no "until they arrive". The carve-out itself lives in source-coverage.ts.
    const quiet = coverage.quietSources ?? [];
    if (missing.length === 0 && regions.length === 0) {
      if (quiet.length === 0) return null;
      const names = quiet.map((entry) => entry.name).join(", ");
      return {
        full: `${NOTE} COMPLETE${GAP}${month.label} files nothing from ${names}, by the owner's`
          + " instruction. Every other source has filed.",
        terse: `${NOTE} ${count(quiet.length, "source")} not filing`,
      };
    }

    // Sources first when both are missing: a whole absent distributor outweighs an absent region
    // of the Direct sheet, and the long form still names the region count after it.
    const gone =
      missing.length > 0 ? count(missing.length, "source") : count(regions.length, "Direct region");
    const against =
      missing.length > 0 && coverage.prevSourceCount > 0
        ? ` of the ${formatInt(coverage.prevSourceCount)} that fed ${monthParts(coverage.prevPeriod).label}`
        : "";
    const scale =
      missing.length > 0 && coverage.missingPrevValue > 0
        ? `${GAP}${formatInt(coverage.missingPrevValue)} EGP of ${monthParts(coverage.prevPeriod).label} value is absent.`
        : "";
    const alsoRegions =
      missing.length > 0 && regions.length > 0
        ? ` The Direct sheet has nothing yet from ${count(regions.length, "region")}.`
        : "";
    return {
      full: `${WARN} INCOMPLETE${GAP}${month.label} is missing ${gone}${against}.${scale}${alsoRegions}`
        + " Totals are understated until they arrive.",
      terse: `${WARN} INCOMPLETE${GAP}${gone} missing`,
    };
  })();

  const headline = (sheet: string) => `${sheet}${GAP}${month.label}${GAP}${line}`;
  /**
   * The completeness note does NOT go here, and that was measured rather than assumed.
   *
   * A1 overflows right until it meets the emblem, and `clearTitleEmblem` answers by sliding the
   * emblem out of the way — which works until the caption is long enough to slide it past the last
   * column, where the logo floats in empty space. Putting the note in A1 did exactly that on 8 of
   * the 12 sheets, by as much as 1783px; Area x Product had 3px of slack in the baseline, so it
   * cannot absorb one character. The note lives on row 2 instead — empty on every sheet, and clear
   * of an emblem that anchors to row 1 alone. See `stampCoverageNote` in closing-engine-fill.ts.
   */
  const title = (sheet: string, subtitle: string) =>
    [headline(sheet), subtitle, filterNote].filter(Boolean).join(SEP);
  /**
   * The Rep Card's masthead is two lines, and it is the only sheet that gets one.
   *
   * Every other sheet runs the whole caption along A1, where it overflows to the right until it
   * meets the emblem — and `clearTitleEmblem` slides the emblem out of its way. The card cannot be
   * fixed that way: it is eight columns wide, 798px, and the emblem already sits at 689px with
   * 16px of slack. There is nowhere for the logo to go, so on this one sheet the caption is what
   * has to give. Eighty-odd characters on one line ended 25pt short of the wordmark — not a
   * collision, but not a masthead either, and it is the sheet a rep is meant to be proud to share.
   *
   * So the sheet name, the month and the line stay on A1 and the descriptive half drops to A2,
   * where the template already reserves a full empty row. Half the length, twice the air, and a
   * longer line name can never reach the logo again.
   *
   * Row 2 is clear of the emblem outright, not merely roomier: the picture anchors `from row=0` to
   * `to row=0` in the template's own drawing, so it occupies row 1 alone. What still binds row 2 is
   * the card's width — eight columns, 798px — which is why the completeness note DISPLACES the
   * tagline here rather than joining it. On the one sheet built to be shared, "this month is
   * missing sources" outranks "one person, one month, every product", and displacing it keeps the
   * line short enough to be read rather than run off the card.
   */
  // 🔴 THE REP CARD HAS NO DECK LINE. Owner, 2026-09-10: "in rep card in row 2 their is
  // irrelevnt txt behind the buttons". The line was "one person, one month, every product", written
  // to A2 and painted over by the navigation buttons anchored from that same row, so it had never
  // been readable on any export — which is exactly why he called it irrelevant.
  //
  // ⚠ IT CANNOT SIMPLY MOVE DOWN A ROW, and that was tried before this. Row 3 is the WARNING
  // strip: `paintExecutiveBands` paints any row 3 carrying text in the amber incomplete-month fill,
  // so the tagline came out as a warning about nothing. Row 1 has no room either — the card is
  // eight columns and 798px wide with the emblem anchored at 689px.
  //
  // So the line is gone, which is what he asked for. What it carried that MATTERS is the filter
  // note, and that moves up into A1 below rather than being lost with it: a Rep Card exported for
  // one region has to say so, or a filtered card reads as the whole line.

  const areas = buildAreas(input);
  const salesData = buildSalesData(input, areas);
  const areaBook = buildAreaBook(areas);
  // Keyed uppercase because `closingAreaOf` normalises, and a lookup that misses falls back to
  // whatever the distributor's own sheet said -- a slightly worse label instead of a loud failure.
  const areaBookByCode = new Map<string, AreaBookEntry>(
    areas.map((area) => [
      area.areaCode.trim().toUpperCase(),
      { areaName: area.areaName, regionName: area.regionName, repName: area.repName },
    ]),
  );

  const headlineSales = matrix.grandTotal.rowTotal.salesValue;
  const targeted = areas.filter((area) => area.targetValue != null && area.targetValue > 0);
  const targetTotal = targeted.reduce((sum, area) => sum + (area.targetValue ?? 0), 0);
  // B5 divided by D5 — literally the two numbers printed either side of it, so a reader can do the
  // division by hand and land on F5. That is also the Closing Matrix's own grand-total arithmetic
  // (`salesValue / targetValue`), which is what makes this headline and the closing screen agree.
  // It did NOT divide before: F5 was targeted sales over target while B5 showed every pound, so the
  // three cells on the masthead never tied and the smaller F5 had no visible explanation.
  const headlineAchievement = achievementOf(headlineSales, targetTotal || null);
  const atTarget = targeted.filter((area) => (area.achievement ?? 0) >= 1).length;

  const priorTotal = input.priorMatrix ? input.priorMatrix.grandTotal.rowTotal.salesValue : null;
  const priorCaption = prior.name
    ? priorTotal == null
      ? `no ${prior.name} figure`
      : `${prior.name} was ${formatInt(priorTotal)}`
    : "";

  // ── Overview ────────────────────────────────────────────────────────────────────────────────
  // Region rows come from the areas above rather than from the matrix subtotals, so this column
  // and the Data sheet cannot disagree. A month whose direct money carries no area at all keeps
  // its own row here (the matrix's `directNational`) — it belongs to the headline but cannot be
  // put on a pivot by area, which is the one place Data legitimately totals less than B5.
  const byRegion = new Map<string, AreaAggregate[]>();
  for (const region of matrix.regions) {
    byRegion.set(region.regionName, areas.filter((area) => area.regionCode === region.regionCode));
  }
  const overviewRows: EngineValue[][] = [];
  for (const [regionName, regionAreas] of byRegion) {
    if (!regionAreas.length) continue;
    const sales = regionAreas.reduce((sum, area) => sum + area.salesValue, 0);
    const target = regionAreas.reduce<number | null>(
      (sum, area) => (area.targetValue == null ? sum : (sum ?? 0) + area.targetValue),
      null,
    );
    // The region's whole sales column over its whole target column, so each Overview row divides
    // the way the two cells beside it read — same rule as the headline above and as every area row.
    const achievement = achievementOf(sales, target);
    const regionPrior = regionAreas.reduce<number | null>(
      (sum, area) => (area.priorValue == null ? sum : (sum ?? 0) + area.priorValue),
      null,
    );
    const withTarget = regionAreas.filter((area) => area.targetValue != null && area.targetValue > 0);
    overviewRows.push([
      regionName,
      regionAreas.length,
      sales,
      orNoTarget(target),
      orNoTarget(achievement),
      arrowFor(achievement),
      regionPrior,
      growthOf(sales, regionPrior),
      `${withTarget.filter((area) => (area.achievement ?? 0) >= 1).length} of ${withTarget.length}`,
    ]);
  }
  if (matrix.directNational) {
    const row = matrix.directNational;
    overviewRows.push([
      row.regionName,
      0,
      row.rowTotal.salesValue,
      row.rowTotal.targetValue,
      row.rowTotal.achievement,
      arrowFor(row.rowTotal.achievement),
      null,
      null,
      DASH,
    ]);
  }

  // ── Rep Ranking, Top Achievers ──────────────────────────────────────────────────────────────
  const repRankingRows: EngineValue[][] = areas.map((area) => [
    area.rank,
    area.repName,
    area.areaName,
    area.regionName,
    area.managerName,
    area.salesValue,
    orNoTarget(area.targetValue),
    orNoTarget(area.achievement),
    arrowFor(area.achievement),
    growthOf(area.salesValue, area.priorValue),
  ]);

  const topTen = areas.filter((area) => area.achievement != null).slice(0, 10);
  const first = topTen[0];

  // ── Family Performance ──────────────────────────────────────────────────────────────────────
  // `review.families` already divides all of a family's sales by its target — the closing screen's
  // own arithmetic — so the row's own achievement is taken as it comes and nothing is recomputed
  // here. Between 2026-09-03 and 2026-09-05 this block overrode it with targeted-only sales to
  // match an Overview that was itself on the wrong rule; both are back on the closing's rule now,
  // so the override has nothing left to correct and re-adding one would reopen the same gap from
  // the other side. The page is the Performance Review's family table, and it must read as it does
  // on screen.
  const familyRows: EngineValue[][] = review.families.map((family) => {
    const achievement = family.achievement;
    return [
      family.family,
      family.productCount,
      family.salesValue,
      orNoTarget(family.targetValue),
      orNoTarget(achievement),
      arrowFor(achievement),
      headlineSales ? family.salesValue / headlineSales : null,
    ];
  });

  // ── Family by Month ─────────────────────────────────────────────────────────────────────────
  // The by-month series is per PRODUCT CODE; a family is the sum of its products, and a sum of
  // values is legitimate where a sum of units would not be. A month is null when no product in the
  // family reported it at all — which is not the same as zero, and is left blank rather than
  // drawn as a floor.
  const monthLabels = review.months.map((month) => monthParts(month).label);
  const familyOrder = [...new Set([...review.families.map((row) => row.family), ...review.productValueByMonth.map((row) => row.subLabel)])];

  const familySeries = familyOrder
    .map((family) => {
      const products = review.productValueByMonth.filter((row) => row.subLabel === family);
      const perMonth = review.months.map((_month, index) => {
        const reported = products.map((row) => row.perMonth[index]).filter((value): value is number => value != null);
        return reported.length ? reported.reduce((sum, value) => sum + value, 0) : null;
      });
      return { family, perMonth, total: perMonth.reduce<number>((sum, value) => sum + (value ?? 0), 0) };
    })
    .filter((row) => row.perMonth.some((value) => value != null));

  const lineByMonth = review.months.map((_month, index) =>
    familySeries.reduce<number>((sum, row) => sum + (row.perMonth[index] ?? 0), 0),
  );

  const familyMonthRows: EngineValue[][] = [];
  for (const row of familySeries) {
    row.perMonth.forEach((value, index) => {
      const previous = index > 0 ? row.perMonth[index - 1] ?? null : null;
      const growth = value == null ? null : growthOf(value, previous);
      familyMonthRows.push([
        row.family,
        monthLabels[index] ?? review.months[index] ?? "",
        value,
        value != null && lineByMonth[index] ? value / lineByMonth[index]! : null,
        growth,
        growthArrow(growth),
        value != null && row.total ? value / row.total : null,
      ]);
    });
  }

  const seriesStart = monthParts(PERFORMANCE_REVIEW_FIRST_PERIOD);
  const familyMonthNotes = [
    "Value only, never units — a family holds several products at several concentrations, so its units cannot be added. The Units Matrix is where units belong.",
    `The series starts at ${seriesStart.label} and fills forward as each month closes. Earlier months were closed on a different geography and revalued at different prices, so setting them beside this one would measure the change of regime, not the business.`,
  ];

  // ── Watch List ──────────────────────────────────────────────────────────────────────────────
  const watchRows: EngineValue[][] = [];
  for (const area of areas) {
    area.cells.forEach((cell, index) => {
      const column = matrix.columns[index];
      if (!column) return;
      if (cell.targetValue == null || cell.targetValue <= 0) return;
      if (cell.salesValue >= cell.targetValue) return;
      const achievement = cell.salesValue / cell.targetValue;
      watchRows.push([
        area.areaName,
        area.regionName,
        area.repName,
        area.managerName,
        column.productName,
        cell.salesUnits,
        cell.targetUnits,
        cell.salesValue,
        cell.targetValue,
        cell.targetValue - cell.salesValue,
        achievement,
        arrowFor(achievement),
      ]);
    });
  }
  watchRows.sort((a, b) => Number(b[9] ?? 0) - Number(a[9] ?? 0));

  // ── Top Customers, Details ──────────────────────────────────────────────────────────────────
  const detailRows = (input.details ?? []).filter((row) => countsInClosingHeadline(row));
  const groups = buildDetailGroups(detailRows, areaBookByCode);
  const customers = buildCustomers(groups);

  let running = 0;
  const customerRows: EngineValue[][] = customers.rows.map((customer, index) => {
    const share = customers.namedValue ? customer.salesValue / customers.namedValue : null;
    running += share ?? 0;
    return [
      index + 1,
      customer.clientCode,
      customer.clientName,
      customer.areaName,
      customer.regionName,
      customer.salesValue,
      share,
      share == null ? null : running,
    ];
  });

  const achievementByCell = new Map<string, number | null>();
  for (const area of areas) {
    area.cells.forEach((cell, index) => {
      const column = matrix.columns[index];
      if (!column) return;
      achievementByCell.set(
        cellKey(area.areaCode, column.productCode),
        cell.targetValue ? cell.salesValue / cell.targetValue : null,
      );
    });
  }
  const areaCodeByName = new Map(areas.map((area) => [area.areaName, area.areaCode]));
  const detailSheetRows: EngineValue[][] = groups.map((group) => {
    const areaCode = areaCodeByName.get(group.areaName) ?? "";
    const achievement = achievementByCell.get(cellKey(areaCode, group.productCode)) ?? null;
    return [
      group.regionName,
      group.areaName,
      group.repName,
      group.clientCode,
      group.clientName,
      group.productCode,
      group.productName,
      group.family,
      group.channel,
      group.factoryPrice,
      group.qty,
      group.bonusQty,
      group.effectiveUnits,
      group.salesValue,
      group.invoiceLines,
      orNoTarget(achievement),
      arrowFor(achievement),
      group.clientAddress,
    ];
  });

  // ── Footnotes ───────────────────────────────────────────────────────────────────────────────
  // The owner wrote these under his July sheets, and three of them quote July's own figures. They
  // are restated here for the month and the filter actually being exported, because a footnote
  // that still reads "15 areas carry no target" over a different month is worse than no footnote:
  // it is a number a reader will quote. Family Performance's two are month-neutral and are left in
  // the template untouched.
  const untargeted = areas.length - targeted.length;

  const overviewNotes = [
    `One line per workbook — this is ${line} only. Head Office is not part of any line and is excluded throughout.`,
    `${UP} means the target was met and ${DOWN} that it was not; a green cell made target, an amber cell is under half of it.`,
    untargeted === 0
      ? "Every area on this line carries a target, so every area is ranked and scored."
      : `${count(untargeted, "area")} ${agree(untargeted, "carries", "carry")} no target: ${agree(untargeted, "it is", "they are")} listed and counted in the totals, but never ranked and never scored as zero.`,
  ];

  const achieverNotes = [
    "Ranked on achievement against each area's own target, not on size — a small area that made its number outranks a big one that did not.",
    untargeted === 0
      ? `All ${count(targeted.length, "area")} on this line carry a target and can be ranked.`
      : `${count(targeted.length, "area")} on this line ${agree(targeted.length, "carries", "carry")} a target and can be ranked; ${formatInt(untargeted)} ${agree(untargeted, "carries", "carry")} none and ${agree(untargeted, "is", "are")} excluded entirely, not scored as zero.`,
  ];

  // ⚠ THE SECOND NOTE HAS THREE STATES, NOT TWO, AND THE MIDDLE ONE IS THE POINT.
  //
  // With Main Stores on the sheet, "every row names its buyer" is false and "N rows carry no client
  // code" is both false and a published figure for money the owner is hiding the source of. The
  // middle branch says the true thing: warehouse sales reach an AREA rather than an outlet, so they
  // are counted everywhere and ranked nowhere. It names no distributor and sizes nothing.
  const customerNotes = [
    `Share is against the ${formatInt(customers.namedValue)} EGP that reached a named customer, not against the whole line.`,
    customers.mainStoresValue > 0 || customers.epdaShareValue > 0
      ? `${[customers.mainStoresValue > 0 ? "Main Stores" : null, customers.epdaShareValue > 0 ? "EPDA share" : null].filter(Boolean).join(" and ")} rows are counted in every total on this workbook and listed on Details. They are`
        + " left out of this ranking because an area's share reaches an area, not one outlet."
      : customers.unnamedCount === 0
        ? "Every row in scope names its buyer, so nothing is left out of this ranking."
        : `${count(customers.unnamedCount, "row")} worth ${formatInt(customers.unnamedValue)} EGP ${agree(customers.unnamedCount, "carries", "carry")} no client code — the distributor reported the sale without naming the buyer.`,
    customers.unnamedCount === 0
      ? "A customer buying in two areas appears once per area, because the sale belongs to the area that made it."
      : `${agree(customers.unnamedCount, "That row is", "Those rows are")} counted in every total on this workbook and ${agree(customers.unnamedCount, "is", "are")} listed on Details; ${agree(customers.unnamedCount, "it is", "they are")} only left out of this ranking, because ${agree(customers.unnamedCount, "it names", "they name")} no customer to rank.`,
  ];

  // The rows on this sheet are the invoice lines AS INVOICED. Every headline figure in this
  // workbook is after the Office and store allocation, which credits a sale to the area that earned
  // it rather than the branch that shipped it. Across a whole line the two agree to the cent — the
  // allocation only moves value between areas, it never creates or destroys any (measured on CNS
  // July 2026: the seven regional gaps sum to exactly zero). Narrow the export to one region and
  // they stop agreeing, and a reader who adds up this sheet and gets a different number from the
  // Overview has no way to tell which one to believe. So the sheet says it itself, at the top,
  // where it is frozen and actually read — not at the bottom of fourteen thousand rows.
  //
  // 🔴 THE FIGURES STAY, THE EXPLANATION MOVES. Owner, 2026-09-10: "starting from details no
  // logo their". The logo was there — 2,313px along the sheet, because this caption ran to 285
  // characters and `clearTitleEmblem` slides the emblem clear of whatever the caption measures. No
  // reader ever sees 2,313px of an eighteen-column sheet, so the mark had effectively gone.
  //
  // The 150-character clause explaining WHY the two totals differ is what came out. It now sits on
  // the contents page beside this sheet's own name (`INDEX_SECTIONS` in closing-engine-fill.ts),
  // which is the page a reader passes through on the way here. The NUMBERS stay on the sheet, where
  // someone adding up a column needs them: at 139 characters the emblem lands at 1,042px, in line
  // with Watch List's 1,256 and Rep Ranking's 1,115, both of which read fine.
  const detailValue = detailRows.reduce((sum, row) => sum + row.salesValue, 0);
  const detailSubtitle = detailRows.length
    ? [
        groups.length === detailRows.length
          ? `${formatInt(detailRows.length)} invoice lines`
          : `${formatInt(groups.length)} rows${SEP}${formatInt(detailRows.length)} invoice lines`,
        Math.round(detailValue) === Math.round(headlineSales)
          ? null
          : `${formatInt(detailValue)} EGP as invoiced against the ${formatInt(headlineSales)} EGP headline`,
      ]
        .filter((part): part is string => part !== null)
        .join(SEP)
    : "no invoice lines in scope";

  const fill: ClosingEngineFill = {
    data: {
      areaBook,
      pickList: areaBook.map((row) => String(row[0] ?? "")),
      salesData,
    },
    repCard: { products: matrix.columns.map((column) => column.productName), targetedAreaCount: targeted.length },
    sheets: {
      "Area x Product": { cells: { A1: title("Area x Product", "value against target, opened one region at a time") } },
      "Closing Matrix": { cells: { A1: title("Closing Matrix", "sales value against target, per area") } },
      Details: { cells: { A1: title("Details", detailSubtitle) }, rows: detailSheetRows },
      "Family by Month": {
        cells: {
          A1: title(
            "Family by Month",
            monthLabels.length === 1
              ? `${monthLabels[0]} only${SEP}the series starts here and fills forward as each month closes`
              : `${count(monthLabels.length, "month")}, oldest first${SEP}by value, never units`,
          ),
        },
        notes: familyMonthNotes,
        rows: familyMonthRows,
      },
      "Family Performance": {
        // Short on purpose: A1 is merged A1:H1 with the emblem sitting in the last two columns,
        // and the old 111-character subtitle ran under the logo and then clipped mid-word. The
        // reason it says nothing about units is that rows 12 and 13 of this very sheet say it in
        // full, in the owner's own wording.
        cells: { A1: title("Family Performance", "by value, never units") },
        rows: familyRows,
      },
      Overview: {
        cells: {
          A1: title("Monthly Closing", `built ${built}`),
          B5: headlineSales,
          B6: `EGP, ${month.label}`,
          D5: targetTotal || null,
          D6: `across ${targeted.length} targeted areas`,
          F5: headlineAchievement,
          F6: `${atTarget} of ${targeted.length} areas at or above target`,
          // I4/H8/I8 name the month before this one. The template ships them blank on purpose —
          // a caption reading "June" over August's comparison is the failure this replaces.
          H8: prior.name ? `${prior.name} value` : "Prior value",
          I4: prior.name ? `Against ${prior.name}` : "Against prior month",
          I5: growthOf(headlineSales, priorTotal),
          I6: priorCaption,
          I8: prior.name ? `Against ${prior.name}` : "Against prior month",
        },
        notes: overviewNotes,
        rows: overviewRows,
      },
      "Rep Card": {
        cells: {
          // The filter note rides on A1 here, where every other sheet's `title` puts it. The card
          // has room: its caption is 30 characters against the ~80 that reach the emblem.
          A1: [headline("Rep Card"), filterNote].filter(Boolean).join(SEP),
          B5: areaBook.length ? String(areaBook[0]![0] ?? "") : "",
          B14: `EGP, ${month.label}`,
          // The card's own prior-month sentence reads its month name from here, so the formula
          // never has to be rewritten for a new month. See build-closing-engine-template.mjs.
          N4: prior.name || "The prior month",
        },
      },
      "Rep Ranking": {
        cells: {
          A1: title("Rep Ranking", "every area, ranked by achievement against its own target"),
          J4: prior.name ? `Against ${prior.name}` : "Against prior month",
        },
        rows: repRankingRows,
      },
      "Top Achievers": {
        cells: {
          A1: title("Top Achievers", "the ten highest against their own target"),
          B5: first ? first.repName : "",
          B6: first
            ? `${first.areaName}${SEP}${first.regionName}${SEP}${formatInt(first.salesValue)} against a target of ${formatInt(first.targetValue)} EGP`
            : "",
          G5: first ? first.achievement : null,
        },
        notes: achieverNotes,
        rows: topTen.map((area, index) => [
          index + 1,
          area.repName,
          area.areaName,
          area.regionName,
          area.salesValue,
          area.targetValue,
          area.achievement,
          arrowFor(area.achievement),
        ]),
      },
      "Top Customers": {
        cells: {
          A1: title(
            "Top Customers",
            customers.rows.length
              ? `all ${formatInt(customers.rows.length)} named customers, largest first`
              : "no named customer in scope",
          ),
        },
        notes: customerNotes,
        rows: customerRows,
      },
      "Units Matrix": { cells: { A1: title("Units Matrix", "units against target, never summed across products") } },
      "Watch List": {
        cells: { A1: title("Watch List", "every area and product still short of target, largest shortfall first") },
        rows: watchRows,
      },
    },
  };

  // The completeness note, on its own row, on every sheet that carries a caption.
  //
  // Not the end of A1: the caption overflows right into the emblem and `clearTitleEmblem` answers
  // by sliding the emblem along, so a note appended there pushed the logo past the last column on 8
  // of the 12 sheets. It needs a line of its own.
  //
  // ROW 3, NOT ROW 2 -- and row 2 is why this note has been unreadable for as long as it has
  // existed. Row 2 is EMPTY in the owner's template, which is what the reasoning here used to
  // check, but empty is not free: every navigation button on every sheet is a drawing anchored
  // from row 2, so the note was written underneath them and the buttons painted straight over it.
  // Measured on the owner's own September export, and it is the first thing his 2026-09-08 design
  // brief forbids: "Warning must NEVER overlap buttons."
  //
  // Raising row 2 does not fix it, which is worth knowing before someone tries: the buttons are
  // anchored INTO the row below and a `twoCellAnchor` resizes with its rows, so a taller row 2
  // yields a taller button that still overhangs. The row the note sits in has to change.
  //
  // The approved reference separates the three the same way -- title row 1, navigation row 2,
  // warning strip row 3, at 44/37/30 points. `EXECUTIVE_GEOMETRY` carries those heights and
  // `fitNavigationBand` clamps the buttons to row 2, so the strip below them is clear.
  //
  // The Rep Card is skipped because it already carries the short form on A2 -- it is the one sheet
  // whose row 2 is spoken for, and the one most likely to be shared on its own. A sheet with no
  // caption (Data) has no emblem and no reader, and is skipped with it.
  // REMOVED BY THE OWNER, 2026-09-09: "REMOVE AND DO NOT SHOW THIS LINE IN ANY TAB."
  //
  // The note is no longer written to any sheet. It is left COMPUTED above rather than deleted,
  // because `coverageNote.terse` is a separate decision on the Rep Card's own deck line and the
  // completeness figures behind it are read elsewhere; ripping the calculation out would make this
  // a wider change than he asked for.
  //
  // What this costs, recorded here so nobody has to rediscover it: the workbook no longer says when
  // a month is missing distributor feeds. A September that has three of its four sources absent now
  // reads as a real collapse in sales rather than as an incomplete month, and nothing on the page
  // distinguishes the two. He was told that and asked for it anyway, so it is a decision and not an
  // oversight — do not reinstate the line on the reasoning that its absence looks like a bug.
  void coverageNote;

  return fill;
}

/** "2026-07" -> "2026-06". Returns null for anything that is not a period. */
export function previousPeriod(period: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  const priorYear = monthIndex === 1 ? year - 1 : year;
  const priorMonth = monthIndex === 1 ? 12 : monthIndex - 1;
  return `${priorYear}-${String(priorMonth).padStart(2, "0")}`;
}
