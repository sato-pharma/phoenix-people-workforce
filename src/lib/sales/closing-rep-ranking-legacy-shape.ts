import {
  type RepRanking,
  type RepRankingSeat,
  UNASSIGNED_TEAM,
} from "@/lib/sales/closing-rep-ranking";

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE THE SHEET CODE READS.
//
// The nine sheets of the ranking workbook were written, measured and BREAK-TESTED against this
// shape — 39 deliberate breaks, each one proving that one assertion is load-bearing, and the
// arrangement the owner corrected on 2026-10-13 is pinned by four of them. Re-typing those sheets
// against new field names would have thrown that away and re-opened every defect the breaks caught,
// so the sheets keep the shape they were proved against and this file maps the production figures
// onto it. Nothing here computes a figure: `RepRanking` already carries the published closing's own.
//
// Read `closing-rep-ranking.ts` for where each number comes from. This is a rename, not a rule.
// ─────────────────────────────────────────────────────────────────────────────

/** A seat, in the shape the sheets read. */
export type LegacySeat = {
  /** True when the closing published any cell for this seat — absence is never a zero. */
  answered: boolean;
  area: string;
  /** The seat's achievement, or null when it carries no target (unranked, never scored zero). */
  ach: number | null;
  code: string;
  dir: number;
  dist: number;
  /** The distributor book with the warehouses taken out, so distOnly + store + dir === sales. */
  distOnly: number;
  prior: number | null;
  rank: number | null;
  region: string;
  sales: number;
  share: number;
  store: number;
  target: number;
  who: LegacyWho;
};

export type LegacyWho = {
  dm: string;
  dmProbation: string | null;
  rep: string;
  repProbation: string | null;
  vacant: boolean;
};

export type LegacyDistrict = {
  ach: number | null;
  dir: number;
  dist: number;
  members: LegacySeat[];
  sales: number;
  store: number;
  target: number;
  vacant: number;
};

export type LegacyTeam = {
  d: LegacyDistrict;
  dm: string;
  members: LegacySeat[];
  probation: string | null;
};

export type LegacyProductCell = { dir: number; dist: number; store: number };

export type LegacyShape = {
  SEATS: { ranked: number; rows: LegacySeat[]; total: number };
  /** Districts ranked by their own achievement, "Not assigned" last. A manager appears ONCE. */
  TEAMS: LegacyTeam[];
  DM_OF: Map<string, LegacyDistrict>;
  PRODUCTS_BY_AREA: Map<string, string[]>;
  achievement: (sales: number, target: number) => number | null;
  apOf: (period: string, area: string, product: string) => LegacyProductCell | null;
  apSalesTotal: (cell: LegacyProductCell | null) => number;
  apTargetOf: (period: string, area: string, product: string) => number;
  areaRowOf: (code: string) => { area_name: string } | undefined;
  areaRegion: (code: string) => string;
  holderOf: (code: string) => LegacyWho;
  lineSales: (period: string) => number;
  lineTarget: (period: string) => number;
  monthOf: (period: string, code: string) => { dir: number; dist: number } | null;
  monthTargetOf: (period: string, code: string) => number;
  productFamily: (code: string) => string;
  productName: (code: string) => string;
  targetUnitsOf: (period: string, area: string, product: string) => number;
  unitsOf: (period: string, area: string, product: string) => number | null;
  /** Every area the closing published a cell for in the trend, per month. */
  areaCodesOf: (period: string) => string[];
  /** `period|AREA|PRODUCT` → units, for the units tab's own product list. */
  apUnits: Map<string, number>;
  apTargetUnits: Map<string, number>;
  /**
   * One entry per published cell of the month, tagged with its channel — what the Trust sheet counts
   * to say how much of the line the ranking is actually made of.
   */
  cellsOf: (period: string) => Array<{ areaCode: string; channel: string }>;
  /** The target rows of the month, for the Trust sheet's "seats with a target" count. */
  targetRows: (period: string) => Array<{ areaCode: string }>;
  /** This line's publication history, newest first — the Trust sheet's provenance table. */
  publications: ReadonlyArray<RankingPublication>;
  warehouseCustomers: number;
};

export type RankingPublication = {
  period: string;
  published_at: string | null;
  published_by: string | null;
  unpublished_at: string | null;
};

/** The channel words the Trust sheet's cell counts are labelled with. */
export const DIST = "Distributor";
export const DIRECT = "Direct";

const achievement = (sales: number, target: number): number | null => (target > 0 ? sales / target : null);

const UNKNOWN_WHO: LegacyWho = {
  dm: UNASSIGNED_TEAM,
  dmProbation: null,
  rep: "Reached no seat",
  repProbation: null,
  vacant: false,
};

/**
 * A manager's probation date is not carried per seat in `RepRanking` — it is a property of the
 * person, and the ranking records it only for reps. The sheets ask for it to tint a manager's band,
 * so it is resolved from any seat whose manager is on probation, which is how the proven build did
 * it too.
 */
function managerProbation(seats: readonly RepRankingSeat[], probationByName: ReadonlyMap<string, string>): string | null {
  for (const seat of seats) {
    const ends = probationByName.get(seat.managerName);
    if (ends) return ends;
  }
  return null;
}

export function toLegacyShape(
  ranking: RepRanking,
  probationByName: ReadonlyMap<string, string>,
  /**
   * The closing month's warehouse and direct money at `period|AREA|PRODUCT` grain
   * (carveChannelsByArea). 🔴 WITHOUT IT THE PRODUCT ROWS WOULD SHOW "none" IN BOTH CHANNEL COLUMNS
   * WHILE THEIR SEAT LINE SHOWED REAL FIGURES, so a block would not add to its own seat — which is
   * exactly what the Area x Product break suite refuses. Only the closing month needs it: every
   * other month on this workbook is read as a total, never split.
   */
  carve: { direct: ReadonlyMap<string, number>; stores: ReadonlyMap<string, number> },
  publications: ReadonlyArray<RankingPublication> = [],
): LegacyShape {
  const { period, trend } = ranking;
  const priorPeriod = trend.length > 1 ? trend[trend.length - 2] : null;
  const priorIndex = priorPeriod ? trend.indexOf(priorPeriod) : -1;
  const closingIndex = trend.indexOf(period);

  const seatOf = new Map<string, RepRankingSeat>();
  for (const seat of [...ranking.seats, ...ranking.seatlessAreas]) {
    seatOf.set(seat.areaCode.toUpperCase(), seat);
  }

  const legacyOf = (seat: RepRankingSeat): LegacySeat => {
    const months = seat.months;
    return {
      ach: seat.achievement,
      answered: months[closingIndex] != null,
      area: seat.areaName,
      code: seat.areaCode,
      dir: seat.channels.direct,
      dist: seat.channels.distributor + seat.channels.stores,
      distOnly: seat.channels.distributor,
      prior: priorIndex >= 0 ? months[priorIndex] ?? null : null,
      rank: seat.rank,
      region: seat.regionName,
      sales: seat.salesValue,
      share: ranking.totals.salesValue > 0 ? seat.salesValue / ranking.totals.salesValue : 0,
      store: seat.channels.stores,
      target: seat.targetValue ?? 0,
      who: {
        dm: seat.managerName,
        dmProbation: probationByName.get(seat.managerName) ?? null,
        rep: seat.repName,
        repProbation: seat.probationEndsOn,
        vacant: seat.vacant,
      },
    };
  };

  const rows = ranking.seats.map(legacyOf);
  const byCode = new Map(rows.map((row) => [row.code.toUpperCase(), row]));

  const DM_OF = new Map<string, LegacyDistrict>();
  const TEAMS: LegacyTeam[] = ranking.teams.map((team) => {
    const members = team.seats
      .map((seat) => byCode.get(seat.areaCode.toUpperCase()))
      .filter((row): row is LegacySeat => row !== undefined);
    const district: LegacyDistrict = {
      ach: team.achievement,
      dir: team.channels.direct,
      dist: team.channels.distributor,
      members,
      sales: team.salesValue,
      store: team.channels.stores,
      target: team.targetValue ?? 0,
      vacant: members.filter((row) => row.who.vacant).length,
    };
    DM_OF.set(team.managerName, district);
    return {
      d: district,
      dm: team.managerName,
      members,
      probation: managerProbation(team.seats, probationByName),
    };
  });

  // The product grid, keyed the way the sheets ask for it: period|AREA|PRODUCT. Every figure is the
  // closing's own published cell for that month.
  const apCells = new Map<string, LegacyProductCell>();
  const apTargets = new Map<string, number>();
  const apUnits = new Map<string, number>();
  const apTargetUnits = new Map<string, number>();
  const productsByArea = new Map<string, Set<string>>();
  const productName = new Map<string, string>();
  const productFamily = new Map<string, string>();
  for (const product of ranking.products) {
    productName.set(product.productCode, product.productName);
    productFamily.set(product.productCode, product.family);
  }

  for (const seat of [...ranking.seats, ...ranking.seatlessAreas]) {
    const area = seat.areaCode.toUpperCase();
    for (const product of seat.products) {
      trend.forEach((month, index) => {
        const value = product.months[index];
        const units = product.monthUnits[index];
        const key = `${month}|${area}|${product.productCode}`;
        if (value != null) {
          // The closing month carries its real channel split at this grain; an earlier month is only
          // ever read as a total on this workbook, so its whole figure sits in the distributor half
          // rather than being apportioned by a ratio nobody measured.
          const store = month === period ? carve.stores.get(key) ?? 0 : 0;
          const direct = month === period ? carve.direct.get(key) ?? 0 : 0;
          apCells.set(key, { dir: direct, dist: value - direct, store });
        }
        if (units != null) apUnits.set(key, units);
        const targetValue = product.monthTargetValues[index];
        const targetUnits = product.monthTargetUnits[index];
        if (targetValue != null) apTargets.set(key, targetValue);
        if (targetUnits != null) apTargetUnits.set(key, targetUnits);
      });
      if (product.salesValue !== 0 || (product.targetValue ?? 0) > 0) {
        const set = productsByArea.get(area) ?? new Set<string>();
        set.add(product.productCode);
        productsByArea.set(area, set);
      }
    }
  }

  const PRODUCTS_BY_AREA = new Map(
    [...productsByArea].map(([area, codes]) => [
      area,
      [...codes].sort((a, b) =>
        (productName.get(a) ?? a).localeCompare(productName.get(b) ?? b),
      ),
    ]),
  );

  const monthSales = new Map<string, { dir: number; dist: number }>();
  const monthTargets = new Map<string, number>();
  const areaCodesByPeriod = new Map<string, Set<string>>();
  for (const seat of [...ranking.seats, ...ranking.seatlessAreas]) {
    const area = seat.areaCode.toUpperCase();
    trend.forEach((month, index) => {
      const value = seat.months[index];
      if (value == null) return;
      const codes = areaCodesByPeriod.get(month) ?? new Set<string>();
      codes.add(area);
      areaCodesByPeriod.set(month, codes);
      // Direct is known for the closing month; an earlier month's split is not carried, so its whole
      // figure sits in the distributor half rather than being apportioned by a ratio nobody measured.
      const direct = month === period ? seat.channels.direct : 0;
      monthSales.set(`${month}|${area}`, { dir: direct, dist: value - direct });
    });
    // Each month's OWN target, never the closing month's reused — see RepRankingSeat.monthTargets.
    trend.forEach((month, index) => {
      const target = seat.monthTargets[index];
      if (target != null) monthTargets.set(`${month}|${area}`, target);
    });
  }

  const areaNames = new Map<string, string>();
  const areaRegions = new Map<string, string>();
  for (const seat of [...ranking.seats, ...ranking.seatlessAreas]) {
    areaNames.set(seat.areaCode.toUpperCase(), seat.areaName);
    areaRegions.set(seat.areaCode.toUpperCase(), seat.regionName);
  }

  return {
    DM_OF,
    PRODUCTS_BY_AREA,
    SEATS: { ranked: ranking.totals.rankedCount, rows, total: ranking.totals.salesValue },
    TEAMS,
    achievement,
    apOf: (month, area, product) => apCells.get(`${month}|${area.toUpperCase()}|${product}`) ?? null,
    apSalesTotal: (cellValue) => (cellValue ? cellValue.dist + cellValue.dir : 0),
    apTargetOf: (month, area, product) => apTargets.get(`${month}|${area.toUpperCase()}|${product}`) ?? 0,
    areaCodesOf: (month) => [...(areaCodesByPeriod.get(month) ?? new Set<string>())],
    areaRegion: (code) => areaRegions.get(code.toUpperCase()) ?? "Unassigned",
    areaRowOf: (code) => {
      const name = areaNames.get(String(code ?? "").toUpperCase());
      return name === undefined ? undefined : { area_name: name };
    },
    holderOf: (code) => seatOf.get(String(code ?? "").toUpperCase()) === undefined
      ? UNKNOWN_WHO
      : byCode.get(String(code ?? "").toUpperCase())?.who ?? UNKNOWN_WHO,
    lineSales: (month) => {
      const index = trend.indexOf(month);
      if (index < 0) return 0;
      return [...ranking.seats, ...ranking.seatlessAreas].reduce(
        (total, seat) => total + (seat.months[index] ?? 0),
        0,
      );
    },
    apTargetUnits,
    apUnits,
    cellsOf: (month) => {
      const out: Array<{ areaCode: string; channel: string }> = [];
      for (const [key, value] of apCells) {
        const [cellMonth, area] = key.split("|");
        if (cellMonth !== month) continue;
        // A cell that EXISTS and is negative is a measured figure, not an absence: a month whose
        // credits outweighed its invoices. It is counted, because the month's column has to add to
        // the line.
        if (value.dist !== 0 || value.store !== 0) out.push({ areaCode: area, channel: DIST });
        if (value.dir !== 0) out.push({ areaCode: area, channel: DIRECT });
      }
      return out;
    },
    lineTarget: (month) => {
      let total = 0;
      for (const [key, value] of monthTargets) if (key.startsWith(`${month}|`)) total += value;
      return total;
    },
    monthOf: (month, code) => monthSales.get(`${month}|${code.toUpperCase()}`) ?? null,
    monthTargetOf: (month, code) => monthTargets.get(`${month}|${code.toUpperCase()}`) ?? 0,
    productFamily: (code) => productFamily.get(code) ?? "",
    productName: (code) => productName.get(code) ?? code,
    publications,
    targetRows: (month) => {
      const out: Array<{ areaCode: string }> = [];
      for (const key of monthTargets.keys()) {
        const [targetMonth, area] = key.split("|");
        if (targetMonth === month) out.push({ areaCode: area });
      }
      return out;
    },
    targetUnitsOf: (month, area, product) => apTargetUnits.get(`${month}|${area.toUpperCase()}|${product}`) ?? 0,
    unitsOf: (month, area, product) => apUnits.get(`${month}|${area.toUpperCase()}|${product}`) ?? null,
    warehouseCustomers: ranking.totals.warehouseCustomers,
  };
}
