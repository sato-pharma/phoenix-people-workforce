// Pure de-cumulation of cumulative weekly-sales rows into real "this week only" rows.
//
// MOST distributor weekly sheets are CUMULATIVE within a month (week 2 already contains week 1, etc.).
// For each (distributor, cycle_month) the real value/units of a week = its cumulative MINUS the
// previous week's matching (product × branch) cumulative. The first week of a cycle is itself. STOCK is
// a point-in-time snapshot — never subtracted. Untagged rows (no cycle_month / week_number) pass through
// unchanged. Telescoping keeps the month total correct: the sum of the real weeks equals the last
// cumulative sheet of the cycle.
//
// NOT every distributor restates. Direct is invoice-keyed, so MOST months each sheet carries only that
// week's own orders and subtracting the prior sheet invents negative weeks. The registry marks Direct
// `cumulative: false` in distributors.ts so the parser and upload preview read one source of truth —
// but Direct has NOT been consistent: some months it was uploaded as cumulative month-to-date files
// (June 2026 was, and summing its four sheets counted the month ~2.2x). So for a distributor the flag
// marks non-cumulative, the cumulative-or-not decision is made PER cycle month FROM ITS OWN SHEETS
// (cycleGroupIsCumulative): a running total never loses a cell and never lets one fall; a per-week feed
// does both. A distributor the flag marks cumulative is ALWAYS de-cumulated — detection never turns it
// off, so the working distributors cannot regress.
//
// Pure apart from that registry lookup, so it stays unit-testable in isolation
// (see tests/weekly-decumulation.test.ts).

import { weeklyDistributorIsCumulative } from "@/lib/sales/weekly/distributors";
import type { WeeklyThisWeekProductNet } from "@/lib/sales/weekly/types";

export type DecumulableRow = {
  weekStart: string;
  /** first day of the month-cycle (YYYY-MM-DD); "" when untagged */
  cycleMonth: string;
  /** week-of-month 1–4; null when untagged */
  weekNumber: number | null;
  distributorCode: string;
  productCode: string;
  branchCode: string;
  branchName: string;
  salesValue: number;
  salesQty: number;
  netQty: number;
  stockQty: number;
};

const up = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

// A cell is one product at one branch. Branch falls back to its name when it has no code. Both the
// de-cumulation and the cumulative detection key on this, so they always agree on what a cell is.
const cellKey = (r: DecumulableRow) => `${up(r.productCode)}||${up(r.branchCode) || up(r.branchName)}`;

// Detecting a cumulative cycle from its own sheets (see cycleGroupIsCumulative). A running month-to-date
// total never loses a cell and never lets one fall, so a per-week (invoice) feed shows both. Measured on
// production for the Direct channel: 2026-05 scored 0.633 and 2026-07 0.688 (per-week), while 2026-06
// scored 0.000 (a genuine cumulative upload). 0.15 sits far below every per-week month and above a
// cumulative month that carries the odd returns-driven dip.
const CUMULATIVE_NET_EPSILON = 0.01;
const CUMULATIVE_MAX_VIOLATION_FRACTION = 0.15;

/**
 * Do a single (distributor, cycle_month) group's sheets look cumulative — does each week restate the
 * month to date? Pure, and keyed on the SAME cell as decumulateRows.
 *
 * A running total has two signatures: a cell present one week stays present every later week, and its
 * value never falls. A per-week feed breaks both — cells appear and vanish, and values drop (a
 * returns-only week even goes negative). We pool the vanished + fallen cells over every consecutive week
 * pair and call it cumulative when they are a small fraction of the cells seen. Fewer than two weeks
 * carry no evidence either way, so the caller's registry flag decides those.
 */
export function directGroupLooksCumulative(rows: readonly DecumulableRow[]): boolean {
  const weeks = [...new Set(rows.map((r) => r.weekStart).filter(Boolean))].sort();
  if (weeks.length < 2) return false;
  const byWeek = new Map<string, Map<string, number>>();
  for (const week of weeks) byWeek.set(week, new Map());
  for (const r of rows) {
    const m = byWeek.get(r.weekStart);
    if (!m) continue;
    const k = cellKey(r);
    m.set(k, (m.get(k) ?? 0) + r.netQty);
  }
  let priorCells = 0;
  let violations = 0;
  for (let i = 1; i < weeks.length; i++) {
    const prev = byWeek.get(weeks[i - 1])!;
    const curr = byWeek.get(weeks[i])!;
    for (const [k, prevNet] of prev) {
      priorCells++;
      const currNet = curr.get(k);
      if (currNet === undefined) violations++; // a running total never loses a cell
      else if (currNet < prevNet - CUMULATIVE_NET_EPSILON) violations++; // nor lets one fall
    }
  }
  return priorCells > 0 && violations / priorCells <= CUMULATIVE_MAX_VIOLATION_FRACTION;
}

/**
 * Should this (distributor, cycle_month) group be de-cumulated?
 *
 * A distributor the registry marks cumulative (every real export except Direct) always is — detection
 * never turns de-cumulation OFF for them, so the working distributors cannot regress
 * (tests/weekly-decumulation.test.ts). A distributor the registry marks NON-cumulative (Direct) is
 * decided from its own sheets per cycle month: Direct has been per-week invoice sheets some months and a
 * cumulative month-to-date file others (June 2026 was cumulative, and the fixed flag summed its four
 * sheets ~2.2x — the double-count this detection removes).
 */
export function cycleGroupIsCumulative(
  distributorCode: string | null | undefined,
  groupRows: readonly DecumulableRow[],
): boolean {
  if (weeklyDistributorIsCumulative(distributorCode)) return true;
  return directGroupLooksCumulative(groupRows);
}

export function decumulateRows<T extends DecumulableRow>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row.cycleMonth || row.weekNumber == null) {
      out.push(row); // untagged / legacy — leave exactly as-is
      continue;
    }
    // Bucket EVERY tagged row, whatever its flag: whether a Direct cycle is really cumulative is decided
    // per group from its own sheets below (cycleGroupIsCumulative), not from the registry flag alone.
    const key = `${up(row.distributorCode)}||${row.cycleMonth}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  for (const groupRows of groups.values()) {
    if (!cycleGroupIsCumulative(groupRows[0]?.distributorCode, groupRows)) {
      // A per-week feed (Direct's invoice sheets): each row IS its own week, nothing to subtract.
      for (const r of groupRows) out.push(r);
      continue;
    }
    const weeks = [...new Set(groupRows.map((r) => r.weekStart).filter(Boolean))].sort();
    // Per-week cumulative cell maps. Duplicate cells within a week (shouldn't happen post-aggregate) sum.
    const byWeek = new Map<string, Map<string, T>>();
    for (const week of weeks) byWeek.set(week, new Map());
    for (const r of groupRows) {
      const m = byWeek.get(r.weekStart);
      if (!m) continue;
      const k = cellKey(r);
      const ex = m.get(k);
      if (ex) {
        ex.salesValue += r.salesValue;
        ex.salesQty += r.salesQty;
        ex.netQty += r.netQty;
        ex.stockQty += r.stockQty;
      } else {
        m.set(k, { ...r });
      }
    }
    for (let i = 0; i < weeks.length; i++) {
      const curr = byWeek.get(weeks[i]);
      if (!curr) continue;
      const prev = i > 0 ? byWeek.get(weeks[i - 1]) ?? null : null;
      for (const [k, r] of curr) {
        const p = prev?.get(k);
        out.push({
          ...r,
          salesValue: p ? r.salesValue - p.salesValue : r.salesValue,
          salesQty: p ? r.salesQty - p.salesQty : r.salesQty,
          netQty: p ? r.netQty - p.netQty : r.netQty,
          stockQty: r.stockQty, // snapshot — never subtracted
        });
      }
    }
  }
  return out;
}

const roundUnits = (value: number) => Number(value.toFixed(2));

/**
 * The upload preview's "this week only" net units, ONE PRODUCT AT A TIME: each product's cumulative on
 * this sheet minus its own cumulative on the previous sheet of the month. It is the per-product form of
 * the sheet-level subtraction computeThisWeekOnly does with the batch header, and exists because that
 * header adds every product, so its result is a real figure only for a one-product sheet — units of
 * different products are never added (owner rule, 2026-08-27).
 *
 * `prior` is the previous sheet's rows, one per product and branch, so a product can appear more than
 * once and is added up here. null means there is nothing to subtract — the cycle's first sheet, or a
 * distributor whose sheets are not cumulative — and each product's own cumulative IS its week. A product
 * the previous sheet never carried has nothing to subtract either. A product only the previous sheet
 * carried has no figure to print and is left out. Products are matched trimmed and upper-cased, as the
 * cells of decumulateRows are, and each result keeps the code its sheet gave it. Pure.
 */
export function decumulateProductNet(
  current: readonly WeeklyThisWeekProductNet[],
  prior: readonly WeeklyThisWeekProductNet[] | null,
): WeeklyThisWeekProductNet[] {
  const priorByProduct = new Map<string, number>();
  for (const entry of prior ?? []) {
    const key = up(entry.productCode);
    priorByProduct.set(key, (priorByProduct.get(key) ?? 0) + entry.netQty);
  }
  return current.map((entry) => ({
    productCode: entry.productCode,
    netQty: roundUnits(entry.netQty - (priorByProduct.get(up(entry.productCode)) ?? 0)),
  }));
}

// M6: within a (distributor, cycle_month), de-cumulation subtracts each week against the PREVIOUS
// PRESENT week, not the calendar-adjacent one. If an earlier week of the cycle was never uploaded,
// the current week's real figure silently spans that missing week (its delta = cumulative-now minus
// cumulative-of-the-last-present-week). The month total stays correct via telescoping, but the single
// week is inflated. This returns true when a gap exists immediately before `currWeekNumber`, i.e. the
// previous present week number is more than one behind it. prevWeekNumber === null means this is the
// first present week of the cycle (nothing to span). Pure + trivially unit-testable.
export function weekHasDecumulationGap(
  prevWeekNumber: number | null,
  currWeekNumber: number,
): boolean {
  if (prevWeekNumber == null) return false;
  return currWeekNumber - prevWeekNumber > 1;
}

// M6 PER DEPOT. The flag above is pooled: it asks whether ANY distributor uploaded the week before, so a
// depot that skipped a week goes unflagged whenever another depot uploaded it, and that depot's next week
// still holds two weeks of its sales. This asks the question of each (distributor, cycle month) on its
// own, over the rows decumulateRows is given: a depot's week spans a gap when that depot sent no sheet
// for the week before it in that month. Its first sheet of a month spans one too when it is not week 1,
// because a month-to-date sheet then holds every week up to it (weeklySalesUploadCalendar in
// sales-depot-detail.ts counts the same span). Untagged rows, rows with no week date, and a
// non-cumulative distributor (Direct) never span a gap: decumulateRows subtracts nothing from them.
//
// Week numbers decide, where de-cumulation orders by date. The two agree whenever a depot's week numbers
// rise with its dates, which every validated upload on production did when this was written. Pure.
export type DepotWeekGap = { distributorCode: string; cycleMonth: string; weekNumber: number };

/** The key a depot's week is looked up under. Case-blind on the distributor, as decumulateRows groups it. */
export function depotWeekGapKey(
  distributorCode: string | null | undefined,
  cycleMonth: string | null | undefined,
  weekNumber: number | null | undefined,
): string {
  return `${up(distributorCode)}||${cycleMonth ?? ""}||${weekNumber ?? ""}`;
}

export function depotWeekGaps(
  rows: readonly Pick<DecumulableRow, "distributorCode" | "cycleMonth" | "weekNumber" | "weekStart">[],
): DepotWeekGap[] {
  const calendars = new Map<string, { distributorCode: string; cycleMonth: string; weeks: Set<number> }>();
  for (const row of rows) {
    if (!row.cycleMonth || row.weekNumber == null || !row.weekStart) continue;
    // The "spans gap" badge stays keyed on the registry flag, not on decumulateRows' per-cycle
    // detection: it takes rows WITHOUT values, so it cannot run the same test, and it only drives a
    // cosmetic badge and the per-week display suppression — never the month total. The one month this
    // could under-flag (a Direct cycle detection finds cumulative) has no missing weeks in practice
    // (June 2026 has all four), so there is nothing to badge there anyway.
    if (!weeklyDistributorIsCumulative(row.distributorCode)) continue;
    const key = `${up(row.distributorCode)}||${row.cycleMonth}`;
    const calendar = calendars.get(key) ?? { distributorCode: up(row.distributorCode), cycleMonth: row.cycleMonth, weeks: new Set<number>() };
    calendar.weeks.add(row.weekNumber);
    calendars.set(key, calendar);
  }
  const gaps: DepotWeekGap[] = [];
  for (const { distributorCode, cycleMonth, weeks } of calendars.values()) {
    for (const weekNumber of weeks) {
      if (weekNumber > 1 && !weeks.has(weekNumber - 1)) gaps.push({ distributorCode, cycleMonth, weekNumber });
    }
  }
  return gaps.sort(
    (a, b) =>
      a.cycleMonth.localeCompare(b.cycleMonth) || a.distributorCode.localeCompare(b.distributorCode) || a.weekNumber - b.weekNumber,
  );
}

/** depotWeekGaps as a lookup set, for moneySpansDepotGap. */
export function depotWeekGapKeys(gaps: readonly DepotWeekGap[]): Set<string> {
  return new Set(gaps.map((gap) => depotWeekGapKey(gap.distributorCode, gap.cycleMonth, gap.weekNumber)));
}

// The one rule every screen flags a week by (owner, 2026-09-17): a week is marked where money that counts
// on that screen came from a depot week that spans a gap. A row that moves no money cannot make a figure
// read high, so a stock-only row never marks its week. Pure.
export function moneySpansDepotGap(
  row: { distributorCode?: string | null; cycleMonth?: string | null; weekNumber?: number | null },
  money: { value: number; units: number },
  gapKeys: ReadonlySet<string>,
): boolean {
  if (row.weekNumber == null || (money.value === 0 && money.units === 0)) return false;
  return gapKeys.has(depotWeekGapKey(row.distributorCode, row.cycleMonth, row.weekNumber));
}

// M6 remediation (chosen fix: "suppress + flag"): when a week spans an upload gap its de-cumulated
// single-week figure silently includes the missing week(s) and is NOT a true weekly value, so it must
// never be shown as one. This nulls the figure at the source (the week-comparison builder), so every
// downstream consumer -- table, cross-month chart, and both exports -- renders it as "—"/blank next to
// the "spans gap" badge instead of the inflated number. Stock is a point-in-time snapshot (never
// subtracted) so it stays a real value even across a gap; only sales value/units and the WoW % are
// suppressed. Month totals are unaffected: they telescope from the raw cumulative sheets, not from
// these per-week display figures. Pure + unit-tested.
export function suppressGapSpannedValue<T>(spansGap: boolean, value: T): T | null {
  return spansGap ? null : value;
}
