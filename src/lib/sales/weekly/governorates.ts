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
  // One depot IS pinned to AB3 in AREA_SYNONYMS below, and that is not an exception to this line:
  // the owner placed it there by name. Its number matching AB3's is a coincidence, not a reading.
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
 * A name earns a place here one of three ways, and never on the strength of a map of Egypt.
 *
 *   1. The district unambiguously IS a Phoenix area. A town that is merely inside a governorate
 *      does not qualify: Mansoura and Kafr El Zayat are not areas (Dakahlia and Gharbia are split
 *      by number, not by town), so those names correctly resolve to the whole governorate.
 *   2. THE BRICK TABLE puts the place in exactly one area. `source_of_sales_bricks` is the
 *      company's own authority for which area a place belongs to — it outranks any geography we
 *      could reason out — so when it files a town under a single area, that is a fact about
 *      Phoenix, not a guess about Egypt. Every entry below marked `brick:` was read out of it.
 *   3. THE OWNER RULED ON THAT DEPOT BY NAME. Some depot names are not a place at all — they are a
 *      commercial round covering several, one of which no area may even cover. No table can answer
 *      that; only he can. An entry marked `owner:` carries his words and the date, and it is NOT
 *      to be "corrected" against the brick table later — the brick table was never its source.
 *
 * The brick path already resolves a branch whose name IS a brick verbatim (see brickScope). These
 * exist because a distributor never writes the brick verbatim: the depot is "Kalioub Branch", the
 * brick is "قليوب". Without the alias the name states no place and the money spreads across the
 * whole region — Aswan's depot was landing on fourteen areas.
 */
const AREA_SYNONYMS: Array<[string, string[]]> = [
  // owner: 2026-08-27, asked which area "ك.عملاء مطروح واسكن3" belongs to — "Matrouh and
  // Alexandria 3 ALEX WEST". AB3 IS Alex West. The depot is one commercial round over Matrouh,
  // which NO Phoenix area covers, plus the distributor's own "Alexandria 3" — so neither half
  // could be looked up, and this is his call rather than a reading of any table.
  //
  // The WHOLE phrase is registered, never a bare "اسكن3" and never a bare "مطروح":
  //   - مطروح alone is a governorate two tables down, and matching it first would drop the branch
  //     onto no area at all, which is exactly the bug this fixes. The longest phrase wins, so
  //     spelling it out in full is what keeps that from happening.
  //   - Alexandria depots 1, 2 and 4 also exist and he has NOT ruled on them; they keep reading
  //     the whole Alexandria governorate. A bare "اسكن3" risks a later depot 3 of somewhere else.
  // Both spacings appear because a distributor's spacing is not a promise.
  ["AB3", ["مطروح واسكن3", "مطروح و اسكن3"]],
  ["GZ2", ["الدقي", "dokki", "المهندسين", "mohandseen", "بولاق", "bolak"]],
  ["GZ3", ["امبابه", "imbaba"]],
  // فبصل is a typo for فيصل that is live in the data. brick: ترعة المريوطية -> GZ4.
  ["GZ4", ["الهرم", "haram", "فيصل", "فبصل", "faisal", "maryoutia"]],
  ["GZ5", ["حلوان", "helwan", "المعادي", "maadi"]],
  ["GZ7", ["اكتوبر", "october", "زايد", "zayed"]],
  ["CA1", ["هليوبليس", "heliopolis", "مصر الجديده"]],
  ["CA2", ["مدينه نصر", "nasr city", "م نصر"]],
  ["CA3", ["ain shams"]], // brick: عين شمس الشرقيه AND عين شمس الغربيه, both CA3 — no ambiguity
  ["CA5", ["وسط البلد", "downtown", "down town"]],
  ["D11", ["kalioub"]], // brick: قليوب -> D11
  // brick: شبين الكوم -> D12. The WHOLE phrase, never a bare "shbein": شبين القناطر is a DIFFERENT
  // town and the brick table files it under D11 Qalubeya. The Arabic "شبين" alias two tables down
  // already reads Menoufia for both, which is wrong for القناطر — do not copy that shortcut here.
  ["D12", ["shbein el kom"]],
  ["D14", ["طنطا", "tanta"]],
  ["D15", ["المحله", "mahalla"]],
  ["D25", ["fakous"]], // brick: فاقوس -> D25 (Sharkia 2), not the Sharkia governorate at large
  // brick: السويس -> OT2. English only, deliberately: the Arabic bare سويس also sits inside
  // "جسر السويس", which is a street in CAIRO and files under CA3.
  ["OT2", ["suiz"]],
  ["UE9", ["bani swif"]], // brick: مدينة بنى سويف -> UE9. "bani suwa" below is a different truncation
];

/**
 * Phrases that name a whole REGION of the organogram, not a governorate.
 *
 * These exist because the biggest depots left unread were named after regions, not places:
 * "Direct - Delta (1)" EGP 1,791,647, "Direct - Delta (2)" 957,899, "Super KA. W Delta1" 423,113,
 * "Direct - Upper Egypt" 506,515. A region IS a statement of territory — it is the organogram's own
 * unit — so a depot named for one spreads across that region's areas ON THAT LINE, which is where
 * the owner's per-line Beni Suef rule falls out for free (see areasForRegionScope).
 *
 * A BARE "Delta" IS DELIBERATELY ABSENT. "Super KA Delta" (EGP 900,983 plus its 1,179,245 mirror)
 * names neither Delta 1 nor Delta 2, and choosing one would move a million pounds on the strength
 * of one word. It falls through to the region the owner himself mapped the branch to, which is
 * exactly today's behaviour and no worse. Same for "Canal" and "National": the first is not one of
 * our regions, the second is the whole country and belongs to nobody.
 */
const REGION_SYNONYMS: Array<[string, string[]]> = [
  ["D1", ["delta 1", "delta1"]],
  ["D2", ["delta 2", "delta2", "del2"]],   // "del2" is the private-hospital depot's spelling
  ["UE", ["upper egypt", "صعيد", "upper"]], // bare "upper" is that depot too; "upper egypt" is longer and still wins
  ["AB", ["alex-bhr", "alex bhr"]],
  ["OT", ["others"]],
];

/**
 * One index over BOTH tables. Longest phrase first, so "kafr el sheikh" is never eaten by the
 * shorter tokens in "kafr elzayat", and an area phrase always beats the governorate phrase it sits
 * inside.
 */
const PLACE_INDEX: Array<{ phrase: string; area?: string; governorate?: GovernorateKey; region?: string }> = [
  // Areas FIRST. A phrase present in both tables must resolve to the area: "امبابه" is GZ3, not a
  // hint about Giza, and the dedupe below keeps whichever entry it meets first.
  ...AREA_SYNONYMS.flatMap(([area, phrases]) => phrases.map((phrase) => ({ phrase: normalizeArabic(phrase), area }))),
  ...WEEKLY_EXTRA_ALIASES.flatMap(([label, phrases]) =>
    phrases.map((phrase) => ({ phrase: normalizeArabic(phrase), governorate: label.toLowerCase() }))),
  ...placeAliases.flatMap((entry) =>
    entry.aliases.map((phrase) => ({ phrase: normalizeArabic(phrase), governorate: entry.label.toLowerCase() }))),
  // Regions LAST, so "Cairo" and "Giza" — which are both a governorate and a region — keep their
  // governorate reading. Only a phrase no place answers to, like "Delta 1", resolves as a region.
  ...REGION_SYNONYMS.flatMap(([region, phrases]) => phrases.map((phrase) => ({ phrase: normalizeArabic(phrase), region }))),
]
  .flatMap((entry) => [entry, { ...entry, phrase: stripArticle(entry.phrase) }])
  .filter((entry, i, all) => entry.phrase.length > 1 && all.findIndex((o) => o.phrase === entry.phrase) === i)
  .sort((a, b) => b.phrase.length - a.phrase.length);

export type PlaceMention = {
  /** Exactly one of these is set. An area mention is already precise; the other two split. */
  area?: string;
  governorate?: GovernorateKey;
  /** An organogram region code — "D1", "UE". Splits across that region's areas on the line. */
  region?: string;
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
  const already = (m: PlaceMention, area?: string, governorate?: string, region?: string) =>
    area ? m.area === area : governorate ? m.governorate === governorate : m.region === region;
  for (const { phrase, area, governorate, region } of PLACE_INDEX) {
    for (;;) {
      const at = haystack.indexOf(phrase);
      if (at < 0) break;
      const adjacent = /^\s{0,2}(\d{1,2})(?!\d)/.exec(haystack.slice(at + phrase.length));
      haystack = haystack.slice(0, at) + " ".repeat(phrase.length) + haystack.slice(at + phrase.length);
      if (found.some((f) => already(f, area, governorate, region))) continue;
      found.push({ area, governorate, region, at, ordinal: adjacent ? Number(adjacent[1]) : null });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}
