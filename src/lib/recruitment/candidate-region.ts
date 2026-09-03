// Recruitment / ATS — which company region a candidate's home governorate belongs to.
//
// The owner asked to filter the pool on things like "Upper Egypt district managers". `governorate`
// is free text extracted from a CV (267 of 426 filled, 2026-08-24), so there was no way to ask for
// a REGION at all — only one governorate at a time, and only if it was spelled the way the
// extractor happened to write it that day.
//
// The grouping is NOT invented here. It mirrors the company's own region vocabulary, `au.regions`
// joined to `au.canonical_areas`, which is what the Organogram and every sales screen already use:
//
//   Upper Egypt  Assuit 1/2, Minia 1/2, Qena 1/2, Sohag1/2
//   Giza         Beni Suef, Fayoum, Giza - Giza Centers, Dokki, Haram, Helwan-Maadi, Imbaba, October
//   Cairo        Cairo East 1/2, Cairo West, Down town, Heliopolis, Nasr City
//   Alex-BHR     Alex Center/East/West, Behira 1/2
//   Delta (1)    Gharbia 1/2, Kafr El-Sheikh 1/2, Menoufia 1/2
//   Delta (2)    Dakahlia 1/2/3, Port said - Domiat
//   Delta (3)    Qalubeya, Sharkia 1/2, Suez, Ismailia
//   Others       Aswan, Hurgada, Luxor, New Valley, North/South Sinai, Red Sea
//
// Owner decision 2026-08-24, asked directly: use the COMPANY regions, not plain geography. So
// Beni Suef and Fayoum are Giza here and Aswan and Luxor are Others, exactly as they are everywhere
// else in Phoenix — one vocabulary across the whole app beats a screen that quietly disagrees with
// the Organogram about where Fayoum is.

// DELTA (3) — the GOVERNORATES, 2026-08-28. A new Anti Infective district was opened — Qalubeya,
// Sharkia 1/2, Suez and Ismailia — with a District Manager hired for 2026-09-01 and her reps still
// to be recruited. The CODE joined the vocabulary below in the same day's work; this block is about
// the MAP further down, which is the half a recruiter actually feels. A CV says "Sharkia", never
// "Delta (3)", so until these five governorates were re-filed, filtering the pool on her district
// returned nothing while her own candidates sat under Delta (1), Delta (2) and Others.
//
// This file moved FIRST, and the reason it gave has since been OVERTAKEN — do not act on the old
// one. It said the sales geography "must wait until the August closing has been published, because
// the closing resolves each area's region using TODAY's map". That was true when written on
// 2026-08-28 and false about 28 hours later: #2613 gave the closing org-chart history and #2608 made
// it resolve at the PERIOD END, not the run date. The sales change then went in on 2026-08-29 as a
// dated PAIR — old row closed at `effective_to = '2026-09-01'`, a `D3` row open from it — so the two
// halves no longer disagree and NOTHING is waiting on the August closing.
//
// Read that carefully before "finishing" anything: an August closing published in September or
// October still resolves on 2026-08-31 and still contains no Delta (3) at all. That is the owner's
// golden rule, stated 2026-08-29 — "whenever I publish it, whenever I do it, it does not contain
// Delta three" — and AGENTS.md §4 carries it with the four checks that prove it is already enforced.
//
// Held as a static reviewed map rather than a live query: the areas are named for SELLING territory
// ("Dokki - Mohandseen - Bolak"), not for governorates, so deriving this at runtime would mean
// parsing those names — and this list has to answer for governorates no area covers at all
// (Matrouh, Port Said) which a join can never produce.

// D3 added 2026-08-28: Delta (3) is live and `carries_target` in `au.regions`, and the owner was
// hiring a District Manager into it while an applicant could not choose it at all. UE-1/UE-2 are
// deliberately NOT here — they are sales subdivisions of Upper Egypt, and offering all three to a
// job applicant asks them to know an internal split they cannot be expected to know.
import { normalizeArabic, placeAliases } from "@/lib/geo/egypt-locations";

export const candidateRegionCodes = ["CA", "GZ", "AB", "D1", "D2", "D3", "UE", "OT"] as const;
export type CandidateRegionCode = (typeof candidateRegionCodes)[number];

/** The company's own region names, verbatim from `au.regions.region_name`. */
export const candidateRegionLabels: Record<CandidateRegionCode, string> = {
  AB: "Alex-BHR",
  CA: "Cairo",
  D1: "Delta (1)",
  D2: "Delta (2)",
  D3: "Delta (3)",
  GZ: "Giza",
  OT: "Others",
  UE: "Upper Egypt",
};

/**
 * Governorate spellings seen in production plus the obvious variants of each. Keys are already
 * normalised by `normalizeGovernorate` below, so every key here is lowercase, unpunctuated and
 * single-spaced. Arabic spellings are listed as their own keys because transliterating at runtime
 * would be a second guess on top of the extractor's first one.
 */
const governorateRegions: Record<string, CandidateRegionCode> = {
  // Cairo
  cairo: "CA",
  "al qahira": "CA",
  "el qahira": "CA",
  qahira: "CA",
  "\u0627\u0644\u0642\u0627\u0647\u0631\u0629": "CA",
  // Giza — includes Beni Suef and Fayoum, per the company's Giza region
  giza: "GZ",
  "al giza": "GZ",
  "el giza": "GZ",
  "\u0627\u0644\u062c\u064a\u0632\u0629": "GZ",
  helwan: "GZ",
  "6th of october": "GZ",
  october: "GZ",
  "beni suef": "GZ",
  "bani suef": "GZ",
  "beni sweif": "GZ",
  "benisuef": "GZ",
  "bani seuf": "GZ",
  "beni seuf": "GZ",
  fayoum: "GZ",
  faiyum: "GZ",
  "el fayoum": "GZ",
  "al fayoum": "GZ",
  // Alex-BHR
  alexandria: "AB",
  alex: "AB",
  iskandariya: "AB",
  "\u0627\u0644\u0625\u0633\u0643\u0646\u062f\u0631\u064a\u0629": "AB",
  beheira: "AB",
  behira: "AB",
  behaira: "AB",
  buhayrah: "AB",
  buhayra: "AB",
  // One word, so the "al " article strip never fires on it - the joined spelling needs its own key.
  albuhayra: "AB",
  "el beheira": "AB",
  // Delta (1)
  gharbia: "D1",
  "el gharbia": "D1",
  tanta: "D1",
  mahalla: "D1",
  "kafr el sheikh": "D1",
  "kafr elsheikh": "D1",
  "kafr elshikh": "D1",
  "kafr al sheikh": "D1",
  kafrelsheikh: "D1",
  "kafr el shiekh": "D1",
  "kafr elshiekh": "D1",
  menoufia: "D1",
  monufia: "D1",
  menofia: "D1",
  // Delta (2)
  dakahlia: "D2",
  "el dakahlia": "D2",
  dakahliya: "D2",
  dakahleya: "D2",
  daqahlia: "D2",
  daqahliya: "D2",
  eldakahlia: "D2",
  mansoura: "D2",
  damietta: "D2",
  domiat: "D2",
  dumyat: "D2",
  "port said": "D2",
  portsaid: "D2",
  // Delta (3) — Qalubeya, Sharkia 1/2, Suez, Ismailia (district opened 2026-08-28)
  qalyubia: "D3",
  "al qalyubia": "D3",
  "el qalyubia": "D3",
  qalubeya: "D3",
  qaliubiya: "D3",
  banha: "D3",
  sharqia: "D3",
  sharkia: "D3",
  "el sharqia": "D3",
  sharqiya: "D3",
  sharqiyah: "D3",
  sharkiya: "D3",
  sharkiyah: "D3",
  // Article written ONTO the name, so `normalizeGovernorate` never sees the space it strips on. A
  // key with a space after the article — "el sharqia" above — is unreachable for the same reason;
  // spell any new one closed up, the way it arrived.
  elsharkia: "D3",
  elsharqia: "D3",
  zagazig: "D3",
  suez: "D3",
  "el suez": "D3",
  ismailia: "D3",
  ismailiya: "D3",
  "el ismailia": "D3",
  // Upper Egypt
  assiut: "UE",
  asyut: "UE",
  assuit: "UE",
  "\u0623\u0633\u064a\u0648\u0637": "UE",
  minya: "UE",
  minia: "UE",
  "el minya": "UE",
  "al minya": "UE",
  menia: "UE",
  menya: "UE",
  elmenia: "UE",
  elminia: "UE",
  qena: "UE",
  qina: "UE",
  sohag: "UE",
  suhag: "UE",
  "\u0633\u0648\u0647\u0627\u062c": "UE",
  // Others — real governorates the company does not group into a selling region
  aswan: "OT",
  luxor: "OT",
  uqsur: "OT",
  "red sea": "OT",
  hurghada: "OT",
  hurgada: "OT",
  matrouh: "OT",
  "marsa matrouh": "OT",
  "new valley": "OT",
  wadi: "OT",
  "north sinai": "OT",
  "south sinai": "OT",
  sinai: "OT",
  arish: "OT",
};

/**
 * Places that are not in Egypt, and the country they are in.
 *
 * These exist so that "we know where this person lives and it is not a Phoenix region" stops being
 * indistinguishable from "the map has a gap". Both used to answer null, so both showed the same
 * blank cell and both landed in the same filter bucket — which meant a recruiter looking at people
 * with no region could not tell which were data problems worth fixing.
 *
 * Recruitment is Egyptian nationals only, so this is not a foreign-hire list: it is Egyptians whose
 * CV gives an address abroad, overwhelmingly the Gulf, where a great many Egyptian pharmacists and
 * medical reps spend part of a career. Dubai and Gauteng are what production holds today; the rest
 * are the neighbours they arrive with, on the same "spellings seen plus the obvious variants"
 * standard the governorate map above is built to.
 *
 * These deliberately do NOT resolve to "Others". Others is a real selling region with real areas in
 * it, and filing Dubai there would claim somebody covers a territory nobody has confirmed — the
 * same reason `candidateRegionForGovernorate` returns null rather than guessing.
 */
const foreignPlaces: Record<string, string> = {
  // United Arab Emirates
  dubai: "United Arab Emirates",
  "abu dhabi": "United Arab Emirates",
  abudhabi: "United Arab Emirates",
  sharjah: "United Arab Emirates",
  ajman: "United Arab Emirates",
  uae: "United Arab Emirates",
  "united arab emirates": "United Arab Emirates",
  // Saudi Arabia
  riyadh: "Saudi Arabia",
  jeddah: "Saudi Arabia",
  dammam: "Saudi Arabia",
  khobar: "Saudi Arabia",
  makkah: "Saudi Arabia",
  mecca: "Saudi Arabia",
  medina: "Saudi Arabia",
  ksa: "Saudi Arabia",
  "saudi arabia": "Saudi Arabia",
  saudi: "Saudi Arabia",
  // The rest of the Gulf
  kuwait: "Kuwait",
  doha: "Qatar",
  qatar: "Qatar",
  manama: "Bahrain",
  bahrain: "Bahrain",
  muscat: "Oman",
  oman: "Oman",
  // Elsewhere, as production actually spells it
  gauteng: "South Africa",
  johannesburg: "South Africa",
  "south africa": "South Africa",
  uitenhage: "South Africa",
  pretoria: "South Africa",
  durban: "South Africa",
  // South Asia — the largest foreign group in the CV pool by a wide margin.
  pakistan: "Pakistan",
  karachi: "Pakistan",
  lahore: "Pakistan",
  islamabad: "Pakistan",
  rawalpindi: "Pakistan",
  india: "India",
  delhi: "India",
  mumbai: "India",
  bengaluru: "India",
  bangalore: "India",
  chennai: "India",
  hyderabad: "India",
  kolkata: "India",
  agra: "India",
  faridabad: "India",
  dehradun: "India",
  durgapur: "India",
  bhilwara: "India",
  azamgarh: "India",
  auraiya: "India",
  rajasthan: "India",
  karnataka: "India",
  haryana: "India",
  assam: "India",
  "uttar pradesh": "India",
  "west bengal": "India",
  bangladesh: "Bangladesh",
  dhaka: "Bangladesh",
  nepal: "Nepal",
  kathmandu: "Nepal",
  lalitpur: "Nepal",
  // South-East Asia
  indonesia: "Indonesia",
  jakarta: "Indonesia",
  tangerang: "Indonesia",
  banten: "Indonesia",
  philippines: "Philippines",
  manila: "Philippines",
  sampaloc: "Philippines",
  cavite: "Philippines",
  malaysia: "Malaysia",
  "kuala lumpur": "Malaysia",
  // The Levant and the rest of the Arab world
  jordan: "Jordan",
  amman: "Jordan",
  zarqa: "Jordan",
  irbid: "Jordan",
  lebanon: "Lebanon",
  beirut: "Lebanon",
  syria: "Syria",
  damascus: "Syria",
  aleppo: "Syria",
  iraq: "Iraq",
  baghdad: "Iraq",
  erbil: "Iraq",
  yemen: "Yemen",
  sanaa: "Yemen",
  sudan: "Sudan",
  khartoum: "Sudan",
  // North and West Africa. Tripoli is Libya's capital and no Egyptian town shares the name.
  libya: "Libya",
  tripoli: "Libya",
  benghazi: "Libya",
  misrata: "Libya",
  algeria: "Algeria",
  algiers: "Algeria",
  constantine: "Algeria",
  "grarem gouga": "Algeria",
  morocco: "Morocco",
  casablanca: "Morocco",
  tunisia: "Tunisia",
  tunis: "Tunisia",
  nigeria: "Nigeria",
  lagos: "Nigeria",
  abuja: "Nigeria",
  sagamu: "Nigeria",
  ogun: "Nigeria",
  ghana: "Ghana",
  accra: "Ghana",
  kenya: "Kenya",
  nairobi: "Kenya",
  // Europe and North America
  "united kingdom": "United Kingdom",
  london: "United Kingdom",
  canada: "Canada",
  toronto: "Canada",
  turkey: "Turkiye",
  istanbul: "Turkiye",
  usa: "United States",
  "united states": "United States",
  "new jersey": "United States",
  nj: "United States",
  california: "United States",
  texas: "United States",
};

/**
 * Free-text governorate reduced to a comparable key: lowercase, Arabic definite article and the
 * "governorate"/"gov." suffix removed, punctuation collapsed to single spaces.
 *
 * `al-qalyubia` and `Qalyubia` are the same place and both appear in production; without this they
 * are two options in the dropdown and each hides the other's candidates.
 */
export function normalizeGovernorate(raw: string | null | undefined): string {
  const flattened = String(raw ?? "")
    .toLowerCase()
    .replace(/\bgovernorate\b|\bgov\.?\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  // Article stripped LAST, on the already-trimmed string. " Al-Qalyubia " flattens to " al qalyubia "
  // with a leading space, so an earlier ^(al|el) could never match it — which is exactly what the
  // test caught. The region lookup still resolved via the word-by-word fallback, so this was a
  // silently wrong normaliser sitting behind a correct-looking answer.
  return flattened.replace(/^(al|el)\s+/, "");
}

/**
 * The company region a governorate sits in, or null when the field is blank or names somewhere the
 * map does not cover. Null is deliberately NOT "Others": "Others" is a real selling region with
 * real areas in it, and folding unknown text into it would silently claim a candidate works a
 * territory nobody has confirmed.
 */
export function candidateRegionForGovernorate(raw: string | null | undefined): CandidateRegionCode | null {
  const key = normalizeGovernorate(raw);
  if (!key) return null;
  const direct = governorateRegions[key];
  if (direct) return direct;
  // "Cairo, Egypt" and "Sohag - Egypt" both reach here; the first recognised word wins.
  for (const part of key.split(" ")) {
    const hit = governorateRegions[part];
    if (hit) return hit;
  }
  return null;
}

/** Human-readable region name for a governorate, for display next to the value itself. */
export function candidateRegionLabelForGovernorate(raw: string | null | undefined): string | null {
  const code = candidateRegionForGovernorate(raw);
  return code ? candidateRegionLabels[code] : null;
}

/** What a screen calls someone whose address is outside Egypt, so it never reads as a blank. */
export const foreignRegionLabel = "Outside Egypt";

/**
 * The country an address names when it is not in Egypt, or null.
 *
 * Asked only once `candidateRegionForGovernorate` has already answered null, so an Egyptian
 * governorate can never reach it and the existing region answers are untouched by this file's
 * foreign list. Kept as its own question rather than folded into the region lookup because the two
 * answers mean different things: one is which of the company's regions somebody works, the other is
 * that the question does not apply to them.
 */
export function foreignCountryForGovernorate(raw: string | null | undefined): string | null {
  const key = normalizeGovernorate(raw);
  if (!key) return null;
  const direct = foreignPlaces[key];
  if (direct) return direct;
  // "Dubai, UAE" and "Riyadh - Saudi Arabia" both reach here; the first recognised word wins, the
  // same fallback the governorate lookup uses.
  for (const part of key.split(" ")) {
    const hit = foreignPlaces[part];
    if (hit) return hit;
  }
  return null;
}

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

// ── The AREA rows the apply flow shows under each region ───────────────────────────────────────────
// Question 3's area LIST is read live from the SALES geography (`au.canonical_areas`, via
// `au_v_canonical_areas`), which exposes OPEN rows only — "who owns this area today". Today, in
// August, that is still Delta (1), Delta (2) and Others for Qalubeya, Sharkia 1, Sharkia 2, Suez and
// Ismailia, and it carries no Delta (3) row at all — so without an override an applicant who picks
// "Delta (3)" is shown an EMPTY area list.
//
// NOTHING IS PENDING ON THE SALES SIDE, and this comment used to say otherwise. The Delta (3) move is
// not deferred awaiting the August closing: it was applied as a migration on 2026-08-29 and written as
// a DATED PAIR — the old row closed at `effective_to = '2026-09-01'`, a `D3` row open from that date.
// The date does the work, and AGENTS.md §4 forbids re-applying, re-dating or "finishing" it.
//
// The region MAP above already calls those five governorates Delta (3), so without this the apply
// flow contradicts itself: the same five areas still appear under Delta (1)/(2)/Others, and someone
// from Sharkia who taps the region where they SEE their area is filed under Delta (2) — the exact
// mis-file the region move was made to prevent. This map overrides the sales grouping for
// RECRUITMENT ONLY: it moves nothing in the database and is invisible to sales, the closing and every
// other consumer of `au.canonical_areas`.
//
// 🔒 THIS MAP IS PERMANENT — DO NOT EMPTY IT, and the instruction to do so is what this note replaces.
// Delta (3) is ANTI-INFECTIVE ONLY (owner-confirmed 2026-08-29, verified against production the same
// day). From 1 September the five areas flip to `D3` on `anti_infective` and on NO other line: on CNS
// and Pedia they keep their districts for good — Qalubeya stays Delta (1), Sharkia 1/2 stay Delta (2),
// Suez and Ismailia stay Others, in both months. Sales therefore never "catches up" for those lines
// and these overrides never become no-ops. The apply flow asks role, then region, then area, and has
// no concept of a product line, so one unconditional grouping is all it can express — and Delta (3) is
// the right one, because that is the district being staffed (`area_state = 'vacant_will_hire'`), which
// is what an applicant is being routed towards.
//
// Keyed by the EXACT `area_name` in `au.canonical_areas` (verified against production 2026-08-29). A
// rename there would silently drop the override, so the registered test pins these five names.
export const recruitmentAreaRegionOverrides: Record<string, CandidateRegionCode> = {
  Qalubeya: "D3",
  "Sharkia 1": "D3",
  "Sharkia 2": "D3",
  Suez: "D3",
  Ismailia: "D3",
};

/**
 * The region an area belongs to IN RECRUITMENT: the sales region it carries in `au.canonical_areas`,
 * unless it is one of the five areas the Delta (3) recruitment split has already moved. Pure — it is
 * handed the sales region rather than reading the database, so the grouping stays testable.
 */
export function recruitmentRegionForArea(areaName: string, salesRegionCode: string): string {
  return recruitmentAreaRegionOverrides[areaName] ?? salesRegionCode;
}
