import "server-only";

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getKpisBoard, type KpiRepRow } from "@/lib/crm/kpis-board";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { personKey, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadAreaBrickMaster, upperCode } from "@/lib/sales/closing-brick-sales";
import type { PharmacyCountRow } from "@/lib/sales/closing-pharmacy-counts";
import { loadRankingSeats } from "@/lib/sales/closing-rep-ranking";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { listMonthlyClosingLines } from "@/lib/sales/monthly-distributor-import";
import { listPublishedPeriodsForLine } from "@/lib/sales/monthly-closing-publication";
import { lineName, loadMonthlyAchievement, loadProductNameMap, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import {
  buildRepEffectiveness,
  kpiFiguresOf,
  monthsBetween,
  resolveReviewPeriod,
  REVIEW_MAX_KPI_MONTHS,
  summariseClosingMonth,
  type EffKpiMonth,
  type EffMonth,
  type EffPeriod,
  type EffRep,
  type EffUniverse,
  type RepEffectivenessReport,
} from "@/lib/sales/rep-effectiveness/model";
import { seatLineKey } from "@/lib/sales/sos-pharmacy-actions-workbook";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The rep effectiveness review's reads (owner, 25 Nov 2026). One rep: the area she holds, every month its
 * line has PUBLISHED (the last twelve), and the KPIs board for her last three months.
 *
 * 🔴 THE SUPER ADMIN'S ALONE, like the rep visits export beside it — it is HR evidence on one named person.
 * Asked on the page, on the route and here, before any read.
 *
 * 🔴 EVERY SALES FIGURE IS THE CLOSING ENGINE'S, PUBLISHED MONTHS ONLY: sales and targets from
 * `loadMonthlyAchievement` (the closing's own achievement), customers and sources from the closing's own
 * invoice rows (`loadMonthlyClosingDetails`, which applies the El Qema mask for this viewer).
 */

const CONCURRENCY = 2;

export function canExportRepEffectiveness(access: Pick<AccessContext, "role">): boolean {
  return access.role === "Super Admin";
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => {
  const out = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return out ? out : null;
};
const nameKey = (value: string | null | undefined) => tidyAllCapitalsName(String(value ?? "")).toLowerCase().replace(/\s+/g, " ").trim();

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) out.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  return out;
}

/** The closing's own line name for a seat's line ("Pedia", "CNS", "Anti Infective"). */
async function closingLineOf(seat: OrgSeat): Promise<string | null> {
  const wanted = seatLineKey(seat.lineName ?? lineName(seat.lineCode ?? null));
  const code = seatLineKey(seat.lineCode ?? "");
  const lines = await listMonthlyClosingLines();
  return lines.find((line) => seatLineKey(line) === wanted || seatLineKey(line) === code) ?? null;
}

async function loadUniverse(areaCode: string): Promise<EffUniverse> {
  try {
    const bricks = (await loadAreaBrickMaster([areaCode], [])).filter((brick) => brick.areaCode === areaCode && brick.current);
    if (bricks.length === 0) return { total: null, byBrick: {} };
    const nameOf = new Map(bricks.map((brick) => [brick.brickId, brick.brickName || brick.brickId]));
    const supabase = getSupabaseAdmin();
    const read = await readEveryPage<Row>(
      (() =>
        supabase
          .from("source_of_sales_customer_map")
          .select("id, distributor_code, customer_code, brick_id")
          .in("brick_id", [...nameOf.keys()])
          .eq("active", true)
          .order("id")) as never,
      { maxRows: 50_000, whenFull: "refuse", what: "the customer map", uniqueBy: (row) => String(row.id) },
    );
    if (read.error) return { total: null, byBrick: {} };
    const seen = new Map<string, Set<string>>();
    for (const row of read.rows) {
      const brick = nameOf.get(String(row.brick_id ?? ""));
      const code = text(row.customer_code);
      if (!brick || !code) continue;
      const set = seen.get(brick) ?? new Set<string>();
      set.add(`${upperCode(text(row.distributor_code))}|${code.toUpperCase()}`);
      seen.set(brick, set);
    }
    const byBrick = Object.fromEntries([...seen.entries()].map(([brick, set]) => [brick, set.size]));
    const all = new Set<string>();
    for (const set of seen.values()) for (const key of set) all.add(key);
    return { total: all.size, byBrick };
  } catch {
    return { total: null, byBrick: {} };
  }
}

/** KPI months: the period's months, never before the hire month, never after this month — the latest six. */
export function kpiMonthsFor(period: EffPeriod, hireDate: string | null, today: string): string[] {
  const current = today.slice(0, 7);
  const hireMonth = hireDate?.slice(0, 7) ?? null;
  const start = hireMonth && hireMonth > period.from ? hireMonth : period.from;
  const end = period.to < current ? period.to : current;
  return monthsBetween(start, end).slice(-REVIEW_MAX_KPI_MONTHS);
}

async function loadKpis(access: AccessContext, rep: EffRep, period: EffPeriod, today: string): Promise<EffKpiMonth[]> {
  const current = today.slice(0, 7);
  const months = kpiMonthsFor(period, rep.hireDate, today);
  const wanted = canonicalHrIdKey(rep.hrId);
  const out: EffKpiMonth[] = [];
  // ONE MONTH AT A TIME: a company-wide board holds a whole month of visits and plans in memory.
  for (const month of months) {
    try {
      const board = await getKpisBoard({ access, includeReports: false, month, todayIso: today });
      const own = board.reps.find((row) => canonicalHrIdKey(row.agentHrId) === wanted) ?? null;
      const manager = nameKey(own?.managerName ?? rep.managerName);
      const colleagues = manager
        ? board.reps
            .filter((row: KpiRepRow) => row !== own && nameKey(row.managerName) === manager)
            .map((row) => ({ name: tidyAllCapitalsName(row.repName), area: row.areaName ?? null, figures: kpiFiguresOf(row) }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
      out.push({ month, toDate: month === current, unread: false, rep: own ? kpiFiguresOf(own) : null, colleagues });
    } catch {
      out.push({ month, toDate: month === current, unread: true, rep: null, colleagues: [] });
    }
  }
  return out;
}

export async function loadRepEffectiveness(
  access: AccessContext,
  raw: { hrId?: unknown; from?: unknown; to?: unknown },
): Promise<RepEffectivenessReport> {
  if (!canExportRepEffectiveness(access)) throw forbiddenError("The effectiveness review is for the Super Admin.");
  const hrId = personKey(text(raw.hrId));
  if (!hrId) throw validationError("Choose a rep.");
  const today = cairoTodayIso();
  const period = resolveReviewPeriod(raw, today);
  if ("error" in period) throw validationError(period.error);
  const supabase = getSupabaseAdmin();

  const [{ data: employee, error: employeeError }, org] = await Promise.all([
    supabase.from("employees").select("hr_id, full_name, job_title, hire_date").in("hr_id", hrIdLookupKeys(hrId)).limit(1).maybeSingle(),
    loadPhoenixCrmOrg(),
  ]);
  throwIfError(employeeError);
  if (!employee) throw validationError("No employee has this HR id.");
  const seat = (org.seatsByOccupant.get(hrId) ?? []).find((s) => s.tier === TERRITORY_TIER) ?? null;
  const areaCode = upperCode(seat?.areaCode ?? null);
  if (!seat || !areaCode) throw validationError("This person holds no rep territory, so there is no area to review.");
  const line = await closingLineOf(seat);
  if (!line) throw validationError("This rep's line has no monthly closing.");

  // The published months inside the chosen period; a month not published is absent, never a zero.
  const months = (await listPublishedPeriodsForLine(line)).filter((m) => /^\d{4}-\d{2}$/.test(m) && m >= period.from && m <= period.to).sort();
  const lineCode = resolveTargetLineCode(line);
  const [productNames, universe] = await Promise.all([loadProductNameMap().catch(() => new Map<string, string>()), loadUniverse(areaCode)]);
  const repName = text(employee.full_name) ?? hrId;
  const seatKey = `${seatLineKey(line)}::${areaCode}`;

  const loaded = await inBatches(months, CONCURRENCY, async (month): Promise<EffMonth & { managerName: string | null }> => {
    const [details, achievement, seats] = await Promise.all([
      loadMonthlyClosingDetails({ access, line, period: month, availableLines: [line], availablePeriods: [month], unpaged: true }),
      loadMonthlyAchievement(month),
      loadRankingSeats(month).catch(() => new Map()),
    ]);
    const rows = details.outOfScope || details.line !== line ? [] : (details.rows as unknown as PharmacyCountRow[]);
    const { sources, buyers } = summariseClosingMonth(rows, areaCode);
    const products = achievement
      .filter((row) => row.lineCode === lineCode && upperCode(row.areaCode) === areaCode && !row.isOther)
      .map((row) => ({
        code: row.productCode.toUpperCase(),
        name: productNames.get(row.productCode.toUpperCase()) ?? row.productCode,
        actualUnits: row.actualUnits,
        actualValue: row.actualValue,
        targetUnits: row.targetUnits,
        targetValue: row.targetValue,
      }));
    const seatNow = seats.get(seatKey) as { repName: string | null; repIsVacant: boolean; managerName: string | null } | undefined;
    const holder = seatNow?.repName ? tidyAllCapitalsName(seatNow.repName) : seatNow?.repIsVacant ? "Vacant seat" : null;
    return { month, holder, isRepMonth: false, products, sources, buyers, managerName: seatNow?.managerName ?? null };
  });

  // Her months. 🔴 THE SEAT MODEL KNOWS ONLY TODAY'S HOLDER: asked for July it names her, hired in
  // September (measured 25 Nov 2026, `rep_hr_id` on every month of the area). So the hire month decides,
  // and a month before it never carries her name. With no hire date, the seat holder's name decides.
  const mine = nameKey(repName);
  const hireMonth = text(employee.hire_date)?.slice(0, 7) ?? null;
  const shortName = tidyAllCapitalsName(repName).split(" ").slice(0, 2).join(" ");
  for (const m of loaded) {
    if (hireMonth) {
      m.isRepMonth = m.month >= hireMonth;
      if (!m.isRepMonth) m.holder = `Before ${shortName} joined`;
    } else {
      const holder = nameKey(m.holder);
      m.isRepMonth = Boolean(holder) && (holder === mine || mine.startsWith(`${holder} `));
    }
  }

  const rep: EffRep = {
    hrId,
    name: tidyAllCapitalsName(repName),
    jobTitle: text(employee.job_title) ?? "Medical Representative",
    line,
    areaCode,
    areaName: seat.areaName ?? areaCode,
    regionName: seat.regionName ?? null,
    managerName: [...loaded].reverse().find((m) => m.managerName)?.managerName ?? null,
    hireDate: text(employee.hire_date)?.slice(0, 10) ?? null,
  };
  const kpis = await loadKpis(access, rep, period, today);
  return buildRepEffectiveness({
    rep,
    generatedAt: new Date().toISOString(),
    period,
    months: loaded.map((m) => ({ month: m.month, holder: m.holder, isRepMonth: m.isRepMonth, products: m.products, sources: m.sources, buyers: m.buyers })),
    kpis,
    universe,
  });
}
