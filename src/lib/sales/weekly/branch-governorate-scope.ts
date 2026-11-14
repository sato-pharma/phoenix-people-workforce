// Weekly Stock — narrow a viewer's depots from his whole REGION down to his own GOVERNORATE.
//
// WHY THIS EXISTS
// ───────────────
// A weekly row is a depot shipment, and a territory viewer is bounded by his region: a Delta (1)
// district manager whose seat is Menoufia sees every Delta (1) depot — Gharbia, Qalyubia, Kafr
// El-Sheikh and his own. The owner asked for governorate scope instead (2026-09-23): each viewer
// sees only the depots in his OWN governorate, with two deliberate exceptions —
//
//   • Kibar Omala (key-account) depots stay visible to EVERYONE. They are a company-wide book, not
//     a territory. They carry no flag in the data; they are known only by their name tokens, the
//     same tokens branch-name-scope.ts strips (ك.ع / كبار عملاء / key acc / super ka).
//   • A depot whose name states no governorate at all — a region-wide warehouse, a Delta chain, a
//     national tender — keeps its current region-level visibility (the FLOOR). Nothing is hidden
//     that cannot be placed, so no viewer ever loses a depot to a name this cannot read.
//
// This is VISIBILITY ONLY. It never writes area_code and never moves a single unit of attribution:
// the money a depot is credited with is untouched. It reads the depot's own name (and its mapped
// area when it has one) exactly the way the split rule already reads it, through placeMentions, so
// the day a place moves territory this moves with it.
//
// The resolution order for one depot, most reliable first:
//   1. Kibar Omala token in the name        -> ALL (visible to everyone)
//   2. a mapped area_code                    -> that area's governorate(s)
//   3. a hand override (below)               -> its governorate(s), or FLOOR
//   4. a place read out of the name          -> that place's governorate(s)
//   5. nothing readable                      -> FLOOR (region-level, as today)

import {
  AREAS_EXCLUDED_FROM_GOVERNORATES,
  GOVERNORATES_BY_AREA,
  type GovernorateKey,
  normalizeArabic,
  placeMentions,
} from "@/lib/sales/weekly/governorates";
import type { WeeklyAccessScope } from "@/lib/sales/weekly/access";

/** What a depot resolves to: the governorates it belongs to, or a rule that skips governorate scope. */
export type BranchGovernorateScope = Set<GovernorateKey> | "ALL" | "FLOOR";

/** Just the fields of a stock row this reads. */
type BranchGovernorateInput = { branchName: string | null | undefined; areaCode: string | null | undefined };

// The whole Delta and Alex footprints, spelled with the shared table's own keys, for the one owner
// ruling placeMentions cannot read from a bare "Delta": a chain that serves Alex AND Delta.
const ALEX_GOVERNORATES: GovernorateKey[] = ["alexandria", "beheira"];
const DELTA_GOVERNORATES: GovernorateKey[] = [
  "qalyubia", "menoufia", "gharbia", "kafr el-sheikh", // Delta (1)
  "dakahlia", "sharqia", "port said", "damietta", // Delta (2)
];

// Hand overrides, keyed by the depot's own name. Kept as small as it can be: placeMentions already
// reads 104 of the 141 region-only depots correctly (probed on production 2026-09-23). These are the
// few it does not, plus the owner's explicit multi-governorate ruling.
//
//   • منطقة القناة  — placeMentions matched "قنا" INSIDE "القناة" and wrongly returned Qena. The
//     Canal is nowhere near Qena, so it must not narrow to it; left at region level.
//   • Chain - Alex & Delta — owner: "shown to Alex and Delta only." placeMentions reads only Alex
//     from the name.
//   • مينا البصل / قها / Benisuef 2 — a place glued to a role word, so placeMentions floored it; each
//     names one unambiguous governorate.
const RAW_OVERRIDES: Array<[string, GovernorateKey[] | "FLOOR"]> = [
  ["منطقة القناة_ك", "FLOOR"],
  ["Chain - Alex & Delta_ك", [...ALEX_GOVERNORATES, ...DELTA_GOVERNORATES]],
  ["جملة - مينا البصل", ["alexandria"]],
  ["WSقها", ["qalyubia"]],
  ["Benisuef 2 Warehouse", ["beni suef"]],
];

/** Fold a depot name to the key both the override table and its lookup use: Arabic folded, latin lower, spaces collapsed. */
function branchKey(name: string | null | undefined): string {
  return normalizeArabic(String(name ?? "")).toLowerCase().replace(/\s+/g, " ").trim();
}

const OVERRIDES = new Map<string, GovernorateKey[] | "FLOOR">(
  RAW_OVERRIDES.map(([name, value]) => [branchKey(name), value]),
);

// Kibar Omala tokens, mirroring the ones branch-name-scope.ts strips as noise. The Arabic side is
// tested against folded text; the dot is optional so a folder that drops it cannot silently break the
// match. The English side is tested against the raw name. A false positive only ever makes a depot
// MORE visible (shown to all), never less, so erring permissive here is safe.
const KIBAR_OMALA_AR = /كبار\s*عملاء|ك\s*\.?\s*ع/u;
const KIBAR_OMALA_EN = /key\s*acc|super\s*ka/i;

/** True when a depot name carries a key-account (Kibar Omala) token. Such a depot is visible to everyone. */
export function isKibarOmalaBranch(name: string | null | undefined): boolean {
  const raw = String(name ?? "");
  return KIBAR_OMALA_AR.test(normalizeArabic(raw)) || KIBAR_OMALA_EN.test(raw);
}

/** Read one depot into the governorate(s) it belongs to, or a rule that skips governorate scope. Pure. */
export function resolveBranchGovernorates(row: BranchGovernorateInput): BranchGovernorateScope {
  const name = row.branchName;
  if (isKibarOmalaBranch(name)) return "ALL";

  const area = row.areaCode?.trim().toUpperCase();
  if (area && !AREAS_EXCLUDED_FROM_GOVERNORATES.has(area)) {
    const govs = GOVERNORATES_BY_AREA[area];
    if (govs && govs.length > 0) return new Set(govs);
  }

  const override = OVERRIDES.get(branchKey(name));
  if (override !== undefined) return override === "FLOOR" ? "FLOOR" : new Set(override);

  const govs = new Set<GovernorateKey>();
  for (const mention of placeMentions(String(name ?? ""))) {
    if (mention.area && !AREAS_EXCLUDED_FROM_GOVERNORATES.has(mention.area)) {
      for (const gov of GOVERNORATES_BY_AREA[mention.area] ?? []) govs.add(gov);
    } else if (mention.governorate) {
      // A region mention (e.g. "Delta (1)") names no single governorate, so it contributes nothing
      // and the depot floors to region level — exactly its behaviour today.
      govs.add(mention.governorate as GovernorateKey);
    }
  }
  return govs.size > 0 ? govs : "FLOOR";
}

/**
 * The governorates a viewer may see, derived from the areas he is bound to: his territory scope's
 * area codes, plus the areas behind his own-area keys (`${line}|${AREA}`, as a rep's are keyed).
 * Empty means "do not narrow" — a full/product viewer, a region manager with no area bound, or a
 * viewer bound only to an area with no governorate (Main Store). His existing region scope still
 * bounds him; governorate scope only ever narrows further. Pure.
 */
export function viewerGovernorates(
  scope: WeeklyAccessScope,
  ownAreaKeys: ReadonlySet<string>,
): Set<GovernorateKey> {
  const areaCodes = new Set<string>();
  if (scope.tier === "territory" && scope.allowedAreaCodes) {
    for (const code of scope.allowedAreaCodes) {
      const upper = code.trim().toUpperCase();
      if (upper) areaCodes.add(upper);
    }
  }
  for (const key of ownAreaKeys) {
    const area = key.split("|")[1]?.trim().toUpperCase();
    if (area) areaCodes.add(area);
  }

  const govs = new Set<GovernorateKey>();
  for (const area of areaCodes) {
    if (AREAS_EXCLUDED_FROM_GOVERNORATES.has(area)) continue;
    for (const gov of GOVERNORATES_BY_AREA[area] ?? []) govs.add(gov);
  }
  return govs;
}

/**
 * Keep only the depots a viewer's governorates admit: everything when he has no governorate bound
 * (see viewerGovernorates), otherwise a Kibar Omala depot, a depot with no readable governorate
 * (FLOOR), or a depot in at least one of his governorates. Pure; returns the rows themselves, in
 * order.
 */
export function narrowStockRowsToGovernorate<T extends BranchGovernorateInput>(
  rows: readonly T[],
  viewerGovs: ReadonlySet<GovernorateKey>,
): T[] {
  if (viewerGovs.size === 0) return [...rows];
  // A depot reads the same on every row (its name and area), and a stock load holds tens of thousands
  // of rows over a few hundred depots, each read running the whole place table over its name: read
  // each depot once. Kept per call, so nothing outlives the request (14 Nov 2026, the 3.1 s freeze).
  const byDepot = new Map<string, BranchGovernorateScope>();
  return rows.filter((row) => {
    const depot = `${row.areaCode ?? ""}\u0000${row.branchName ?? ""}`;
    let scope = byDepot.get(depot);
    if (scope === undefined) {
      scope = resolveBranchGovernorates(row);
      byDepot.set(depot, scope);
    }
    if (scope === "ALL" || scope === "FLOOR") return true;
    for (const gov of scope) if (viewerGovs.has(gov)) return true;
    return false;
  });
}
