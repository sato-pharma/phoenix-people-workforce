import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import type { SplitRegions } from "@/lib/sales/store-sales-city-split";
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
//   CNS             UE   = UE1..UE7              D16 (Kafr El-Sheikh 1) sits under AB, not D1
//   Pedia           UE-1 / UE-2 from 2026-09-01  D16 joins Delta (1) from 2026-09-01
//
// 🔴 BOTH PEDIA ROWS ARE DATED, AND THE DATE IS THE MECHANISM. Pedia's Upper Egypt split and its
// Kafr El-Sheikh 1 move are each written as a PAIR in au.line_area_map effective 2026-09-01, so
// August resolves to the left-hand structure and September to the right-hand one no matter when a
// closing is run. Read the two Pedia lines above as "before | after", never as current state, and
// never assume the same area answers the same on two lines: Pedia's UE-1 / UE-2 membership
// deliberately differs from Anti Infective's, and CNS keeps Kafr El-Sheikh 1 on Alex-BHR for good.
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
 * The field-sales lines whose closing groups areas by the ORGANOGRAM instead of by geography.
 *
 * Anti Infective is on this list because its Upper Egypt is genuinely two DM districts, and the
 * owner wants UE-1 / UE-2 subtotals on the sheet rather than one UE lump.
 *
 * Pedia and CNS are on this list because the owner confirmed on 2026-08-07 that Monthly Closing
 * must follow the EU Organogram source of truth. That puts every area under the manager territory
 * assigned to that line, including Kafr El-Sheikh 2 (D17) in Others (OT) for both lines.
 *
 * Lines outside the field-sales structure (for example Head Office) keep geographic grouping.
 *
 * ADDING A LINE HERE REWRITES THAT LINE'S REGION SUBTOTALS — ask the owner first, every time.
 * (Owner ruling 2026-08-07: Pedia and CNS must follow the EU Organogram.)
 */
const CLOSING_ORGANOGRAM_REGION_LINES = new Set(["anti_infective", "cns", "pedia"]);

/** Does this line's closing group by the organogram? Line code as `resolveTargetLineCode` returns. */
export function usesOrganogramRegions(lineCode: string | null | undefined): boolean {
  return CLOSING_ORGANOGRAM_REGION_LINES.has(String(lineCode ?? "").trim().toLowerCase());
}

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
    // A row that names its own AREA needs no estimate at all: this whole function exists to guess
    // which district manager earned money tagged only with a geographic region, and an exact area
    // answers that outright — the area's own row decides which territory it lands in. Splitting it
    // pro-rata would take known geography and blur it back into a guess, and would also strip the
    // areaCode (`push` builds a fresh cell), silently returning the row to the anonymous Direct row.
    if (up(cell.areaCode ?? "")) {
      allocated.push(cell);
      return;
    }
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
 * Builds the area -> region map out of raw `au_v_line_area_map_all` rows, effective-dated at `asOf`.
 *
 * Split out of the loader so the dating rule can be tested without a database. This is the exact
 * predicate `au.f_line_area_map_asof` uses — `effective_from <= asOf`, with `effective_to`
 * EXCLUSIVE — so a row that ends on the day its successor begins never double-maps its area.
 *
 * Rows arrive UNORDERED, and once history is exposed one area can legitimately have several of
 * them, so the winner is picked explicitly: the latest `effective_from` still covering `asOf`,
 * matching `f_line_area_map_asof`'s `distinct on … order by effective_from desc`. Without that
 * tie-break the answer would depend on the order PostgREST happened to return rows in — a bug that
 * would surface once, in production, in the month a territory move lands.
 *
 * An area with no row covering `asOf` is simply absent, and `applyOperationalRegions` then leaves
 * it on its geographic region: a missing mapping must never cost the matrix a row of sales.
 */
export function buildOperationalRegionMap(
  rows: Array<Record<string, unknown>>,
  asOf: string,
  regionNames: Map<string, string>,
): LineOperationalRegionMap | null {
  const regionByArea = new Map<string, OperationalRegion>();
  const winningFrom = new Map<string, string>();
  rows.forEach((row) => {
    const areaCode = up(row.area_code as string | null);
    const regionCode = up(row.operational_region_code as string | null);
    if (!areaCode || !regionCode) return;
    const from = String(row.effective_from ?? "");
    const to = String(row.effective_to ?? "");
    // Not yet in force for the month being closed. This single line is the whole point of `asOf`.
    if (from && from > asOf) return;
    // Already superseded. EXCLUSIVE, matching the database: a row closed on 2026-09-01 covers
    // 2026-08-31 and not 2026-09-01, which is the day its successor opens.
    if (to && to <= asOf) return;
    // ISO dates order correctly as plain strings; "" (a missing effective_from) loses to any date.
    const incumbent = winningFrom.get(areaCode);
    if (incumbent !== undefined && incumbent >= from) return;
    winningFrom.set(areaCode, from);
    regionByArea.set(areaCode, { regionCode, regionName: regionNames.get(regionCode) ?? regionCode });
  });
  // Collected after the winners settle, so a superseded row cannot leave its region in the filter
  // list — the region picker would otherwise offer a district that owns nothing this month.
  const regionCodes = new Set<string>();
  regionByArea.forEach((region) => regionCodes.add(region.regionCode));
  return regionByArea.size > 0 ? { regionByArea, regionCodes } : null;
}

/**
 * The date a closing resolves the organogram at: the LAST DAY OF THE MONTH BEING CLOSED.
 *
 * Not the day the closing is run, and the difference is not academic. The closing golden rule means
 * a month cannot publish before the 1st of the month after it, so every possible run date for
 * August 2026 falls on or after 2026-09-01 — and a structure change dated 2026-09-01 is in force on
 * every one of them. Resolving at the period end is what keeps a forward-dated territory move out
 * of the month it was deliberately dated to spare. The Anti Infective Delta (3) split is the case
 * that proved it; see AGENTS.md §4.
 *
 * The period end is also where `au.f_line_area_map_asof(period_end)` resolves inside the attribution
 * engine, so the sheet and the achievement numbers cannot disagree about who owns an area.
 *
 * No period at all — the empty skeleton the UI renders before a month is picked — falls back to
 * Cairo's today, the current structure, which is the right answer when no month has been chosen.
 * Cairo's and not UTC's: Cairo runs two to three hours ahead, so a UTC date is still yesterday
 * until about 03:00 local.
 */
export function closingRegionsAsOfDate(period: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? "").trim());
  if (!match) return currentCairoDateOnlyIso();
  const month = Number(match[2]);
  if (month < 1 || month > 12) return currentCairoDateOnlyIso();
  // Day 0 of the following month is the last day of this one, leap years included.
  const lastDay = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
}

const LINE_AREA_MAP_COLUMNS = "area_code,operational_region_code,effective_from,effective_to";

/**
 * The organogram's area -> region map for one line, as of the month being closed.
 *
 * PASS THE PERIOD, ALWAYS. It is a required argument precisely because it used to be a defaulted
 * one: the loader resolved at `new Date()`, so a territory move dated to the 1st of next month
 * landed on the month before it the moment that month was closed. Pass null only where there is
 * genuinely no month yet — the empty skeleton — never as a shortcut.
 *
 * Reads `au_v_line_area_map_all` — the closing, and (since finding 5) the Territory Drilldown's
 * loadLineAreas, both resolve as-of a chosen date and so read the effective-dated history rather
 * than the open-row view. Every OTHER consumer stays on `au_v_line_area_map`, which exposes open
 * rows only and answers "who owns this area today" — the owner's standing rule that SoS sales
 * attribute to today's structure, never as-was, still governs them. The closing is the one place
 * that has to ask the other question, "who owned it in the month I am closing", and it cannot be
 * answered from open rows alone: a territory move is written as a
 * PAIR, so while it is still in the future the current-only view shows NEITHER half — the old row
 * has an `effective_to`, the new one has not started — and the area silently falls back to its
 * geographic region. That is what the history view exists to close.
 *
 * Falls back to `au_v_line_area_map` if the history view is missing, so this is safe to deploy
 * before its migration is applied. On today's data the two agree exactly: 3 of 150 rows are closed,
 * no area has more than one row, and every 2026 month-end resolves identically either way.
 *
 * Fails SOFT. A null return means "no organogram view of this line" and the caller keeps the
 * geographic grouping it has always used — which is also the right answer for Head Office, a
 * confidential line with no field structure at all. A closing must never fail to render because
 * the org chart is unavailable.
 */
export async function loadLineOperationalRegions(
  lineCode: string | null | undefined,
  period: string | null | undefined,
): Promise<LineOperationalRegionMap | null> {
  if (!lineCode) return null;
  try {
    const supabase = getSupabaseAdmin();
    const [historyResult, regionResult] = await Promise.all([
      supabase.from("au_v_line_area_map_all").select(LINE_AREA_MAP_COLUMNS).eq("line_code", lineCode),
      supabase.from("au_v_regions").select("region_code,region_name"),
    ]);
    // Only the history view's absence is worth a second round trip; a fallback that also masked a
    // real outage would hand the closing a half-built map, which is worse than no map at all.
    const mapResult = historyResult.error
      ? await supabase.from("au_v_line_area_map").select(LINE_AREA_MAP_COLUMNS).eq("line_code", lineCode)
      : historyResult;
    if (mapResult.error || !mapResult.data) return null;

    const regionNames = new Map<string, string>();
    (regionResult.error ? [] : regionResult.data ?? []).forEach((row) => {
      const typed = row as { region_code?: string | null; region_name?: string | null };
      const code = up(typed.region_code);
      if (code) regionNames.set(code, String(typed.region_name ?? "").trim() || code);
    });

    return buildOperationalRegionMap(
      mapResult.data as Array<Record<string, unknown>>,
      closingRegionsAsOfDate(period),
      regionNames,
    );
  } catch {
    return null; // see "Fails SOFT" above
  }
}

/**
 * Answers "which DM territory owned this area, on this line, in this month" for MANY lines and
 * MANY months from a single pair of reads.
 *
 * `loadLineOperationalRegions` above is per line and per month, which is exactly right for a
 * closing — it shows one line, for one month. The executive dashboard shows every line the viewer
 * is entitled to, across a selected month set plus its prior and year-ago anchors, so the per-line
 * loader would be one round trip per (line, month) pair on the hot path of the page.
 *
 * The dating is NOT hoisted out of the loop. `buildOperationalRegionMap` is re-run per (line,
 * month) against the same unordered rows, because that is the function that applies the
 * `effective_from <= asOf < effective_to` window — resolving once at "now" and reusing it for
 * every month is precisely the bug `closingRegionsAsOfDate` exists to prevent (AGENTS.md §4, the
 * August / Delta (3) golden rule). Two months therefore legitimately get two different maps.
 *
 * Fails SOFT exactly like the per-line loader: on any read failure every lookup returns null and
 * the caller keeps the geographic grouping it has always used. A dashboard must never fail to
 * render because the org chart is unavailable.
 *
 * The unfiltered select is safe at this size and only at this size: the whole history view is 155
 * rows (147 open) against `au_v_regions`' 10, measured on production 2026-08-31. An unbounded
 * PostgREST select stops at 1000 rows with no marker of any kind, so if the org chart ever grows
 * toward that, this needs paging — a silently truncated map does not fail, it just stops moving
 * some areas.
 */
export type OperationalRegionResolver = {
  /** null ⇒ this line does not use organogram regions, or the org chart could not be read. */
  forLinePeriod: (officialLine: string | null | undefined, period: string | null | undefined) => LineOperationalRegionMap | null;
  /** Display name for a region code, covering codes that exist ONLY operationally (UE-1, UE-2). */
  regionName: (regionCode: string) => string | undefined;
  /** False when the org chart could not be read at all — the caller then knows it is on geography. */
  available: boolean;
};

const EMPTY_RESOLVER: OperationalRegionResolver = {
  forLinePeriod: () => null,
  regionName: () => undefined,
  available: false,
};

export async function loadOperationalRegionResolver(): Promise<OperationalRegionResolver> {
  try {
    const supabase = getSupabaseAdmin();
    const [historyResult, regionResult] = await Promise.all([
      supabase.from("au_v_line_area_map_all").select(`line_code,${LINE_AREA_MAP_COLUMNS}`),
      supabase.from("au_v_regions").select("region_code,region_name"),
    ]);
    // Same rule as the per-line loader: only the history view's ABSENCE earns a second round trip.
    // A fallback that also masked a real outage would hand the caller a half-built map, which is
    // worse than no map at all — it would silently move some areas and not others.
    const mapResult = historyResult.error
      ? await supabase.from("au_v_line_area_map").select(`line_code,${LINE_AREA_MAP_COLUMNS}`)
      : historyResult;
    if (mapResult.error || !mapResult.data) return EMPTY_RESOLVER;

    const regionNames = new Map<string, string>();
    (regionResult.error ? [] : regionResult.data ?? []).forEach((row) => {
      const typed = row as { region_code?: string | null; region_name?: string | null };
      const code = up(typed.region_code);
      if (code) regionNames.set(code, String(typed.region_name ?? "").trim() || code);
    });

    const rowsByLine = new Map<string, Array<Record<string, unknown>>>();
    (mapResult.data as Array<Record<string, unknown>>).forEach((row) => {
      const lineCode = String(row.line_code ?? "").trim().toLowerCase();
      if (!lineCode) return;
      const bucket = rowsByLine.get(lineCode);
      if (bucket) bucket.push(row);
      else rowsByLine.set(lineCode, [row]);
    });

    const cache = new Map<string, LineOperationalRegionMap | null>();
    return {
      available: true,
      regionName: (regionCode) => regionNames.get(up(regionCode)),
      forLinePeriod: (officialLine, period) => {
        const lineCode = resolveTargetLineCode(officialLine);
        // Head Office resolves to null here and must: it is a confidential line with no field
        // structure, and it is not on the organogram list either way.
        if (!lineCode || !usesOrganogramRegions(lineCode)) return null;
        const asOf = closingRegionsAsOfDate(period);
        const key = `${lineCode} ${asOf}`;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const built = buildOperationalRegionMap(rowsByLine.get(lineCode) ?? [], asOf, regionNames);
        cache.set(key, built);
        return built;
      },
    };
  } catch {
    return EMPTY_RESOLVER; // see "Fails SOFT" above
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

    // Paged in full: a single read stops at a fixed row count with no error, and a short list here
    // would quietly skew the shares. A failed page throws into the catch below (the pro-rata fallback).
    const rowData = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("source_of_sales_import_rows")
          .select("region_code,product_code,value,raw_row")
          .in("batch_id", batchIds)
          .eq("is_direct", true)
          .eq("official_line", line),
      "id",
    );

    return rowData
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
 * 🔴 NEVER WIRED, AND THE OWNER HAS RULED THAT IT NEVER WILL BE (2026-09-30, asked directly and
 * answered): *"this is previously, when we used the Excel import direct order. Now direct orders are
 * all from the system, from the direct order request, so we'll never meet this situation again. The
 * last time was July. Starting from August you will not see this split again. So September, don't
 * split it, never."*
 *
 * He is right, and it is measurable: a split only ever happens for a Direct row with a BLANK area
 * (the allocator passes an area-carrying row straight through), and blank-area Direct rows ended
 * with July. Measured on production that day, Anti Infective via `phx_monthly_closing_direct`:
 * **2026-07 8 of 8 rows blank · 2026-08 0 of 9 · 2026-09 0 of 14** — every row since August carries
 * its own area and brick, written by `direct_order_request`. July is published AND locked, so the
 * one month this could ever have changed can never be restated (AGENTS.md §4).
 *
 * So: do NOT create the `au_v_direct_region_allocation` wrapper view, do NOT pass `allocationWeights`
 * at the call site, and do NOT re-raise this as a finding — a select-audit WILL flag the missing view
 * again, because the read below names a relation that does not exist in `public`. That is expected.
 * This function is unreachable by design and is kept only so the reasoning is not rediscovered from
 * scratch. `tests/closing-organogram-regions.test.ts` pins that nothing calls it.
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

/**
 * The organogram region code that means "Others" — the manager territory a line parks an area in
 * when it has no district of its own on that line.
 *
 * 🔴 IT IS NOT A GEOGRAPHY. Down town (CA5) sits in Cairo on the map and in OT on the Pedia
 * organogram; Kafr El-Sheikh 2 (D17) is in OT on Pedia AND CNS; Qalubeya (D11) is in OT on Anti
 * Infective. So "is this area in Others" can only be answered per LINE, from the map below — never
 * from the area code, and never from the geographic region.
 */
export const OTHERS_REGION_CODE = "OT";

/**
 * Every area this line's organogram parks in Others, upper-cased.
 *
 * Pure: it reads a map the caller already loaded, so a caller that has the resolver spends no extra
 * round trip. Returns an EMPTY set when the map is null — which is the safe direction, because an
 * empty exclusion list splits exactly as the code did before this existed. A missing org chart must
 * never silently REMOVE areas from a distribution; that would move money on an outage.
 */
export function othersAreasFrom(map: LineOperationalRegionMap | null): ReadonlySet<string> {
  const others = new Set<string>();
  if (!map) return others;
  for (const [areaCode, region] of map.regionByArea) {
    if (String(region.regionCode ?? "").trim().toUpperCase() === OTHERS_REGION_CODE) {
      others.add(String(areaCode).trim().toUpperCase());
    }
  }
  return others;
}

/**
 * The line code an Others lookup must use, from whatever form the caller holds.
 *
 * 🔴 EXTRACTED SO IT CAN BE TESTED WITHOUT A DATABASE, because getting it wrong fails GREEN.
 * Callers hold DISPLAY NAMES — `ATTRIBUTION_SPLIT_LINES` is `["Pedia", "Anti Infective", "CNS"]`,
 * and the closing passes `matrix.line` — while `au_v_line_area_map*` is keyed by CODE
 * (`anti_infective`). Hand the view a name and the `.eq` matches nothing; no rows builds an EMPTY
 * exclusion set, and an empty set is exactly how the split spells "nothing is in Others". The rule
 * then silently does not apply: no error, no missing row, every area keeps its share.
 *
 * Measured 2026-09-08 — the first deploy of the Others rule was completely inert in production for
 * this reason, and the only thing that caught it was a backfill dry run still printing "49 areas".
 *
 * Falls back to the trimmed input rather than null so a line the alias table has not heard of is
 * looked up as given: it will find nothing, which is the same safe direction as before.
 */
export function othersLookupLineCode(officialLine: string | null | undefined): string {
  const raw = String(officialLine ?? "").trim();
  return resolveTargetLineCode(raw) ?? raw;
}

/** `othersAreasFrom` for a caller holding only a line and a period. One round trip. */
export async function loadOthersAreas(
  officialLine: string | null | undefined,
  period: string | null | undefined,
): Promise<ReadonlySet<string>> {
  return othersAreasFrom(await loadLineOperationalRegions(othersLookupLineCode(officialLine), period));
}

/**
 * Every area of the line's organogram, grouped by its operational region code, upper-cased.
 *
 * Pure, same as `othersAreasFrom`, and an EMPTY map for a null input for the same reason: a missing
 * org chart must never silently change a distribution. An empty map means no regional block matches,
 * so every warehouse falls back to its own governorate — where the money already was.
 */
export function areasByRegionFrom(
  map: LineOperationalRegionMap | null,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byRegion = new Map<string, Set<string>>();
  if (!map) return byRegion;
  for (const [areaCode, region] of map.regionByArea) {
    const code = String(region.regionCode ?? "").trim().toUpperCase();
    const area = String(areaCode).trim().toUpperCase();
    if (!code || !area) continue;
    const bucket = byRegion.get(code) ?? new Set<string>();
    bucket.add(area);
    byRegion.set(code, bucket);
  }
  return byRegion;
}

/**
 * Everything the split needs from one organogram read, in the shape the split takes.
 *
 * 🔴 THE POINT IS THAT IT IS ONE CALL. Others and the Upper Egypt block come from the same
 * rows, and both fail SILENTLY and in the same direction when a lookup misses — an empty set reads
 * as "the rule does not apply", which is precisely how the Others rule shipped inert in production
 * on 2026-09-08. Two loaders would let a caller update one and not the other, and nothing would
 * report it. See `SplitRegions` in store-sales-city-split.ts.
 */
export function splitRegionsFrom(map: LineOperationalRegionMap | null): SplitRegions {
  return { areasByRegion: areasByRegionFrom(map), others: othersAreasFrom(map) };
}

/** `splitRegionsFrom` for a caller holding only a line and a period. One round trip. */
export async function loadSplitRegions(
  officialLine: string | null | undefined,
  period: string | null | undefined,
): Promise<SplitRegions> {
  return splitRegionsFrom(await loadLineOperationalRegions(othersLookupLineCode(officialLine), period));
}

/**
 * The manager who runs each operational region on a line, for naming a downloaded workbook:
 * region name (lower-cased, trimmed) -> manager's English full name.
 *
 * Reads the same three views the region grouping and `loadRegionBySubmitter` read — the current
 * line-area map (region -> district-manager seat), the org tree (seat -> occupant) and the region
 * names — so the manager is the one the closing's own region is drawn from. A region whose seats
 * hold more than one person, a vacant seat, or an unreadable view is simply absent: the file is then
 * named for the region alone. It never throws and never guesses; a name is a courtesy, not data.
 *
 * Current structure only. The map's dated rows decide which areas a past month's region held; the
 * manager named on a file is whoever runs the region today.
 */
export async function loadRegionManagerNames(lineCode: string | null | undefined): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const code = othersLookupLineCode(lineCode);
  if (!code) return names;
  try {
    const supabase = getSupabaseAdmin();
    const [mapResult, treeResult, regionResult] = await Promise.all([
      supabase.from("au_v_line_area_map").select("operational_region_code,dm_seat_id").eq("line_code", code),
      supabase.from("au_v_org_tree_sales").select("seat_id,occupant_hr_id").eq("line_code", code),
      supabase.from("au_v_regions").select("region_code,region_name"),
    ]);
    if (mapResult.error || treeResult.error || regionResult.error) return names;

    const occupantBySeat = new Map<string, string>();
    (treeResult.data ?? []).forEach((row) => {
      const typed = row as { seat_id?: string | null; occupant_hr_id?: string | null };
      const seat = String(typed.seat_id ?? "").trim();
      const hrId = String(typed.occupant_hr_id ?? "").trim();
      if (seat && hrId) occupantBySeat.set(seat, hrId);
    });
    const hrIdsByRegion = new Map<string, Set<string>>();
    (mapResult.data ?? []).forEach((row) => {
      const typed = row as { operational_region_code?: string | null; dm_seat_id?: string | null };
      const region = up(typed.operational_region_code);
      const hrId = occupantBySeat.get(String(typed.dm_seat_id ?? "").trim());
      if (!region || !hrId) return;
      const held = hrIdsByRegion.get(region) ?? new Set<string>();
      held.add(hrId);
      hrIdsByRegion.set(region, held);
    });
    const hrIds = [...new Set([...hrIdsByRegion.values()].flatMap((held) => [...held]))];
    if (hrIds.length === 0) return names;

    const employeeResult = await supabase.from("employees").select("hr_id,full_name").in("hr_id", hrIds);
    if (employeeResult.error) return names;
    const nameByHrId = new Map<string, string>();
    (employeeResult.data ?? []).forEach((row) => {
      const typed = row as { hr_id?: string | null; full_name?: string | null };
      const hrId = String(typed.hr_id ?? "").trim();
      const fullName = String(typed.full_name ?? "").trim();
      if (hrId && fullName) nameByHrId.set(hrId, fullName);
    });
    const regionNameByCode = new Map<string, string>();
    (regionResult.data ?? []).forEach((row) => {
      const typed = row as { region_code?: string | null; region_name?: string | null };
      const regionCode = up(typed.region_code);
      const regionName = String(typed.region_name ?? "").trim();
      if (regionCode && regionName) regionNameByCode.set(regionCode, regionName);
    });

    hrIdsByRegion.forEach((held, regionCode) => {
      if (held.size !== 1) return;
      const regionName = regionNameByCode.get(regionCode);
      const manager = nameByHrId.get([...held][0]);
      if (regionName && manager) names.set(regionName.toLowerCase(), manager);
    });
    return names;
  } catch {
    return names;
  }
}
