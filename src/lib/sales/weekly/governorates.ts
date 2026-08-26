// Which governorate each sales AREA covers, and how that governorate is spelled in the wild.
//
// WHY THIS FILE HAS TO EXIST
// ─────────────────────────
// The owner's split rule (see branch-area-split.ts) needs to know which areas make up a
// governorate. The database has no governorate layer at all — the sales geography is only
// area + brick, and `information_schema` confirms no governorate column exists on either. So the
// grouping has to be stated somewhere, and this is that somewhere.
//
// It is keyed on the area CODE, not the area name, because the names are not consistent enough to
// parse. Stripping a trailing number works for "Minia 1" and lies about "Gharbia 1 (Tanta)",
// "Alex East", "Down town" and "Giza - Giza Centers". A rename would also silently repoint a
// name-keyed table; a code is stable.
//
// THIS IS A NAMING FACT, NOT A BUSINESS RULE — with four exceptions, marked FLAG below, where it
// genuinely is the owner's call. Those four are defaulted conservatively and are individually
// small; each one is called out where it sits.

import { placeAliases } from "@/lib/geo/egypt-locations";

/**
 * The governorate vocabulary is NOT redefined here. `src/lib/geo/egypt-locations.ts` already is
 * "the single source of truth for turning free-text / Arabic / English place strings into one
 * governorate" — it consolidated three separate copies once already, and a fourth would drift the
 * same way. Its 27 canonical labels, lowercased, are the join token used throughout this module.
 */
export const GOVERNORATE_KEYS: readonly string[] = placeAliases.map((p) => p.label.toLowerCase());

/** A lowercased canonical label from the shared table — "assiut", "kafr el-sheikh", "red sea". */
export type GovernorateKey = string;

/**
 * Area code -> the governorate(s) it covers. An area covering two governorates lists both, which
 * is not hypothetical: D26 is literally named "Port said - Domiat".
 *
 * An area absent from this map is not excluded — buildWeeklyAreaSplitIndex falls back to the
 * trailing-number heuristic, so a NEW area named "Minia 3" still lands in Minia without an edit
 * here. The map exists to be right about the ones the heuristic gets wrong.
 */
export const GOVERNORATES_BY_AREA: Record<string, GovernorateKey[]> = {
  // Alexandria + Beheira. The Alex areas are compass points, so nothing about "Alexandria 1"
  // in a distributor's branch name corresponds to them — that number is the depot's, not ours.
  AB1: ["alexandria"], AB2: ["alexandria"], AB3: ["alexandria"],
  AB4: ["beheira"], AB5: ["beheira"],

  // Cairo — all six are districts of the one governorate.
  CA1: ["cairo"], CA2: ["cairo"], CA3: ["cairo"], CA4: ["cairo"], CA5: ["cairo"], CA6: ["cairo"],

  // Delta 1
  D11: ["qalyubia"],
  D12: ["menoufia"], D13: ["menoufia"],
  D14: ["gharbia"], D15: ["gharbia"],
  D16: ["kafr el-sheikh"], D17: ["kafr el-sheikh"],

  // Delta 2
  D21: ["dakahlia"], D22: ["dakahlia"], D23: ["dakahlia"],
  D24: ["sharqia"], D25: ["sharqia"],
  D26: ["port said", "damietta"], // one area, two governorates — by its own name

  // Giza
  GZ1: ["giza"], GZ2: ["giza"], GZ3: ["giza"], GZ4: ["giza"],
  // FLAG (1 of 4): GZ5 is "Helwan-Maadi". Helwan and Maadi are administratively CAIRO, but
  // Phoenix files the area under GZ. Filed here as giza, following the company's own coding
  // rather than the map. No weekly branch names Helwan or Maadi today, so nothing turns on it yet.
  GZ5: ["giza"],
  GZ6: ["fayoum"],
  GZ7: ["giza"], // 6th of October / Sheikh Zayed are Giza governorate

  // Others
  OT1: ["north sinai"], OT2: ["suez"], OT4: ["new valley"], OT6: ["luxor"],
  OT7: ["aswan"], OT9: ["ismailia"], OT10: ["south sinai"],
  // FLAG (2 of 4): OT5 "Hurgada" and OT8 "Red Sea" are the SAME governorate. Both are listed, so
  // a branch naming Hurghada or the Red Sea splits across the two. EGP ~92,797 rides on this.
  OT5: ["red sea"], OT8: ["red sea"],

  // Upper Egypt
  UE1: ["minya"], UE2: ["minya"],
  UE3: ["assiut"], UE4: ["assiut"],
  UE5: ["sohag"], UE6: ["sohag"],
  UE7: ["qena"], UE8: ["qena"],
  UE9: ["beni suef"],
};

/**
 * Areas that must never be reached by a GOVERNORATE name, though an explicit area or brick scope
 * still resolves them.
 *
 * FLAG (3 of 4): OT3 is "Aswan (Legacy)" and OT7 is "Aswan". Left in, a branch named اسوان would
 * pay half its value to the legacy seat. EGP ~327,029 rides on this being right.
 * FLAG (4 of 4): OTMS is "Main Store" — a stock location, not a territory.
 */
export const AREAS_EXCLUDED_FROM_GOVERNORATES = new Set(["OT3", "OTMS"]);

/**
 * Fold Arabic spelling variance so a lookup does not depend on which alef or which final letter a
 * distributor's clerk typed. Also strips the definite article, Latin punctuation and diacritics.
 */
export function normalizeArabic(input: string | null | undefined): string {
  return String(input ?? "")
    .replace(/[ً-ٰٟـ]/g, "") // harakat, dagger alef, tatweel
    .replace(/[آأإٱ]/g, "ا") // آ أ إ ٱ -> ا
    .replace(/ى/g, "ي") // ى -> ي
    .replace(/ة/g, "ه") // ة -> ه
    .replace(/[ؤ]/g, "و") // ؤ -> و
    .replace(/[ئ]/g, "ي") // ئ -> ي
    .replace(/[._\-–—/\\()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Drop the definite article so "الغربيه" and "غربيه" are the same token. */
function stripArticle(token: string): string {
  return token.startsWith("ال") ? token.slice(2) : token;
}

/**
 * Spellings that appear in DISTRIBUTOR BRANCH NAMES and are not in the shared table. Everything
 * else — every governorate, and every town that resolves to one — comes from `placeAliases`.
 *
 * These are kept local rather than pushed upstream because the shared table also drives expense and
 * HR place resolution, and a two-letter token like "bhr" is safe beside "Alex-" in a depot name but
 * not in free text.
 */
const WEEKLY_EXTRA_ALIASES: Array<[string, string[]]> = [
  ["Beheira", ["bhr"]],
  ["Gharbia", ["kafr elza", "kafr elzayat"]],            // the branch truncates "Kafr El Zayat"
  ["Menoufia", ["shebien", "shebin", "شبين"]],           // Shebin El Kom, spelled three ways
  ["Damietta", ["domiat"]],
  ["Beni Suef", ["bani suwa"]],                          // the branch truncates "Bani Sueif"
  ["Minya", ["menya"]],
  ["Alexandria", ["qabary", "القبارى", "الفلكي", "al-falaky", "falaky"]],
  ["Cairo", ["almaza", "الماظه", "el-salam", "salahsalem", "صلاح سالم"]],
  ["Giza", ["الزامل", "زامل"]],
  ["Assiut", ["assuit"]],
  ["Sohag", ["البلينا"]],
];

/**
 * Phrases that name ONE AREA, not a governorate. Kept separate and matched first, because the
 * difference is money: "ك.عملاء امبابة" carries EGP 2,235,364 and Imbaba IS an area (GZ3) — reading
 * it as "somewhere in Giza" would spread five sixths of it onto reps the name never mentioned.
 *
 * Only districts that unambiguously ARE a Phoenix area appear here. A town that is merely inside a
 * governorate stays out: Mansoura and Kafr El Zayat are not areas (Dakahlia and Gharbia are split
 * by number, not by town), so those names correctly resolve to the whole governorate.
 */
const AREA_SYNONYMS: Array<[string, string[]]> = [
  ["GZ2", ["الدقي", "dokki", "المهندسين", "mohandseen", "بولاق", "bolak"]],
  ["GZ3", ["امبابه", "imbaba"]],
  ["GZ4", ["الهرم", "haram", "فيصل", "فبصل", "faisal"]], // فبصل is a typo for فيصل that is live in the data
  ["GZ5", ["حلوان", "helwan", "المعادي", "maadi"]],
  ["GZ7", ["اكتوبر", "october", "زايد", "zayed"]],
  ["CA1", ["هليوبليس", "heliopolis", "مصر الجديده"]],
  ["CA2", ["مدينه نصر", "nasr city", "م نصر"]],
  ["CA5", ["وسط البلد", "downtown", "down town"]],
  ["D14", ["طنطا", "tanta"]],
  ["D15", ["المحله", "mahalla"]],
];

/**
 * One index over BOTH tables. Longest phrase first, so "kafr el sheikh" is never eaten by the
 * shorter tokens in "kafr elzayat", and an area phrase always beats the governorate phrase it sits
 * inside.
 */
const PLACE_INDEX: Array<{ phrase: string; area?: string; governorate?: GovernorateKey }> = [
  // Areas FIRST. A phrase present in both tables must resolve to the area: "امبابه" is GZ3, not a
  // hint about Giza, and the dedupe below keeps whichever entry it meets first.
  ...AREA_SYNONYMS.flatMap(([area, phrases]) => phrases.map((phrase) => ({ phrase: normalizeArabic(phrase), area }))),
  ...WEEKLY_EXTRA_ALIASES.flatMap(([label, phrases]) =>
    phrases.map((phrase) => ({ phrase: normalizeArabic(phrase), governorate: label.toLowerCase() }))),
  ...placeAliases.flatMap((entry) =>
    entry.aliases.map((phrase) => ({ phrase: normalizeArabic(phrase), governorate: entry.label.toLowerCase() }))),
]
  .flatMap((entry) => [entry, { ...entry, phrase: stripArticle(entry.phrase) }])
  .filter((entry, i, all) => entry.phrase.length > 1 && all.findIndex((o) => o.phrase === entry.phrase) === i)
  .sort((a, b) => b.phrase.length - a.phrase.length);

export type PlaceMention = {
  /** Exactly one of these is set. An area mention is already precise; a governorate one splits. */
  area?: string;
  governorate?: GovernorateKey;
  /** Where in the normalized text it matched, so mentions come back in reading order. */
  at: number;
  /**
   * A number written immediately after the name — the "2" in "الدقهلية2 ودمياط", which binds to
   * Dakahlia and not to Damietta. Null when the name carries no adjacent number.
   */
  ordinal: number | null;
};

/**
 * Every place a piece of text names, in reading order, without double-counting an overlap.
 *
 * Matched phrases are blanked out as they are consumed. That is what stops "كفر الشيخ" also being
 * read as a bare "الشيخ", stops a place named twice counting twice, and — the reason the two tables
 * share one pass — stops "امبابه" registering as the GZ3 area and again as the Giza governorate.
 */
export function placeMentions(text: string | null | undefined): PlaceMention[] {
  let haystack = ` ${normalizeArabic(text)} `;
  const found: PlaceMention[] = [];
  for (const { phrase, area, governorate } of PLACE_INDEX) {
    for (;;) {
      const at = haystack.indexOf(phrase);
      if (at < 0) break;
      const adjacent = /^\s{0,2}(\d{1,2})(?!\d)/.exec(haystack.slice(at + phrase.length));
      haystack = haystack.slice(0, at) + " ".repeat(phrase.length) + haystack.slice(at + phrase.length);
      if (found.some((f) => (area ? f.area === area : f.governorate === governorate))) continue;
      found.push({ area, governorate, at, ordinal: adjacent ? Number(adjacent[1]) : null });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}
