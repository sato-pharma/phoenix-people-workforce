import { unstable_cache } from "next/cache";

import { CRM_DAILY_FORECAST_CACHE_TAG } from "@/lib/dashboard/invalidation";

import { countCallRateWorkingDays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { isIsoDay, monthEndOf, monthStartOf } from "@/lib/phoenix-crm/calendar";
import {
  accuracyReading,
  compareBoardRows,
  dailyShare,
  FORECAST_LINE_CODE,
  forecastShareOfDay,
  isForecastLine,
  monthAccuracy,
  parseForecastDraft,
  periodOfDay,
  unitsRatio,
  type AccuracyReading,
} from "@/lib/phoenix-crm/daily-forecast";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  readsTeamReports,
  readTestFlag,
  territoryForRead,
  territoryForRepWrite,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory } from "@/lib/phoenix-crm/server/territory";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { applyAchievementAreaMerges, foldAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import {
  loadMonthlyAchievement,
  loadMonthlyTargets,
  loadProductFamilyMap,
  loadProductNameMap,
  loadProductPriceMap,
  type MonthlyTargetRow,
} from "@/lib/sales/monthly-targets";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — the daily forecast's reads and its one save. The rules are in ../daily-forecast.ts.
 *
 * WHERE EVERY FIGURE COMES FROM — and none of them is computed here a second way:
 *   - the month's target: `au.monthly_targets`, through `loadMonthlyTargets` (the targets module is the
 *     only reader of that table the repo has, and this is not a place to grow a second);
 *   - last month's result: the MONTHLY CLOSING, through `loadMonthlyAchievement` — the closing engine
 *     every sales surface reads — and ONLY for a month whose CNS closing is PUBLISHED (the golden rule:
 *     a surface shows a month once the owner has published it, never on the strength of an upload);
 *   - the working days: the call rate's own calendar, Saturday to Wednesday less national holidays;
 *   - prices: the period's price map, which knows a product repriced mid-year.
 *
 * WHO SEES WHAT:
 *   - the FORM is the territory's own rep's (and the Super Admin's in test mode): his products, his
 *     daily share, his last published month, and what he sent today. No accuracy. No other rep.
 *   - the BOARD and the ACCURACY are the managers' (`readsTeamReports`: a manager seat, the CEO, the SFE
 *     Manager, the Super Admin), over the CNS territories in their own downward scope — never wider.
 */

type Row = Record<string, unknown>;

const NOT_CNS = "The daily forecast is for the CNS line only.";

// ── Shapes the screens read ───────────────────────────────────────────────────────────────────────

export type ForecastProductLine = {
  productCode: string;
  productName: string;
  /** The product family from the master (Tebofortin, Rispadex, …) — what the WhatsApp message groups by. */
  productFamily: string | null;
  /** The month's target for this territory, in boxes of THIS product. */
  monthTargetUnits: number | null;
  /** The pre-filled boxes: the month's target ÷ the month's working days. */
  suggestedUnits: number | null;
  /** Last PUBLISHED month on this product, units against units, as a ratio. */
  lastMonthRatio: number | null;
  /** What he sent today, or null when he has not sent. */
  sentUnits: number | null;
};

export type ForecastFormView = {
  seatId: string;
  territoryName: string;
  /** The visit day the forecast is for (Cairo, until 02:00 the next morning — the visit's own day). */
  day: string;
  period: string;
  workingDays: number;
  /** False when the national holiday calendar could not be read: the working days may count a holiday. */
  holidaysComplete: boolean;
  /** The month "last month" means — the newest published CNS closing — or null when none is published. */
  lastMonthPeriod: string | null;
  lines: ForecastProductLine[];
  /** When he first sent today's forecast; a second send replaces the boxes and keeps this time. */
  sentAt: string | null;
  isTest: boolean;
};

export type ForecastBoardRow = {
  seatId: string;
  name: string;
  repName: string | null;
  areaName: string | null;
  regionName: string | null;
  /**
   * No rep holds the territory, so nobody can send for it. Listed (a manager still sees the gap in his
   * map), but last, and never counted as "not sent": nine of the 35 CNS territories were vacant the
   * day this shipped, and counting them buried the reps who really had not sent.
   */
  vacant: boolean;
  sent: boolean;
  sentAt: string | null;
  /** The day's forecast against the day's share of target, by value (1 = exactly the share). */
  shareOfDay: number | null;
};

export type ForecastBoardRegion = {
  regionName: string;
  territories: number;
  sent: number;
  shareOfDay: number | null;
};

export type ForecastBoardView = {
  day: string;
  period: string;
  workingDays: number;
  rows: ForecastBoardRow[];
  regions: ForecastBoardRegion[];
  isTest: boolean;
};

export type ForecastAccuracyRow = {
  seatId: string;
  name: string;
  repName: string | null;
  areaName: string | null;
  regionName: string | null;
  daysSent: number;
  projectedValue: number;
  actualValue: number;
  delivered: number | null;
  reading: AccuracyReading | null;
};

export type ForecastAccuracyView = {
  period: string;
  /** Every published CNS month, newest first — the only months accuracy can be scored for. */
  publishedPeriods: string[];
  /** False when `period` is not published: no row is scored, and the screen says why. */
  published: boolean;
  workingDays: number;
  rows: ForecastAccuracyRow[];
  isTest: boolean;
};

// ── Reads shared by the three views ─────────────────────────────────────────────────────────────

async function workingDaysOf(period: string): Promise<{ workingDays: number; complete: boolean }> {
  const start = monthStartOf(`${period}-01`);
  const end = monthEndOf(start);
  const holidays = await loadCallRateHolidays(start, end);
  return { workingDays: countCallRateWorkingDays(start, end, holidays.dates), complete: holidays.complete };
}

/** The CNS targets of one month, by area, then product. */
async function cnsTargets(period: string): Promise<Map<string, Map<string, MonthlyTargetRow>>> {
  const rows = await loadMonthlyTargets(period);
  // The targets read is ONE PostgREST call, and PostgREST stops at 1,000 rows without saying so. A
  // month holds ~730 today; past the cap this refuses rather than pre-filling half the line with blanks.
  if (rows.length >= 1000) throw new Error(`au.monthly_targets returned ${rows.length} rows for ${period}, at PostgREST's cap.`);
  const byArea = new Map<string, Map<string, MonthlyTargetRow>>();
  for (const row of rows) {
    if (!isForecastLine(row.lineCode) || !row.areaCode || !row.productCode) continue;
    const area = row.areaCode.toUpperCase();
    const products = byArea.get(area) ?? new Map<string, MonthlyTargetRow>();
    products.set(row.productCode.toUpperCase(), row);
    byArea.set(area, products);
  }
  return byArea;
}

/**
 * One published month's CNS closing, by area and product: units and value. Cached ten minutes — a
 * published month changes only if the owner unpublishes it, and the engine read behind it is the
 * whole company's month, paged. A publish, an unpublish and a target save or drop expire it at once
 * (invalidateCrmDailyForecastCache); the TTL is only the backstop.
 */
const loadCnsClosing = unstable_cache(
  async (period: string): Promise<Array<{ areaCode: string; productCode: string; actualUnits: number; actualValue: number; targetUnits: number | null }>> => {
    const rows = applyAchievementAreaMerges(await loadMonthlyAchievement(period));
    return rows
      .filter((row) => isForecastLine(row.lineCode) && row.areaCode && row.productCode)
      .map((row) => ({
        areaCode: String(row.areaCode).toUpperCase(),
        productCode: row.productCode.toUpperCase(),
        actualUnits: row.actualUnits,
        actualValue: row.actualValue,
        targetUnits: row.targetUnits,
      }));
  },
  ["phoenix-crm-forecast-cns-closing"],
  { revalidate: 600, tags: ["sos-reference", CRM_DAILY_FORECAST_CACHE_TAG] },
);

async function publishedCnsPeriods(): Promise<string[]> {
  return listPublishedPeriodsForLine(FORECAST_LINE_CODE);
}

function seatAreaCode(seat: OrgSeat): string | null {
  const code = seat.areaCode?.trim();
  return code ? code.toUpperCase() : null;
}

function assertForecastSeat(seat: OrgSeat): void {
  if (!isForecastLine(seat.lineCode)) throw forbiddenError(NOT_CNS);
}

type SentLine = { productCode: string; units: number; createdAt: string };

async function sentLinesOn(seatIds: readonly string[], isTest: boolean, from: string, to: string): Promise<Map<string, Map<string, SentLine[]>>> {
  // seat -> day -> lines
  const bySeat = new Map<string, Map<string, SentLine[]>>();
  if (seatIds.length === 0) return bySeat;
  // Paged: a month of a whole line is ~26 territories × 22 days × 7 products, past PostgREST's cap.
  // KEYSET-paged on the primary key since 2026-10-16 (Phoenix CRM performance audit), the module's rule
  // for a read that grows with the field: an offset walk re-scans every page it skips and loses a row
  // when a forecast is sent mid-read, and the seat chunks now read side by side rather than in turn.
  // Each chunk's rows still come in id order, so every seat's lines are filed in the order they were.
  const parts = await mapWithConcurrency(chunk([...seatIds], 100), 4, (part) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_daily_forecasts")
          .select("id, seat_id, forecast_date, product_code, units, created_at")
          .in("seat_id", part)
          .eq("is_test", isTest)
          .gte("forecast_date", from)
          .lte("forecast_date", to),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const rows of parts) {
    for (const row of rows) {
      const seatId = textOrNull(row.seat_id);
      const day = textOrNull(row.forecast_date);
      const productCode = textOrNull(row.product_code);
      const units = numberOrNull(row.units);
      if (!seatId || !day || !productCode || units === null) continue;
      const days = bySeat.get(seatId) ?? new Map<string, SentLine[]>();
      const lines = days.get(day) ?? [];
      lines.push({ productCode: productCode.toUpperCase(), units, createdAt: textOrNull(row.created_at) ?? "" });
      days.set(day, lines);
      bySeat.set(seatId, days);
    }
  }
  return bySeat;
}

function firstSentAt(lines: readonly SentLine[]): string | null {
  const times = lines.map((line) => line.createdAt).filter(Boolean).sort();
  return times[0] ?? null;
}

// ── The rep's form ──────────────────────────────────────────────────────────────────────────────

/** The month's targets and working days, which a send has already read for the same month. */
type FormBasis = {
  targets: Map<string, Map<string, MonthlyTargetRow>>;
  days: { workingDays: number; complete: boolean };
};

async function buildForm(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, known?: FormBasis): Promise<ForecastFormView> {
  const day = viewer.visitDay;
  const period = periodOfDay(day);
  const area = seatAreaCode(seat);
  // Last month's closing needs only the published list, so it is read the moment that list is in,
  // inside the same wave, rather than after the slowest of the other reads (Phoenix CRM performance
  // audit, 2026-10-16). The month it reads and the rule behind it are unchanged: the newest PUBLISHED
  // CNS month before this one, or none.
  const lastMonthRead = publishedCnsPeriods().then(async (published) => {
    const lastMonthPeriod = published.find((entry) => entry < period) ?? null;
    return { lastMonthPeriod, closing: lastMonthPeriod ? await loadCnsClosing(lastMonthPeriod) : [] };
  });
  // A send has just read this month's targets and working days to check and price the boxes; the form
  // it hands back reuses them rather than reading the same month twice in one request.
  const [targets, days, names, families, { lastMonthPeriod, closing }, sent, people] = await Promise.all([
    known?.targets ?? cnsTargets(period),
    known?.days ?? workingDaysOf(period),
    loadProductNameMap(),
    loadProductFamilyMap(),
    lastMonthRead,
    sentLinesOn([seat.seatId], isTest, day, day),
    loadPeopleNames(seat.occupantHrId ? [seat.occupantHrId] : []),
  ]);
  const closingArea = area && lastMonthPeriod ? foldAreaCodeForLine(FORECAST_LINE_CODE, area, lastMonthPeriod) : null;
  const lastMonth = new Map<string, { actualUnits: number; targetUnits: number }>();
  for (const row of closing) {
    if (row.areaCode !== closingArea) continue;
    const entry = lastMonth.get(row.productCode) ?? { actualUnits: 0, targetUnits: 0 };
    entry.actualUnits += row.actualUnits;
    entry.targetUnits += row.targetUnits ?? 0;
    lastMonth.set(row.productCode, entry);
  }

  const sentToday = sent.get(seat.seatId)?.get(day) ?? [];
  const sentByProduct = new Map(sentToday.map((line) => [line.productCode, line.units]));
  const areaTargets = area ? targets.get(area) : undefined;
  const lines: ForecastProductLine[] = [...(areaTargets?.values() ?? [])]
    .map((target) => {
      const code = target.productCode.toUpperCase();
      const past = lastMonth.get(code);
      return {
        productCode: code,
        productName: names.get(code) ?? code,
        productFamily: families.get(code) ?? null,
        monthTargetUnits: target.targetUnits,
        suggestedUnits: dailyShare(target.targetUnits, days.workingDays),
        lastMonthRatio: past ? unitsRatio(past.actualUnits, past.targetUnits) : null,
        sentUnits: sentByProduct.has(code) ? (sentByProduct.get(code) ?? null) : null,
      };
    })
    // The biggest daily share first: the products that carry the month lead the form.
    .sort((left, right) => (right.suggestedUnits ?? -1) - (left.suggestedUnits ?? -1) || left.productName.localeCompare(right.productName));

  return {
    seatId: seat.seatId,
    territoryName: describeTerritory(viewer.org, seat, people).name,
    day,
    period,
    workingDays: days.workingDays,
    holidaysComplete: days.complete,
    lastMonthPeriod,
    lines,
    sentAt: firstSentAt(sentToday),
    isTest,
  };
}

/** Today's form for one territory: its rep's own, or the Super Admin's in test mode. */
export async function loadForecastForm(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown }): Promise<ForecastFormView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  assertForecastSeat(seat);
  // A MANAGER reads the board, not a rep's form: the form is where a rep sees his own last month, and
  // the board is where a manager sees his people. Only the territory's own rep (or the Super Admin
  // trying it in test mode) opens this one.
  const own = viewer.ownTerritories.some((entry) => entry.seatId === seat.seatId);
  if (!own && !(viewer.isSuperAdmin && isTest)) throw forbiddenError("The daily forecast form is the territory's own rep's.");
  return buildForm(viewer, seat, isTest);
}

/**
 * Send (or re-send) today's forecast. The day is the server's visit day, never the body's; the
 * suggested boxes are recomputed here, never taken from the screen; and a second send the same day
 * replaces the boxes while keeping the first send's time.
 */
export async function saveForecast(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; lines?: unknown },
): Promise<ForecastFormView> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));
  assertForecastSeat(seat);
  const period = periodOfDay(viewer.visitDay);
  const area = seatAreaCode(seat);
  const [targets, days] = await Promise.all([cnsTargets(period), workingDaysOf(period)]);
  const areaTargets = area ? targets.get(area) : undefined;
  if (!areaTargets || areaTargets.size === 0) {
    throw validationError("This month's targets are not loaded for your territory yet, so there is nothing to forecast against.");
  }
  const parsed = parseForecastDraft(raw, new Set(areaTargets.keys()));
  if (!parsed.ok) throw validationError(parsed.error);

  await callPhoenixCrm("phoenix_crm_save_daily_forecast", {
    p: {
      actor_hr_id: viewer.hrId,
      area_code: area,
      forecast_date: viewer.visitDay,
      is_test: isTest,
      line_code: seat.lineCode,
      lines: parsed.value.map((line) => ({
        product_code: line.productCode,
        suggested_units: dailyShare(areaTargets.get(line.productCode)?.targetUnits ?? null, days.workingDays),
        units: line.units,
      })),
      rep_hr_id: seat.occupantHrId,
      seat_id: seat.seatId,
    },
  });
  // His district manager hears that it is in — in-app, once a day (owner, 2026-10-01). Never throws,
  // so an alert that cannot be delivered never undoes the forecast he just saved.
  await notifyPhoenixCrm(
    { kind: "forecast_sent", org: viewer.org, seat, day: viewer.visitDay, repHrId: seat.occupantHrId ?? viewer.hrId },
    isTest,
  );
  return buildForm(viewer, seat, isTest, { targets, days });
}

// ── The managers' board ─────────────────────────────────────────────────────────────────────────

function assertBoardReader(viewer: PhoenixCrmViewer): void {
  if (!readsTeamReports(viewer)) throw forbiddenError("The forecast board is for the managers of the CNS territories.");
}

function cnsSeatsInScope(viewer: PhoenixCrmViewer, isTest: boolean): OrgSeat[] {
  return testReadSeats(viewer, isTest, viewer.scopeTerritories).filter((seat) => isForecastLine(seat.lineCode));
}

/** One day across every CNS territory beneath the viewer: who sent, when, and how it sits against the day's share. */
export async function loadForecastBoard(viewer: PhoenixCrmViewer, raw: { day?: unknown; test: unknown }): Promise<ForecastBoardView> {
  assertBoardReader(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const day = isIsoDay(raw.day) && raw.day <= viewer.visitDay ? raw.day : viewer.visitDay;
  const period = periodOfDay(day);
  const seats = cnsSeatsInScope(viewer, isTest);
  const [targets, days, prices, sent, names] = await Promise.all([
    cnsTargets(period),
    workingDaysOf(period),
    loadProductPriceMap(period),
    sentLinesOn(
      seats.map((seat) => seat.seatId),
      isTest,
      day,
      day,
    ),
    loadPeopleNames(seats.flatMap((seat) => (seat.occupantHrId ? [seat.occupantHrId] : []))),
  ]);

  const rows: ForecastBoardRow[] = seats.map((seat) => {
    const lines = sent.get(seat.seatId)?.get(day) ?? [];
    const area = seatAreaCode(seat);
    const areaTargets = area ? targets.get(area) : undefined;
    const dayTargetValue =
      areaTargets && days.workingDays > 0
        ? [...areaTargets.values()].reduce((sum, target) => sum + (target.targetValue ?? 0), 0) / days.workingDays
        : null;
    const summary = describeTerritory(viewer.org, seat, names);
    return {
      seatId: seat.seatId,
      name: summary.name,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      areaName: seat.areaName,
      regionName: seat.regionName,
      vacant: !seat.occupantHrId,
      sent: lines.length > 0,
      sentAt: firstSentAt(lines),
      shareOfDay:
        lines.length > 0
          ? forecastShareOfDay(
              lines.map((line) => ({ units: line.units, price: prices.get(line.productCode) ?? null })),
              dayTargetValue,
            )
          : null,
    };
  });
  rows.sort(compareBoardRows);

  // A region's share is its territories' forecast VALUE over their day's target VALUE — the parts are
  // summed, never the percentages averaged.
  const regions = new Map<string, { territories: number; sent: number; forecastValue: number; targetValue: number }>();
  for (const seat of seats) {
    const regionName = seat.regionName ?? "No region";
    const entry = regions.get(regionName) ?? { territories: 0, sent: 0, forecastValue: 0, targetValue: 0 };
    // "3 of 5 sent" counts the territories someone CAN send for — a vacant one is nobody's to send.
    if (seat.occupantHrId) entry.territories += 1;
    const lines = sent.get(seat.seatId)?.get(day) ?? [];
    const area = seatAreaCode(seat);
    const areaTargets = area ? targets.get(area) : undefined;
    if (lines.length > 0) {
      entry.sent += 1;
      for (const line of lines) entry.forecastValue += line.units * (prices.get(line.productCode) ?? 0);
      if (areaTargets && days.workingDays > 0) {
        entry.targetValue += [...areaTargets.values()].reduce((sum, target) => sum + (target.targetValue ?? 0), 0) / days.workingDays;
      }
    }
    regions.set(regionName, entry);
  }

  return {
    day,
    period,
    workingDays: days.workingDays,
    rows,
    regions: [...regions.entries()]
      .map(([regionName, entry]) => ({
        regionName,
        territories: entry.territories,
        sent: entry.sent,
        shareOfDay: entry.targetValue > 0 ? entry.forecastValue / entry.targetValue : null,
      }))
      .sort((left, right) => left.regionName.localeCompare(right.regionName)),
    isTest,
  };
}

/**
 * A closed month: what each territory forecast (its average day, carried across the month) against
 * what the PUBLISHED closing credits it with. Scored only for a published month.
 */
/** One month's reads for the accuracy view, all but the closing itself. */
function accuracyMonthReads(period: string, seats: readonly OrgSeat[], isTest: boolean) {
  const start = monthStartOf(`${period}-01`);
  return Promise.all([
    workingDaysOf(period),
    loadProductPriceMap(period),
    sentLinesOn(
      seats.map((seat) => seat.seatId),
      isTest,
      start,
      monthEndOf(start),
    ),
    loadPeopleNames(seats.flatMap((seat) => (seat.occupantHrId ? [seat.occupantHrId] : []))),
  ]);
}

export async function loadForecastAccuracy(viewer: PhoenixCrmViewer, raw: { period?: unknown; test: unknown }): Promise<ForecastAccuracyView> {
  assertBoardReader(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const requested = typeof raw.period === "string" && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : null;
  const seats = cnsSeatsInScope(viewer, isTest);
  // A month asked for by name is one the screen offered from the published list, so its forecasts,
  // prices, working days and names start reading BESIDE that list rather than after it (Phoenix CRM
  // performance audit, 2026-10-16). Nothing is scored or shown until the month is confirmed published
  // below, and the closing — the expensive read, and the one the golden rule governs — still waits for
  // that confirmation. The `.catch` only stops an early return from leaving a rejection unhandled; the
  // await further down still throws it.
  const early = requested ? accuracyMonthReads(requested, seats, isTest) : null;
  if (early) early.catch(() => undefined);
  const publishedPeriods = await publishedCnsPeriods();
  const period = requested ?? publishedPeriods[0] ?? periodOfDay(viewer.cairoToday);
  const published = publishedPeriods.includes(period);
  if (!published) {
    return { period, publishedPeriods, published, workingDays: 0, rows: [], isTest };
  }

  const [[days, prices, sent, names], closing] = await Promise.all([
    early ?? accuracyMonthReads(period, seats, isTest),
    loadCnsClosing(period),
  ]);

  const rows: ForecastAccuracyRow[] = seats.map((seat) => {
    const byDay = sent.get(seat.seatId) ?? new Map<string, SentLine[]>();
    const forecastUnits = new Map<string, number>();
    for (const lines of byDay.values()) {
      for (const line of lines) forecastUnits.set(line.productCode, (forecastUnits.get(line.productCode) ?? 0) + line.units);
    }
    const area = seatAreaCode(seat);
    const closingArea = area ? foldAreaCodeForLine(FORECAST_LINE_CODE, area, period) : null;
    // The actual is valued on the SAME products he forecast: a product he never put in a forecast is
    // not part of what his forecast promised.
    const actualValue = closing
      .filter((row) => row.areaCode === closingArea && forecastUnits.has(row.productCode))
      .reduce((sum, row) => sum + row.actualValue, 0);
    const scored = monthAccuracy({ daysSent: byDay.size, workingDays: days.workingDays, forecastUnits, prices, actualValue });
    const summary = describeTerritory(viewer.org, seat, names);
    return {
      seatId: seat.seatId,
      name: summary.name,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      areaName: seat.areaName,
      regionName: seat.regionName,
      daysSent: byDay.size,
      projectedValue: scored.projectedValue,
      actualValue: scored.actualValue,
      delivered: scored.delivered,
      reading: accuracyReading(scored.delivered),
    };
  });
  // Scored rows first, furthest from the mark first; the territories that sent nothing after them.
  rows.sort((left, right) => {
    if ((left.delivered === null) !== (right.delivered === null)) return left.delivered === null ? 1 : -1;
    const gap = (value: number | null) => (value === null ? 0 : Math.abs(1 - value));
    return gap(right.delivered) - gap(left.delivered) || left.name.localeCompare(right.name);
  });

  return { period, publishedPeriods, published, workingDays: days.workingDays, rows, isTest };
}
