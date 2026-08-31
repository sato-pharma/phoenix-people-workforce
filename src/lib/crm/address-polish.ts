/**
 * Turns a raw reverse-geocoded address into something a person reads.
 *
 * WHY THIS EXISTS. The addresses on this board are Google reverse-geocode strings captured at a
 * rep's check-in, and they are written for a machine. Measured across all 111,912 of them in
 * production on 2026-09-01:
 *
 *   - 77,612 (69.4%) open with a plus code — `X64Q+739`, `HP59+637`. That is a raw code, which the
 *     owner's standing rule says a screen never shows, and it is redundant here anyway: the address
 *     is a link to the exact coordinate.
 *   - 104,443 (93.3%) carry the word `Governorate` / `محافظة`. Boilerplate on every Egyptian row.
 *   - 111,874 (99.97%) end in `Egypt` / `مصر`. Every contact this company has is in Egypt.
 *   - Almost all carry a 5-7 digit postal code glued to the governorate. Egypt does not use them.
 *
 * So `X64Q+739، منيل شيحة، أبو النمرس، محافظة الجيزة 3398442، مصر` becomes
 * `منيل شيحة، أبو النمرس، الجيزة` — the same place, minus four kinds of noise.
 *
 * SEGMENTS, NOT A STRING, and that is the point of the return type. 20,313 of those addresses
 * (18.2%) are BILINGUAL — Arabic and English in one value, e.g. `الامام محمد عبده, Mansoura Qism 2,
 * Dakahlia Governorate`. AGENTS.md §2.1 records what happens if such a value is rendered under a
 * single `dir="auto"`: auto reads only the first strong character, the whole block turns RTL, and
 * the English half then renders backwards — the exact mirror of the bug you were fixing. Handing
 * the caller segments lets it isolate each one (`<bdi>`), which is direction per line, the fix that
 * hook prescribes. Do not "simplify" this to a joined string.
 *
 * WHAT IT DELIBERATELY DOES NOT STRIP. `Qism` / `قسم` / `مركز` and district numbers (`Sohag 1`,
 * `El Mansoura 2`) look like boilerplate and are not — they are how Egyptian districts are named,
 * and dropping them merges two real places into one. A rep sent to the wrong Mansoura by a tidier
 * address is worse off than one reading an untidy correct one. Polishing removes noise; it never
 * removes a place.
 */

/** ASCII comma and Arabic comma (U+060C) both separate segments; Google emits whichever fits. */
const SEGMENT_SPLIT = /[,،]+/;

/** Bidi control marks ride along in geocoded Arabic and would otherwise survive every trim. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** An Open Location Code: 2-8 chars, a plus, 2-4 more. Its own segment in every sample seen. */
const PLUS_CODE = /^[0-9A-Z]{2,8}\+[0-9A-Z]{2,4}$/i;

/** The same code where the geocoder glued it to the front of a real segment. */
const LEADING_PLUS_CODE = /^[0-9A-Z]{2,8}\+[0-9A-Z]{2,4}\s+/i;

/** A postal code — 5 or more digits. A house number is 1-4, so this cannot eat one. */
const POSTAL_ONLY = /^\d{5,}$/;
const TRAILING_POSTAL = /\s+\d{5,}$/;

/** Pure boilerplate: every row is in Egypt, and every Egyptian address says "Governorate". */
const COUNTRY = /^(egypt|مصر)$/i;
const GOVERNORATE = /\s*(governorate|محافظة)\s*/gi;

/**
 * The address as readable segments, outermost last. Empty when nothing survives — which the caller
 * must render as an absence rather than as an empty string, so a stripped address never reads as a
 * contact that has none.
 */
export function polishAddress(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const segments: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.replace(BIDI_MARKS, "").split(SEGMENT_SPLIT)) {
    let segment = part.trim().replace(/\s+/g, " ");
    if (!segment) continue;
    if (PLUS_CODE.test(segment)) continue;
    segment = segment.replace(LEADING_PLUS_CODE, "").trim();
    if (!segment || COUNTRY.test(segment) || POSTAL_ONLY.test(segment)) continue;

    segment = segment
      .replace(TRAILING_POSTAL, "")
      .replace(GOVERNORATE, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!segment || COUNTRY.test(segment) || POSTAL_ONLY.test(segment)) continue;

    // The geocoder repeats a name at two administrative levels often enough to matter, and the
    // repeat carries nothing. Case-folded so `Maadi` and `MAADI` count as one.
    const key = segment.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(segment);
  }

  return segments;
}

/**
 * The polished address as one string, for a spreadsheet cell or a search box.
 *
 * Never use this to RENDER: a joined bilingual string is the `dir="auto"` trap described above.
 * Excel and the search index have no direction problem, so they take the joined form.
 */
export function polishAddressText(raw: string | null | undefined): string {
  return polishAddress(raw).join(", ");
}
