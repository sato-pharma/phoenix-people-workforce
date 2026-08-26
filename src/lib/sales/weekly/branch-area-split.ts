// Split one distributor branch's sales across the areas it actually serves.
//
// THE OWNER'S RULE (2026-08-27)
// ────────────────────────────
// Weekly sales arrive at DISTRIBUTOR-BRANCH grain. A branch is a depot, and its name usually says
// which governorates it serves — "ك.ع.المنيا واسيوط" is the Minya AND Assiut key-account depot.
// Such a branch is not unmappable and it does not belong to one rep. Its money is spread:
//
//   evenly across the governorates the name names, then evenly again across that governorate's
//   areas.
//
//   "Minya and Assiut" -> 50% Minya, 50% Assiut -> UE1 25%, UE2 25%, UE3 25%, UE4 25%
//   "Minya"            -> UE1 50%, UE2 50%
//
// A branch whose name IS a brick (جملة – البلينا -> B214-M1) is not split at all — a brick has
// exactly one area, so it resolves 100% to it.
//
// THE ORGANOGRAM IS THE SOURCE OF TRUTH, AND THE SPLIT IS THEREFORE PER LINE
// ─────────────────────────────────────────────────────────────────────────
// The owner's words: "your source of truth in any distribution is the organogram." That is not a
// formality — the same governorate resolves to DIFFERENT areas on different lines, so a single
// stored area list per branch would be wrong for two lines out of three. Verified live in
// au_v_line_area_map on 2026-08-27:
//
//   UE9 Beni Suef  ->  anti_infective UE-1 (Upper Egypt) · pedia GZ (Giza) · cns OT (Others)
//   UE8 Qena 2     ->  anti_infective UE-2               · pedia OT       · cns OT
//
// So "Qena" splits UE7/UE8 fifty-fifty on Anti Infective, and resolves to UE7 alone under a
// REGION scope on CNS and Pedia, because Qena 2 is not inside those lines' Upper Egypt at all.
// Hard-coding a governorate -> areas table would credit a rep who does not exist on that line.
//
// Nothing here filters on carries_target or area_state. Region membership already does that job:
// a "Upper Egypt" scope asks the organogram which areas that line puts in UE, and an area parked
// in Others simply is not among them. An EXPLICIT governorate scope keeps every area the line maps,
// including one parked in Others — that is a real destination and the organogram says so.

import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** What a branch's name resolves to. Stored per branch; interpreted per line at read time. */
export type WeeklyBranchScope =
  /** The name is a brick. Exactly one area, no split, no ambiguity. */
  | { kind: "brick"; brickId: string; areaCode: string }
  /** The name is one area. No split. */
  | { kind: "area"; areaCode: string }
  /** The name lists governorates. Even across them, then even inside each. */
  | { kind: "governorates"; names: string[] }
  /** The name is a whole region ("Upper Egypt"). Even across that line's areas in it. */
  | { kind: "region"; regionCode: string };

export type WeeklyAreaShare = {
  areaCode: string;
  /** Fraction of the row's value. Every share list returned here sums to exactly 1. */
  weight: number;
};

export type WeeklyAreaSplitIndex = {
  /** `line||governorate` (both lowercased) -> the area codes that line maps in that governorate. */
  areasByLineGovernorate: Map<string, string[]>;
  /** `line||REGION` -> the area codes that line places in that operational region. */
  areasByLineRegion: Map<string, string[]>;
  /** area code -> display name, for the calculation the mapping sheet shows. */
  areaNames: Map<string, string>;
};

const splitKey = (line: string, token: string) => `${line}||${token}`;

/**
 * "Minia 1" -> "minia", "Sohag1" -> "sohag", "Qena 2" -> "qena", "Beni Suef" -> "beni suef".
 *
 * The governorate is the area name with its trailing rep number removed. Phoenix names areas that
 * way throughout, which is why this needs no lookup table — and why a table would go stale the
 * first time an area is renamed or a third rep is added to a governorate.
 */
export function governorateOfAreaName(areaName: string | null | undefined): string {
  return String(areaName ?? "")
    .trim()
    .replace(/[\s\-_]*\d+$/, "")
    .trim()
    .toLowerCase();
}

export type WeeklyAreaSplitMapRow = {
  line_code?: string; area_code?: string; operational_region_code?: string;
  effective_from?: string | null; effective_to?: string | null;
};
export type WeeklyAreaSplitAreaRow = { area_code?: string; area_name?: string };

/**
 * Pure index build, so the split can be proven against a fixture — and against a dump of the real
 * organogram — without a database. `today` is injected for the same reason.
 */
export function buildWeeklyAreaSplitIndex(
  mapRows: WeeklyAreaSplitMapRow[],
  areaRows: WeeklyAreaSplitAreaRow[],
  today: string,
): WeeklyAreaSplitIndex {
  const areaNames = new Map<string, string>();
  for (const row of areaRows) {
    const code = String(row.area_code ?? "").trim().toUpperCase();
    const name = String(row.area_name ?? "").trim();
    if (code && name && !areaNames.has(code)) areaNames.set(code, name);
  }

  const areasByLineGovernorate = new Map<string, string[]>();
  const areasByLineRegion = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, area: string) => {
    const list = map.get(key);
    if (!list) map.set(key, [area]);
    else if (!list.includes(area)) list.push(area);
  };

  for (const r of mapRows) {
    const from = r.effective_from ?? null;
    const to = r.effective_to ?? null;
    if (from && from > today) continue;
    if (to && to <= today) continue;

    const line = resolveTargetLineCode(String(r.line_code ?? "").trim());
    const area = String(r.area_code ?? "").trim().toUpperCase();
    const region = String(r.operational_region_code ?? "").trim().toUpperCase();
    if (!line || !area) continue;

    if (region) push(areasByLineRegion, splitKey(line, region), area);
    const governorate = governorateOfAreaName(areaNames.get(area));
    if (governorate) push(areasByLineGovernorate, splitKey(line, governorate), area);
  }

  // Deterministic order so a split's shares — and the sheet that prints them — never reshuffle.
  for (const list of areasByLineGovernorate.values()) list.sort();
  for (const list of areasByLineRegion.values()) list.sort();

  return { areasByLineGovernorate, areasByLineRegion, areaNames };
}

/** Load the organogram and build the index. Fails soft: an empty index splits nothing. */
export async function loadWeeklyAreaSplitIndex(): Promise<WeeklyAreaSplitIndex> {
  const supabase = getSupabaseAdmin();
  const [mapResult, areaResult] = await Promise.all([
    supabase.from("au_v_line_area_map").select("line_code, area_code, operational_region_code, effective_from, effective_to"),
    supabase.from("source_of_sales_areas").select("area_code, area_name"),
  ]);
  return buildWeeklyAreaSplitIndex(
    mapResult.error ? [] : ((mapResult.data ?? []) as WeeklyAreaSplitMapRow[]),
    areaResult.error ? [] : ((areaResult.data ?? []) as WeeklyAreaSplitAreaRow[]),
    new Date().toISOString().slice(0, 10),
  );
}

/**
 * The areas a REGION scope covers on one line, honouring district refinements.
 *
 * "Upper Egypt" is not one region on every line. Anti Infective has no region `UE` at all — it has
 * `UE-1` and `UE-2` — so an exact match returns nothing and a branch named for the whole region
 * would silently resolve to no areas. A region therefore also matches its `<CODE>-<n>` refinements,
 * the same predicate Monthly Closing uses in isClosingRegionRefinement.
 *
 * This is what makes the owner's per-line Beni Suef rule fall out for free rather than being coded:
 *   Anti Infective  "UE" -> UE-1 ∪ UE-2 -> includes UE9 Beni Suef
 *   Pedia           "UE" -> UE           -> EXCLUDES UE9, because Pedia files Beni Suef under GZ
 *   CNS             "UE" -> UE           -> EXCLUDES UE9, because CNS files Beni Suef under OT
 */
function areasForRegionScope(index: WeeklyAreaSplitIndex, line: string, regionCode: string): string[] {
  const code = regionCode.trim().toUpperCase();
  if (!code) return [];
  const exact = index.areasByLineRegion.get(splitKey(line, code));
  if (exact && exact.length > 0) return exact;

  const prefix = `${code}-`;
  const merged: string[] = [];
  for (const [key, areas] of index.areasByLineRegion) {
    const [keyLine, keyRegion] = key.split("||");
    if (keyLine !== line || !keyRegion.startsWith(prefix)) continue;
    for (const area of areas) if (!merged.includes(area)) merged.push(area);
  }
  return merged.sort();
}

/**
 * The shares one branch's value takes on ONE line. Returns [] when the scope resolves to nothing on
 * that line — the caller must then leave the row alone rather than invent a destination.
 */
export function resolveBranchAreaShares(
  index: WeeklyAreaSplitIndex,
  officialLine: string | null | undefined,
  scope: WeeklyBranchScope | null | undefined,
): WeeklyAreaShare[] {
  if (!scope) return [];
  const line = resolveTargetLineCode(String(officialLine ?? "").trim());
  if (!line) return [];

  if (scope.kind === "brick" || scope.kind === "area") {
    const area = String(scope.kind === "brick" ? scope.areaCode : scope.areaCode).trim().toUpperCase();
    return area ? [{ areaCode: area, weight: 1 }] : [];
  }

  if (scope.kind === "region") {
    const areas = areasForRegionScope(index, line, scope.regionCode);
    if (areas.length === 0) return [];
    return areas.map((areaCode) => ({ areaCode, weight: 1 / areas.length }));
  }

  // Governorates: even across the governorates that resolve on THIS line, then even inside each.
  // A governorate the line does not map at all (Beni Suef on CNS reaches Others, but a line that
  // mapped it nowhere) drops out, and the rest share the whole — never a silent short-pay.
  const groups = scope.names
    .map((name) => index.areasByLineGovernorate.get(splitKey(line, name.trim().toLowerCase())) ?? [])
    .filter((areas) => areas.length > 0);
  if (groups.length === 0) return [];

  const perGovernorate = 1 / groups.length;
  const shares = new Map<string, number>();
  for (const areas of groups) {
    for (const areaCode of areas) {
      shares.set(areaCode, (shares.get(areaCode) ?? 0) + perGovernorate / areas.length);
    }
  }
  return [...shares.entries()].map(([areaCode, weight]) => ({ areaCode, weight }));
}

/**
 * The same split rendered for the mapping sheet — "UE1 Minia 1 25%  ·  EGP 399,338".
 * The owner asked for the calculation to be visible where the mapping is done, not just applied.
 */
export function describeBranchAreaShares(
  index: WeeklyAreaSplitIndex,
  shares: WeeklyAreaShare[],
  value?: number,
): string {
  if (shares.length === 0) return "";
  return shares
    .map((share) => {
      const pct = share.weight * 100;
      const name = index.areaNames.get(share.areaCode);
      const head = `${share.areaCode}${name ? ` ${name}` : ""} ${pct.toFixed(Math.abs(pct % 1) < 0.005 ? 0 : 2)}%`;
      if (!Number.isFinite(value as number)) return head;
      return `${head} = ${Math.round((value as number) * share.weight).toLocaleString("en-US")}`;
    })
    .join("   ·   ");
}
