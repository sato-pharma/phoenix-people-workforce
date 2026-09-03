/**
 * Which Phoenix brick is this CRM region?
 *
 * The CRM writes its localities in English transliteration ("Kit kat Imbaba", "Beba", "Shebeen El
 * Kom"); every one of Phoenix's 697 active bricks is written in Arabic. Nothing matched on text, so
 * `ireports360_crm_region_brick_resolutions` held 0 rows against 295 distinct CRM regions and every
 * visit in the system sat in an unresolved place — no brick, no area, no region, on 89,058 calls.
 *
 * This suggester has since been used: re-measured 2026-09-03 the table holds 105 resolutions,
 * covering 100 of the 261 regions that appear on contacts. The unresolved remainder is what it is
 * still for — the 0-rows line above is the starting point, not the current state.
 *
 * TWO INDEPENDENT SIGNALS, and the answer is only trusted where they agree.
 *
 *   1. THE NAME. `@/lib/geo/arabic-name-key` collapses either script to a consonant skeleton, so
 *      "الكيت كات" and "Kit kat Imbaba" both key to "ktkt". Measured against production: the name
 *      alone reaches at least one brick for 97.3% of visits — but on its own it is not enough, and
 *      it is dangerous exactly where it looks easiest. "Dokki" keys to "dk", and so does "إدكو"
 *      (Edku, in Beheira, 200km away).
 *
 *   2. THE BEHAVIOUR. Which organogram area the reps who logged those visits actually sit in. It
 *      knows nothing about spelling, so it is a genuinely independent check: 221 of 237 regions with
 *      any org evidence have a single area holding 90%+ of their visits.
 *
 * Together they resolve 220 of 295 regions — 82.6% of all visits — to exactly one brick. The rest
 * are handed to the owner as a question, never guessed: per his standing rule, a "which one of these
 * does this belong to" question goes out as a spreadsheet with dropdowns, and the Region Mapping tab
 * already round-trips exactly that file.
 *
 * NOTHING HERE WRITES. Everything this module produces is a SUGGESTION that a human accepts.
 */

import { placeNameIndexKeys, placeNameKey, placeNameKeyCandidates } from "@/lib/geo/arabic-name-key";

export type BrickForSuggestion = {
  brickId: string;
  brickName: string;
  areaCode: string | null;
  areaName: string | null;
  regionCode: string | null;
  regionName: string | null;
};

/**
 * How much of the answer is actually known.
 *
 *   confirmed  the name matched AND the reps' own area agrees — the two signals independently
 *              landed on the same brick
 *   likely     one signal is strong and the other is silent (no org evidence for this region, or a
 *              name too short to stand alone)
 *   unsure     the name reached several bricks and nothing separates them — a question, not an answer
 */
export type SuggestionConfidence = "confirmed" | "likely" | "unsure";

export type CrmRegionBrickSuggestion = {
  brickId: string;
  brickName: string;
  areaCode: string | null;
  areaName: string | null;
  regionName: string | null;
  confidence: SuggestionConfidence;
  /** Plain English, for a human deciding whether to accept it. Never a code, never a score. */
  reason: string;
  /** How many other bricks the same name also reached. Zero means the name was unambiguous. */
  otherCandidates: number;
};

/** A brick name is trustworthy on its own only once its skeleton is this long. "b" is Beba — and
 *  also Bab El Louk, Abu Zaabal and nineteen others. */
const STANDALONE_KEY_FLOOR = 3;

export type BrickNameIndex = ReadonlyMap<string, BrickForSuggestion[]>;

/** File every brick under its name and its opening words, so a CRM region that leaves off a
 *  qualifier ("Mahalla" for "المحلة الكبرى") can still find it. */
export function buildBrickNameIndex(bricks: readonly BrickForSuggestion[]): BrickNameIndex {
  const index = new Map<string, BrickForSuggestion[]>();
  for (const brick of bricks) {
    for (const key of placeNameIndexKeys(brick.brickName)) {
      const bucket = index.get(key);
      if (!bucket) index.set(key, [brick]);
      else if (!bucket.some((b) => b.brickId === brick.brickId)) bucket.push(brick);
    }
  }
  return index;
}

/**
 * The best brick for one CRM region, or null when the name reaches nothing at all.
 *
 * `dominantAreaCode` is the organogram area holding most of that region's visits, or null when no
 * visiting rep holds a seat. It is used to CHOOSE between bricks the name already reached — never to
 * reach one on its own, because an area contains many bricks and knowing the area is not knowing the
 * place.
 */
export function suggestBrickForCrmRegion(
  crmRegionName: string | null | undefined,
  dominantAreaCode: string | null,
  index: BrickNameIndex,
): CrmRegionBrickSuggestion | null {
  let pool: BrickForSuggestion[] = [];
  let matchedKey = "";
  // Longest run of words first: "Kit kat Imbaba" must find the Kit Kat brick before it falls back
  // to Imbaba, which is the whole district around it.
  for (const candidate of placeNameKeyCandidates(crmRegionName)) {
    const found = index.get(candidate);
    if (found && found.length > 0) {
      pool = found;
      matchedKey = candidate;
      break;
    }
  }
  if (pool.length === 0) return null;

  // A brick whose WHOLE name is this key beats one that merely starts with it: "Ma-adi" is المعادى,
  // not المعادى الجديده; "Shobra" is شبرا, not شبرا الخيمه.
  const exact = pool.filter((brick) => placeNameKey(brick.brickName) === matchedKey);
  const narrowed = exact.length > 0 ? exact : pool;

  const agreeing = dominantAreaCode ? narrowed.filter((brick) => brick.areaCode === dominantAreaCode) : [];
  const areaAgreed = agreeing.length > 0;
  const finalists = areaAgreed ? agreeing : narrowed;
  const nameStandsAlone = matchedKey.length >= STANDALONE_KEY_FLOOR;

  const best = finalists[0];
  if (!best) return null;
  const otherCandidates = finalists.length - 1;

  const confidence: SuggestionConfidence =
    finalists.length > 1
      ? "unsure"
      : areaAgreed && nameStandsAlone
        ? "confirmed"
        : areaAgreed || nameStandsAlone
          ? "likely"
          : "unsure";

  return {
    brickId: best.brickId,
    brickName: best.brickName,
    areaCode: best.areaCode,
    areaName: best.areaName,
    regionName: best.regionName,
    confidence,
    otherCandidates,
    reason: describe({ areaAgreed, best, confidence, finalists, nameStandsAlone }),
  };
}

function describe({
  areaAgreed,
  best,
  confidence,
  finalists,
  nameStandsAlone,
}: {
  areaAgreed: boolean;
  best: BrickForSuggestion;
  confidence: SuggestionConfidence;
  finalists: readonly BrickForSuggestion[];
  nameStandsAlone: boolean;
}): string {
  const where = best.areaName ?? best.areaCode ?? "an unnamed area";
  if (confidence === "confirmed") {
    return `The Arabic name matches, and the reps who visit here work in ${where} — both point at this brick.`;
  }
  if (confidence === "likely" && areaAgreed) {
    return `The reps who visit here work in ${where}. The name is short, so the area is what decides it.`;
  }
  if (confidence === "likely") {
    return `The Arabic name matches this brick and no other. No visiting rep holds an organogram seat, so there is nothing to cross-check it against.`;
  }
  if (finalists.length > 1) {
    return `The name matches ${finalists.length} bricks and nothing separates them${
      areaAgreed ? ` — all ${finalists.length} sit in ${where}` : ""
    }. Pick the right one.`;
  }
  return nameStandsAlone
    ? "The name matches, but nothing confirms it."
    : "The name is too short to stand on its own and no rep here holds an organogram seat. This one needs a human.";
}
