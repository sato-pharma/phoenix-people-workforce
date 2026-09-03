// Recruitment / ATS — which PLACE a CV's own text names, and how firmly.
//
// WHY THIS IS ITS OWN MODULE. Two screens ask the same question of the same string and used to have
// only one answer between them. position-suggestion.ts asks "which open seat does this address point
// at" and has read a CV address down to a neighbourhood since 2026-08-28. district-manager-folders.ts
// asks "whose folder does this CV belong in" and, until this module existed, read nothing off the
// address at all — it went straight from "the applicant declared no area" to the district's catch-all
// folder, which is called "No area named". So a CV that plainly says Nasr City sat in a folder saying
// nobody knew where the person was, next to a screen one module over that could already read it.
//
// The owner, 2026-09-03: *"do a fucking effort that's extracted from the CV already."* The effort was
// already built. It was in the wrong file to be reused, so this is where it lives now and both
// callers import it. That is the whole change of substance here — the rules below are MOVED, not
// rewritten, and every comment explaining a correction is the original one, kept because each of
// them records a real wrong answer this matcher used to give.
//
// THE VOCABULARY IS NEVER COPIED. `placeAliases` (Egypt's governorates, Arabic and English) and the
// generated neighbourhood index (626 brick names, all Arabic) are imported. Writing a second copy of
// Egypt's place names is a documented mistake in this repository; this is not one.
//
// PURE — no database, no network, no environment, no React. Both callers are reached from "use
// client" screens, so anything else here would ship a server client to a browser.

import { addressNamesPlace, addressWords, compileArabicPlace, type ArabicPlace } from "@/lib/geo/arabic-place-match";
import { placeAliases } from "@/lib/geo/egypt-locations";
import { NEIGHBOURHOOD_AREAS, NEIGHBOURHOOD_PLACES } from "@/lib/geo/neighbourhood-index-generated";

// ── Normalisation ────────────────────────────────────────────────────────────
// Deliberately the same shape as the geography module's own normaliser: lowercase, punctuation to
// spaces, collapse. Kept local and Latin-first because everything compared HERE — area names and CV
// addresses alike — is written in Latin script. Arabic arrives too, and is handled where it is
// actually understood: the alias tables below and the Arabic brick matcher. Arabic codepoints are
// preserved rather than stripped so a wholly Arabic address still reaches those with content intact.
export function normalizePlaceText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** " nasr city " — padded so a containment test cannot match inside a longer word. */
function padded(value: string): string {
  return ` ${value} `;
}

// ── Governorate ──────────────────────────────────────────────────────────────

/**
 * Governorate names, from the geography module's own exported vocabulary.
 *
 * MATCHED ON WHOLE WORDS, which resolveGovernorate does not do — and that difference is not
 * academic. That function tests `candidate.includes(key)` as a bare substring, and several aliases
 * are three or four letters long, so on the first run of this matcher against the real 447 CVs a
 * candidate living at "New Bapunagar, Bhilwara, Rajasthan" was resolved to DAKAHLIA: "bapunAGAr"
 * contains "aga", the alias for the town of Aga. Twelve more followed it. The alias table is
 * written with a leading space for exactly that reason — " aga" — but normalising the key trims the
 * space back off, so the guard never survives to be applied.
 */
const NORMALIZED_ALIASES: ReadonlyArray<{ label: string; keys: string[] }> = placeAliases.map(
  (entry) => ({
    keys: entry.aliases.map((alias) => normalizePlaceText(alias)).filter(Boolean),
    label: entry.label,
  }),
);

/** The canonical governorate labels, normalised — used to tell a governorate name from a place name. */
const GOVERNORATE_LABELS = new Set(placeAliases.map((entry) => normalizePlaceText(entry.label)));

/**
 * Which governorate a string names, on a whole-word match, or null.
 *
 * Order follows the vocabulary's own priority, so an address naming two governorates resolves to the
 * one the geography module ranks first. "Alexandria, Egypt (Willing to relocate to Cairo if
 * available Post)" is a real address on file and resolves to Alexandria — where the person lives,
 * which is the question being asked.
 */
export function governorateNamedBy(value: string | null | undefined): string | null {
  const cleaned = normalizePlaceText(value);
  if (!cleaned) return null;
  const hay = padded(cleaned);
  // The space-free form as well, so "Down town" reaches the alias "downtown" and vice versa.
  const squashedHay = padded(cleaned.replace(/\s+/g, ""));
  for (const { label, keys } of NORMALIZED_ALIASES) {
    for (const key of keys) {
      if (hay.includes(padded(key))) return label;
      const squashedKey = key.replace(/\s+/g, "");
      if (squashedKey !== key && squashedHay.includes(padded(squashedKey))) return label;
    }
  }
  return null;
}

// ── Area names ───────────────────────────────────────────────────────────────

/**
 * Area-name fragments an address could plausibly contain.
 *
 * The WHOLE name is a token, and so is each part after splitting on separators. Both are needed and
 * neither is enough: "Dokki - Mohandseen - Bolak" is three neighbourhoods and a CV names one of
 * them, but "Kafr El-Sheikh 1" carries the same hyphen inside a single name, and splitting it alone
 * leaves the fragments "kafr el" and "sheikh" — neither of which is a place. "Gharbia 1 (Tanta)"
 * yields both "gharbia 1" and "tanta"; the second is what anybody actually writes.
 *
 * A trailing index comes off as well ("Assuit 2" -> "assuit", "Sohag1" -> "sohag"), because the
 * number is the company's way of splitting a governorate between two reps and means nothing on a CV.
 */
export function areaTokens(areaName: string | null): string[] {
  if (!areaName) return [];
  const tokens = new Set<string>();
  const add = (raw: string) => {
    const cleaned = normalizePlaceText(raw);
    // A token has to be long enough, and made of letters, to identify anywhere. "Delta (2)" splits
    // into "delta" and "2"; a street number then matched it, and a sales manager living at "2 St.
    // El Mahata, El Marg" — which is in Cairo — was pre-filled into the Delta district manager's
    // seat because their address happened to start with the right digit.
    if (!cleaned || cleaned.length < 3 || !/[a-z؀-ۿ]/.test(cleaned)) return;
    tokens.add(cleaned);
    const withoutIndex = cleaned.replace(/\s+\d+$/, "").trim();
    if (withoutIndex && withoutIndex !== cleaned) tokens.add(withoutIndex);
    // "Sohag1" carries no separator at all, so the digit has to come off a bare word too.
    const glued = cleaned.replace(/([a-z])\d+$/, "$1").trim();
    if (glued && glued !== cleaned) tokens.add(glued);
  };
  add(areaName);

  // Splitting is only safe when it does not cut a name in half. "Kafr El-Sheikh 1" carries the same
  // hyphen as "Helwan-Maadi" but means something different by it, and splitting it yields "kafr el"
  // and "sheikh" — at which point a candidate living in Al Sheikh Zayed, which is in GIZA, was being
  // matched to Kafr El-Sheikh on the fragment. The tell is the leftover article: a piece ending in a
  // bare "el" or "al" was cut mid-name, so the pieces are thrown away and only the whole name kept.
  const parts = areaName.split(/[-/(),]/).map((part) => normalizePlaceText(part)).filter(Boolean);
  if (!parts.some((part) => /(^|\s)(el|al)$/.test(part))) {
    for (const part of parts) add(part);
  }
  return [...tokens];
}

/**
 * Tokens that must never match an address.
 *
 * "Egypt" is a real area — the National Sales Manager's seat — and every Egyptian address on file
 * ends with the word. Matching it would hand the country's top sales job to whoever wrote their
 * country down. "Head office" and "office" are the same trap in miniature: an address says "office"
 * for reasons that have nothing to do with a seat at head office.
 */
const NON_PLACE_TOKENS = new Set(["egypt", "head office", "office"]);

/**
 * True when the address names this area outright — by a name that is the AREA's, not merely its
 * governorate's.
 *
 * A GOVERNORATE NAME IS NOT AN AREA HIT, even when an area is named after one. This is the single
 * correction that mattered most: one of the open seats sits in an area called simply "Cairo" and is
 * a District Sales Manager post. On the first run against the real 447 CVs it took 48 of the 81
 * pre-fills — nearly three in five — because "Cairo" is the only area name a plain Cairo address
 * contains, so it won on precision while eleven genuine Cairo seats sat one tier below it. A
 * general accountant in Shubra was being handed a district manager's job. Writing "Cairo" on a CV
 * says which governorate somebody lives in and nothing whatsoever about which seat they want, so it
 * is scored as what it is.
 */
export function addressNamesArea(haystack: string, areaName: string | null): boolean {
  const hay = padded(haystack);
  // "Down town" and "downtown" are the same place spelled two ways, and one of them is the area's
  // own name — so the space-free form is compared as well, on both sides.
  const squashedHay = padded(haystack.replace(/\s+/g, ""));
  for (const token of areaTokens(areaName)) {
    if (NON_PLACE_TOKENS.has(token)) continue;
    if (GOVERNORATE_LABELS.has(token)) continue;
    if (hay.includes(padded(token))) return true;
    const squashedToken = token.replace(/\s+/g, "");
    if (squashedToken !== token && squashedHay.includes(padded(squashedToken))) return true;
  }
  return false;
}

/** Which governorate an area sits in, read from its own name through the shared vocabulary. */
export function areaGovernorate(areaName: string | null): string | null {
  for (const token of areaTokens(areaName)) {
    if (NON_PLACE_TOKENS.has(token)) continue;
    const label = governorateNamedBy(token);
    if (label) return label;
  }
  return null;
}

// ── Neighbourhoods ───────────────────────────────────────────────────────────

/**
 * The neighbourhoods each area covers, compiled so an English address can find an Arabic name.
 *
 * Built once at module load from the generated index — see
 * scripts/generate-neighbourhood-index.ts for where the names come from and
 * src/lib/geo/arabic-place-match.ts for how an English word is tested against one. Keyed on the
 * area NAME rather than its code because that is what a vacancy carries, and because two areas of
 * the same name on two different lines cover the same ground: a candidate living in Helmeyet
 * El-Zeitoun is equally near both.
 */
const NEIGHBOURHOODS_BY_AREA = new Map<string, ArabicPlace[]>();
for (const entry of NEIGHBOURHOOD_PLACES) {
  const separator = entry.lastIndexOf("|");
  if (separator <= 0) continue;
  const place = compileArabicPlace(entry.slice(0, separator));
  if (!place) continue;
  for (const rawIndex of entry.slice(separator + 1).split(",")) {
    const areaName = NEIGHBOURHOOD_AREAS[Number(rawIndex)];
    if (!areaName) continue;
    const areaKey = normalizePlaceText(areaName);
    const existing = NEIGHBOURHOODS_BY_AREA.get(areaKey);
    if (existing) existing.push(place);
    else NEIGHBOURHOODS_BY_AREA.set(areaKey, [place]);
  }
}

/**
 * Does this address name somewhere INSIDE this area, without naming the area itself?
 *
 * This is the rung that only exists because the two halves of the answer were written in different
 * scripts. The bricks are the company's own map of Egypt and all 697 are in Arabic; every CV
 * address is in English. So "Helmeyet El-Zeitoun" used to reach nothing but "Cairo" — a governorate
 * covering a dozen open seats, which is silence.
 *
 * Reads the ADDRESS only, never the governorate column. A governorate is by definition not a
 * neighbourhood, and letting "Cairo" into this check would hand a neighbourhood-grade answer to a
 * CV that named no neighbourhood at all.
 */
export function neighbourhoodMatchStrength(
  address: string | null | undefined,
  areaName: string | null,
): number {
  if (!areaName) return 0;
  const places = NEIGHBOURHOODS_BY_AREA.get(normalizePlaceText(areaName));
  if (!places || places.length === 0) return 0;
  const text = String(address ?? "").trim();
  if (!text) return 0;
  const words = addressWords(text);
  if (words.length === 0) return 0;
  let strength = 0;
  for (const place of places) {
    // The count is how many words of the brick name the address satisfied, and it is the tie-break
    // between two real places of the same name. "Dar Al-Salam, Sohag" matches both دار السلام, in
    // Cairo, and دار السلام - سوهاج, in Sohag; the second reads three words of the address where
    // the first reads two, and it is the one the candidate wrote down.
    if (place.words.length > strength && addressNamesPlace(place, words)) strength = place.words.length;
  }
  return strength;
}

// ── The one question a folder rule asks ──────────────────────────────────────

/**
 * How the area was identified. "area" means the CV's own text named the area; "neighbourhood" means
 * it named somewhere inside it. There is deliberately no governorate grade here: a governorate
 * covers up to twelve areas in this company, so it identifies a REGION and never an area, and the
 * caller that wants that answer already has `districtRoutingRegion` for it.
 */
export type CvAreaGrade = "area" | "neighbourhood";

/** What a CV's own text says about where its writer is, resolved against a list of real areas. */
export type CvAreaEvidence = {
  grade: CvAreaGrade;
  /** The one area the CV names. Never a shortlist — see `areaNamedByCv` for why a tie is refused. */
  areaName: string;
};

/**
 * The single area this CV's own text names, or null.
 *
 * ONE ANSWER OR NONE, AND THE REFUSAL IS THE POINT. Where several areas match equally well, this
 * returns null rather than picking one. Two different areas reading the same address means the
 * address does not actually distinguish them, and a CV filed under the wrong area is a CV the right
 * manager never sees — while the caller's fallback is the district's catch-all folder, which is
 * exactly where the CV already was. Refusing therefore costs nothing and guessing costs a candidate.
 *
 * The two grades are tried in order and never mixed. An address that names an area outright beats
 * one that names a neighbourhood inside it, and if the better grade produced a tie the worse one is
 * not consulted — a shortlist that mixes "the address says Nasr City" with "the address says
 * somewhere in Nasr City" reads as two equal options when only one of them was written down.
 *
 * `areaNames` is the caller's own list of real areas — the organogram's, in every current caller —
 * so nothing here can invent an area the company does not hold.
 */
export function areaNamedByCv(
  input: { address?: string | null; governorate?: string | null },
  areaNames: readonly string[],
): CvAreaEvidence | null {
  const address = normalizePlaceText(input.address);
  const governorate = normalizePlaceText(input.governorate);
  const haystack = [address, governorate].filter(Boolean).join(" ");
  if (!haystack) return null;

  // ── Named outright ────────────────────────────────────────────────────────
  const named = new Set<string>();
  for (const areaName of areaNames) {
    if (addressNamesArea(haystack, areaName)) named.add(areaName);
  }
  if (named.size === 1) return { areaName: [...named][0]!, grade: "area" };
  if (named.size > 1) return null;

  // ── Named a neighbourhood inside it ───────────────────────────────────────
  // The strength tie-break is the brick matcher's own: the area whose brick name the address
  // satisfied in MORE words wins, because that is the longer place name and the one actually
  // written down. Only an exact tie at the top is a refusal.
  let best = 0;
  const winners = new Set<string>();
  for (const areaName of areaNames) {
    const strength = neighbourhoodMatchStrength(input.address, areaName);
    if (strength === 0) continue;
    if (strength > best) {
      best = strength;
      winners.clear();
      winners.add(areaName);
    } else if (strength === best) {
      winners.add(areaName);
    }
  }
  if (winners.size === 1) return { areaName: [...winners][0]!, grade: "neighbourhood" };
  return null;
}
