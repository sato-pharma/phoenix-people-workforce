// ─────────────────────────────────────────────────────────────────────────────
// RANK THE DISTRIBUTOR CODES BY WHERE THE REP IS STANDING — AND DROP NOTHING.
//
// WHY THIS EXISTS. Until now the distributor code was typed free-hand into a box, and nothing
// compared that number against the shop in front of the rep at the moment he typed it. Both real
// incidents were transcription errors on shops standing beside the doctor:
//
//   2026-09-29  Samaa Shalaby  typed 443359  (احمد عبدالشافى, Haram/Faisal, Giza)
//                              meant 442359  (اسعد جديدة, ناحية نشوة, الزقازيق)   — ONE DIGIT
//   2026-09-23  Taha AboElftouh typed 1510270 (a real pharmacy in Sherbin, Dakahlia)
//                              while standing at house 75 of his doctor's own street in 6th of
//                              October City — 59 m from the doctor
//
// Both were caught, but only AFTER the save and only at governorate level, by which time the rep
// had left the shop and only a Super Admin could release the link. Ranking the candidates by the
// rep's own captured place puts the right code in front of him while he can still read the number
// off the till.
//
// 🔒 NOTHING IS EVER FILTERED OUT — owner ruling, 2026-09-29: "build the code picker ranked by gps,
// nothing filtered out". This is the whole contract of this module and the reason it ranks rather
// than searches. A filter was the obvious design and it is REFUSED, with a measured reason:
// **25,811 of the 50,936 reference codes (50.7%) carry no area at all**, so an area filter would
// make half the database unreachable and a legitimate shop with a blank reference row could never
// be captured — punishing a rep for a hole in Phoenix's own import. `rankPharmacyCodeSuggestions`
// therefore returns exactly the rows it was given, reordered, and its test asserts that on both
// count and identity. Any future change that drops a row here breaks that test, and should.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveGovernorate } from "@/lib/geo/egypt-locations";

/** One candidate code out of the Phoenix reference database. */
export type PharmacyCodeCandidate = {
  /** The distributor's registered address for this code. Often the only human-readable field. */
  address?: string | null;
  /** The area the distributor files this code under, e.g. "الزقازيق". May be blank — half are. */
  areaName?: string | null;
  /** The pharmacy code itself, as the distributor writes it. */
  code: string;
  /** The governorate, e.g. "الشرقية". May be blank. */
  governorateName?: string | null;
  /** The shop's name where Phoenix knows it. Absent from the reference import for many codes. */
  name?: string | null;
};

/** How a candidate relates to where the rep is standing. Presentational — never a gate. */
export type PharmacyCodeProximity =
  /** The distributor files this code in the same area the rep just captured. */
  | "same_area"
  /** Same governorate, different area. */
  | "same_governorate"
  /** Somewhere else, or the candidate carries no place at all. Still shown, still selectable. */
  | "elsewhere";

export type RankedPharmacyCode = PharmacyCodeCandidate & {
  proximity: PharmacyCodeProximity;
};

/** Where the rep is, as resolved from his capture. Either field may be blank. */
export type CapturedPlace = {
  areaName?: string | null;
  governorateName?: string | null;
};

/**
 * Arabic and English place names arrive from three unrelated sources — Google's reverse geocode,
 * the distributor's own spreadsheet, and Phoenix's area table — so they agree on the place and
 * disagree on the spelling. Normalise the differences that are pure orthography and nothing else.
 *
 * Deliberately NOT a fuzzy match. A near-miss that silently equated two real towns would rank a
 * wrong code first, which is the exact failure this module exists to prevent; anything it cannot
 * confidently equate simply falls to `elsewhere`, where it is still visible and still selectable.
 */
export function normalizePlaceName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    // Arabic definite article, and the alef/ya/ta-marbuta variants that differ only by keyboard.
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/^ال/, "")
    // English noise: "Governorate", "Gov.", punctuation, repeated spaces.
    .replace(/\bgovernorate\b|\bgov\.?\b/g, "")
    // An explicit class rather than `\p{L}\p{N}` with the `u` flag: Unicode property escapes are
    // ES2018 and this repo's tsconfig targets ES2017. `pnpm test` STRIPS types instead of checking
    // them, so a target violation here runs green locally and only turns up as a red `checks` job —
    // which is exactly how the first version of this branch reached CI. Arabic block, Latin,
    // digits, whitespace; everything else becomes a separator.
    .replace(/[^؀-ۿݐ-ݿa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE TWO TIERS RESOLVE DIFFERENTLY, AND THAT ASYMMETRY IS THE DESIGN.
 *
 * The two sides speak different languages: Google reverse-geocodes the rep's position into ENGLISH
 * ("Zagazig, Al-Sharqia Governorate") while the distributor's reference import is ARABIC
 * ("الزقازيق", "الشرقية"). A raw string comparison therefore matches nothing across that boundary —
 * the first version of this module scored Samaa's own capture as `elsewhere` against the very code
 * that belonged to it, which its test caught.
 *
 * GOVERNORATE goes through `resolveGovernorate`, the repository's single canonical place vocabulary
 * (`src/lib/geo/egypt-locations.ts`), which already knows both languages and every spelling, and is
 * the same resolver the post-save governorate check uses. Never add a second copy of that table
 * here.
 *
 * AREA has no cross-language equivalent, and one is NOT invented here. A town-level transliteration
 * guess that wrongly equated two places would rank a wrong code first — precisely the failure this
 * module exists to prevent. So the area tier matches only when both sides are written the same way,
 * and everything else falls through to the governorate tier: a coarser ranking that is still
 * correct, rather than a finer one that can be confidently wrong.
 */
function proximityOf(candidate: PharmacyCodeCandidate, place: CapturedPlace): PharmacyCodeProximity {
  const area = normalizePlaceName(place.areaName);
  const candidateArea = normalizePlaceName(candidate.areaName);
  if (area && candidateArea && area === candidateArea) return "same_area";

  // Fall back to the code's own address when the reference row carries no explicit region — half of
  // the import is missing one, and the governorate is usually sitting in the address text.
  const governorate = resolveGovernorate(place.governorateName) ?? resolveGovernorate(place.areaName);
  const candidateGovernorate = resolveGovernorate(candidate.governorateName)
    ?? resolveGovernorate(candidate.areaName)
    ?? resolveGovernorate(candidate.address);
  if (governorate && candidateGovernorate && governorate === candidateGovernorate) {
    return "same_governorate";
  }
  return "elsewhere";
}

const RANK: Record<PharmacyCodeProximity, number> = {
  same_area: 0,
  same_governorate: 1,
  elsewhere: 2,
};

/**
 * Reorder candidates so the ones registered where the rep is standing come first.
 *
 * 🔒 RETURNS EVERY ROW IT WAS GIVEN. Same length, same members, different order. This is an owner
 * ruling, not an implementation detail — see the module header. Never add a `.filter()` here, never
 * add a `limit`, and never drop a candidate because it has no place on it: a blank area is the
 * commonest state in the reference import (50.7% of rows), not a signal about the shop.
 *
 * The sort is stable within each tier, so the caller's own ordering — typically closest code match
 * first — survives underneath the proximity ranking rather than being scrambled by it.
 */
export function rankPharmacyCodeSuggestions(
  candidates: readonly PharmacyCodeCandidate[],
  place: CapturedPlace,
): RankedPharmacyCode[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      proximity: proximityOf(candidate, place),
    }))
    .sort((a, b) => RANK[a.proximity] - RANK[b.proximity] || a.index - b.index)
    .map(({ candidate, proximity }) => ({ ...candidate, proximity }));
}

/**
 * The one-line hint shown beside a suggestion. Describes the CODE's registered place, never the
 * rep — nothing here implies he is being checked or that his position was judged.
 */
export function proximityLabel(proximity: PharmacyCodeProximity): string {
  switch (proximity) {
    case "same_area":
      return "In this area";
    case "same_governorate":
      return "In this governorate";
    default:
      return "Elsewhere";
  }
}
