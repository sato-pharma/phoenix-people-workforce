import type { SalesBatch, SalesDashboardData, SalesProductPerformanceRow } from "@/lib/sales/types";
import { roundCurrency } from "@/lib/payroll/money";

export type SalesMetricRecord = Record<string, unknown> & {
  batchId?: string | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  factoryPrice?: number | null;
  family?: string | null;
  line?: string | null;
  linkStatus?: string | null;
  managerHrId?: string | null;
  managerName?: string | null;
  month?: number | null;
  period?: string | null;
  product?: string | null;
  rowNumber?: number | null;
  salesType?: string | null;
  salesUnits?: number | null;
  salesValue?: number | null;
  targetUnits?: number | null;
  targetValue?: number | null;
  territory?: string | null;
  validationState?: string | null;
  year?: number | null;
};

export type SalesDashboardView = {
  channelMix: Array<Record<string, unknown>>;
  currentPeriod?: Record<string, unknown>;
  familyRows: Array<Record<string, unknown>>;
  lineRows: Array<Record<string, unknown>>;
  managerRows: Array<Record<string, unknown>>;
  previousPeriod?: Record<string, unknown>;
  productRows: Array<Record<string, unknown>>;
  repRows: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  territoryRows: Array<Record<string, unknown>>;
  trendRows: Array<Record<string, unknown>>;
};

export type SalesProductAnalytics = {
  bottomProducts: SalesProductPerformanceRow[];
  insights: Array<{
    description: string;
    title: string;
    type: "positive" | "warning" | "risk" | "info";
  }>;
  kpis: {
    achievementRate: number;
    remainingGap: number;
    totalSales: number;
    totalTarget: number;
  };
  productMix: Array<{
    contribution: number;
    name: string;
    value: number;
  }>;
  topProducts: SalesProductPerformanceRow[];
};

type BatchIdentity = Pick<SalesBatch, "approvedAt" | "createdAt" | "id" | "line" | "replacedByBatchId" | "status" | "version">;

function valueAsNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueAsText(value: unknown) {
  return String(value ?? "");
}

function cleanPersonName(value: unknown) {
  return valueAsText(value).replace(/\s*\[HR\s+[^\]]+\]/gi, "").replace(/\s*\[[^\]]+\]/g, "").trim();
}

function uniqueSorted(rows: SalesMetricRecord[], key: string) {
  return [...new Set(rows.map((row) => valueAsText(row[key]).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function salesAchievementRate(sales: number, target: number) {
  return target > 0 ? sales / target : 0;
}

/**
 * How the COMPANY-WIDE achievement rate must be NAMED wherever it is shown.
 *
 * `getSalesPlatformMetrics` runs the canonical dashboard with no filter, so the rate it hands back
 * covers `SALES_HISTORY_FLOOR` ("2026-01") through the current Cairo month — cumulative, never a
 * single month. On the CEO and SFE overviews that figure sits directly beside tiles explicitly
 * stamped with one closing month, so unlabelled it reads as that month's achievement. Owner
 * decision, 2026-09-22: label it "2026 to date".
 *
 * The year is the FLOOR's, not today's — the window opens in 2026 and runs to now, so this stays
 * true in later years too. `runSalesSourceOfTruthTests` pins it against `SALES_HISTORY_FLOOR` so
 * the label and the window it describes cannot drift apart in silence.
 */
export const SALES_ACHIEVEMENT_WINDOW_LABEL = "2026 to date";

export type SalesManagerPerformanceMember = {
  managerHrId?: string | null;
  managerName?: string | null;
  /**
   * The vacant District Manager seat a rep sits under when there is no `managerHrId` — see
   * DsmTeamMemberData. Each vacant seat is its own group, named by `managerName` ("Vacant — …").
   */
  vacantManagerSeatId?: string | null;
  totalSales: number;
  totalTarget: number;
};

export type SalesManagerPerformanceGroup<TMember extends SalesManagerPerformanceMember> = {
  achievementPercent: number;
  managerHrId: string;
  managerName: string;
  /** True for a vacant district's group — there is no manager to show, only the seat. */
  isVacantSeat: boolean;
  members: TMember[];
  totalSales: number;
  totalTarget: number;
};

export function buildSalesManagerPerformanceGroups<TMember extends SalesManagerPerformanceMember>(
  members: TMember[],
): Array<SalesManagerPerformanceGroup<TMember>> {
  const groups = new Map<string, { managerName: string; isVacantSeat: boolean; members: TMember[] }>();

  for (const member of members) {
    // A vacant seat groups under its own key, never the shared "unassigned" one (owner, 2026-10-20):
    // two vacant districts must not merge into one bucket under whichever label arrived first.
    const vacantSeatId = member.managerHrId ? null : member.vacantManagerSeatId || null;
    const managerHrId = member.managerHrId || (vacantSeatId ? `vacant:${vacantSeatId}` : "unassigned");
    const group = groups.get(managerHrId) ?? {
      managerName: member.managerName || "Unassigned District",
      isVacantSeat: vacantSeatId != null,
      members: [],
    };
    group.members.push(member);
    groups.set(managerHrId, group);
  }

  return [...groups.entries()]
    .map(([managerHrId, group]) => {
      const totalSales = roundCurrency(group.members.reduce((sum, member) => sum + valueAsNumber(member.totalSales), 0));
      const totalTarget = roundCurrency(group.members.reduce((sum, member) => sum + valueAsNumber(member.totalTarget), 0));
      return {
        achievementPercent: salesAchievementRate(totalSales, totalTarget) * 100,
        managerHrId,
        managerName: group.managerName,
        isVacantSeat: group.isVacantSeat,
        members: group.members,
        totalSales,
        totalTarget,
      };
    })
    .sort((left, right) => left.managerName.localeCompare(right.managerName));
}

export function sumSalesMetricRows<T extends Record<string, unknown>>(rows: T[], key: string) {
  return rows.reduce((total, row) => total + valueAsNumber(row[key]), 0);
}

// Money variant: rounds the aggregate to cents to absorb float drift from summing
// many already-rounded currency rows. Use for currency keys (salesValue/targetValue);
// keep sumSalesMetricRows for unit/count sums.
export function sumSalesMetricMoney<T extends Record<string, unknown>>(rows: T[], key: string) {
  return roundCurrency(sumSalesMetricRows(rows, key));
}

export function aggregateSalesMetricRows<T extends Record<string, unknown>>(rows: T[], key: string) {
  const map = new Map<string, T[]>();
  rows.forEach((row) => {
    const value = valueAsText(row[key]) || "Unassigned";
    map.set(value, [...(map.get(value) ?? []), row]);
  });
  return map;
}

export function isActiveSalesImportBatch(batch: Pick<SalesBatch, "replacedByBatchId" | "status">) {
  return batch.status === "approved" && !batch.replacedByBatchId;
}

export function salesBatchSortValue(batch: Pick<SalesBatch, "approvedAt" | "createdAt" | "status" | "version">) {
  const statusPriority: Record<string, number> = {
    approved: 3,
    validated: 2,
    needs_review: 1,
    staged: 0,
  };
  return [
    String(statusPriority[String(batch.status)] ?? 0).padStart(2, "0"),
    String(batch.approvedAt ?? ""),
    String(batch.createdAt ?? ""),
    String(batch.version ?? 0).padStart(6, "0"),
  ].join("|");
}

export function selectCurrentSalesRecords<TRecord extends SalesMetricRecord, TBatch extends BatchIdentity>(
  records: TRecord[],
  batches: TBatch[],
): TRecord[] {
  const activeBatchMap = new Map(batches.filter(isActiveSalesImportBatch).map((batch) => [batch.id, batch] as const));
  const latestBatchByRecordPeriod = new Map<string, TBatch>();

  records.forEach((record) => {
    const batch = activeBatchMap.get(valueAsText(record.batchId));
    if (!batch || record.validationState === "failed") return;

    const key = `${batch.line || record.line || ""}::${valueAsNumber(record.year)}::${valueAsNumber(record.month)}`;
    const current = latestBatchByRecordPeriod.get(key);
    if (!current || salesBatchSortValue(batch) > salesBatchSortValue(current)) {
      latestBatchByRecordPeriod.set(key, batch);
    }
  });

  return records.flatMap((record) => {
    const batch = activeBatchMap.get(valueAsText(record.batchId));
    if (!batch || record.validationState === "failed") return [];
    const key = `${batch.line || record.line || ""}::${valueAsNumber(record.year)}::${valueAsNumber(record.month)}`;
    if (latestBatchByRecordPeriod.get(key)?.id !== batch.id) return [];
    return [{ ...record, line: batch.line || record.line } as TRecord];
  });
}

function isC01Row(row: SalesMetricRecord) {
  return valueAsText(row.managerHrId).trim().toLowerCase() === "c-o1" || valueAsText(row.employeeHrId).trim().toLowerCase() === "c-o1";
}

function areaLabel(items: SalesMetricRecord[]) {
  const areas = uniqueSorted(items, "territory");
  if (areas.length === 0) return "-";
  if (areas.length <= 2) return areas.join(", ");
  return `${areas.slice(0, 2).join(", ")} +${areas.length - 2}`;
}

export function buildSalesDashboardView(rows: SalesMetricRecord[], fallbackSummary: Record<string, unknown> = {}): SalesDashboardView {
  const reportRows = rows.filter((row) => !isC01Row(row));
  // Headline figures are summed over reportRows, NOT rows. They used to include C-O1 while every
  // breakdown below them excluded it, so the headline total could never equal the sum of the parts
  // and the difference had no visible home. One row set, one number.
  const totalSales = sumSalesMetricMoney(reportRows, "salesValue");
  const totalTarget = sumSalesMetricMoney(reportRows, "targetValue");
  const unitsSold = sumSalesMetricRows(reportRows, "salesUnits");
  const activeProducts = new Set(reportRows.map((row) => valueAsText(row.product)).filter(Boolean)).size;
  const linkedEmployees = new Set(reportRows.map((row) => valueAsText(row.employeeHrId)).filter(Boolean)).size;
  const dsmIds = new Set(reportRows.map((row) => valueAsText(row.managerHrId)).filter(Boolean));
  // reportRows for the same reason as the totals above: an average drawn from a wider row set than
  // the one on screen is not the average of what is on screen.
  const prices = reportRows.map((row) => valueAsNumber(row.factoryPrice)).filter((price) => price > 0);
  const averageFactoryPrice = prices.length ? prices.reduce((total, price) => total + price, 0) / prices.length : 0;

  const trendRows = [...aggregateSalesMetricRows(rows, "period").entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return {
        achievementRate: salesAchievementRate(sales, target),
        linkedEmployees: new Set(items.map((item) => valueAsText(item.employeeHrId)).filter(Boolean)).size,
        period,
        sales,
        target,
      };
    });

  const managerRows = [...aggregateSalesMetricRows(reportRows, "managerName").entries()]
    .map(([manager, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      const topProduct = [...aggregateSalesMetricRows(items, "product").entries()]
        .map(([product, productRows]) => ({ product, sales: sumSalesMetricMoney(productRows, "salesValue") }))
        .sort((left, right) => right.sales - left.sales)[0]?.product ?? "Unknown";
      return { achievementRate: salesAchievementRate(sales, target), area: areaLabel(items), manager: cleanPersonName(manager), sales, target, topProduct };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const lineRows = [...aggregateSalesMetricRows(reportRows, "line").entries()]
    .map(([line, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return { achievementRate: salesAchievementRate(sales, target), line, rows: items.length, sales, target };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const productRows = [...aggregateSalesMetricRows(reportRows, "product").entries()]
    .map(([product, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return { achievementRate: salesAchievementRate(sales, target), family: valueAsText(items[0]?.family) || "Unknown", product, sales, target };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const repRows = [...aggregateSalesMetricRows(reportRows.filter((row) => valueAsText(row.employeeName)), "employeeName").entries()]
    .map(([rep, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return { achievementRate: salesAchievementRate(sales, target), area: areaLabel(items), rep: cleanPersonName(rep), sales, target };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const territoryRows = [...aggregateSalesMetricRows(reportRows, "territory").entries()]
    .map(([name, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return { achievementRate: salesAchievementRate(sales, target), name, sales, target };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const familyRows = [...aggregateSalesMetricRows(reportRows, "family").entries()]
    .map(([name, items]) => {
      const sales = sumSalesMetricMoney(items, "salesValue");
      const target = sumSalesMetricMoney(items, "targetValue");
      return { achievementRate: salesAchievementRate(sales, target), name, sales, target, units: sumSalesMetricRows(items, "salesUnits") };
    })
    .sort((left, right) => valueAsNumber(right.sales) - valueAsNumber(left.sales));

  const channelMix = [...aggregateSalesMetricRows(reportRows, "salesType").entries()]
    .map(([name, items]) => ({ name, value: sumSalesMetricMoney(items, "salesValue") }))
    .sort((left, right) => valueAsNumber(right.value) - valueAsNumber(left.value));

  return {
    channelMix,
    currentPeriod: trendRows[trendRows.length - 1],
    familyRows,
    lineRows,
    managerRows,
    previousPeriod: trendRows[trendRows.length - 2],
    productRows,
    repRows,
    summary: {
      ...fallbackSummary,
      achievementRate: salesAchievementRate(totalSales, totalTarget),
      activeProducts,
      approvedRecords: rows.length,
      averageFactoryPrice,
      dataQualityRate: dsmIds.size > 0 ? 1 : Number(fallbackSummary.dataQualityRate ?? 1),
      dsmLinkedRecords: dsmIds.size,
      dsmTotalRecords: dsmIds.size,
      linkedEmployees,
      topManager: valueAsText(managerRows[0]?.manager) || "-",
      totalApprovedSales: rows.length > 0 ? totalSales : null,
      totalApprovedTarget: rows.length > 0 ? totalTarget : null,
      unitsSold,
    },
    territoryRows,
    trendRows,
  };
}

export function buildSalesProductAnalytics(data: SalesDashboardData, searchQuery = ""): SalesProductAnalytics {
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const products = (data.productPerformance ?? []).filter((product) =>
    normalizedSearch ? product.product.toLowerCase().includes(normalizedSearch) : true,
  );
  const totalSales = valueAsNumber(data.summary?.totalApprovedSales);
  const totalTarget = valueAsNumber(data.summary?.totalApprovedTarget);
  const achievementRate = salesAchievementRate(totalSales, totalTarget);
  const remainingGap = Math.max(0, totalTarget - totalSales);
  const topBySales = [...products].sort((a, b) => b.sales - a.sales);
  const topProducts = topBySales.slice(0, 5);
  const bottomProducts = [...products].sort((a, b) => a.achievementRate - b.achievementRate).slice(0, 5);
  const top5Sales = topBySales.slice(0, 5);
  const top5SalesTotal = roundCurrency(top5Sales.reduce((sum, product) => sum + product.sales, 0));
  const others = Math.max(0, totalSales - top5SalesTotal);
  const productMix = [
    ...top5Sales.map((product) => ({
      contribution: totalSales > 0 ? (product.sales / totalSales) * 100 : 0,
      name: product.product,
      value: product.sales,
    })),
    ...(others > 0 ? [{ contribution: totalSales > 0 ? (others / totalSales) * 100 : 0, name: "Remaining Products", value: others }] : []),
  ];

  const insights: SalesProductAnalytics["insights"] = [];
  if (products.length === 0) {
    insights.push({
      description: "No product performance data available. Adjust filters or check data linkage.",
      title: "No Product Data",
      type: "info",
    });
  } else {
    let topProduct = products[0];
    let belowTargetCount = 0;
    let aboveTargetCount = 0;
    for (const product of products) {
      if ((product.achievementRate ?? 0) < 0.5) belowTargetCount += 1;
      if ((product.achievementRate ?? 0) >= 1) aboveTargetCount += 1;
      if (topProduct && (product.sales || 0) > (topProduct.sales || 0)) topProduct = product;
    }
    if (topProduct) {
      const contribution = totalSales > 0 ? (topProduct.sales / totalSales) * 100 : 0;
      insights.push({
        description: `${topProduct.product} contributes ${contribution.toFixed(1)}% of total sales.`,
        title: "Top Performing Product",
        type: "positive",
      });
    }
    if (belowTargetCount > 0) {
      insights.push({
        description: `${belowTargetCount} product(s) are below 50% of target. Review performance and support.`,
        title: "Products Below 50% Achievement",
        type: "risk",
      });
    }
    if (aboveTargetCount > 0) {
      insights.push({
        description: `${aboveTargetCount} product(s) have achieved or exceeded their target.`,
        title: "Exceeding Target",
        type: "positive",
      });
    }
  }

  return {
    bottomProducts,
    insights,
    kpis: {
      achievementRate,
      remainingGap,
      totalSales,
      totalTarget,
    },
    productMix,
    topProducts,
  };
}

function normalizeMetricHrId(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || "unassigned";
}

function periodForRecord(record: SalesMetricRecord) {
  if (record.period) return String(record.period);
  if (record.year && record.month) return `${record.year}-${String(record.month).padStart(2, "0")}`;
  return "";
}

export function buildPortalSalesDashboardMetrics(records: SalesMetricRecord[]): SalesDashboardData {
  // `coveredSales` is the part of a month's sales that sits on a key carrying a target — the only
  // part an achievement may divide. It is tracked alongside `sales` rather than replacing it
  // because both are true and they answer different questions: a rep sold `sales`, and is measured
  // on `coveredSales / target`. Dividing total sales by a partial target reads as over-achievement
  // that the rep never earned, which matters most where it turns into money (the incentive tab).
  const trendByPeriod = new Map<string, { coveredSales: number; sales: number; target: number; linkedEmployees: number }>();
  const productPerformanceMap = new Map<string, { family: string; sales: number; salesUnits: number; target: number }>();
  const familyMatrixMap = new Map<string, { sales: number; salesRows: SalesMetricRecord[]; target: number; units: number }>();
  const territoryMap = new Map<string, { sales: number; target: number }>();
  const linePerformance = new Map<string, { sales: number; target: number; linkedEmployees: number }>();
  const maxTargetsByPeriodProduct = new Map<string, number>();
  const maxTargetsByLineProduct = new Map<string, number>();
  const maxTargetsByPeriodFamily = new Map<string, number>();
  // Territory was the ONE dimension summing target raw, while trend, product, family and line all
  // de-duplicate. The source rows echo the same target across every (period, product) line for an
  // employee, so a raw sum multiplies a territory's target by the row-echo factor — and understates
  // its achievement % by exactly that factor. Same key shape as the siblings.
  const maxTargetsByTerritory = new Map<string, number>();
  const seenTrendTargets = new Set<string>();
  const seenProductTargets = new Set<string>();
  const seenFamilyTargets = new Set<string>();
  const seenLineTargets = new Set<string>();
  const seenTerritoryTargets = new Set<string>();

  records.forEach((record) => {
    const period = periodForRecord(record);
    const product = valueAsText(record.product) || "Unknown";
    const line = valueAsText(record.line) || "Unassigned";
    const family = valueAsText(record.family) || "Unknown";
    const territory = valueAsText(record.territory) || "Unassigned";
    const employeeHrId = normalizeMetricHrId(record.hrId ?? record.employeeHrId);
    const targetValue = valueAsNumber(record.targetValue);

    if (!period) return;
    const targetKey = `trend::${employeeHrId}::${territory}::${period}::${product}`;
    maxTargetsByPeriodProduct.set(targetKey, Math.max(targetValue, maxTargetsByPeriodProduct.get(targetKey) ?? 0));

    const lineTargetKey = `line::${employeeHrId}::${territory}::${line}::${period}::${product}`;
    maxTargetsByLineProduct.set(lineTargetKey, Math.max(targetValue, maxTargetsByLineProduct.get(lineTargetKey) ?? 0));

    const familyTargetKey = `fam::${employeeHrId}::${territory}::${period}::${product}::${family}`;
    maxTargetsByPeriodFamily.set(familyTargetKey, Math.max(targetValue, maxTargetsByPeriodFamily.get(familyTargetKey) ?? 0));

    const territoryTargetKey = `terr::${employeeHrId}::${territory}::${period}::${product}`;
    maxTargetsByTerritory.set(territoryTargetKey, Math.max(targetValue, maxTargetsByTerritory.get(territoryTargetKey) ?? 0));
  });

  records.forEach((record) => {
    const period = periodForRecord(record);
    const product = valueAsText(record.product) || "Unknown";
    const line = valueAsText(record.line) || "Unassigned";
    const family = valueAsText(record.family) || "Unknown";
    const territory = valueAsText(record.territory) || "Unassigned";
    const employeeHrId = normalizeMetricHrId(record.hrId ?? record.employeeHrId);
    const salesValue = valueAsNumber(record.salesValue);

    if (period) {
      const current = trendByPeriod.get(period) ?? { coveredSales: 0, sales: 0, target: 0, linkedEmployees: 0 };
      const targetKey = `trend::${employeeHrId}::${territory}::${period}::${product}`;
      // The key's target, before the seen-gate: EVERY row on a targeted key is covered sales, while
      // only the FIRST contributes the target itself (the rest are the source's row echo).
      const keyTarget = maxTargetsByPeriodProduct.get(targetKey) ?? 0;
      const targetValue = seenTrendTargets.has(targetKey) ? 0 : keyTarget;
      seenTrendTargets.add(targetKey);

      trendByPeriod.set(period, {
        coveredSales: current.coveredSales + (keyTarget > 0 ? salesValue : 0),
        linkedEmployees: current.linkedEmployees + 1,
        sales: current.sales + salesValue,
        target: current.target + targetValue,
      });
    }

    const prevProduct = productPerformanceMap.get(product) ?? { family, sales: 0, salesUnits: 0, target: 0 };
    const productTargetKey = `prod::${employeeHrId}::${territory}::${period}::${product}`;
    const productTargetValue = period && !seenProductTargets.has(productTargetKey)
      ? (maxTargetsByPeriodProduct.get(`trend::${employeeHrId}::${territory}::${period}::${product}`) ?? 0)
      : 0;
    if (period) seenProductTargets.add(productTargetKey);
    productPerformanceMap.set(product, {
      family: prevProduct.family,
      sales: prevProduct.sales + salesValue,
      salesUnits: prevProduct.salesUnits + valueAsNumber(record.salesUnits),
      target: prevProduct.target + productTargetValue,
    });

    const prevFamily = familyMatrixMap.get(family) ?? { sales: 0, salesRows: [], target: 0, units: 0 };
    const familyProductTargetKey = `fam::${employeeHrId}::${territory}::${period}::${product}::${family}`;
    const familyTargetValue = period && !seenFamilyTargets.has(familyProductTargetKey)
      ? (maxTargetsByPeriodFamily.get(familyProductTargetKey) ?? 0)
      : 0;
    if (period) seenFamilyTargets.add(familyProductTargetKey);
    familyMatrixMap.set(family, {
      sales: prevFamily.sales + salesValue,
      salesRows: [...prevFamily.salesRows, record],
      target: prevFamily.target + familyTargetValue,
      units: prevFamily.units + valueAsNumber(record.salesUnits),
    });

    const prevTerritory = territoryMap.get(territory) ?? { sales: 0, target: 0 };
    const territoryTargetKey = `terr::${employeeHrId}::${territory}::${period}::${product}`;
    const territoryTargetValue = seenTerritoryTargets.has(territoryTargetKey)
      ? 0
      : (maxTargetsByTerritory.get(territoryTargetKey) ?? 0);
    seenTerritoryTargets.add(territoryTargetKey);
    territoryMap.set(territory, {
      sales: prevTerritory.sales + salesValue,
      target: prevTerritory.target + territoryTargetValue,
    });

    const prevLine = linePerformance.get(line) ?? { sales: 0, target: 0, linkedEmployees: 0 };
    const lineTargetKey = `line::${employeeHrId}::${territory}::${line}::${period}::${product}`;
    const lineTargetValue = seenLineTargets.has(lineTargetKey) ? 0 : (maxTargetsByLineProduct.get(lineTargetKey) ?? 0);
    seenLineTargets.add(lineTargetKey);
    linePerformance.set(line, {
      linkedEmployees: prevLine.linkedEmployees + 1,
      sales: prevLine.sales + salesValue,
      target: prevLine.target + lineTargetValue,
    });
  });

  const trend = [...trendByPeriod.entries()]
    .map(([period, value]) => ({
      ...value,
      achievementRate: salesAchievementRate(value.sales, value.target),
      period,
    }))
    .sort((left, right) => left.period.localeCompare(right.period));
  const productPerformance = [...productPerformanceMap.entries()]
    .map(([product, value]) => ({
      achievementRate: salesAchievementRate(value.sales, value.target),
      family: value.family,
      product,
      sales: value.sales,
      salesUnits: value.salesUnits,
      target: value.target,
    }))
    .sort((left, right) => right.sales - left.sales);
  const familyMatrix = [...familyMatrixMap.entries()].map(([name, value]) => ({
    achievementRate: salesAchievementRate(value.sales, value.target),
    name,
    sales: value.sales,
    salesRows: value.salesRows,
    target: value.target,
    units: value.units,
  }));
  const totalSales = sumSalesMetricRows(records, "salesValue");
  const totalTarget = [...maxTargetsByPeriodProduct.values()].reduce((sum, value) => sum + value, 0);
  const activeProducts = new Set(records.map((item) => item.product).filter(Boolean)).size;
  const totalUnits = sumSalesMetricRows(records, "salesUnits");

  return {
    anomalies: [],
    familyMatrix,
    filters: {
      families: uniqueSorted(records, "family"),
      lines: uniqueSorted(records, "line"),
      managers: uniqueSorted(records, "managerHrId"),
      periods: trend.map((item) => item.period),
      products: uniqueSorted(records, "product"),
      salesTypes: uniqueSorted(records, "salesType"),
      territories: uniqueSorted(records, "territory"),
    },
    linePerformance: [...linePerformance.entries()].map(([line, value]) => ({
      achievementRate: salesAchievementRate(value.sales, value.target),
      line,
      linkedEmployees: value.linkedEmployees,
      sales: value.sales,
      target: value.target,
    })),
    managerPerformance: [],
    productPerformance,
    recentBatches: [],
    summary: {
      achievementRate: salesAchievementRate(totalSales, totalTarget),
      activeProducts,
      activeTargetRecords: 0,
      anomalyCount: 0,
      approvedRecords: records.length,
      averageFactoryPrice: 0,
      dataQualityRate: 1,
      dsmLinkedRecords: 0,
      dsmTotalRecords: 0,
      linkedEmployees: 0,
      linkedRecords: records.length,
      openReviewBatches: 0,
      topManager: "-",
      totalApprovedSales: totalSales,
      totalApprovedTarget: totalTarget,
      unitsSold: totalUnits,
    },
    territories: [...territoryMap.entries()].map(([name, value]) => ({
      achievementRate: salesAchievementRate(value.sales, value.target),
      name,
      sales: value.sales,
      target: value.target,
    })),
    topManager: "-",
    transactions: [],
    trend,
  } as SalesDashboardData;
}
