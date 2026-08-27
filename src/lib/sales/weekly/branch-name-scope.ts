// Read a distributor branch name and work out which territory it serves.
//
// Weekly sales arrive per DEPOT, and the depot's name is the only description of where its money
// went — there is no customer and no brick on a weekly row. Measured on production 2026-08-27,
// 152 branches carrying EGP 57,539,669 (67.9% of all tracked-line weekly value) reach a manager
// but no rep, purely because nobody has read their names. This is what reads them.
//
// The names are a mix of Arabic and English transliteration, usually with a role prefix, and they
// name a place at four different grains. All four are read, most precise first:
//
//   جملة – البلينا        El-Balyana, a BRICK               -> UE6 Sohag 2, exactly
//   ك.عملاء امبابة        Imbaba, one of our AREAS          -> GZ3, exactly
//   Key Acc. W Shebien   Shebin El Kom = Menoufia          -> D12 50% + D13 50%
//   Direct – Delta (1)   a REGION of the organogram        -> that region's areas, evenly
//
// and two names at once split evenly between them first: "ك.ع.الدقهلية2 ودمياط" is Dakahlia **2**
// and Damietta, so D22 50% + D26 50%, not all three Dakahlia areas beside Damietta.
//
// TWO CLASSES ARE NOT TERRITORIES AT ALL and are deliberately NOT split to reps: warehouses
// (EGP 507,869) and tenders (EGP 76,550). A stock transfer into a warehouse is not a sale in
// anyone's territory, and a tender is institutional. Both keep region-level behaviour, labelled.
//
// PRIVATE HOSPITALS WERE A THIRD SUCH CLASS UNTIL 2026-08-27. Whether a private hospital is the
// local rep's credit was never a technical question, and this comment said exactly that while
// EGP 1,091,946 sat crediting nobody. The owner was asked and ruled: YES, credit the area the
// hospital sits in. So `hospital` still CLASSIFIES — that is what keeps a name like "Assiut 2
// Warehouse" from being read as a governorate — but it no longer stops the split.

import {
  GOVERNORATES_BY_AREA,
  normalizeArabic,
  placeMentions,
  type GovernorateKey,
} from "@/lib/sales/weekly/governorates";
import { regionName } from "@/lib/sales/monthly-targets";
import type { WeeklyAreaSplitIndex, WeeklyBranchScope } from "@/lib/sales/weekly/branch-area-split";

export type WeeklyBranchClass = "territory" | "warehouse" | "hospital" | "tender" | "unreadable";

/** Classes that stop at the region instead of splitting down to reps. */
export const NON_TERRITORY_CLASSES: ReadonlySet<WeeklyBranchClass> = new Set<WeeklyBranchClass>([
  "warehouse", "tender",
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

/**
 * Build a matcher over words written in real Arabic but compared against FOLDED text.
 *
 * normalizeArabic rewrites the hamza forms, so a pattern spelled the way a human types it can never
 * match the text it is tested against: "رئيسي" becomes "رييسي" in the haystack, and the literal
 * "رئيسي" in the regex then matches nothing — silently, and forever. Folding the pattern too is the
 * only version of this that stays correct while remaining readable at the call site.
 */
const foldedMatcher = (words: string[]) => new RegExp(words.map((word) => normalizeArabic(word)).join("|"), "u");

const WAREHOUSE = foldedMatcher(["warehouse", "storage", "مستودع", "رئيسي", "central", "main store"]);
const TENDER = foldedMatcher(["مناقصات", "tender"]);
const HOSPITAL = foldedMatcher(["hospi", "مستشفيات", "مستشفي"]);

/** Classify before reading geography: "Assiut 2 Warehouse" names a governorate but is not one. */
export function classifyWeeklyBranch(branchName: string | null | undefined): WeeklyBranchClass {
  const text = normalizeArabic(branchName);
  if (WAREHOUSE.test(text)) return "warehouse";
  if (TENDER.test(text)) return "tender";
  if (HOSPITAL.test(text)) return "hospital";
  return "territory";
}

/**
 * Depot spellings of a brick that the bricks table spells differently.
 *
 * The AREA still comes from source_of_sales_bricks — this bridges the spelling only, so the day
 * Mallawi moves territory the answer moves with it. Mallawi is the owner's own example: the branch
 * writes "ملوى" and the brick table writes "ملاوى", one alef apart, which no amount of folding
 * should paper over generally — dropping alefs outright would collide names across 696 bricks.
 */
const BRICK_SPELLING_BRIDGE: Array<[string, string]> = [["ملوى", "ملاوى"]];

/**
 * A governorate's canonical key as something a person reads.
 *
 * placeAliases is keyed on lowercase tokens — "matrouh", "kafr el-sheikh", "beni suef" — because it
 * is a lookup table, not a display list. Printing that key straight onto the mapping sheet breaks the
 * owner's standing rule that a screen shows names and never raw codes, so it is cased here. Only the
 * label changes; the key itself is still what the map is looked up by.
 */
function governorateLabel(key: string): string {
  return key
    .split(" ")
    .map((word) => word.split("-").map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join("-"))
    .join(" ");
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

/** The whole name IS a brick — the most precise reading there is. Null when it is not one. */
function brickScope(index: WeeklyAreaSplitIndex, stripped: string): { areaCode: string; brick: string } | null {
  const normalized = normalizeArabic(stripped);
  if (!normalized) return null;
  const candidates = [normalized];
  for (const [depotSpelling, brickSpelling] of BRICK_SPELLING_BRIDGE) {
    if (normalized === normalizeArabic(depotSpelling)) candidates.push(normalizeArabic(brickSpelling));
  }
  for (const candidate of candidates) {
    const areaCode = index.areaByBrick.get(candidate);
    if (areaCode) return { areaCode, brick: stripped };
  }
  return null;
}

/**
 * Read one branch name into a scope.
 *
 * `fallbackRegionCode` is the region the owner's own branch mapping already put on the row, used
 * only when the NAME states no place at all. It is his data rather than a guess, and it is
 * self-limiting: "Direct – National" carries NATIONAL and "Unallocated POS" carries nothing, and
 * neither resolves to any area, so those rows are left exactly where they are. What it does place
 * is the depot mapped to a real region whose own name happens to be uninformative — "Super KA
 * Delta", EGP 900,983, which names neither Delta 1 nor Delta 2 but is mapped to Delta 1.
 */
export function readWeeklyBranchName(
  index: WeeklyAreaSplitIndex,
  branchName: string | null | undefined,
  fallbackRegionCode?: string | null,
): WeeklyBranchReading {
  const branchClass = classifyWeeklyBranch(branchName);
  if (NON_TERRITORY_CLASSES.has(branchClass)) {
    // Every member of NON_TERRITORY_CLASSES needs a clause here. A missing one would read as a
    // tender, which is why `weekly-branch-name-scope` iterates the set and asserts each note names
    // its own class - an exhaustive Record would NOT gate the build (next.config ignores type
    // errors), so the guard has to run at runtime.
    const reason = branchClass === "warehouse"
      ? "a stock location, not a territory"
      : "an institutional tender, not field-force sales";
    return { branchClass, scope: null, note: `Not split: ${reason}. Stays at region level.` };
  }

  const stripped = stripRoleWords(String(branchName ?? ""));

  // A brick beats everything: it names one area outright, with no arithmetic at all.
  const brick = brickScope(index, stripped);
  if (brick) {
    const areaName = index.areaNames.get(brick.areaCode) ?? brick.areaCode;
    return {
      branchClass: "territory",
      scope: { kind: "brick", brickId: brick.brick, areaCode: brick.areaCode },
      note: `"${brick.brick}" is a brick in ${areaName} — the whole branch belongs to that one area.`,
    };
  }

  const mentions = placeMentions(stripped);
  if (mentions.length === 0) {
    const region = String(fallbackRegionCode ?? "").trim().toUpperCase();
    return region
      ? {
          branchClass: "unreadable",
          scope: { kind: "region", regionCode: region },
          note: "No place in the name — spread evenly across the areas its mapped region covers on each line.",
        }
      : {
          branchClass: "unreadable",
          scope: null,
          note: "No place in the name and no region on the branch — stays exactly where it is today.",
        };
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
  const pushArea = (areaCode: string) => {
    parts.push({ kind: "area", areaCode });
    labels.push(`${areaCode} ${index.areaNames.get(areaCode) ?? ""}`.trim());
  };
  for (const mention of mentions) {
    if (mention.area) {
      pushArea(mention.area);
      continue;
    }
    if (mention.region) {
      parts.push({ kind: "region", regionCode: mention.region });
      labels.push(`the ${regionName(mention.region) || mention.region} region`);
      continue;
    }
    const key = mention.governorate as GovernorateKey;
    const pinned = mention.ordinal != null ? areaForOrdinal(index, key, mention.ordinal) : null;
    if (pinned) pushArea(pinned);
    else {
      parts.push({ kind: "governorates", names: [key] });
      labels.push(governorateLabel(key));
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
