import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  MonthlyClosingAggregateCell,
  MonthlyClosingDirectCell,
  SalesAreaReference,
} from "@/lib/sales/monthly-distributor-import";

// WHY THIS EXISTS: an area's region is not one fact, it is two, and they legitimately disagree.
//
//   source_of_sales_areas.region_code        = where the area sits geographically. This is the
//                                              region code the SALES rows themselves carry.
//   au.line_area_map.operational_region_code = which DM territory owns that area ON THAT LINE —
//                                              the People Organogram, and the structure a manager
//                                              actually reads a closing against.
//
// The Closing Matrix grouped by the geographic one, so it showed a single "Upper Egypt" for every
// line. The organogram says otherwise, and it is per line (verified against production):
//
//   Anti Infective  UE-1 = UE1, UE2 (+ GZ6)      UE-2 = UE3..UE8      — no plain "UE" at all
//   CNS / Pedia     UE   = UE1..UE7              D16 (Kafr El-Sheikh) sits under AB, not D1
//
// The same split already governs Direct uploads (see ambiguousDirectRegion, which rejects a Direct
// row tagged "UE" on Anti Infective precisely because it covers two DMs) and the AU achievement
// engine. The Closing Matrix was the one reader still grouping geographically.

const NATIONAL = "NATIONAL";

/** Scale used when splitting money, matching the 6-dp rounding the rest of the closing uses. */
const SPLIT_SCALE = 1e6;

const up = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

export type OperationalRegion = { regionCode: string; regionName: string };

/** One "this manager booked this much Direct" row, read off the upload sheet's D.S.M. column. */
export type DirectSubmitterRow = {
  productCode: string;
  /** The region the row was tagged with — geographic, the same code the Direct RPC returns. */
  regionCode: string;
  /** The submitter's name exactly as typed on the sheet (Arabic in practice). */
  submitter: string;
  value: number;
};

/**
 * Match key for a name typed free-hand into a spreadsheet. Sheets carry a short form ("احمد نشأت")
 * while the employee master holds the full one ("احمد نشأت على أحمد"), so only the first two names
 * are compared. Arabic spelling varies by keyboard, so alef/hamza forms, ya/alef-maqsura,
 * ta-marbuta and diacritics are all folded together first.
 *
 * Deliberately NOT fuzzy beyond that: this key decides whose sales a manager is credited with, and
 * Direct counts toward achievement. A near-miss must fail to resolve and fall back, never guess.
 */
export function submitterKey(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/[أإآٱ]/g, "ا") // أ إ آ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .replace(/ة/g, "ه") // ة -> ه
    .replace(/[ً-ْـ]/g, "") // diacritics + tatweel
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
}

export type LineOperationalRegionMap = {
  /** Upper-cased area code -> the DM territory that owns it on this line. */
  regionByArea: Map<string, OperationalRegion>;
  /** Every operational region code this line has, upper-cased. */
  regionCodes: Set<string>;
};

/**
 * Re-labels each area with the region the organogram gives it for this line. An area the map does
 * not cover keeps its geographic region rather than vanishing — a missing mapping must never cost
 * the matrix a row of sales.
 */
export function applyOperationalRegions(
  areas: SalesAreaReference[],
  map: LineOperationalRegionMap | null,
): SalesAreaReference[] {
  if (!map || map.regionByArea.size === 0) return areas;
  return areas.map((area) => {
    const operational = map.regionByArea.get(up(area.areaCode));
    if (!operational || up(operational.regionCode) === up(area.regionCode)) return area;
    return {
      ...area,
      regionCode: operational.regionCode,
      regionName: operational.regionName,
      // Remember where it came from: access scoping still resolves viewers by geographic region.
      sourceRegionCode: area.regionCode,
      sourceRegionName: area.regionName,
    };
  });
}

/**
 * Splits `total` across `weights` so the parts add back up to `total` exactly (largest remainder).
 * Exactness is the point: these parts replace a single Direct row, and a rounding crumb would move
 * the national grand total. Handles negative totals — Direct carries real credit notes.
 */
export function splitProRata(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total === 0 || weightSum <= 0) return weights.map(() => 0);

  const scaledTotal = Math.round(total * SPLIT_SCALE);
  const raw = weights.map((weight) => (scaledTotal * weight) / weightSum);
  const parts = raw.map((value) => Math.floor(value));
  // floor() never overshoots, so the leftover is always 0..n-1 whole units — including for a
  // negative total, where flooring simply lands further from zero.
  let leftover = scaledTotal - parts.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, index) => ({ fraction: value - Math.floor(value), index }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let i = 0; i < byFraction.length && leftover > 0; i += 1) {
    parts[byFraction[i].index] += 1;
    leftover -= 1;
  }
  return parts.map((value) => value / SPLIT_SCALE);
}

/**
 * Moves Direct rows onto the organogram's regions.
 *
 * A Direct row is tagged with a region code, and on most lines that code already IS an operational
 * region — those pass through untouched. The exception is a geographic region the organogram splits
 * across several DMs: Anti Infective has Direct booked against "UE" in five months of 2026 even
 * though that line has only UE-1 and UE-2. Those rows are split pro-rata across the DM territories,
 * weighted by each one's distributor sales from the areas that geographic region contains — so the
 * weight for UE-1 comes from UE1+UE2 only, and a Giza area that happens to sit under UE-1 cannot
 * drag Upper Egypt's Direct money with it.
 *
 * PRO-RATA IS THE FALLBACK, NOT THE RULE. The upload sheet names the district manager who booked
 * the sale in its "D.S.M." column, so where that name resolves to a territory the row is attributed
 * to the manager who actually earned it — no estimate at all. Measured on Anti Infective 2026-07 the
 * two differ a lot: by submitter it is UE-1 27,354 / UE-2 5,980, where pro-rata guessed 8,566 /
 * 24,768. Pro-rata only covers the remainder whose submitter cannot be resolved.
 *
 * A row that cannot be placed at all is passed through unchanged — never dropped.
 */
export function allocateDirectToOperationalRegions(
  directCells: MonthlyClosingDirectCell[],
  input: {
    /** Areas carrying their GEOGRAPHIC region — the codes Direct rows are tagged with. */
    areas: SalesAreaReference[];
    /** Area × product distributor sales for this line and month; the split weight. */
    cells: MonthlyClosingAggregateCell[];
    map: LineOperationalRegionMap | null;
    /** Per-submitter Direct values off the upload sheet, and who each submitter manages. */
    submitters?: DirectSubmitterRow[];
    regionBySubmitter?: Map<string, string>;
    /** au.direct_region_allocation: the owner's own fallback weights, keyed by geographic region. */
    allocationWeights?: Map<string, Map<string, number>>;
  },
): MonthlyClosingDirectCell[] {
  const { map } = input;
  if (!map || map.regionByArea.size === 0 || directCells.length === 0) return directCells;

  const valueByArea = new Map<string, number>();
  input.cells.forEach((cell) => {
    const areaCode = up(cell.areaCode);
    valueByArea.set(areaCode, (valueByArea.get(areaCode) ?? 0) + (Number(cell.salesValue) || 0));
  });

  // geographic region -> operational region -> weight
  const targetsByGeographic = new Map<string, Map<string, number>>();
  input.areas.forEach((area) => {
    const areaCode = up(area.areaCode);
    const geographic = up(area.regionCode);
    const operational = map.regionByArea.get(areaCode);
    if (!geographic || !operational) return;
    let targets = targetsByGeographic.get(geographic);
    if (!targets) {
      targets = new Map();
      targetsByGeographic.set(geographic, targets);
    }
    // Negative area sales must not subtract from a territory's claim on the Direct row.
    const weight = Math.max(0, valueByArea.get(areaCode) ?? 0);
    targets.set(operational.regionCode, (targets.get(operational.regionCode) ?? 0) + weight);
  });

  // Sheet-declared submitter values per (tagged region, product), split into the territory each
  // submitter manages plus an "unresolved" bucket for names that match nobody.
  const UNRESOLVED = "";
  const submitterSplit = new Map<string, Map<string, number>>();
  (input.submitters ?? []).forEach((row) => {
    const key = `${up(row.regionCode)} ${up(row.productCode)}`;
    let byRegion = submitterSplit.get(key);
    if (!byRegion) {
      byRegion = new Map();
      submitterSplit.set(key, byRegion);
    }
    const target = input.regionBySubmitter?.get(submitterKey(row.submitter)) ?? UNRESOLVED;
    // Weights must be non-negative; a credit note cannot hand a territory a negative claim.
    byRegion.set(target, (byRegion.get(target) ?? 0) + Math.max(0, Number(row.value) || 0));
  });

  const allocated: MonthlyClosingDirectCell[] = [];
  const push = (productCode: string, regionCode: string, salesUnits: number, salesValue: number) => {
    if (salesUnits === 0 && salesValue === 0) return;
    allocated.push({ productCode, regionCode, salesUnits, salesValue });
  };

  directCells.forEach((cell) => {
    const region = up(cell.regionCode);
    // Already an operational region for this line, or the National bucket — nothing to do.
    if (region === NATIONAL || map.regionCodes.has(region)) {
      allocated.push(cell);
      return;
    }
    const targets = targetsByGeographic.get(region);
    if (!targets || targets.size === 0) {
      allocated.push(cell); // unplaceable — keep it visible rather than lose the money
      return;
    }
    // au.direct_region_allocation is the company's declared fallback for this exact case and wins
    // over anything derived here; deriving our own weights alongside it would be a second, silently
    // diverging rule for the same question.
    const declaredWeights = input.allocationWeights?.get(region);
    const weightFor = (code: string) => declaredWeights?.get(code) ?? targets.get(code) ?? 0;
    const proRataCodes = [...new Set([...(declaredWeights?.keys() ?? []), ...targets.keys()])].sort();
    if (proRataCodes.length === 1) {
      allocated.push({ ...cell, regionCode: proRataCodes[0] });
      return;
    }

    // ── 1. Attribute by who actually booked it ──
    // Shares rather than the sheet's own money: the Direct RPC stays the single source of truth for
    // the amount, and the sheet is used only to say how it divides.
    const declared = submitterSplit.get(`${region} ${up(cell.productCode)}`);
    const resolvedCodes = [...(declared?.keys() ?? [])].filter((code) => code !== UNRESOLVED).sort();
    if (declared && resolvedCodes.length > 0) {
      const buckets = [...resolvedCodes, UNRESOLVED];
      const weights = buckets.map((code) => declared.get(code) ?? 0);
      if (weights.reduce((sum, weight) => sum + weight, 0) > 0) {
        const units = splitProRata(cell.salesUnits, weights);
        const values = splitProRata(cell.salesValue, weights);
        resolvedCodes.forEach((code, index) => push(cell.productCode, code, units[index], values[index]));

        // ── 2. Whatever had no identifiable submitter falls back to pro-rata ──
        const restUnits = units[buckets.length - 1];
        const restValue = values[buckets.length - 1];
        if (restUnits !== 0 || restValue !== 0) {
          const restWeights = proRataCodes.map(weightFor);
          const usable = restWeights.reduce((sum, weight) => sum + weight, 0) > 0
            ? restWeights
            : proRataCodes.map(() => 1);
          const spreadUnits = splitProRata(restUnits, usable);
          const spreadValues = splitProRata(restValue, usable);
          proRataCodes.forEach((code, index) => push(cell.productCode, code, spreadUnits[index], spreadValues[index]));
        }
        return;
      }
    }

    // ── No submitter information at all ⇒ pro-rata by each territory's sales ──
    let weights = proRataCodes.map(weightFor);
    // Nothing sold in that geography this month — fall back to an even split rather than dropping
    // the row on the floor.
    if (weights.reduce((sum, weight) => sum + weight, 0) <= 0) weights = proRataCodes.map(() => 1);

    const units = splitProRata(cell.salesUnits, weights);
    const values = splitProRata(cell.salesValue, weights);
    proRataCodes.forEach((code, index) => push(cell.productCode, code, units[index], values[index]));
  });
  return allocated;
}

/**
 * The organogram's area -> region map for one line, as of today.
 *
 * "As of today" on purpose: the owner's standing rule is that SoS sales attribute to today's
 * structure, never as-was, so a reorganisation re-cuts the history rather than leaving old months
 * on the old shape.
 *
 * Fails SOFT. A null return means "no organogram view of this line" and the caller keeps the
 * geographic grouping it has always used — which is also the right answer for Head Office, a
 * confidential line with no field structure at all. A closing must never fail to render because
 * the org chart is unavailable.
 */
export async function loadLineOperationalRegions(
  lineCode: string | null | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<LineOperationalRegionMap | null> {
  if (!lineCode) return null;
  try {
    const supabase = getSupabaseAdmin();
    const [mapResult, regionResult] = await Promise.all([
      supabase
        .from("au_v_line_area_map")
        .select("area_code,operational_region_code,effective_from,effective_to")
        .eq("line_code", lineCode),
      supabase.from("au_v_regions").select("region_code,region_name"),
    ]);
    if (mapResult.error || !mapResult.data) return null;

    const regionNames = new Map<string, string>();
    (regionResult.error ? [] : regionResult.data ?? []).forEach((row) => {
      const typed = row as { region_code?: string | null; region_name?: string | null };
      const code = up(typed.region_code);
      if (code) regionNames.set(code, String(typed.region_name ?? "").trim() || code);
    });

    const regionByArea = new Map<string, OperationalRegion>();
    const regionCodes = new Set<string>();
    (mapResult.data as Array<Record<string, unknown>>).forEach((row) => {
      const areaCode = up(row.area_code as string | null);
      const regionCode = up(row.operational_region_code as string | null);
      if (!areaCode || !regionCode) return;
      const from = String(row.effective_from ?? "");
      const to = String(row.effective_to ?? "");
      if (from && from > today) return;
      if (to && to < today) return;
      regionByArea.set(areaCode, { regionCode, regionName: regionNames.get(regionCode) ?? regionCode });
      regionCodes.add(regionCode);
    });

    return regionByArea.size > 0 ? { regionByArea, regionCodes } : null;
  } catch {
    return null; // see "Fails SOFT" above
  }
}

/**
 * The Direct rows of one line/month with the manager who submitted each, read off the upload
 * sheet's "D.S.M." column (there is no submitter column on the aggregated fact tables).
 *
 * Only validated batches count, matching the Direct RPC exactly, so the shares derived from these
 * rows apply to the same population the RPC totalled. Fails soft to an empty list ⇒ the caller
 * falls back to a pro-rata split.
 */
export async function loadDirectSubmitters(
  line: string | null,
  period: string | null,
): Promise<DirectSubmitterRow[]> {
  if (!line || !period) return [];
  try {
    const supabase = getSupabaseAdmin();
    const batches = await supabase
      .from("source_of_sales_import_batches")
      .select("id")
      .eq("period", period)
      .eq("status", "validated");
    if (batches.error || !batches.data || batches.data.length === 0) return [];
    const batchIds = batches.data.map((row) => (row as { id: unknown }).id);

    const rows = await supabase
      .from("source_of_sales_import_rows")
      .select("region_code,product_code,value,raw_row")
      .in("batch_id", batchIds)
      .eq("is_direct", true)
      .eq("official_line", line);
    if (rows.error || !rows.data) return [];

    return (rows.data as Array<Record<string, unknown>>)
      .map((row) => {
        const raw = (row.raw_row ?? {}) as Record<string, unknown>;
        return {
          productCode: String(row.product_code ?? ""),
          regionCode: String(row.region_code ?? ""),
          submitter: String(raw["D.S.M."] ?? "").trim(),
          value: Number(row.value ?? 0) || 0,
        };
      })
      .filter((row) => row.submitter.length > 0 && row.regionCode.length > 0);
  } catch {
    return [];
  }
}

/**
 * au.direct_region_allocation for one line: geographic region -> target region -> weight.
 *
 * The company's own declared answer to "this Direct row names a region the line splits across two
 * district managers — how does it divide?". It is what the AU achievement engine already applies,
 * so the closing must not invent a second rule. Empty map ⇒ the caller falls back to weighting by
 * each territory's own sales.
 *
 * NOT WIRED IN YET, deliberately: au.direct_region_allocation has no public wrapper view, and
 * PostgREST only reaches the `public` schema. Creating `au_v_direct_region_allocation` alongside the
 * other au_v_* wrappers is a migration and needs the owner's approval; until then calling this would
 * be one guaranteed-failing round-trip per closing load. The allocator already accepts the weights,
 * so wiring it is a one-line change once the view exists.
 */
export async function loadDirectRegionAllocation(
  lineCode: string | null | undefined,
): Promise<Map<string, Map<string, number>>> {
  const byRegion = new Map<string, Map<string, number>>();
  if (!lineCode) return byRegion;
  try {
    const supabase = getSupabaseAdmin();
    const result = await supabase
      .from("au_v_direct_region_allocation")
      .select("sos_region_code,target_region_code,weight")
      .eq("line_code", lineCode);
    if (result.error || !result.data) return byRegion;
    (result.data as Array<Record<string, unknown>>).forEach((row) => {
      const source = up(row.sos_region_code as string | null);
      const target = up(row.target_region_code as string | null);
      const weight = Number(row.weight ?? 0);
      if (!source || !target || !(weight > 0)) return;
      let targets = byRegion.get(source);
      if (!targets) {
        targets = new Map();
        byRegion.set(source, targets);
      }
      targets.set(target, (targets.get(target) ?? 0) + weight);
    });
    return byRegion;
  } catch {
    return byRegion;
  }
}

/**
 * submitterKey(name) -> the operational region that manager runs on this line.
 *
 * Two sources, in order: the organogram seat they occupy (the structural source of truth), then the
 * region code on their own employee record. A manager who resolves through neither is left out, and
 * their Direct falls back to pro-rata rather than being credited to a guess.
 *
 * A name that matches MORE THAN ONE manager is dropped rather than resolved — two people sharing a
 * first and family name must not silently hand one of them the other's sales.
 */
export async function loadRegionBySubmitter(lineCode: string | null | undefined): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (!lineCode) return resolved;
  try {
    const supabase = getSupabaseAdmin();
    const [mapResult, treeResult, employeeResult] = await Promise.all([
      supabase.from("au_v_line_area_map").select("operational_region_code,dm_seat_id").eq("line_code", lineCode),
      supabase.from("au_v_org_tree").select("seat_id,occupant_hr_id").eq("line_code", lineCode),
      supabase.from("employees").select("hr_id,full_name,name_ar,region_code"),
    ]);
    if (employeeResult.error || !employeeResult.data) return resolved;

    const regionBySeat = new Map<string, string>();
    (mapResult.error ? [] : mapResult.data ?? []).forEach((row) => {
      const typed = row as { operational_region_code?: string | null; dm_seat_id?: string | null };
      const seat = String(typed.dm_seat_id ?? "").trim();
      const region = up(typed.operational_region_code);
      if (seat && region) regionBySeat.set(seat, region);
    });
    const regionByHrId = new Map<string, string>();
    (treeResult.error ? [] : treeResult.data ?? []).forEach((row) => {
      const typed = row as { seat_id?: string | null; occupant_hr_id?: string | null };
      const hrId = String(typed.occupant_hr_id ?? "").trim();
      const region = regionBySeat.get(String(typed.seat_id ?? "").trim());
      if (hrId && region && !regionByHrId.has(hrId)) regionByHrId.set(hrId, region);
    });

    const ambiguous = new Set<string>();
    (employeeResult.data as Array<Record<string, unknown>>).forEach((row) => {
      const hrId = String(row.hr_id ?? "").trim();
      const region = regionByHrId.get(hrId) ?? up(row.region_code as string | null);
      if (!region) return;
      [row.name_ar, row.full_name].forEach((candidate) => {
        const key = submitterKey(candidate as string | null);
        if (!key) return;
        const existing = resolved.get(key);
        if (existing && existing !== region) {
          ambiguous.add(key);
          return;
        }
        resolved.set(key, region);
      });
    });
    ambiguous.forEach((key) => resolved.delete(key));
    return resolved;
  } catch {
    return resolved;
  }
}
