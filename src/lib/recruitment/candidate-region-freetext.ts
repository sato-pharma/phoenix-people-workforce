/**
 * Reading a company region out of FREE TEXT — a street address, a city, an Arabic line.
 *
 * WHY THIS IS A SEPARATE FILE FROM `candidate-region.ts`. That module is one of the three
 * vocabularies `screening-link` may import, and it is pinned to ZERO imports so its purity holds
 * more than one level deep; in this repo a server-only module reaching a client graph does not fail
 * that page alone, it 500s every later request including `/api/healthz`. This reader needs
 * `@/lib/geo/egypt-locations`, so it lives here rather than there. Do not merge the two back.
 */
import { normalizeArabic, placeAliases } from "@/lib/geo/egypt-locations";

import {
  type CandidateRegionCode,
  candidateRegionForGovernorate,
  foreignCountryForGovernorate,
  normalizeGovernorate,
} from "@/lib/recruitment/candidate-region";

/**
 * The company region a piece of FREE TEXT names — a street address, a city, an Arabic line — or null.
 *
 * WHY THIS IS NOT JUST `candidateRegionForGovernorate`.
 *
 * That function answers for a governorate FIELD. Measured on production 2026-09-04, 53 candidates
 * holding a CV had no governorate at all and an address the map could not read: "Damanhour, Damanhour
 * 22511", "Baltim, Kafr El-Sheikh, Egypt", "Naga Hammadi, Egypt", "10th of Ramadan". Every one of
 * those places is already in `src/lib/geo/egypt-locations.ts`, which carries town-level names in both
 * scripts. So this reuses that vocabulary rather than starting a fourth copy of Egypt.
 *
 * TWO THINGS IT DOES NOT DO, AND BOTH ARE THE POINT.
 *
 * 1. It does NOT call `resolveGovernorate`. That function matches with a bare `includes`, so a key
 *    can match inside an unrelated word: "Sagamu, Ogun State, Nigeria" resolves to **Dakahlia**,
 *    because the Dakahlia alias "aga" sits inside "Sagamu". A Nigerian CV would have been filed in a
 *    Delta folder. Measured, not hypothetical — it is why the matching below is whole-word.
 *
 * 2. It asks whether the text is EGYPTIAN before it asks which country it is, rather than the other
 *    way round. Those two questions overlap: "riyadh" is a real town in Kafr El-Sheikh and also the
 *    Saudi capital. So an explicit Egyptian signal — the word "Egypt", or a governorate's own name —
 *    settles it first, and only text carrying no such signal is offered to the foreign list.
 *
 * Null means "nothing recognised", never "Others" — same rule, and same reason, as the governorate
 * lookup above.
 */
export function egyptRegionFromFreeText(raw: string | null | undefined): CandidateRegionCode | null {
  const text = normalizeGovernorate(normalizeArabic(String(raw ?? "")));
  if (!text) return null;

  // Whole-word / whole-phrase containment. The padding is what `resolveGovernorate`'s `includes`
  // lacks, and it is the entire difference between "Sagamu" matching Dakahlia and not.
  const holds = (needle: string): boolean => {
    const key = normalizeGovernorate(normalizeArabic(needle));
    return key.length > 0 && ` ${text} `.includes(` ${key} `);
  };

  // An explicit Egyptian signal: the country itself, or a governorate called by its own name.
  const namesEgypt =
    holds("egypt") || holds("مصر") || placeAliases.some((place) => holds(place.label));

  if (!namesEgypt && foreignCountryForGovernorate(text)) return null;

  // This file's OWN map first: it is where the misspellings production actually produces live
  // ("Behaira", "Kafr Elshikh"), and the geo module carries only correct spellings and real town
  // names. Word-matched already, so it is safe on a long address.
  const fromSpellingMap = candidateRegionForGovernorate(text);
  if (fromSpellingMap) return fromSpellingMap;

  // Then governorate names, then the town-level aliases beneath them, so a line naming both its
  // town and its governorate is decided by the governorate.
  for (const place of placeAliases) {
    if (holds(place.label)) return candidateRegionForGovernorate(place.label);
  }
  for (const place of placeAliases) {
    if (place.aliases.some(holds)) return candidateRegionForGovernorate(place.label);
  }
  return null;
}
