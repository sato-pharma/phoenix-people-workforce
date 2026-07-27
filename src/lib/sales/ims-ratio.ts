import { selectAllRows } from "@/lib/sales/master-data/list";

/**
 * IMS (market share) ratio integrity for the Source-of-Sales geography master.
 *
 * Ratios are stored as FRACTIONS (0.0341 = 3.41%), matching formatPercent()'s default
 * input:"ratio" in src/lib/sales/format.ts.
 *
 * THE OTHERS RULE (owner decision, 2026-07-27): the OT ("Others") region's share is tracked as ONE
 * indivisible figure on source_of_sales_regions.ims_ratio and is NEVER split across its areas —
 * OT's area list is volatile (it went from 3 areas to 9 in a single day), and a per-area split
 * would have to be re-derived every time that set changes. Every OT *area* keeps ims_ratio NULL.
 *
 * That split storage is exactly what can drift: the area figures and the region figure live in two
 * places and nothing in the schema ties them together. `summarizeImsRatios` is the tie — it asserts
 * the whole model still adds to 1.
 */

export const IMS_OTHERS_REGION_CODE = "OT";

/** Sum of the 39 non-OT area ratios (95.03%). */
export const IMS_NON_OT_TOTAL = 0.9503;

/** Residual held at region level for OT (4.97%). */
export const IMS_OTHERS_TOTAL = 0.0497;

/**
 * Ratios are exact `numeric` in Postgres but arrive here as IEEE-754 doubles, so summing 39 of them
 * lands a few ULPs off. Compare against this, never with `===`.
 */
export const IMS_TOLERANCE = 1e-6;

export type ImsAreaRow = {
  area_code: string;
  region_code: string;
  active: boolean;
  ims_ratio: number | null;
};

export type ImsRegionRow = {
  region_code: string;
  ims_ratio: number | null;
};

export type ImsRatioSummary = {
  /** Sum of ims_ratio across ACTIVE non-OT areas. */
  nonOtTotal: number;
  /** The OT region-level ratio (0 when unset). */
  othersTotal: number;
  /** nonOtTotal + othersTotal — must be 1. */
  total: number;
  /** Active non-OT areas still missing a ratio. */
  areasMissingRatio: string[];
  /** OT areas that wrongly carry a per-area ratio (violates the Others rule). */
  otAreasWithRatio: string[];
  ok: boolean;
  problems: string[];
};

function near(value: number, expected: number) {
  return Math.abs(value - expected) <= IMS_TOLERANCE;
}

/**
 * Pure integrity check over the two master tables. Kept free of I/O so the invariant is unit-tested
 * without a database.
 */
export function summarizeImsRatios(areas: ImsAreaRow[], regions: ImsRegionRow[]): ImsRatioSummary {
  const activeNonOt = areas.filter((a) => a.active && a.region_code !== IMS_OTHERS_REGION_CODE);

  const nonOtTotal = activeNonOt.reduce((sum, a) => sum + (a.ims_ratio ?? 0), 0);

  const othersTotal =
    regions.find((r) => r.region_code === IMS_OTHERS_REGION_CODE)?.ims_ratio ?? 0;

  const areasMissingRatio = activeNonOt
    .filter((a) => a.ims_ratio === null || a.ims_ratio === undefined)
    .map((a) => a.area_code)
    .sort();

  const otAreasWithRatio = areas
    .filter((a) => a.region_code === IMS_OTHERS_REGION_CODE && a.ims_ratio !== null && a.ims_ratio !== undefined)
    .map((a) => a.area_code)
    .sort();

  const total = nonOtTotal + othersTotal;
  const problems: string[] = [];

  if (!near(nonOtTotal, IMS_NON_OT_TOTAL)) {
    problems.push(
      `Active non-OT area ratios sum to ${nonOtTotal.toFixed(6)}, expected ${IMS_NON_OT_TOTAL}.`,
    );
  }
  if (!near(othersTotal, IMS_OTHERS_TOTAL)) {
    problems.push(
      `OT region ratio is ${othersTotal.toFixed(6)}, expected ${IMS_OTHERS_TOTAL}.`,
    );
  }
  if (!near(total, 1)) {
    problems.push(`IMS ratios total ${total.toFixed(6)}, expected exactly 1.`);
  }
  if (areasMissingRatio.length > 0) {
    problems.push(`Active non-OT area(s) without an IMS ratio: ${areasMissingRatio.join(", ")}.`);
  }
  if (otAreasWithRatio.length > 0) {
    problems.push(
      `OT area(s) carry a per-area IMS ratio, but the Others share must stay at region level: ${otAreasWithRatio.join(", ")}.`,
    );
  }

  return {
    nonOtTotal,
    othersTotal,
    total,
    areasMissingRatio,
    otAreasWithRatio,
    ok: problems.length === 0,
    problems,
  };
}

/** Live drift check against the current master tables. */
export async function checkImsRatioIntegrity(): Promise<ImsRatioSummary> {
  const [areas, regions] = await Promise.all([
    selectAllRows("source_of_sales_areas", "area_code"),
    selectAllRows("source_of_sales_regions", "region_code"),
  ]);

  return summarizeImsRatios(
    areas.map((row) => ({
      area_code: String(row.area_code),
      region_code: String(row.region_code),
      active: row.active !== false,
      ims_ratio: row.ims_ratio === null || row.ims_ratio === undefined ? null : Number(row.ims_ratio),
    })),
    regions.map((row) => ({
      region_code: String(row.region_code),
      ims_ratio: row.ims_ratio === null || row.ims_ratio === undefined ? null : Number(row.ims_ratio),
    })),
  );
}
