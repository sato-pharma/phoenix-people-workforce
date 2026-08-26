// Read a distributor branch name and work out which territory it serves.
//
// Weekly sales arrive per DEPOT, and the depot's name is the only description of where its money
// went — there is no customer and no brick on a weekly row. Measured on production 2026-08-27,
// 161 branches carrying EGP 57,105,208 (67.9% of all tracked-line weekly value) reach a manager
// but no rep, purely because nobody has read their names. This is what reads them.
//
// The names are a mix of Arabic and English transliteration, usually with a role prefix:
//
//   ك.عملاء الغربية 2      key accounts, Gharbia 2        -> one area   (D15)
//   ك.ع.الدقهلية2 ودمياط   key accounts, Dakahlia 2 AND Damietta -> D22 50% + D26 50%
//   Key Acc. W Shebien     Shebin El Kom = Menoufia       -> D12 50% + D13 50%
//   Super KA Alex          Alexandria, no usable number   -> AB1/AB2/AB3, a third each
//   Direct – Delta (1)     names a region, not a place    -> the region's areas, evenly
//
// THREE CLASSES ARE NOT TERRITORIES AT ALL and are deliberately NOT split to reps:
// warehouses (EGP 507,869), private hospitals (EGP 1,091,946) and tenders (EGP 76,550). A stock
// transfer into a warehouse is not a sale in anyone's territory, a tender is institutional, and
// whether a private hospital is the local rep's credit is a commercial decision. They keep today's
// region-level behaviour and are labelled, pending the owner's answer. Changing that is a one-line
// edit to NON_TERRITORY_CLASSES once he rules.

import {
  GOVERNORATES_BY_AREA,
  normalizeArabic,
  placeMentions,
  type GovernorateKey,
} from "@/lib/sales/weekly/governorates";
import type { WeeklyAreaSplitIndex, WeeklyBranchScope } from "@/lib/sales/weekly/branch-area-split";

export type WeeklyBranchClass = "territory" | "warehouse" | "hospital" | "tender" | "unreadable";

/** Classes that stop at the region instead of splitting down to reps. */
export const NON_TERRITORY_CLASSES: ReadonlySet<WeeklyBranchClass> = new Set<WeeklyBranchClass>([
  "warehouse", "hospital", "tender",
]);

export type WeeklyBranchReading = {
  branchClass: WeeklyBranchClass;
  /** Null means "do not split this branch" — either it is not a territory, or nothing was readable. */
  scope: WeeklyBranchScope | null;
  /** Plain-language reason, shown beside the branch in the mapping sheet. */
  note: string;
};

/**
 * The "overseas" distributor mirrors every POS branch with a `_ك` suffix. Same place, same split.
 * Role prefixes carry no geography either, so they come off before the name is read — otherwise
 * "Retail Qena" and "قنا" would be treated as two different questions.
 */
const NOISE = [
  /_ك\s*$/u,
  /^\s*(ك\s*\.\s*ع\s*(?:ملاء)?|كبار\s+عملاء|ك\s*\.\s*عملاء)\s*\.?/u,
  /^\s*(key\s+acc(?:ounts?)?\.?\s*w?|super\s+ka\.?\s*w?|private\s+hospi|retail|direct|ws|wholesale|جملة|فرع|مركز\s+تموين)\s*[-–—.]?\s*/iu,
];

function stripRoleWords(branchName: string): string {
  let out = String(branchName ?? "");
  for (const pattern of NOISE) out = out.replace(pattern, " ");
  return out.trim();
}

/** Classify before reading geography: "Assiut 2 Warehouse" names a governorate but is not one. */
export function classifyWeeklyBranch(branchName: string | null | undefined): WeeklyBranchClass {
  const text = normalizeArabic(branchName);
  if (/warehouse|storage|مستودع|رئيسي|central|main store/u.test(text)) return "warehouse";
  if (/مناقصات|tender/u.test(text)) return "tender";
  if (/hospi|مستشفيات|مستشفي/u.test(text)) return "hospital";
  return "territory";
}

/** The one area of `governorate` whose NAME carries this standalone number, e.g. "Gharbia 2" -> D15. */
function areaForOrdinal(
  index: WeeklyAreaSplitIndex,
  governorate: GovernorateKey,
  ordinal: number,
): string | null {
  const matches: string[] = [];
  for (const [code, name] of index.areaNames) {
    if (!(GOVERNORATES_BY_AREA[code] ?? []).includes(governorate)) continue;
    // Read the numbers out of the name rather than building a regex around the ordinal: a `\d`
    // written inside a template literal is the letter d, not a digit class, and the resulting
    // near-miss regex still matches often enough to look correct in testing.
    const numbers = (name.match(/\d+/g) ?? []).map(Number);
    if (numbers.includes(ordinal)) matches.push(code);
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Read one branch name into a scope.
 *
 * `fallbackRegionCode` is the region already stamped on the row. It is the floor, not a guess: every
 * one of the 161 branches carries one that resolves to a real seat, so a name nobody can read still
 * spreads across the right region rather than vanishing.
 */
export function readWeeklyBranchName(
  index: WeeklyAreaSplitIndex,
  branchName: string | null | undefined,
  fallbackRegionCode?: string | null,
): WeeklyBranchReading {
  const region = String(fallbackRegionCode ?? "").trim().toUpperCase();
  const regionScope: WeeklyBranchScope | null = region ? { kind: "region", regionCode: region } : null;

  const branchClass = classifyWeeklyBranch(branchName);
  if (NON_TERRITORY_CLASSES.has(branchClass)) {
    const reason = branchClass === "warehouse" ? "a stock location, not a territory"
      : branchClass === "tender" ? "an institutional tender, not field-force sales"
      : "a private hospital — a channel, not a territory";
    return { branchClass, scope: null, note: `Not split: ${reason}. Stays at region level.` };
  }

  const mentions = placeMentions(stripRoleWords(String(branchName ?? "")));
  if (mentions.length === 0) {
    return regionScope
      ? { branchClass: "unreadable", scope: regionScope, note: `No place in the name — spread evenly across region ${region}.` }
      : { branchClass: "unreadable", scope: null, note: "No place in the name and no region to fall back on." };
  }

  // Each mention becomes one part, and the parts share the value evenly — the owner's rule. A
  // governorate written with a number the AREA names actually use is pinned to that one area:
  // "الدقهلية2 ودمياط" is Dakahlia 2 and Damietta, 50/50, not all three Dakahlia areas and Damietta.
  //
  // The ordinal is ignored when no single area answers to it, which is the case that matters most:
  // "ك.عملاء اسكندرية 4" is the depot's own numbering — Alexandria's areas are East, Center and
  // West — so it correctly falls back to all of Alexandria instead of inventing a fourth rep.
  const parts: WeeklyBranchScope[] = [];
  const labels: string[] = [];
  for (const mention of mentions) {
    if (mention.area) {
      parts.push({ kind: "area", areaCode: mention.area });
      labels.push(`${mention.area} ${index.areaNames.get(mention.area) ?? ""}`.trim());
      continue;
    }
    const key = mention.governorate as GovernorateKey;
    const pinned = mention.ordinal != null ? areaForOrdinal(index, key, mention.ordinal) : null;
    if (pinned) {
      parts.push({ kind: "area", areaCode: pinned });
      labels.push(`${pinned} ${index.areaNames.get(pinned) ?? ""}`.trim());
    } else {
      parts.push({ kind: "governorates", names: [key] });
      labels.push(key);
    }
  }

  const scope: WeeklyBranchScope = parts.length === 1 ? parts[0] : { kind: "mixed", parts };
  const note = parts.length === 1
    ? (parts[0].kind === "area"
        ? `Names one area exactly: ${labels[0]}.`
        : `Names ${labels[0]} — split evenly across its areas on each line.`)
    : `Names ${parts.length} places (${labels.join(", ")}) — ${(100 / parts.length).toFixed(100 % parts.length === 0 ? 0 : 1)}% each, then evenly inside each.`;
  return { branchClass: "territory", scope, note };
}
