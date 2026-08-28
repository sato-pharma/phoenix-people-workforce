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
// This file moves FIRST, on purpose. The matching change to the SALES geography — repointing those
// areas in au.line_area_map and au.canonical_areas — must wait until the August closing has been
// published, because the closing resolves each area's region using TODAY's map (see AGENTS.md §4),
// so moving them early would split a month of Anti Infective sales into a district that did not
// own them. Recruitment touches neither sales nor the closing, so it is safe to be correct here
// before the sales side catches up. Until it does, the two deliberately disagree about Sharkia.
//
// Held as a static reviewed map rather than a live query: the areas are named for SELLING territory
// ("Dokki - Mohandseen - Bolak"), not for governorates, so deriving this at runtime would mean
// parsing those names — and this list has to answer for governorates no area covers at all
// (Matrouh, Port Said) which a join can never produce.

// D3 added 2026-08-28: Delta (3) is live and `carries_target` in `au.regions`, and the owner was
// hiring a District Manager into it while an applicant could not choose it at all. UE-1/UE-2 are
// deliberately NOT here — they are sales subdivisions of Upper Egypt, and offering all three to a
// job applicant asks them to know an internal split they cannot be expected to know.
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
  buhayrah: "AB",
  "el beheira": "AB",
  // Delta (1)
  gharbia: "D1",
  "el gharbia": "D1",
  tanta: "D1",
  mahalla: "D1",
  "kafr el sheikh": "D1",
  "kafr elsheikh": "D1",
  "kafr al sheikh": "D1",
  kafrelsheikh: "D1",
  menoufia: "D1",
  monufia: "D1",
  menofia: "D1",
  // Delta (2)
  dakahlia: "D2",
  "el dakahlia": "D2",
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
