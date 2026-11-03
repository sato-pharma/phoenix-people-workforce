/**
 * Empty seats beside the Monthly Closing (owner, 2026-11-03: "build 2").
 *
 * Which empty territory should be filled first? One row per rep seat with nobody in it, ranked by what
 * its area sold in the newest PUBLISHED closing of its line, with the target, how long it has been
 * empty, the list it still holds and who has been visiting it. It reads only: it opens no requisition,
 * moves no customer and offers no action.
 *
 * ## Every figure here is somebody else's
 *
 * - The seats are the Reps List's own (`loadCoverageFilterTree`, `foldVacancyCells`), which carry the
 *   line and area CODES the closing is keyed by. `VacancyReportRow` holds names only.
 * - The sales and the target are the closing engine's (`loadAchievementRange`, the area merges, then
 *   `totalRows`), for the month `latestPublishedPeriodForLine` names. Never a figure of its own, and
 *   the VALUE only: rows span products, and units of different products are never added.
 * - The last rep is the Reps List's (`loadLastHolders`).
 *
 * ## No row is not zero
 *
 * A row exists only where sales or a target exist, so an area with no row says so, and a read that
 * failed says so. Neither is ever drawn as 0, and neither outranks a real figure.
 *
 * ## Who sees what
 *
 * The viewer must hold BOTH `vacancies:read` and `sales:read`, and the seats and rows are both cut by
 * `resolveVsTargetBound`, BEFORE anything is totalled. A viewer the bound cannot place sees no seat,
 * and a rep's `self` bound sees none either, because an empty seat is nobody's own row.
 *
 * ## Visits are a count of what was logged, deliberately not a KPI
 *
 * The question is "is anybody going there", so a visit still waiting on a validation or an approval
 * counts here though it scores nothing: this is no call rate, and the column says "logged". A manager's
 * own visit on an empty territory is filed on HIS table, not the seat's (phoenix-crm-manager-plan), so
 * both tables are read, or the seat would look abandoned while he works it.
 */

import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { cairoDateKey } from "@/lib/activity/working-baseline";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { vacanciesMatching, type CoverageFilterVacancy } from "@/lib/crm/coverage-filters";
import { loadCoverageFilterTree } from "@/lib/crm/coverage-filters-data";
import { foldVacancyCells, loadLastHolders } from "@/lib/crm/reps-list-vacant-areas";
import { latestPublishedPeriodForLine } from "@/lib/employee-portal/line-top-achievers";
import { isParkedSeat } from "@/lib/hr/today-tasks";
import { loadManagerVacantTerritoryVisits } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { applyAchievementAreaMerges, expandAreaCodeForLine, foldAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { periodLabel } from "@/lib/sales/monthly-closing-period-merge";
import {
  loadAchievementRange,
  loadPublishedPeriodKeys,
  SALES_VS_TARGET_FLOOR,
  salesVsTargetPeriods,
  totalRows,
} from "@/lib/sales/vs-target";
import { filterRowsForBound, resolveVsTargetBound, type VsTargetBound } from "@/lib/sales/vs-target-scope";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back the visits column looks, and the line the "long empty" tile is drawn at. */
export const EMPTY_SEAT_VISIT_WINDOW_DAYS = 60;
export const EMPTY_SEAT_LONG_DAYS = 60;

export type EmptySeatClosing =
  /** The line's newest published month holds this area. `targetValue` is null when it carries none. */
  | {
      achievement: number | null;
      periodLabel: string;
      salesValue: number;
      state: "figures";
      targetValue: number | null;
    }
  /** The month is published and holds no row for this area: unknown here, and never a zero. */
  | { periodLabel: string; state: "no_row" }
  /** The line has no published month at all. */
  | { state: "no_published_month" }
  /** The read failed. Said on the page, never drawn as a zero. */
  | { state: "unavailable" };

export type EmptySeatSince = {
  date: string;
  days: number;
  /** Where the date came from, because a vacancy row can be opened long after the rep left. */
  source: "last_rep" | "vacancy_opened";
};

export type EmptySeatRow = {
  areaName: string;
  closing: EmptySeatClosing;
  /** Line and area, for counting an area once. Two empty seats can share one area's sales. Never rendered. */
  closingKey: string;
  /** PM + AM on the list the seat still holds. Null when the read failed, never 0. */
  contactCount: number | null;
  emptySince: EmptySeatSince | null;
  key: string;
  lastRepName: string | null;
  lineName: string;
  managerVisits: number | null;
  /** On the owner's list of seats left empty until he hires into them (`isParkedSeat`). */
  parked: boolean;
  pharmacyCount: number | null;
  regionName: string;
  /** Never rendered: one seat can cover two areas, so it can stand on two rows. */
  seatId: string;
  seatVisits: number | null;
};

export type EmptySeatsBoard = {
  /** Which reads failed, in words, for the page to say. */
  failedReads: string[];
  /** The month each line's figures come from, for the header. */
  linePeriods: Array<{ lineName: string; periodLabel: string | null }>;
  parked: EmptySeatRow[];
  ranked: EmptySeatRow[];
  /** Areas on the board the totals could not include. */
  areasWithoutFigures: number;
  salesTotal: number;
  scopeNote: string;
  /** Distinct seats, ranked and parked together. Rows can outnumber them. */
  seatCount: number;
  targetTotal: number;
  today: string;
  visitWindowDays: number;
};

function normalizeCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Whole days from one ISO date to a later one. On UTC midnights, so no timezone can move a day. */
export function daysBetweenIso(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/**
 * PURE — how long the seat has been empty. The day its last rep left beats the vacancy row, which can
 * be opened weeks later; among a seat's open rows the earliest wins, because one seat can hold several
 * and the seat was already empty at the first. A date in the future (a notice still running) says
 * nothing about today, so it falls through.
 */
export function emptySinceFor(input: {
  heldUntil: string | null | undefined;
  openedDates: readonly string[];
  today: string;
}): EmptySeatSince | null {
  const usable = (value: string | null | undefined) => {
    const date = String(value ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= input.today ? date : null;
  };
  const left = usable(input.heldUntil);
  if (left) return { date: left, days: daysBetweenIso(left, input.today), source: "last_rep" };
  const opened = input.openedDates.map(usable).filter((date): date is string => Boolean(date)).sort()[0];
  return opened ? { date: opened, days: daysBetweenIso(opened, input.today), source: "vacancy_opened" } : null;
}

/**
 * PURE — whether a viewer's sales bound reaches a seat. Asked of the code as stored AND as folded,
 * because a merged area's two cells can sit on either side of a bound. `self` and `none` reach no seat:
 * an empty seat has no holder for a rep's row to match, and an unresolved bound must never mean more.
 */
export function seatInBound(seat: Pick<CoverageFilterVacancy, "areaCode" | "lineCode">, bound: VsTargetBound): boolean {
  switch (bound.kind) {
    case "company":
      return true;
    case "line":
      return bound.lineCodes.has(seat.lineCode);
    case "areas": {
      if (bound.lineCodes && !bound.lineCodes.has(seat.lineCode)) return false;
      const stored = normalizeCode(seat.areaCode);
      return bound.areaCodes.has(stored) || bound.areaCodes.has(normalizeCode(foldAreaCodeForLine(seat.lineCode, stored)));
    }
    case "self":
    case "none":
      return false;
  }
}

/**
 * PURE — the area codes a seat's rows carry in one month. The merges are dated: a seat is folded by
 * TODAY's rules and a row by ITS OWN month's, and the newest published month can stand on the other side
 * of a merge's start or end. So today's members are folded again as that month folded them, or a seat
 * would print half an area under the whole area's name, or nothing at all.
 */
export function closingAreaCodesFor(lineCode: string, areaCode: string, period: string | null): string[] {
  const members = expandAreaCodeForLine(lineCode, areaCode);
  return [...new Set(members.map((member) => foldAreaCodeForLine(lineCode, member, period)))].sort();
}

/**
 * PURE — one seat's figures from rows ALREADY merged and cut by the viewer's bound. `totalRows` does the
 * adding, so the sales, the target and the % are the ones Sales vs Target prints for that area.
 */
export function closingForSeat(input: {
  areaCode: string;
  lineCode: string;
  period: string | null;
  rows: readonly AchievementRow[] | null;
}): EmptySeatClosing {
  if (input.rows === null) return { state: "unavailable" };
  if (!input.period) return { state: "no_published_month" };
  const areas = new Set(closingAreaCodesFor(input.lineCode, input.areaCode, input.period));
  const line = normalizeCode(input.lineCode);
  const mine = input.rows.filter(
    (row) => row.period === input.period && normalizeCode(row.lineCode) === line && areas.has(normalizeCode(row.areaCode)),
  );
  const label = periodLabel(input.period);
  if (mine.length === 0) return { periodLabel: label, state: "no_row" };
  const totals = totalRows([...mine]);
  return {
    achievement: totals.achievementValue,
    periodLabel: label,
    salesValue: totals.actualValue,
    state: "figures",
    targetValue: totals.targetValue !== 0 ? totals.targetValue : null,
  };
}

/** A seat with no figure ranks below every seat with one, whatever that figure is. */
function salesOf(row: EmptySeatRow): number | null {
  return row.closing.state === "figures" ? row.closing.salesValue : null;
}

/**
 * PURE — highest published sales first, then the larger target, then empty longest, then by name so the
 * list holds still between loads. There is no score: every step is a figure printed on the row, so
 * anyone can see why a seat stands where it does.
 */
export function rankEmptySeats(rows: readonly EmptySeatRow[]): EmptySeatRow[] {
  const targetOf = (row: EmptySeatRow) => (row.closing.state === "figures" ? (row.closing.targetValue ?? -1) : -1);
  return [...rows].sort((a, b) => {
    const salesA = salesOf(a);
    const salesB = salesOf(b);
    if (salesA === null && salesB !== null) return 1;
    if (salesB === null && salesA !== null) return -1;
    if (salesA !== null && salesB !== null && salesA !== salesB) return salesB - salesA;
    return (
      targetOf(b) - targetOf(a) ||
      (b.emptySince?.days ?? -1) - (a.emptySince?.days ?? -1) ||
      a.lineName.localeCompare(b.lineName) ||
      a.areaName.localeCompare(b.areaName)
    );
  });
}

/** PURE — visits to a seat since it emptied, keyed by seat. A visit before that was its last rep's own work. */
export function countVisitsSinceEmpty(
  visits: ReadonlyArray<{ seatId: string | null; visitDate: string | null }>,
  sinceBySeat: ReadonlyMap<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const visit of visits) {
    const seatId = visit.seatId;
    const since = seatId ? sinceBySeat.get(seatId) : undefined;
    if (!seatId || since === undefined || !visit.visitDate || visit.visitDate < since) continue;
    counts.set(seatId, (counts.get(seatId) ?? 0) + 1);
  }
  return counts;
}

/**
 * PURE — the board's totals. Each area counts ONCE however many empty seats sit on it, because every one
 * of those rows prints the same area's figure, and adding them would claim sales nobody made.
 */
export function boardTotals(rows: readonly EmptySeatRow[]): {
  areasWithoutFigures: number;
  salesTotal: number;
  seatCount: number;
  targetTotal: number;
} {
  const areas = new Map<string, Extract<EmptySeatClosing, { state: "figures" }>>();
  for (const row of rows) if (row.closing.state === "figures") areas.set(row.closingKey, row.closing);
  const figures = [...areas.values()];
  return {
    // Said beside the totals, so a sum that left an area out never reads as the whole board's.
    areasWithoutFigures: new Set(rows.filter((row) => row.closing.state !== "figures").map((row) => row.closingKey)).size,
    salesTotal: figures.reduce((sum, figure) => sum + figure.salesValue, 0),
    seatCount: new Set(rows.map((row) => row.seatId)).size,
    targetTotal: figures.reduce((sum, figure) => sum + (figure.targetValue ?? 0), 0),
  };
}

/** The server-side gate. Both grants, so this widens neither the vacancy report nor the sales pages. */
export async function canViewEmptySeatsBoard(access: AccessContext): Promise<boolean> {
  const [vacancies, sales] = await Promise.all([canAccess(access, "vacancies", "read"), canAccess(access, "sales", "read")]);
  return vacancies && sales;
}

/** Each line's newest published month and that month's rows, merged and cut by the bound. */
async function loadClosingForSeats(
  lineCodes: readonly string[],
  bound: VsTargetBound,
): Promise<{ periodByLine: Map<string, string | null>; rows: AchievementRow[] }> {
  const publishedKeys = await loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, salesVsTargetPeriods().current);
  const periodByLine = new Map(lineCodes.map((line) => [line, latestPublishedPeriodForLine(line, publishedKeys)]));
  const periods = [...new Set([...periodByLine.values()].filter((period): period is string => Boolean(period)))];
  const months = await Promise.all(periods.map((period) => loadAchievementRange(period, period)));
  // Merged before the bound and before any total, as every other reader of these rows does.
  return { periodByLine, rows: filterRowsForBound(applyAchievementAreaMerges(months.flat()), bound) };
}

/** The list each seat still holds: on it or waiting to be validated, never the archive or the door. */
async function loadListCounts(seatIds: readonly string[]): Promise<Map<string, { contacts: number; pharmacies: number }>> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRowsKeyset<{ id: string; list_type: string | null; seat_id: string | null }>(
    () =>
      supabase
        .from("phoenix_crm_customers")
        .select("id, seat_id, list_type")
        .in("seat_id", [...seatIds])
        .eq("is_test", false)
        .in("status", ["active", "pending"]),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
  const counts = new Map<string, { contacts: number; pharmacies: number }>();
  for (const row of rows) {
    if (!row.seat_id) continue;
    const entry = counts.get(row.seat_id) ?? { contacts: 0, pharmacies: 0 };
    // A pharmacy is not a contact (the AM · PM · Pharmacies rule): always its own figure.
    if (row.list_type === "Pharmacy") entry.pharmacies += 1;
    else entry.contacts += 1;
    counts.set(row.seat_id, entry);
  }
  return counts;
}

/** Both tables a visit to an empty territory can sit on. See the header. */
async function loadVisitCounts(
  sinceBySeat: ReadonlyMap<string, string>,
  from: string,
): Promise<{ managers: Map<string, number>; seats: Map<string, number> }> {
  const supabase = getSupabaseAdmin();
  const seatVisits = await fetchAllRowsKeyset<{ id: string; seat_id: string | null; visit_date: string | null }>(
    () =>
      supabase
        .from("phoenix_crm_visits")
        .select("id, seat_id, visit_date")
        .in("seat_id", [...sinceBySeat.keys()])
        .eq("is_test", false)
        // A visit copied from iReports360 is history (phoenix-crm-imported-history), and this board
        // says who is going there now.
        .is("imported_from_ireports360_at", null)
        .gte("visit_date", from),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
  const managerVisits = await loadManagerVacantTerritoryVisits({ from });
  return {
    managers: countVisitsSinceEmpty(managerVisits, sinceBySeat),
    seats: countVisitsSinceEmpty(
      seatVisits.map((row) => ({ seatId: row.seat_id, visitDate: row.visit_date })),
      sinceBySeat,
    ),
  };
}

async function loadOpenedDates(seatIds: readonly string[]): Promise<Map<string, string[]>> {
  const { data, error } = await getSupabaseAdmin()
    .from("position_vacancies")
    .select("seat_id, created_at")
    .eq("status", "open")
    .in("seat_id", [...seatIds]);
  if (error) throw error;
  const opened = new Map<string, string[]>();
  for (const row of (data ?? []) as Array<{ created_at: string | null; seat_id: string | null }>) {
    // The day in Cairo: a row opened after midnight there is still the day before in UTC.
    const date = cairoDateKey(row.created_at);
    if (!row.seat_id || !date) continue;
    opened.set(row.seat_id, [...(opened.get(row.seat_id) ?? []), date]);
  }
  return opened;
}

/** Runs one read and names it when it fails, so a failure is said on the page and logged, never a blank. */
async function settled<T>(what: string, failed: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[empty-seats] could not read ${what}`, error);
    failed.push(what);
    return null;
  }
}

/** The caller has already asked `canViewEmptySeatsBoard`. A failure of the seat list itself throws. */
export async function getEmptySeatsBoard(access: AccessContext): Promise<EmptySeatsBoard> {
  const today = cairoTodayIso();
  const [bound, tree] = await Promise.all([resolveVsTargetBound(access), loadCoverageFilterTree()]);
  // Cut BEFORE folding: the fold can rewrite a code, and the bound is asked of both spellings above.
  const seats = foldVacancyCells(vacanciesMatching(tree, {}).filter((seat) => seatInBound(seat, bound)));
  const seatIds = seats.map((seat) => seat.seatId);
  const failedReads: string[] = [];

  const lineCodes = [...new Set(seats.map((seat) => seat.lineCode))];
  const [closing, listCounts, holders, opened] = await Promise.all([
    settled("the published closing", failedReads, () => loadClosingForSeats(lineCodes, bound)),
    settled("the customer lists", failedReads, () => (seatIds.length ? loadListCounts(seatIds) : Promise.resolve(new Map()))),
    settled("the last reps", failedReads, () => loadLastHolders(seats)),
    settled("the vacancy dates", failedReads, () => (seatIds.length ? loadOpenedDates(seatIds) : Promise.resolve(new Map()))),
  ]);

  const emptySinceBySeat = new Map(
    seats.map((seat) => [
      seat.seatId,
      emptySinceFor({
        heldUntil: holders?.lastBySeat.get(seat.seatId)?.heldUntil,
        openedDates: opened?.get(seat.seatId) ?? [],
        today,
      }),
    ]),
  );

  // Looks back the window at most, and for a seat with no known date the whole window: its last rep's
  // visits cannot be told apart then, and the row prints no date, so it is read with that in mind.
  const from = addDaysIso(today, -EMPTY_SEAT_VISIT_WINDOW_DAYS);
  const sinceBySeat = new Map(
    seats.map((seat) => {
      const since = emptySinceBySeat.get(seat.seatId)?.date;
      return [seat.seatId, since && since > from ? since : from] as const;
    }),
  );
  const visits = await settled("the visits", failedReads, () =>
    seatIds.length ? loadVisitCounts(sinceBySeat, from) : Promise.resolve({ managers: new Map(), seats: new Map() }),
  );

  const rows: EmptySeatRow[] = seats.map((seat) => {
    const last = holders?.lastBySeat.get(seat.seatId);
    const list = listCounts ? (listCounts.get(seat.seatId) ?? { contacts: 0, pharmacies: 0 }) : null;
    return {
      areaName: seat.areaName,
      closing: closingForSeat({
        areaCode: seat.areaCode,
        lineCode: seat.lineCode,
        period: closing?.periodByLine.get(seat.lineCode) ?? null,
        rows: closing?.rows ?? null,
      }),
      closingKey: `${normalizeCode(seat.lineCode)}|${closingAreaCodesFor(seat.lineCode, seat.areaCode, closing?.periodByLine.get(seat.lineCode) ?? null).join("+")}`,
      contactCount: list?.contacts ?? null,
      emptySince: emptySinceBySeat.get(seat.seatId) ?? null,
      key: `${seat.seatId}|${seat.lineCode}|${seat.areaCode}`,
      lastRepName: last ? (holders?.names.get(last.key) ?? "A former rep not on the employee roster") : null,
      lineName: seat.lineName,
      managerVisits: visits ? (visits.managers.get(seat.seatId) ?? 0) : null,
      parked: isParkedSeat({ areaName: seat.areaName, lineName: seat.lineName }),
      pharmacyCount: list?.pharmacies ?? null,
      regionName: seat.regionName,
      seatId: seat.seatId,
      seatVisits: visits ? (visits.seats.get(seat.seatId) ?? 0) : null,
    };
  });

  const ranked = rankEmptySeats(rows.filter((row) => !row.parked));
  const parked = rankEmptySeats(rows.filter((row) => row.parked));
  const lineNameByCode = new Map(seats.map((seat) => [seat.lineCode, seat.lineName]));
  return {
    failedReads,
    linePeriods: lineCodes
      .map((line) => {
        const period = closing?.periodByLine.get(line) ?? null;
        return { lineName: lineNameByCode.get(line) ?? line, periodLabel: period ? periodLabel(period) : null };
      })
      .sort((a, b) => a.lineName.localeCompare(b.lineName)),
    parked,
    ranked,
    ...boardTotals(rows),
    scopeNote: bound.kind === "company" ? "Every line" : bound.kind === "line" ? "Your line" : "Your territory",
    today,
    visitWindowDays: EMPTY_SEAT_VISIT_WINDOW_DAYS,
  };
}
