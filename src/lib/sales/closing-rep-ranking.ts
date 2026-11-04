import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import {
  type AreaSeatAssignment,
  loadAreaSeatAssignments,
  periodEndDate,
} from "@/lib/sales/closing-performance-review";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import { isOfficeDistributorCode, lineHasOfficeChannel } from "@/lib/sales/office-distributor";
import { isStoreCustomerForPeriod } from "@/lib/sales/customer-channel";
import { isBulkAllocatedRow } from "@/lib/sales/bulk-allocation-channel";
import type { ClosingDetailRow } from "@/lib/sales/monthly-closing-details";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// THE REP RANKING — the figures behind the employee-portal ranking workbook.
//
// WHERE EVERY NUMBER COMES FROM. Nothing in this file computes a sales or a target figure. Each one
// is lifted out of a `MonthlyClosingMatrix` that the portal loader already produced for one
// (line, month) — the PUBLISHED closing, scoped to the viewer — because the Monthly Closing module is
// the one source of truth for every sales AND every target figure system-wide (AGENTS.md §4). A
// surface that re-derives either half from its own query is the bug, never a variant.
//
// WHAT THIS FILE DOES ADD is arrangement, and only arrangement:
//   · it ranks the seats by achievement, leaving an untargeted seat UNRANKED rather than scoring 0%;
//   · it groups those seats into TEAMS — a district's reps together, then their manager (the owner's
//     own arrangement, 2026-10-13: "reps first then their district manager then another rep team
//     then district manager as today['s] arrangement in [the] closing matrix");
//   · it carves the distributor book into the warehouse ("stores") channel and the rest, using the
//     repo's OWN warehouse rule rather than a copy of it — see storesByArea below;
//   · it marks a rep still on probation.
//
// SCOPE IS NOT DECIDED HERE EITHER. The matrices arrive already narrowed to the viewer by
// loadPortalMonthlyClosing, so "everyone sees his scope only" is enforced by the same chain that
// scopes their screen. A Medical Rep's matrix holds his own area alone, so his ranking is his own
// row — the owner's decision on 2026-10-13, taken to keep the locked own-area-never-region rule.
// ─────────────────────────────────────────────────────────────────────────────

/** A seat's customer channels for one month. `distributor` already EXCLUDES the warehouses. */
export type RepRankingChannels = {
  /**
   * The published distributor book less its warehouse rows AND less Office, so the channels add to
   * `sales` on every line.
   */
  distributor: number;
  stores: number;
  direct: number;
  /**
   * The company's own stock, spread across the areas by the locked value-share rule.
   *
   * 🔴 ZERO ON EVERY LINE BUT CNS, and that is the repo's own rule rather than this module's:
   * `lineHasOfficeChannel` is the one list (office-distributor.ts, the owner's 2026-08-25 ruling),
   * and the upload refuses a non-CNS Office product through the same list. Office is NOT a
   * distributor, so it is carved out of the book exactly as the warehouses are — leaving it inside
   * would have the channel shares sum past 100% on the line where it is the biggest channel of all
   * (CNS September 2026: 6,971,180 EGP of 11,885,445, read from production 2026-10-13).
   */
  office: number;
};

export type RepRankingProduct = {
  productCode: string;
  productName: string;
  family: string;
  /** Null for a month the closing never published for this cell — absence is never a zero. */
  months: Array<number | null>;
  monthUnits: Array<number | null>;
  /**
   * Each trend month's own target for this cell, oldest first. The units tab adds target units
   * ACROSS the quarter for one product code, so every month's own figure has to be here: reusing
   * the closing month's three times would treat a quarter as three identical months.
   */
  monthTargetValues: Array<number | null>;
  monthTargetUnits: Array<number | null>;
  salesValue: number;
  salesUnits: number;
  targetValue: number | null;
  targetUnits: number | null;
  achievement: number | null;
};

export type RepRankingSeat = {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  repName: string;
  managerName: string;
  /** True when a rep seat exists for this area and nobody occupies it. Ranked, never hidden. */
  vacant: boolean;
  /** The rep's probation end date when it is still in the future, else null. */
  probationEndsOn: string | null;
  channels: RepRankingChannels;
  salesValue: number;
  targetValue: number | null;
  /** Null when the seat carries no target — unranked, never scored zero. */
  achievement: number | null;
  /** 1-based, and only for a seat that carries a target. */
  rank: number | null;
  /** Oldest first, one entry per trend month. Null = that month was never published for this seat. */
  months: Array<number | null>;
  /**
   * The target in force for each trend month, oldest first. Null = that month gave this seat no
   * target. 🔴 KEPT PER MONTH ON PURPOSE: the Trust sheet prints each month's own sales beside its
   * own target, and reusing the closing month's target for July and August would state a figure
   * nobody set — a partial-window target that flatters or damns an achievement is the defect the
   * closing's source-of-truth rule exists to stop.
   */
  monthTargets: Array<number | null>;
  products: RepRankingProduct[];
};

export type RepRankingTeam = {
  managerName: string;
  /** The seats reporting to this manager, in the ranking's own order. */
  seats: RepRankingSeat[];
  regionNames: string[];
  salesValue: number;
  targetValue: number | null;
  achievement: number | null;
  months: Array<number | null>;
  channels: RepRankingChannels;
};

export type RepRanking = {
  line: string;
  period: string;
  /** Oldest first — the published months this workbook trends over, ending at `period`. */
  trend: string[];
  seats: RepRankingSeat[];
  /**
   * Districts ordered by their OWN achievement, "Not assigned" last. A manager appears once and
   * carries his whole district: never once under every rep.
   */
  teams: RepRankingTeam[];
  /** The areas that sold in a trend month but hold no seat in the closing month. */
  seatlessAreas: RepRankingSeat[];
  products: Array<{ productCode: string; productName: string; family: string }>;
  totals: {
    salesValue: number;
    targetValue: number | null;
    achievement: number | null;
    channels: RepRankingChannels;
    seatCount: number;
    rankedCount: number;
    vacantCount: number;
    probationCount: number;
    /** How many distinct warehouse customers the store channel was carved from. */
    warehouseCustomers: number;
  };
};

/** The label a district with no manager seat carries. Never blank, and always sorted last. */
export const UNASSIGNED_TEAM = "Not assigned";

const lineKey = (value: string | null | undefined): string =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const near = (value: number): number => Math.round(value * 100) / 100;

/**
 * Carve one month's already-scoped detail rows into the two channels the closing's area total hides:
 * the warehouse ("stores") money inside the distributor book, and the direct money booked to an area.
 *
 * 🔴 THE WAREHOUSE RULE IS IMPORTED, NEVER COPIED. `customer-channel.ts` declares itself the single
 * edit point for who counts as a warehouse, and its own history records that a hand-transcribed copy
 * of the store keywords mis-stated the channel by 8.7M EGP. It is called here for exactly that
 * reason, and PER PERIOD, because the owner's warehouse ruling starts at a different month on each
 * line — a closing is the record of a month, so each month is classified with the rule in force
 * for it.
 *
 * 🔴 AND THE VALUE IS THE ROW'S OWN `salesValue`, NEVER A PRICE MULTIPLIED HERE. That field is the
 * row's contribution to the closing's sales value, including the one documented month the engine
 * takes as stored instead of re-pricing (resolveClosingDetailSalesValue). Re-deriving it as
 * units × factory price reproduces the engine for most months and silently disagrees for that one,
 * and a carve that disagrees with the published cell is the defect this whole file exists to avoid.
 *
 * Stores are not a fourth channel — a warehouse is a KIND OF CUSTOMER inside the distributor book
 * (the owner's point: "consider stores as [a] channel and show it side to side"). So the caller
 * subtracts this from the distributor figure instead of adding a bucket, and the three columns still
 * add to the closing's own Sales.
 */
export function carveChannelsByArea(
  rows: readonly ClosingDetailRow[],
  line: string,
): ClosingRepRankingCarve {
  const stores = new Map<string, number>();
  const direct = new Map<string, number>();
  const office = new Map<string, number>();
  const warehouseCustomers = new Set<string>();
  // 🔴 ASKED ONCE, OF THE REPO'S OWN LIST. A line without the Office channel leaves this map empty
  // and every seat's office stays 0 — never a second list of lines living here.
  const carvesOffice = lineHasOfficeChannel(line);
  for (const row of rows) {
    const area = String(row.areaCode ?? "").trim().toUpperCase();
    // A direct row booked before the Direct Orders module stamped geography carries NO area. It
    // keeps the anonymous company row it has always had, so it is skipped here rather than spread:
    // spreading it would be inventing geography.
    if (!area) continue;
    const product = String(row.productCode ?? "").trim().toUpperCase();
    const key = `${row.invoicePeriod}|${area}|${product}`;
    const value = Number(row.salesValue) || 0;
    if (row.isDirect) {
      direct.set(key, (direct.get(key) ?? 0) + value);
      continue;
    }
    if (!row.includedInClosing) continue;
    // 🔴 OFFICE BEFORE THE WAREHOUSE TEST, and the two cannot overlap anyway: an Office row carries
    // no customer by construction (`clientCode` null), so the store rule answers false for it. The
    // order is kept explicit so a later change to either rule cannot start counting one row twice.
    if (carvesOffice && isOfficeDistributorCode(row.distributorCode)) {
      office.set(key, (office.get(key) ?? 0) + value);
      continue;
    }
    // 🔴 AN EPDA ROW THE CLOSING SPREAD IS NOT A STORE AT ITS INVOICED AREA. The matrix has already
    // moved its units and value onto the areas that earned them (bulk-allocation-channel.ts, rule 2
    // from October 2026), so carving it here as Stores at the area the invoice names would leave that
    // area's Distributor column short by the whole book, below zero, and every receiving area's over.
    // Left out of Stores, it reads as distributor book wherever the spread landed it.
    if (isBulkAllocatedRow(row, row.invoicePeriod)) continue;
    if (!isStoreCustomerForPeriod(row.clientName, row.clientCode, row.distributorCode, row.invoicePeriod, line)) {
      continue;
    }
    stores.set(key, (stores.get(key) ?? 0) + value);
    warehouseCustomers.add(`${row.distributorCode}|${row.clientCode}|${row.clientName}`);
  }
  return { direct, office, stores, warehouseCustomers };
}

/**
 * The store and direct carve, keyed `period|AREA|PRODUCT` — the closing's own publishing grain, so a
 * carved figure can be checked against the published cell it came out of rather than only against
 * an area total.
 */
export type ClosingRepRankingCarve = {
  stores: Map<string, number>;
  direct: Map<string, number>;
  /** The company's own stock. Empty on every line but CNS — see RepRankingChannels.office. */
  office: Map<string, number>;
  warehouseCustomers: Set<string>;
};

/** Sum a `period|AREA|PRODUCT` carve up to `period|AREA`. */
export function carveByArea(carve: ReadonlyMap<string, number>): Map<string, number> {
  const byArea = new Map<string, number>();
  for (const [key, value] of carve) {
    const [period, area] = key.split("|");
    const areaKey = `${period}|${area}`;
    byArea.set(areaKey, (byArea.get(areaKey) ?? 0) + value);
  }
  return byArea;
}

/**
 * Rep display name → probation end date, for the names that are UNIQUE in the directory.
 *
 * Keyed on the name because the seat loader hands back names and not HR ids, and threading ids
 * through its dated as-of pass would mean changing a function three other surfaces depend on. A name
 * held by two employees is therefore left OUT: the marker is a courtesy on the sheet, and no marker
 * is honest where a wrong one would libel whichever of the two is not on probation.
 *
 * A date in the PAST is not probation — that is the only reading which does not mark a rep who
 * finished probation months ago.
 */
async function probationByUniqueName(asOf: string): Promise<Map<string, string>> {
  try {
    const rows = await getEmployeeDirectoryRows({ includeInactive: true });
    const seen = new Map<string, number>();
    const dates = new Map<string, string>();
    for (const employee of rows) {
      const name = (employee.displayName || employee.fullName || "").trim();
      if (!name) continue;
      seen.set(name, (seen.get(name) ?? 0) + 1);
      const ends = (employee.probationEndDate ?? "").trim();
      if (ends && ends >= asOf) dates.set(name, ends);
    }
    for (const [name, count] of seen) if (count > 1) dates.delete(name);
    return dates;
  } catch (error) {
    // A directory outage must cost the workbook its probation markers and nothing else.
    logError("Rep ranking probation read failed; the workbook ships without the markers", {
      error,
      labels: { event: "closing_rep_ranking_probation_failed" },
    });
    return new Map();
  }
}

const cellValue = (cell: MonthlyClosingCell | undefined): number => Number(cell?.salesValue ?? 0);

/** Every area row of a matrix, with the synthetic Direct pseudo-area dropped. */
function areaRowsOf(matrix: MonthlyClosingMatrix) {
  return matrix.regions.flatMap((region) =>
    region.areas.filter((area) => !isSyntheticDirectArea(area)).map((area) => ({ area, region })),
  );
}

/**
 * Build the ranking from matrices the caller has already scoped and published-gated.
 *
 * `matricesByPeriod` is oldest-first; its LAST entry is the closing month being exported. Every
 * figure comes out of these matrices, so this function is pure arithmetic over the published
 * closing and can be exercised without a database.
 */
export function buildRepRanking(input: {
  line: string;
  period: string;
  /** Oldest first, ending at `period`. A month absent here is a month never published. */
  matricesByPeriod: ReadonlyArray<{ period: string; matrix: MonthlyClosingMatrix }>;
  seats: ReadonlyMap<string, AreaSeatAssignment>;
  /** Warehouse money, keyed `period|AREA` — see carveByArea. */
  storesByArea: ReadonlyMap<string, number>;
  /** Direct money, keyed `period|AREA` — see carveByArea. */
  directByArea: ReadonlyMap<string, number>;
  /** Office money, keyed `period|AREA` — see carveByArea. Omit it on a line without the channel. */
  officeByArea?: ReadonlyMap<string, number>;
  probationByName: ReadonlyMap<string, string>;
  warehouseCustomers: number;
}): RepRanking {
  const { line, period } = input;
  const trend = input.matricesByPeriod.map((entry) => entry.period);
  const closing = input.matricesByPeriod.find((entry) => entry.period === period)?.matrix ?? null;
  if (!closing) {
    throw new Error(`the rep ranking needs the closing month's own matrix: ${line} ${period}`);
  }

  const key = lineKey(line);
  const seatOf = (areaCode: string): AreaSeatAssignment | undefined =>
    input.seats.get(`${key}::${areaCode.toUpperCase()}`);

  const columns = closing.columns;
  const products = columns.map((column) => ({
    family: column.family,
    productCode: column.productCode,
    productName: column.productName,
  }));

  // area code -> that area's row in each trend month, so a month the closing never published for an
  // area stays ABSENT rather than becoming a zero.
  const perMonth = new Map<string, Map<string, { cells: MonthlyClosingCell[]; rowTotal: MonthlyClosingCell }>>();
  for (const { period: month, matrix } of input.matricesByPeriod) {
    const byArea = new Map<string, { cells: MonthlyClosingCell[]; rowTotal: MonthlyClosingCell }>();
    for (const { area } of areaRowsOf(matrix)) {
      byArea.set(area.areaCode.toUpperCase(), { cells: area.cells, rowTotal: area.rowTotal });
    }
    perMonth.set(month, byArea);
  }

  const seatRows: RepRankingSeat[] = [];
  for (const { area, region } of areaRowsOf(closing)) {
    const areaCode = area.areaCode.toUpperCase();
    const assignment = seatOf(areaCode);
    const repName = assignment?.repName ?? null;
    const vacant = assignment ? assignment.repIsVacant : true;
    const stores = input.storesByArea.get(`${period}|${areaCode}`) ?? 0;
    const direct = input.directByArea.get(`${period}|${areaCode}`) ?? 0;
    const office = input.officeByArea?.get(`${period}|${areaCode}`) ?? 0;
    const salesValue = Number(area.rowTotal.salesValue ?? 0);
    const targetValue = area.rowTotal.targetValue == null ? null : Number(area.rowTotal.targetValue);

    const productRows: RepRankingProduct[] = columns.map((column, index) => {
      const months = trend.map((month) => {
        const row = perMonth.get(month)?.get(areaCode);
        if (!row) return null;
        const cell = row.cells[index];
        return cell === undefined ? null : Number(cell.salesValue ?? 0);
      });
      const monthUnits = trend.map((month) => {
        const row = perMonth.get(month)?.get(areaCode);
        if (!row) return null;
        const cell = row.cells[index];
        return cell === undefined ? null : Number(cell.salesUnits ?? 0);
      });
      const monthTargetValues = trend.map((month) => {
        const cell = perMonth.get(month)?.get(areaCode)?.cells[index];
        return cell?.targetValue == null ? null : Number(cell.targetValue);
      });
      const monthTargetUnits = trend.map((month) => {
        const cell = perMonth.get(month)?.get(areaCode)?.cells[index];
        return cell?.targetUnits == null ? null : Number(cell.targetUnits);
      });
      const cell = area.cells[index];
      const target = cell?.targetValue == null ? null : Number(cell.targetValue);
      const value = cellValue(cell);
      return {
        achievement: target != null && target !== 0 ? value / target : null,
        family: column.family,
        monthTargetUnits,
        monthTargetValues,
        monthUnits,
        months,
        productCode: column.productCode,
        productName: column.productName,
        salesUnits: Number(cell?.salesUnits ?? 0),
        salesValue: value,
        targetUnits: cell?.targetUnits == null ? null : Number(cell.targetUnits),
        targetValue: target,
      };
    });

    seatRows.push({
      achievement: targetValue != null && targetValue !== 0 ? salesValue / targetValue : null,
      areaCode: area.areaCode,
      areaName: area.areaName,
      channels: { direct, distributor: near(salesValue - stores - direct - office), office, stores },
      managerName: assignment?.managerName ?? UNASSIGNED_TEAM,
      monthTargets: trend.map((month) => {
        const row = perMonth.get(month)?.get(areaCode);
        if (!row) return null;
        return row.rowTotal.targetValue == null ? null : Number(row.rowTotal.targetValue);
      }),
      months: trend.map((month) => {
        const row = perMonth.get(month)?.get(areaCode);
        return row ? Number(row.rowTotal.salesValue ?? 0) : null;
      }),
      probationEndsOn: repName ? input.probationByName.get(repName) ?? null : null,
      products: productRows,
      rank: null,
      regionCode: area.regionCode,
      regionName: region.regionName,
      repName: repName ?? "Vacant seat",
      salesValue,
      targetValue,
      vacant,
    });
  }

  // THE RANKING. An untargeted seat is UNRANKED rather than scored 0% — a seat that carries no
  // target has not underperformed, it has not been measured — so those seats sort after every ranked
  // one, by sales, and keep `rank: null`.
  seatRows.sort((a, b) => {
    if (a.achievement == null && b.achievement == null) return b.salesValue - a.salesValue;
    if (a.achievement == null) return 1;
    if (b.achievement == null) return -1;
    return b.achievement - a.achievement;
  });
  let rank = 0;
  for (const seat of seatRows) if (seat.achievement != null) seat.rank = (rank += 1);

  // The areas that sold in an EARLIER trend month but hold no row in the closing month. They are the
  // quarter's unattributed money: shown at the foot, never scattered through the teams, and never
  // silently dropped — which would make the month-by-month columns disagree with the line.
  const closingAreas = new Set(seatRows.map((seat) => seat.areaCode.toUpperCase()));
  const seatlessAreas: RepRankingSeat[] = [];
  for (const { period: month, matrix } of input.matricesByPeriod) {
    if (month === period) continue;
    for (const { area, region } of areaRowsOf(matrix)) {
      const areaCode = area.areaCode.toUpperCase();
      if (closingAreas.has(areaCode)) continue;
      if (seatlessAreas.some((seat) => seat.areaCode.toUpperCase() === areaCode)) continue;
      seatlessAreas.push({
        achievement: null,
        areaCode: area.areaCode,
        areaName: area.areaName,
        channels: { direct: 0, distributor: 0, office: 0, stores: 0 },
        managerName: UNASSIGNED_TEAM,
        monthTargets: trend.map(() => null),
        months: trend.map((trendMonth) => {
          const row = perMonth.get(trendMonth)?.get(areaCode);
          return row ? Number(row.rowTotal.salesValue ?? 0) : null;
        }),
        probationEndsOn: null,
        products: [],
        rank: null,
        regionCode: area.regionCode,
        regionName: region.regionName,
        repName: "No seat in this month",
        salesValue: 0,
        targetValue: null,
        vacant: true,
      });
    }
  }

  // THE TEAMS — his arrangement. A district's reps keep the ranking's order inside the team; the
  // teams themselves are ordered by the DISTRICT's own achievement, which is value over value and
  // never the mean of its seats' percentages. "Not assigned" is always last.
  const byManager = new Map<string, RepRankingSeat[]>();
  for (const seat of seatRows) {
    const list = byManager.get(seat.managerName) ?? [];
    list.push(seat);
    byManager.set(seat.managerName, list);
  }
  const teams: RepRankingTeam[] = [...byManager.entries()].map(([managerName, seats]) => {
    const salesValue = seats.reduce((total, seat) => total + seat.salesValue, 0);
    const targeted = seats.filter((seat) => seat.targetValue != null);
    const targetValue = targeted.length > 0
      ? targeted.reduce((total, seat) => total + Number(seat.targetValue), 0)
      : null;
    return {
      achievement: targetValue != null && targetValue !== 0 ? salesValue / targetValue : null,
      channels: {
        direct: seats.reduce((total, seat) => total + seat.channels.direct, 0),
        distributor: near(seats.reduce((total, seat) => total + seat.channels.distributor, 0)),
        office: seats.reduce((total, seat) => total + seat.channels.office, 0),
        stores: seats.reduce((total, seat) => total + seat.channels.stores, 0),
      },
      managerName,
      months: trend.map((_month, index) =>
        seats.reduce<number | null>((total, seat) => {
          const value = seat.months[index];
          return value == null ? total : (total ?? 0) + value;
        }, null),
      ),
      regionNames: [...new Set(seats.map((seat) => seat.regionName))],
      salesValue,
      seats,
      targetValue,
    };
  });
  teams.sort((a, b) => {
    if (a.managerName === UNASSIGNED_TEAM) return 1;
    if (b.managerName === UNASSIGNED_TEAM) return -1;
    if (a.achievement == null && b.achievement == null) return b.salesValue - a.salesValue;
    if (a.achievement == null) return 1;
    if (b.achievement == null) return -1;
    return b.achievement - a.achievement;
  });

  const salesValue = seatRows.reduce((total, seat) => total + seat.salesValue, 0);
  const targeted = seatRows.filter((seat) => seat.targetValue != null);
  const targetValue = targeted.length > 0
    ? targeted.reduce((total, seat) => total + Number(seat.targetValue), 0)
    : null;

  return {
    line,
    period,
    products,
    seatlessAreas,
    seats: seatRows,
    teams,
    totals: {
      achievement: targetValue != null && targetValue !== 0 ? salesValue / targetValue : null,
      channels: {
        direct: seatRows.reduce((total, seat) => total + seat.channels.direct, 0),
        distributor: near(seatRows.reduce((total, seat) => total + seat.channels.distributor, 0)),
        office: seatRows.reduce((total, seat) => total + seat.channels.office, 0),
        stores: seatRows.reduce((total, seat) => total + seat.channels.stores, 0),
      },
      probationCount: seatRows.filter((seat) => seat.probationEndsOn != null).length,
      rankedCount: seatRows.filter((seat) => seat.rank != null).length,
      salesValue,
      seatCount: seatRows.length,
      targetValue,
      vacantCount: seatRows.filter((seat) => seat.vacant).length,
      warehouseCustomers: input.warehouseCustomers,
    },
    trend,
  };
}

/** The seat map as of the last day of the closing month — a past month names whoever held it then. */
export async function loadRankingSeats(period: string): Promise<Map<string, AreaSeatAssignment>> {
  return loadAreaSeatAssignments(periodEndDate(period));
}

export { probationByUniqueName };
