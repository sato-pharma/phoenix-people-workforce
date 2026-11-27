// ─────────────────────────────────────────────────────────────────────────────
// WHICH GOOGLE MAPS LISTING IS THIS DRILLDOWN PHARMACY (owner, 27 Nov 2026).
//
// PR 821 made every drilldown pharmacy name a free Google Maps SEARCH. Asked which upgrade to build
// first, he chose "Free top-2,616 match": Phoenix looks each top pharmacy up ONCE in Google's place
// search (inside the free monthly allowance) and keeps the listing's place id, so the rep's tap opens
// that exact shop instead of a list to choose from. His standing rule decides how strict this is:
// "make sure … this update will correct work not make reps waste time and lost". A wrong match sends a
// rep to the wrong shop with no list to notice it in; a missed match only leaves the free search.
// So every doubt is a miss.
//
// A listing is the pharmacy only when ALL hold:
//   1. it is within MAX_MATCH_FROM_BRICK_KM of the pharmacy's brick centre;
//   2. every word that names the listing is in the pharmacy's name (one letter off allowed for a word
//      of FUZZY_MIN_LETTERS letters or more). The listing may drop words — the sheets add the street or district
//      ("رامى مصر الجديدة" is listed "صيدلية رامى") — but it may never ADD one:
//      "صيدلية د. أحمد محمد السيد" is not "محمد السيد", it is another pharmacist;
//      A listing named only with the commonest given names ("صيدلية دكتور محمد") is never enough;
//   3. the pharmacy name's FIRST word, the owner's or the shop's own name, is in the listing — so
//      "صيدلية مصر الجديدة" is never "رامى مصر الجديدة" — and, the brick's town set aside, a name of
//      two words or more has at least two of them in the listing: "عمر بن الخطاب" is never "د/ عمر";
//   4. both say the same KIND of place: a pharmacy, a distributor or warehouse, a hospital, a nursery,
//      a medical centre — "يونس لتجارة وتوزيع الادوية" is never "صيدلية يونس"; and a pharmacy is matched
//      only to a listing that SAYS it is one (صيدلية, pharmacy): "صيدلية جامعة الازهر" is never the
//      university's own listing, "مراد صادق" never a "دكتور مراد صادق" that may be his clinic;
//   5. no other listing in the answer passes 1–4: two branches of a chain, or two shops of one name,
//      leave Phoenix unable to tell which, so neither is kept.
// "عبد …" and "ابو …" are ONE name ("عبد الرحمن غلوش" is two words, so "د. عبد الرحمن" carries one).
// Words that only say what kind of place it is (صيدلية, pharmacy, د., دكتور, شركة, لتجارة وتوزيع
// الادوية, "الجديدة", a branch number) never count as names. A listing named only in Latin letters cannot be compared with the Arabic sheet name and
// is never a match.
//
// Measured on the 30 Google answers saved from the PR 821 probe (Cairo 1 and Giza 1): 19 kept, all the
// right shop; 8 wrong shops all refused; the 3 Latin-only listings left to the search. On the first 100
// live lookups (the top of the sales ranking) the kind rule was added after it caught a distributor
// matched to a corner shop. Reading the 2,000 of 27 Nov by eye added the pharmacy-word rule and the
// one-name rule for "عبد …" / "ابو …": 42 matches were set back, 434 kept.
//
// PURE: no database, no Google call. The run is scripts/territory-match-pharmacy-places.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { editDistanceAtMostOne, normalizeName, stemWord } from "@/lib/phoenix-crm/google-place-rules";
import { haversineKm, isUsablePoint, type Point } from "@/lib/pharmacy-search/geo";

import { SHEET_NAME_MARKS } from "./pharmacy-directions";

/** A listing farther than this from the pharmacy's brick centre is not in its district. */
export const MAX_MATCH_FROM_BRICK_KM = 5;

/** How far around the brick centre Google is asked to look (a bias, not a fence). */
export const MATCH_SEARCH_RADIUS_METERS = 3000;

/** How many listings Google is asked for: enough to see a second branch, not more. */
export const MATCH_MAX_LISTINGS = 5;

/** Words that say what kind of place it is, never which one. Normalized spelling. */
const KIND_WORDS: ReadonlySet<string> = new Set([
  "د",
  "دكتور",
  "دكتوره",
  "الدكتور",
  "الدكتوره",
  "فرع",
  "جديده",
  "pharmacy",
  "pharma",
  "dr",
  "rx",
]);

/**
 * What KIND of place a name says it is. A pharmacy on the sheets is matched only to a listing of the
 * same kind: "يونس لتجارة وتوزيع الادوية" is a drug distributor, never the corner shop "صيدلية يونس"
 * (the PR 821 pilot, 27 Nov 2026). Checked in this order; a name with none of these is a pharmacy.
 */
export type PlaceKind = "hospital" | "nursery" | "centre" | "trade" | "pharmacy";

const KIND_MARKERS: ReadonlyArray<{ kind: Exclude<PlaceKind, "pharmacy">; parts: readonly string[] }> = [
  { kind: "hospital", parts: ["مستشفي", "hospital"] },
  { kind: "nursery", parts: ["حضان"] },
  { kind: "centre", parts: ["مركز", "عياد", "مجمع", "center", "centre", "clinic"] },
  { kind: "trade", parts: ["تجار", "توزيع", "مخزن", "مخازن", "شركه", "جمله", "جروب", "group", "استيراد", "توكيل"] },
];

/** Words about medicines in general ("الادوية", "الدوائية"): they name no particular place. */
function isMedicineWord(word: string): boolean {
  return word.includes("ادوي") || word.includes("دواء") || word.includes("دوائ");
}

function isKindWord(word: string): boolean {
  return (
    KIND_WORDS.has(word) ||
    word.includes("صيدل") ||
    word.includes("pharm") ||
    word.includes("drug") ||
    isMedicineWord(word) ||
    KIND_MARKERS.some((marker) => marker.parts.some((part) => word.includes(part)))
  );
}

/** The kind of place a name says it is (see PlaceKind). */
export function placeKind(name: string | null | undefined): PlaceKind {
  const words = normalizeName(String(name ?? "")).split(" ");
  for (const marker of KIND_MARKERS) {
    if (words.some((word) => marker.parts.some((part) => word.includes(part)))) return marker.kind;
  }
  return "pharmacy";
}

const ARABIC_LETTER = /[ء-ي]/;

/** A name that says it is a pharmacy (صيدلية, صيدليات, pharmacy, drug store). */
export function namesAPharmacy(name: string | null | undefined): boolean {
  const normalized = normalizeName(String(name ?? ""));
  return normalized.includes("صيدل") || normalized.includes("pharm") || normalized.includes("drug");
}

/** The first half of a compound given name, written apart or joined: "عبد الرحمن" = "عبدالرحمن". */
const NAME_PREFIXES: ReadonlySet<string> = new Set(["عبد", "ابو"]);

function joinCompoundNames(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (NAME_PREFIXES.has(word) && index + 1 < words.length) {
      out.push(word + words[index + 1]);
      index += 1;
    } else {
      out.push(word);
    }
  }
  return out;
}

/**
 * The words that name WHICH place it is, in order, stemmed: no sheet marks, no kind words, no digits.
 * For a name that has Arabic letters, only its Arabic words (a listing's Latin copy of its own name
 * says nothing more).
 */
export function namingWords(name: string | null | undefined): string[] {
  const raw = String(name ?? "").replace(/[-–—_/\\|]+/g, " ");
  const kept = raw.split(/\s+/).filter((word) => word && !SHEET_NAME_MARKS.has(word)).join(" ");
  const words = joinCompoundNames(
    normalizeName(kept)
      .split(" ")
      .filter((word) => word && !/\d/.test(word) && !isKindWord(word)),
  );
  const arabicOnly = words.some((word) => ARABIC_LETTER.test(word)) ? words.filter((word) => ARABIC_LETTER.test(word)) : words;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of arabicOnly) {
    const stem = stemWord(word);
    if (stem.length < 2 || isKindWord(stem) || seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

/**
 * One letter off is the same word only from this length up. At four letters one letter is a different
 * person: احمد / محمد, بدري / بكري (both refused on the PR 821 probe only after this was raised).
 */
export const FUZZY_MIN_LETTERS = 5;

/**
 * Given names so common that a listing named only with them ("صيدلية دكتور محمد", "الدكتور أحمد السيد")
 * tells no shop apart from the next. Stemmed, normalized spelling.
 */
const COMMON_GIVEN_NAMES: ReadonlySet<string> = new Set(["محمد", "احمد", "محمود", "مصطفي", "علي", "حسن", "حسين", "ابراهيم", "سيد", "عبد"]);

/**
 * How many of the pharmacy's own name words (the town set aside) the listing must carry. One is not
 * enough for a full name: "عمر بن الخطاب" is not "صيدلية د/ عمر", "سامى الحوفى" is not "صيدلية د. سامى"
 * (the PR 821 batch of 400, 27 Nov 2026). A one-word name ("سيف", "اسامة - العياط") needs its one.
 */
export const MIN_WORDS_CARRIED = 2;

function sameWord(left: string, right: string): boolean {
  return left === right || (left.length >= FUZZY_MIN_LETTERS && right.length >= FUZZY_MIN_LETTERS && editDistanceAtMostOne(left, right));
}

/**
 * Rules 2–4: the listing is the same kind of place, names this pharmacy and adds no name of its own.
 * `brickName` is the pharmacy's brick (its town or district): the sheets often add it to the name, so
 * its words are set aside before counting how much of the name the listing carries.
 */
export function listingNamesPharmacy(pharmacyName: string, listingName: string, brickName?: string | null): boolean {
  const kind = placeKind(pharmacyName);
  if (kind !== placeKind(listingName)) return false;
  if ((kind === "pharmacy" || namesAPharmacy(pharmacyName)) && !namesAPharmacy(listingName)) return false;
  const pharmacy = namingWords(pharmacyName);
  const listing = namingWords(listingName);
  if (pharmacy.length === 0 || listing.length === 0) return false;
  if (!ARABIC_LETTER.test(listing.join(""))) return false;
  if (listing.every((word) => COMMON_GIVEN_NAMES.has(word))) return false;
  const town = new Set(namingWords(brickName));
  const ownWords = pharmacy.filter((word) => !town.has(word));
  const own = ownWords.length > 0 ? ownWords : pharmacy;
  const everyListingWordInPharmacy = listing.every((word) => pharmacy.some((candidate) => sameWord(word, candidate)));
  const firstWordInListing = listing.some((word) => sameWord(word, own[0]));
  const carried = own.filter((word) => listing.some((candidate) => sameWord(word, candidate))).length;
  return everyListingWordInPharmacy && firstWordInListing && carried >= Math.min(MIN_WORDS_CARRIED, own.length);
}

export type PlaceListing = { placeId: string; name: string; lat: number; lng: number };

export type PlaceMatchVerdict =
  | { status: "matched"; placeId: string; listingName: string; distanceKm: number }
  | { status: "no_match" }
  | { status: "ambiguous"; placeIds: string[] }
  | { status: "lookup_failed" };

/**
 * The verdict for one pharmacy on Google's answer. `listings` null means the lookup itself failed
 * (no key, Google refused, a timeout) — it is tried again next month, never guessed.
 */
export function pickPlaceMatch(input: {
  pharmacyName: string;
  brickName?: string | null;
  brickCentre: Point;
  listings: readonly PlaceListing[] | null;
}): PlaceMatchVerdict {
  if (input.listings === null) return { status: "lookup_failed" };
  const passing = new Map<string, { listing: PlaceListing; distanceKm: number }>();
  for (const listing of input.listings) {
    if (!isUsablePoint(listing.lat, listing.lng)) continue;
    const distanceKm = haversineKm({ latitude: listing.lat, longitude: listing.lng }, input.brickCentre);
    if (distanceKm > MAX_MATCH_FROM_BRICK_KM) continue;
    if (!listingNamesPharmacy(input.pharmacyName, listing.name, input.brickName)) continue;
    if (!passing.has(listing.placeId)) passing.set(listing.placeId, { listing, distanceKm });
  }
  if (passing.size === 0) return { status: "no_match" };
  if (passing.size > 1) return { status: "ambiguous", placeIds: [...passing.keys()] };
  const [only] = passing.values();
  return { status: "matched", placeId: only.listing.placeId, listingName: only.listing.name, distanceKm: only.distanceKm };
}
