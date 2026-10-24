// Customer channel — is a Source-of-Sales customer a HOSPITAL, a STORE (wholesaler / warehouse /
// trading company) or a PHARMACY?
//
// The owner's rule (2026-08-04): a customer whose NAME contains any of six Arabic words is a
// store; everything else is a pharmacy. Hospitals were added as a third channel on 2026-08-05 on
// the same principle — a name carrying مستشف (which covers both مستشفى and مستشفي) or the latin
// "hosp" is a hospital.
//
// EXTENDED 2026-09-06, after he ruled on 167 customers one by one (see THE TRADE PHRASE below):
// the six words are joined by a PHRASE — a business word (تجارة / توزيع / توريد) together with a
// goods word (أدوية / دواء) — plus four override lists and a set of words that mean "never a
// store". `isStoreCustomer` holds the single order of precedence; read that function to see the
// whole rule in one place. This is deliberately computed at READ time from the customer's name rather
// than stored on the row, so it applies identically to the sales already uploaded and to every
// future historical upload — a new sheet needs no backfill, no migration and no re-classification
// step. Add a word to either list below and the whole history re-classifies on the next render.
//
// Matching is SUBSTRING, not whole-word: مخزن must also catch المخزن, and فارم must catch فارما,
// فارماسي and فارمسي. Because فارم is a prefix of فارما, the shorter stem covers both.

export type CustomerChannel = "hospital" | "pharmacy" | "store";

export type ChannelNameKeyword = {
  /** What the owner calls this word — shown in the UI and in exports. */
  readonly label: string;
  /** The stem actually matched. Normalised before use, so spelling here is forgiving. */
  readonly stem: string;
};

// THE single edit point for the store rule. Adding an entry re-classifies all history.
export const STORE_NAME_KEYWORDS: readonly ChannelNameKeyword[] = [
  { label: "مخزن", stem: "مخزن" },
  // فارم is a prefix of فارما, so one stem covers فارم / فارما / فارماسي / فارمسي.
  { label: "فارما / فارم", stem: "فارم" },
  { label: "تريد", stem: "تريد" },
  { label: "الشركة", stem: "الشركة" },
  { label: "الجمعيه", stem: "الجمعيه" },
  { label: "للتجارة", stem: "للتجارة" },
];

/**
 * Name PREFIXES that mean "warehouse". Matched at the START of the name only — never as a substring.
 *
 * «م - » is EPDA's own notation for مخزن. Owner, 2026-09-07, on a list of 19 EPDA customers: "all
 * those warhouse and should be splitted". Measured on production the same day, over
 * source_of_sales_import_rows: 29 distinct customer names (30 client codes) START with it, worth
 * 5,995,985 EGP across EP / EP-BK / EP-PHS, and every one is unmistakably a warehouse — م - دار
 * الادوية, م - جراند فارم, م - سمارت, م - ايه ام جروب, م - المنوفية لتجارة الادوية.
 *
 * 🔴 IT CANNOT BE A KEYWORD, AND THAT IS THE WHOLE REASON THIS LIST EXISTS. STORE_NAME_KEYWORDS
 * matches a SUBSTRING anywhere in the name, and «م - » appears somewhere inside 623 names while
 * starting only 29 of them. The other 594 (592 client codes, 5,103,941 EGP) are ordinary pharmacies
 * whose preceding word simply ends in م: «السلام - المنيا», «همام - المطار», «هدي الاسلام - بنى
 * سويف», «فرندز فارم - شبين الكوم». Adding it to the keyword list would have reclassified all 594 as
 * warehouses and scattered their sales across their cities — and nothing downstream would have
 * reported it, because the split preserves each line's unit total while moving units between areas,
 * so the publication drift check, which compares UNITS, sees nothing at all.
 *
 * Before adding a prefix here, count it BOTH ways on live data. The gap between 623 and 29 is the
 * entire difference between a correct rule and a silent disaster.
 */
export const STORE_NAME_PREFIXES: readonly ChannelNameKeyword[] = [
  { label: "م - (مخزن, EPDA notation)", stem: "م - " },
  { label: "م- (مخزن, unspaced)", stem: "م- " },
];

// THE single edit point for the hospital rule. مستشف is the shared prefix of مستشفى and مستشفي,
// so one stem covers both spellings and every suffix distributors put after them.
export const HOSPITAL_NAME_KEYWORDS: readonly ChannelNameKeyword[] = [
  { label: "مستشفى / مستشفي", stem: "مستشف" },
  // normalizeCustomerName lowercases latin, so this stem catches Hospital / HOSPITAL / hospitals.
  { label: "hospital", stem: "hosp" },
];

// Harakat (U+064B–U+0652), tatweel (U+0640) and the superscript alef (U+0670) carry no identity
// in a typed customer name — distributors add them inconsistently. Strip them entirely.
const ARABIC_MARKS = /[ً-ْـٰ]/g;

// Letters Egyptian data entry treats as interchangeable. Without this fold, searching الشركة
// finds NONE of the real customers, because they are stored as الشركه.
const LETTER_FOLD: ReadonlyMap<string, string> = new Map([
  ["أ", "ا"], // أ -> ا
  ["إ", "ا"], // إ -> ا
  ["آ", "ا"], // آ -> ا
  ["ٱ", "ا"], // ٱ -> ا
  ["ة", "ه"], // ة -> ه
  ["ى", "ي"], // ى -> ي
  ["ی", "ي"], // ی (farsi yeh) -> ي
  ["ک", "ك"], // ک (keheh) -> ك
  // Lam-alef PRESENTATION FORMS. Several distributors export these single codepoints instead of
  // the two-letter sequence, so اﻻدوية and الادوية are the same word stored two different ways and
  // a substring match finds neither inside the other. Measured on production 2026-09-06: the
  // ligature form appears in customer names the owner ruled are warehouses (الاهرام
  // لتجارةاﻻدويةومستلزمات الطبية, الزهراء لتجارةوتوزيع اﻻدويةومستلزمات), so without this fold the
  // trade phrase below misses them and their sales stay on one area.
  ["ﻵ", "لا"], ["ﻶ", "لا"],
  ["ﻷ", "لا"], ["ﻸ", "لا"],
  ["ﻹ", "لا"], ["ﻺ", "لا"],
  ["ﻻ", "لا"], ["ﻼ", "لا"],
]);

/**
 * Fold an Arabic customer name to the form both sides of a comparison must share:
 * marks stripped, interchangeable letters unified, latin lowercased, whitespace collapsed.
 * Exported because the same folding has to be applied to any search box that looks for these
 * words — a raw `includes` silently misses most real matches.
 */
export function normalizeCustomerName(value: string | null | undefined): string {
  const raw = String(value ?? "").replace(ARABIC_MARKS, "");
  let folded = "";
  for (const char of raw) folded += LETTER_FOLD.get(char) ?? char;
  return folded.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A keyword with its stem already folded, both spaced and squashed. */
type PreparedKeyword = { readonly label: string; readonly spaced: string; readonly squashed: string };

/*
 * Each list's stems, folded ONCE per list rather than once per stem per name.
 *
 * Folding a stem on every call was the cost of a classification: ~58 stems folded for every name,
 * ~0.35 ms each, so the Master Map's ~74,000 shops spent ~25 s of the web server's one thread just
 * re-folding the same 58 words (measured 24 Oct 2026). The folded stem is a pure function of the
 * stem, so caching it changes no answer. Keyed by the list itself: every list here is a readonly
 * module constant, and a caller that passes its own array simply gets its own entry.
 */
const PREPARED_KEYWORDS = new WeakMap<readonly ChannelNameKeyword[], readonly PreparedKeyword[]>();

function prepareKeywords(entries: readonly ChannelNameKeyword[]): readonly PreparedKeyword[] {
  let prepared = PREPARED_KEYWORDS.get(entries);
  if (!prepared) {
    prepared = entries.map((entry) => {
      const spaced = normalizeCustomerName(entry.stem);
      return { label: entry.label, spaced, squashed: spaced.replace(/\s+/g, "") };
    });
    PREPARED_KEYWORDS.set(entries, prepared);
  }
  return prepared;
}

/** The name folded once, in the two forms every matcher compares against. */
type FoldedName = { readonly spaced: string; readonly squashed: string };

function foldName(name: string | null | undefined): FoldedName {
  const spaced = normalizeCustomerName(name);
  return { spaced, squashed: spaced.replace(/\s+/g, "") };
}

function matchFoldedKeywords(folded: FoldedName, keywords: readonly ChannelNameKeyword[]): string[] {
  if (!folded.spaced) return [];
  return prepareKeywords(keywords)
    .filter((keyword) => folded.spaced.includes(keyword.spaced))
    .map((keyword) => keyword.label);
}

function matchKeywords(
  name: string | null | undefined,
  keywords: readonly ChannelNameKeyword[],
): string[] {
  return matchFoldedKeywords(foldName(name), keywords);
}

function matchFoldedPrefixes(folded: FoldedName): string[] {
  if (!folded.spaced) return [];
  return prepareKeywords(STORE_NAME_PREFIXES)
    .filter((entry) => folded.spaced.startsWith(entry.spaced))
    .map((entry) => entry.label);
}

/**
 * Which of the owner's store words appear in this customer's name, in the order they are listed
 * above. Empty array means the name carries no store word. Used by the Stores tab to show WHY a
 * customer was classified as a store, so a false positive is visible rather than buried.
 */
export function matchedStoreKeywords(name: string | null | undefined): string[] {
  return matchKeywords(name, STORE_NAME_KEYWORDS);
}

/**
 * Which store PREFIXES this name starts with. Anchored with startsWith, never includes — see the
 * doc on STORE_NAME_PREFIXES for the 590-vs-40 measurement that makes the distinction load-bearing.
 */
export function matchedStorePrefixes(name: string | null | undefined): string[] {
  return matchFoldedPrefixes(foldName(name));
}

/** Which hospital words appear in this customer's name. Same purpose as the store version. */
export function matchedHospitalKeywords(name: string | null | undefined): string[] {
  return matchKeywords(name, HOSPITAL_NAME_KEYWORDS);
}

/**
 * The words that explain the channel this customer was actually placed in — hospital words when
 * it is a hospital, store words otherwise. A pharmacy reports none.
 */
export function matchedChannelKeywords(name: string | null | undefined): string[] {
  const hospital = matchedHospitalKeywords(name);
  return hospital.length > 0 ? hospital : matchedStoreKeywords(name);
}

/**
 * Customers the owner has ruled are PHARMACIES even though their name carries a store word.
 *
 * THE SINGLE EDIT POINT for the exceptions. Keyed by CUSTOMER CODE, not name: the same shop is
 * spelled differently in each distributor's file, so a name-keyed exception silently stops applying
 * the first time a distributor writes it another way — while the code stays put.
 *
 * The owner reviewed all 22 store-classified Anti Infective customers on 2026-08-06 and ruled every
 * one a genuine store except the two below. Kept as an explicit list rather than by weakening the
 * keywords, because he also ruled the keyword list must stay exactly as it is.
 */
export const PHARMACY_OVERRIDE_CLIENT_CODES: ReadonlySet<string> = new Set([
  // المتحدةشركة صيدليات عابدين فارما — a pharmacy chain, not a warehouse. Matched on فارم.
  "421516",
  // مخزن الطرشوبى للادويه — a pharmacy despite the name. Matched on مخزن, the one keyword that
  // looked safe, which is exactly why these exceptions are keyed by code and not by weakening a
  // word: no keyword survives contact with how shops actually name themselves.
  "1577318",
]);

/**
 * Customers the owner has ruled are STORES even though their name carries none of the six words.
 *
 * THE SINGLE EDIT POINT for these exceptions, keyed by DISTRIBUTOR + CUSTOMER CODE because a
 * customer code is only unique inside one distributor. A name-keyed exception stops applying the
 * moment a distributor spells it differently, while this composite identity stays put.
 *
 * The owner ruled on 2026-08-07 that ابن خلدون (client code 446299, distributor IBNSINA) is a
 * genuine wholesaler and must be split across its city's areas like the others, even though its
 * name — confirmed in production as exactly "ابن خلدون" on every period on record — carries none
 * of the STORE_NAME_KEYWORDS. Comparing its Jul-2026 Menoufia sales against the frontend closing
 * workbook showed the four other Menoufia wholesalers already split correctly on their names
 * (فرندز فارم, مخزن القادسية, جي زد فارما, بدر فارما); this one just never had a matching word.
 *
 * 🔴 AN ENTRY HERE IS NOT PERIOD-GATED, AND IT DOES NOT NEED TO BE — the SPLIT is gated instead.
 * `isStoreOverride` is consulted by BOTH `isStoreCustomer` and `legacyIsStoreCustomer`, so adding a
 * key re-answers "is this a warehouse" for every period on record at once. What stops that from
 * restating a published month is `STORE_CITY_SPLIT_FROM_PERIOD` in store-sales-city-split.ts: no
 * month before 2026-08 divides a warehouse's sales at all, so an override added today cannot move a
 * single area figure in July or earlier. Before adding a key, list the customer's periods and check
 * that the ones at or after that gate are the only ones you mean to change. What DOES change in
 * every period is the channel LABEL the Stores tab and the channel comparison print for it — a
 * breakdown, never an area or an achievement.
 *
 * عامر قطب (client code 402837, distributor IS) — owner ruling 2026-09-10, asked with the evidence
 * below and answered "yes عامر قطب is a warehouse too, split it".
 *
 * WHAT MADE IT A QUESTION RATHER THAN A GUESS. The name carries none of the six store words and
 * states no business at all, so both the old rule and the trade phrase call it a pharmacy, and Ibn
 * Sina's address for it reads «6 جمعية احمد عرابى محل 8 عقار 265 ش» — محل 8 is a SHOP number. Every
 * signal the rule can read says pharmacy.
 *
 * WHAT DECIDED IT. Its entire August 2026 CNS month is one invoice line that is identical to one of
 * ميدل ايست فارما's (446025, a warehouse on فارما, in the SAME brick B12-12): 1,300 units of TE001
 * Tebofotin drops, 78,975.00 EGP, both dated 2026-08-31. Its July was 2,409.75. Two accounts in one
 * brick taking the same 1,300 units of the same product on the same day is the evidence shape
 * AGENTS.md §2.3 accepts for identity — byte-identical order lines in one brick — and it is the only
 * reason this was put to the owner instead of left alone. It was NOT decided on the name, on the
 * August jump, or on a session's inference about the address.
 *
 * WHAT IT MOVES: August 2026 CNS only. 78,975.00 EGP stops sitting whole on Cairo East 2 (CA4) and
 * becomes 13,162.50 on each of the six Cairo areas, so CA4 gives up 65,812.50 and CA1/CA2/CA3/CA5/CA6
 * each gain 13,162.50. Nothing leaves CNS and nothing leaves Cairo. Its other periods on record
 * (2026-01 12,116.25, 2026-02 1,316.25, 2026-07 2,409.75, all CNS) are all before
 * STORE_CITY_SPLIT_FROM_PERIOD and keep the numbers they were published with. August CNS was neither
 * published nor locked when this shipped; August Anti Infective was, and carries no row for it.
 *
 * ITS SIBLING AT ELGOMHOURIA IS HERE TOO, and only because the owner was asked. «عامر قطب - جمعيه
 * احمد عرابى» (33995, EG) records the same shop at the same building and the same shop number — two
 * distributors independently writing عقار 265 / محل 8, which is the one address-based identity signal
 * AGENTS.md §2.3 accepts. It was deliberately left out of the first pass and put to him instead;
 * owner, 2026-09-10: "yes add it too".
 *
 * ⚠ IT MOVES NOTHING TODAY, AND THAT IS THE POINT OF RECORDING IT. Its only periods on production are
 * 2026-01 (1,670.63), 2026-06 (1,620.00) and 2026-07 (810.00), all CNS on CA4, all before
 * STORE_CITY_SPLIT_FROM_PERIOD — so every figure stays exactly where it is. The key decides how the
 * account is treated the FIRST time it sells at or after August, which is precisely when nobody will
 * be looking at it. A future session measuring this key and finding 0.00 is reading the CORRECT
 * state, not a broken override.
 */
export const STORE_OVERRIDE_CUSTOMER_KEYS: ReadonlySet<string> = new Set([
  // ابن خلدون — a wholesaler despite carrying no store keyword.
  "IS-S|446299",
  // عامر قطب at Ibn Sina — a wholesaler despite a shop address and no store keyword. Owner 2026-09-10.
  "IS|402837",
  // عامر قطب - جمعيه احمد عرابى at Elgomhouria — the SAME shop, second distributor. Owner 2026-09-10.
  "EG|33995",
  // ─── الفاتح, Delta 1 — owner ruling 2026-09-23 ────────────────────────────────────────────────
  // The owner ruled that the Delta (1) "الفاتح" accounts are all one wholesaler mis-booked as
  // pharmacies. Its Helwan branch «الفاتح لتجارة وتوزيع الادويه» (SF 1500017188) is already a store
  // on the trade phrase, but these bare-name Delta accounts carry none of the six store words and no
  // trade phrase, so both rules called each a pharmacy and credited its whole sell-in to the one
  // brick it happened to book on. Keyed here so the city split spreads each across its own city's
  // areas like every other مخزن.
  //
  // WHAT IT MOVES. Only 446433 has tracked sales at or after the August split gate. Its August 2026
  // Anti Infective — 200 units / 17,190.00 EGP, whole on Mahalla (D15) — becomes 100 units /
  // 8,595.00 on EACH of Gharbia's two areas, so D15 gives up 8,595.00 to Tanta (D14). Nothing leaves
  // Anti Infective and nothing leaves Delta. August Anti Infective was UNLOCKED by the owner on
  // 2026-09-22 expressly to take this restatement; its July AI (50 units) is before the split gate
  // and does not move. The other two keys carry no split-eligible sales at or after August —
  // 1552831's August is Head Office (excluded from the split) and 1520649 has no sales rows — so
  // they move 0.00 today and only decide how each account is treated the first time it sells.
  //
  // KEYS ARE NORMALIZED. PS pads its codes with leading zeros in the data ("0001552831"), and
  // isStoreOverride() looks up normalizeClientCode(code) which strips them, so the key MUST be the
  // zero-stripped "1552831" — the padded form would never match. (The closing SQL ltrims both
  // sides, so it matches either way; only the TS classifier needs the normalized key.)
  "IS-S|446433",
  "PS|1552831",
  "PS|1520649",
  // ─── بدر, Delta 1 (Menoufia) — owner ruling 2026-09-23 ─────────────────────────────────────────
  // Another Delta (1) wholesaler mis-booked as a pharmacy, same as ابن خلدون / الفاتح above. It sits
  // in Menoufia (areas D12 + D13), so the city split spreads each sale 50/50 across the two. Code
  // 386724 sells through TWO distributors, so it needs a key for each: IS on CNS and IS-S on Anti
  // Infective (both booked on D12).
  //
  // NOTE on الرساله فارم (code 1557996, PS): the owner listed it too, but its name already matches the
  // «فارم» STORE_NAME_KEYWORD, so it is ALREADY a store and already city-splits — no override needed.
  //
  // WHAT بدر MOVES in August 2026 (the owner unlocked ALL of August — AI, CNS and Pedia — on
  // 2026-09-22, so both lines below restate):
  //   AI  20u / 2,223.00 whole on D12 → 10u / 1,111.50 on each of D12, D13  (D12→D13 1,111.50)
  //   CNS 10u / 344.25   whole on D12 →  5u / 172.13 on each of D12, D13    (D12→D13 172.13)
  //   Nothing leaves its own line and nothing leaves Delta. Its pre-August months are before the
  //   split gate and do not move. Code carries no leading zeros, so the keys are the code as written.
  "IS|386724",
  "IS-S|386724",
  // ─── دار الطب-الفاتح-طنطا, Gharbia — owner ruling 2026-09-23 ────────────────────────────────────
  // Code 7010216, distributor RM, in Tanta (D14 → Gharbia, so the split spreads across D14 + D15 like
  // الفاتح above). The name carries no store word, so it defaults to pharmacy and needs the override.
  // Its only sales record on file is a single -1 / -60.75 CNS return in July 2026 (D14), which is
  // before the split gate — so it MOVES 0.00 today and the key only decides how the account is
  // treated the first time it sells on a tracked line from August on.
  "RM|7010216",
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE TRADE PHRASE, AND WHAT OVERRULES IT — owner decisions, 2026-09-06.
//
// The six STORE_NAME_KEYWORDS above are single words, and three of them were written too narrowly
// to match how companies actually spell themselves: مخزن never matched its own plural مخازن,
// للتجارة needs two lams where most write لتجارة, and الشركة needs the definite article where most
// write plain شركة. Scanning all 42,716 customers on the split-eligible lines surfaced 167 the six
// words miss; the owner ruled on every one of them, one row at a time, in
// `xlsx/sos-warehouse-keyword-decisions-2026-09-06.xlsx`.
//
// HIS ANSWERS DESCRIBE A CONCEPT, NOT A LONGER WORD LIST: a warehouse is a company whose name says
// its BUSINESS is trading or distributing MEDICINES — unless the name says it is a pharmacy, a
// hospital, or a government store. Encoded below as a phrase (business + goods) plus exclusions,
// it agrees with 92% of his 167 answers and finds 68 of the 73 he called warehouses. The five it
// cannot find say nothing about medicines at all and are named individually.
//
// WHY A PHRASE AND NOT THE WORD تجارة ON ITS OWN. تجارة alone is right 47% of the time — a coin
// flip — and the reason is one specific artefact: 52 of the 131 names carrying it are ordinary
// pharmacies where the distributor typed a PAPERWORK REMINDER into the customer NAME field
// ("مطلوب سجل تجارى" — a commercial register is required). The owner marked all 52 pharmacies,
// without exception. Excluding that phrase alone lifts تجارة from 47% to 77%; pairing the business
// word with the goods word is what takes it the rest of the way.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Words that mean "never a store", whatever else the name carries. Checked BEFORE the keywords and
 * the trade phrase, so they overrule both.
 *
 * ⚠ `مستشف` here REVERSES a deliberate earlier decision, and the reversal is the owner's. Until
 * 2026-09-06 `isStoreCustomer` ignored the hospital rule on purpose, so a store whose name also
 * mentioned a hospital still split. His decision sheet offered "Hospital — do NOT split" as its own
 * answer and he used it; the four hospital-named customers splitting in production on that date
 * (مستشفى الجمعية الشرعية, صيدليةمستشفى الجمعيةالطبيةالاسلامية, مستشفى السعودى الالمانى, and a
 * unified-procurement hospital store) are all institutions, not wholesalers. Do not restore the
 * old behaviour without asking him again.
 *
 * The government stems (مخازن, مستودع, هيئه, ت.ص, قوى عاملة, سكك حديد) scored ZERO: the owner
 * marked all 17 customers they catch as government depots, none as warehouses. A government depot
 * supplies its own institutions rather than a city's pharmacies, which is what the split assumes.
 *
 * 🔒 OWNER RULING 2026-10-09, after the deeper audit of the store split showed seven government
 * health-insurance depots splitting anyway: **"the three تامين الصحي depots are government, never
 * split them"**. The abbreviation stem ت.ص could not reach them because they spell the words out in
 * full — and they carry مخزن, so the store word won. تامين below closes that, and it is the same
 * 17-of-17 ruling applied to the names that spell themselves differently, not a new policy.
 */
export const NEVER_STORE_KEYWORDS: readonly ChannelNameKeyword[] = [
  { label: "صيدلية", stem: "صيدلي" },
  { label: "مستشفى", stem: "مستشف" },
  // A paperwork note typed into the name field, not a business. 52 of 52 ruled pharmacy.
  { label: "سجل تجارى", stem: "سجل تجار" },
  // Government and institutional depots — 17 of 17 ruled "government depot, do NOT split".
  { label: "مخازن", stem: "مخازن" },
  { label: "مستودع", stem: "مستودع" },
  { label: "هيئة", stem: "هيئه" },
  { label: "ت.ص (تأمين صحى)", stem: "ت.ص" },
  // تأمين صحى spelled out — the owner's 2026-10-09 ruling, see the doc above. Measured on
  // production (ozucdzovmcqvepbozvqf) before it was written: تامين reaches 26 accounts and every
  // single one is the health-insurance authority, one of its branches, depots or clinics, or the
  // unified-procurement authority buying for it. NOT ONE is a wholesaler. Seven of the 26 split
  // today, all seven on مخزن: the three he named — 23495 (العاشر من رمضان), 64845 (القليوبية) and
  // 27863 (شبرا الخيمة) — plus 139383 (منوف), 66085 (بنى سويف), 139359 (جديلة) and 139062 (سوهاج),
  // which are the same kind of depot and which his ruling therefore reaches as well.
  //
  // THE STEM IS تامين AND NOT امين. Broadening it by one letter adds 257 more customer names, every
  // one of them a person called أمين (احمد امين, منال حسنى امين موسى …). None carries a store word,
  // so the broader stem would be inert on the split today and wrong the first day one of them
  // registered a company — the word being ruled on is تأمين, insurance.
  { label: "تأمين صحى (هيئة التأمين الصحي)", stem: "تامين" },
  { label: "قوى عاملة", stem: "قوي عامله" },
  { label: "سكك حديد", stem: "سكك حديد" },
  { label: "كهرباء", stem: "كهرباء" },
];

/**
 * Pharmacy CHAINS, matched on the name rather than on one customer code — owner decision
 * 2026-09-06, asked and answered "by chain".
 *
 * WHY THE CODE FORM WAS NOT ENOUGH. A client code is unique only inside one distributor, and a
 * chain opens an account at each one, so `PHARMACY_OVERRIDE_CLIENT_CODES` protected a single
 * account while the same chain traded on under a dozen other numbers. Measured on production the
 * day this shipped: عابدين فارما held ~15 accounts with ONE protected, الصيرفي فارما 5 with none,
 * and الطرشوبى 313,000 EGP still splitting across two accounts — one of them the largest in the
 * whole group — despite his standing ruling that الطرشوبى is a pharmacy.
 *
 * OVER-MATCHING HERE IS SAFE, AND THAT IS WHY A NAME IS USABLE WHERE IT USUALLY IS NOT. عابدين is
 * both a district of Cairo (الثورة - عابدين) and half of the common personal name زين العابدين, so
 * this stem touches ~101 customers where only ~15 are the chain. Every one of the other 86 is an
 * ordinary pharmacy, which is what this list makes them anyway — the default. A name-keyed rule is
 * dangerous when it can CREATE a store; it cannot here, because it only ever refuses one.
 */
export const PHARMACY_OVERRIDE_CHAINS: readonly ChannelNameKeyword[] = [
  { label: "عابدين فارما", stem: "عابدين" },
  { label: "الصيرفي فارما", stem: "الصيرف" },
  { label: "الطرشوبى", stem: "طرشوب" },
];

/**
 * The five the concept cannot reach — their names say nothing about medicines, so no phrase can
 * find them. The owner marked each a warehouse in the decision sheet.
 *
 * Matched on the name and not on a customer code because each trades under several codes across
 * distributors (الفرسان انترناشيونال جروب alone appears three times), and keying on codes would
 * reopen exactly the gap PHARMACY_OVERRIDE_CHAINS exists to close.
 */
export const STORE_OVERRIDE_NAMES: readonly ChannelNameKeyword[] = [
  { label: "الفرسان انترناشيونال جروب", stem: "الفرسان انترناشيونال" },
  // THE SAME COMPANY, SPELLED THE WAY EL QEMA WRITES IT — «انترناشول», no ي. Owner confirmed
  // 2026-09-07 that الفرسان بنها is a «مخزن جملة». Phoenix's own files spell it «انترناشيونال» and
  // carry zero rows of this spelling, so the stem above matched everything until El Qema's export
  // arrived — a latent gap that went live the moment a new distributor was registered. Two stems
  // rather than one broadened to «الفرسان», because plain «الفرسان» and «الفرسان - الزاوية» are
  // separate customers the owner has never ruled on, and widening the stem would silently make them
  // warehouses too.
  { label: "الفرسان انترناشول جروب (El Qema spelling)", stem: "الفرسان انترناشول" },
  // «الفرسان بنها جملة» — «جملة» means WHOLESALE and is not one of the six keywords. Deliberately
  // NOT added as a general keyword: the owner ruled «شركه أيه ام جروب» a PHARMACY on 2026-09-06, and
  // El Qema sells to «ايه ام جروب الجمله» — the same business carrying جملة. A blanket جملة keyword
  // would reverse a ruling he had just made.
  { label: "الفرسان بنها جملة", stem: "الفرسان بنها" },
  // Three of the 19 EPDA customers the owner ruled warehouses on 2026-09-07 that no pattern reaches.
  // «التعاون» is deliberately NOT a keyword: it would newly catch 20 customers he has not seen, on
  // top of the 28 already classified through الجمعيه, so the one he named is named.
  { label: "التعاون المصرى الخليجى", stem: "التعاون المصري الخليجي" },
  { label: "الرواد للادوية", stem: "الرواد للادويه" },
  { label: "فاروق 14", stem: "فاروق 14" },
  { label: "طيبة جروب", stem: "طيبه جروب" },
  { label: "ابو عميرة", stem: "ابو عميره" },
  { label: "ابوعميرة", stem: "ابوعميره" },
  // Seven more from the same conversation, 2026-09-07: the owner read the EPDA Pedia August list
  // and ruled these seven wholesalers. None carries a store word, a prefix or the trade phrase.
  //
  // EVERY STEM WAS COUNTED BOTH WAYS ON PRODUCTION FIRST, because this list is the one that can
  // CREATE a warehouse — unlike PHARMACY_OVERRIDE_CHAINS, where over-matching only ever refuses one.
  // Together they move 8,201.25 EGP, all of it August 2026 Pedia; every other customer they touch is
  // already a warehouse by another route, so nothing else changes hands.
  //
  // «الفرسان» ALONE WOULD HAVE BEEN A DISASTER: bare, it matches 9 customers worth 15,615,203.94 EGP
  // across five different businesses, so the one he named is named in full. Its neighbour «الفرسان
  // جروب - بنها» (163700, EPDA, 3,637,392.75) is NOT covered by any stem here and stays a pharmacy —
  // he has not ruled on it, and this list is not the place to guess.
  { label: "الفرسان - الزاوية", stem: "الفرسان - الزاويه" },
  // Matches its own bigger sibling «الصفا ميديكال لتجارة وتوزيع الا دوية» (IS) too, which the trade
  // phrase already calls a warehouse — so the stem adds this account and nothing else.
  { label: "الصفا ميديكال", stem: "الصفا ميديكال" },
  // «شركة اورينت جروب - بهتيم» (164162) — ruled a pharmacy on 2026-09-06 and a wholesaler on the
  // EPDA sheet on 2026-09-07. Put back to him, and he settled it: "wholesaler IS THE CORRECT". The
  // fifth such reversal in this rule and handled like the other four — the later answer stands and
  // the pinned fixture carries it, so the contradiction is recorded rather than argued again.
  //
  // The stem reaches this one business on its two accounts (EP-BK and EP-PHS, both code 164162) and
  // nothing else; «جروب» alone is common and is deliberately not used.
  { label: "اورينت جروب", stem: "اورينت جروب" },
  // Also matches «مخزن النهضة للادوية» (PS, 10,447,616.25) — already a warehouse on مخزن. The 151.88
  // account is the only thing this changes, and the 10.4M is not at risk from it.
  { label: "النهضة للادوية", stem: "النهضه للادويه" },
  // Also matches «مالتي ستورز فارما ن.م» (PS), already a warehouse on فارم.
  { label: "مالتى ستورز", stem: "مالتي ستورز" },
  // Named in full: bare «فيوتشر» matches only this one customer today, but a stem that narrow costs
  // nothing and cannot adopt a future pharmacy of the same name.
  { label: "فيوتشر - الزقازيق", stem: "فيوتشر - الزقازيق" },
  // Spelled «هاحر» in the source data, with two spaces before the dash. Folding collapses the
  // spaces; the misspelling is theirs and is kept exactly, because it is what the files carry.
  { label: "هاحر والشروق", stem: "هاحر والشروق" },
  // The neighbour this list deliberately left out until he ruled on it — owner, 2026-09-07, asked
  // directly and answered "wholesaler". Its siblings «الفرسان بنها جملة» and «الفرسان انترناشول
  // جروب بنها» were already warehouses through El Qema, so it was the odd one out.
  //
  // «الفرسان جروب» measured on production matches exactly this ONE business, on its two accounts
  // (EP-PHS and EP-BK, both code 163700) — the other seven «الفرسان» customers put a word between
  // «الفرسان» and «جروب», so none is swept in. Changes NO number today: all 3,667,524.75 EGP of it is
  // Head Office, which is untracked and never splits. It decides how the account is treated the
  // first time it sells on a rep line.
  { label: "الفرسان جروب - بنها", stem: "الفرسان جروب" },
  // TWELVE MORE, 2026-10-09. The owner was sent the whole 10,420-name customer list split two ways
  // — the 119 this rule splits today and the 10,301 it leaves whole — plus a third column naming the
  // ones that read as medicines traders and reach no stem. He ruled: **"split the 11 in column C"**,
  // then **"do a deeper audit … of course more than this should be split"**, which found four more.
  //
  // EVERY STEM COUNTED BOTH WAYS ON PRODUCTION FIRST, as this list requires — it is the one that can
  // CREATE a warehouse. Together the twelve reach 20 distinct customer names on 26 accounts, 374
  // valid rows and 435,133.42 EGP all-time, of which only **51,022.72 EGP over 58 rows actually
  // changes hands**: the override list is read from the cutover only
  // (WAREHOUSE_RULE_FROM_PERIOD_BY_LINE — 2026-09, Pedia 2026-08), Head Office (7 rows, 42,890.78)
  // never splits, Direct carries no area (4 rows, 16,772.40), and two of the names these stems reach
  // were ALREADY warehouses on مخزن (9 rows, 7,132.05), which changes nothing. The whole breakdown
  // is one query, kept in tests/store-split-owner-rulings-2026-10-09.test.ts.
  //
  // «طاى جروب» WAS DELIBERATELY ABSENT UNTIL HE SETTLED IT, and he settled it on 2026-10-09:
  // **"split طاى جروب too, it overrides the Sep 6 sheet"**. He had ruled its four accounts PHARMACY
  // on the 2026-09-06 decision sheet (433363 IS and IS-S, 3080282 RM, 1500023301 SF) with their
  // value and areas in front of him, so the contradiction went back to him rather than being
  // resolved in code — the SIXTH such reversal in this rule, handled exactly like the five before
  // it: the later answer stands, the pinned fixture carries it, and the 2026-09-06 sheet itself is
  // left untouched. The stem is added at the end of this list.
  //
  // Each stem is named in full rather than broadened, for the reason «الفرسان» records above.
  { label: "شركة مخازن كومباس فارما للادوية", stem: "كومباس فارما" },
  // Blocked until now by «مخازن», which is a NEVER_STORE word written for the 17 government depots
  // he ruled on — a private company carrying the plural of مخزن was its one wrong exclusion.
  { label: "دار الدواء", stem: "دار الدواء" },
  // The stem reaches the family, which is what he named: the company (IS 448686, CNS 9,288.00), its
  // long form «دار الدواء للادويةوالمستلزمات الطبية», a DIRECT account that is passed through with no
  // area either way, «دار الدواء-اكتوبر» and «دار الدواء  - اخميم ن» (Head Office, never split), and
  // «دار الدواء المنصورة» (CNS, 111.38). The bare name cannot be narrowed further without a code,
  // and a code-keyed override would reach the PUBLISHED months — legacyIsStoreCustomer reads
  // STORE_OVERRIDE_CUSTOMER_KEYS and ignores this list, so a name is the only safe instrument here.
  { label: "شركة فاروس للادوية والمستحضرات الطبي", stem: "فاروس للادويه" },
  { label: "الشرق للادوية", stem: "الشرق للادويه" },
  // Also matches «مخزن الشرق للادوية المنيا» and «مخزن الشرق للادويه», both already warehouses.
  { label: "الفجر للادوية", stem: "الفجر للادويه" },
  { label: "مركز الخليل للادوية واللقاحات والامصال", stem: "الخليل للادويه" },
  // «الخليل فارما لتجارة الادوية» is already a warehouse and puts فارما between the two words, so it
  // is not what this stem reaches.
  { label: "لاستثمارات الدوائية والكيماويات", stem: "لاستثمارات الدوائيه" },
  { label: "اورينت للاستيراد والتصدير والتوكيلات", stem: "اورينت للاستيراد" },
  // The four the deeper audit found, same shape as the seven above: an organisation that supplies the
  // trade, carrying no store word, no prefix and no trade phrase.
  { label: "شركه لابروكس", stem: "لابروكس" },
  // One business on three accounts — «شركة صيادلةالبحيرة فرع الاسكندرية» (IS 403594), «صيادلة
  // البحيرة» (IS 358607) and «ص  ش  صيادلة البحيره» (SF 1500027123), 177,392.03 EGP between them. A
  // pharmacists' company with branches, which is the case this list exists for; one stem reaches all
  // three, exactly as الفرسان and ابو عميرة do above.
  { label: "صيادلة البحيرة", stem: "صيادله البحيره" },
  // Co-operative societies are warehouses under his own «الجمعيه» keyword — 13 of them already split
  // on it. These two escape it only on spelling: one drops the «ال», the other was typed «الحمعيه»
  // with a ح. Named in full so neither stem can adopt a future society he has not seen.
  { label: "جمعية العاملين بشركة مصر حلوان", stem: "جمعيه العاملين بشركه مصر حلوان" },
  { label: "الحمعيه التعاونيه يشركه كيما", stem: "الحمعيه التعاونيه" },
  // HIS OVERRIDE OF THE 2026-09-06 SHEET, 2026-10-09 — see «طاى جروب» above.
  //
  // «طاى» ALONE WOULD BE A CATASTROPHE AND IS THE REASON THIS STEM IS TWO WORDS: «طاى» is a
  // SUBSTRING of «مطاى», the town Matay, which 60+ Minia pharmacies carry in their name («الفتح -
  // مطاى», «نشوى - مطاى», «هيثم اسامة مطاى» …), and of «مصطاى» and «نهطاى» besides. Bare «جروب» is
  // common too. Measured on production 2026-10-09 over every name containing طاى / طاي / طى جروب:
  // «طاي جروب» reaches this ONE business on its SIX accounts and not a single neighbour —
  // «طاى جروب» (433363 IS and IS-S), «شركة طاى جروب» (3080282 RM, 1500023301 SF), «طاى جروب -
  // الاسكندرية» (22197684 EP-PHS) and «مخزن طاى جروب - طاى» (0001573635 PS), which was already a
  // store on «مخزن» and is unaffected either way.
  //
  // WHAT IT MOVES. All six accounts sell from ONE area — AB2, Alex Center — so the split deals
  // their sales into thirds across Alexandria (AB1 Alex East, AB2 Alex Center, AB3 Alex West).
  // On the rollup at the period factory price: 166 rows and 1,057,167.56 EGP all-time across the
  // six; 113 rows and 620,042.96 on the five that were not already stores; 99 rows and 338,276.36
  // of that on the tracked lines. But the list is read from the cutover only
  // (WAREHOUSE_RULE_FROM_PERIOD_BY_LINE — 2026-09, Pedia 2026-08), so WHAT ACTUALLY CHANGES HANDS
  // IS 11 ROWS AND 20,025.30 EGP, every one of them SEPTEMBER 2026 CNS: 3080282 (RM) 200 units
  // 14,951.25 and 433363 (IS) 123 units 5,074.05. Alex Center gives up 13,350.20 of it and Alex
  // East and Alex West take 6,675.10 each. 22197684 is Head Office only and never splits;
  // 1500023301 has no row at or after the cutover.
  { label: "طاى جروب", stem: "طاي جروب" },
];

/**
 * Companies whose name carries the trade phrase but which the owner ruled are pharmacies. He knows
 * the business; the name does not say it. Kept separate from the chains above because these are
 * single companies, not families of accounts.
 */
export const PHARMACY_OVERRIDE_NAMES: readonly ChannelNameKeyword[] = [
  { label: "اى بى يو", stem: "اي بي يو" },
  { label: "الفاتح لتجارة وتوزيع الادوية", stem: "الفاتح لتجاره وتوزيع" },
  { label: "الهاشم لتجارة و توزيع الادوية", stem: "الهاشم لتجاره" },
];

/**
 * Distributors whose ENTIRE customer base is wholesalers — every customer is a store, whatever its
 * name says.
 *
 * Owner, 2026-09-07, on reviewing El Qema's whole August book: **"all here are wholeslars to be
 * splitted"**. El Qema is an exclusive distributor selling ON to other wholesalers rather than to
 * pharmacies, so the name test — which exists to guess at a customer nobody has classified — has
 * nothing to add and several ways to be wrong. Of their 30 customers the six keywords caught 10;
 * this rule catches all 30, which is what he ruled.
 *
 * THIS IS A STATEMENT ABOUT THE DISTRIBUTOR, NOT A SHORTCUT. Do not add a distributor here to avoid
 * classifying its customers: it is only correct when the distributor genuinely sells wholesale-only,
 * and it silently converts every future customer they add. It is the owner's call each time.
 *
 * DELIBERATELY BELOW THE "NEVER A STORE" WORDS in isStoreCustomer's order of precedence. If El Qema
 * ever invoices a hospital or a government depot, that customer still does not split — a government
 * store supplies its own institutions wherever it bought from, and 17 of the owner's own 2026-09-06
 * rulings say so. No customer in their August book is affected either way; the ordering is there for
 * the month when one is.
 */
export const WHOLESALE_ONLY_DISTRIBUTORS: ReadonlySet<string> = new Set(["QM"]);

/** True when every one of this distributor's customers is a wholesaler by owner ruling. */
export function isWholesaleOnlyDistributor(distributorCode: string | null | undefined): boolean {
  const code = String(distributorCode ?? "").trim().toUpperCase();
  return code !== "" && WHOLESALE_ONLY_DISTRIBUTORS.has(code);
}

/**
 * The business half of the trade phrase: what the company says it DOES.
 * توريد (supply) sits beside تجارة and توزيع because the owner ruled
 * "شركة الهضبه لتوريد الادويه" and "شركة ابوعميره لتوريد وتوزيع الادوية" are warehouses.
 */
export const TRADE_BUSINESS_STEMS = ["تجار", "توزيع", "توريد"] as const;

/**
 * The goods half: WHAT it trades. `الادي` is not a typo — it catches the real production spelling
 * "الفتح لتجارة وتوزيع الادية", a name the owner confirmed is a warehouse and whose goods word the
 * distributor typed without its و.
 */
export const TRADE_GOODS_STEMS = ["ادوي", "دواء", "دوائ", "الادي"] as const;

/**
 * The two business words that mean a warehouse together, without naming the goods —
 * "لتجارة وتوزيع" says the business plainly enough on its own. Named rather than inlined so
 * `customerChannelSqlRule()` can hand the same pair to SQL instead of a second copy of it.
 */
export const TRADE_BUSINESS_PAIR_STEMS = ["تجار", "توزيع"] as const;

/**
 * The name with ALL whitespace removed, not merely collapsed.
 *
 * Distributors split words mid-token — "الصفا ميديكال لتجارة وتوزيع الا دوية" carries a space
 * inside الأدوية — so a phrase test on the space-collapsed form misses a name that reads correctly
 * to a human. Squashing is safe for these stems because every one of them is a single Arabic word.
 */
function squashCustomerName(value: string | null | undefined): string {
  return normalizeCustomerName(value).replace(/\s+/g, "");
}

/**
 * True when the name states a medicines trading or distribution business.
 *
 * TWO WAYS IN, and the second exists for truncation. A name carrying BOTH تجارة and توزيع is a
 * trading house whether or not the goods word survived the distributor's field width — production
 * holds "شركة المحمدية لتجارة وتوزيع ال" and "الجمهورية لتجارة وتوزيع ن م", both cut off mid-word,
 * and the owner ruled both warehouses.
 */
export function matchesTradePhrase(name: string | null | undefined): boolean {
  return foldedMatchesTradePhrase(squashCustomerName(name));
}

function foldedMatchesTradePhrase(squashed: string): boolean {
  if (!squashed) return false;
  const business = TRADE_BUSINESS_STEMS.filter((stem) => squashed.includes(stem));
  if (business.length === 0) return false;
  if (TRADE_BUSINESS_PAIR_STEMS.every((stem) => squashed.includes(stem))) return true;
  return TRADE_GOODS_STEMS.some((stem) => squashed.includes(stem));
}

/** True when a "never a store" word appears — checked on both the spaced and squashed forms. */
export function matchedNeverStoreKeywords(name: string | null | undefined): string[] {
  return foldedNeverStoreKeywords(foldName(name));
}

function foldedNeverStoreKeywords(folded: FoldedName): string[] {
  if (!folded.spaced) return [];
  return prepareKeywords(NEVER_STORE_KEYWORDS)
    .filter((keyword) => folded.spaced.includes(keyword.spaced) || folded.squashed.includes(keyword.squashed))
    .map((keyword) => keyword.label);
}

/** The first matching entry's label against an already-folded name, or null. */
function foldedMatchesAnyKeyword(folded: FoldedName, entries: readonly ChannelNameKeyword[]): string | null {
  if (!folded.spaced) return null;
  for (const entry of prepareKeywords(entries)) {
    if (folded.spaced.includes(entry.spaced) || folded.squashed.includes(entry.squashed)) return entry.label;
  }
  return null;
}

/**
 * The label of the first entry whose stem appears in this name (spaced OR squashed form), or null.
 *
 * Exported so a caller outside the closing — e.g. the venue wholesaler guard — reuses the closing's
 * EXACT matching against a keyword list (STORE_OVERRIDE_NAMES, the pharmacy override lists) instead
 * of re-implementing the spaced/squashed comparison and drifting from it. Pure; no behaviour change
 * from when this was the private `matchesAnyName`.
 */
export function nameMatchesAnyKeyword(
  name: string | null | undefined,
  entries: readonly ChannelNameKeyword[],
): string | null {
  return foldedMatchesAnyKeyword(foldName(name), entries);
}

/** Codes arrive with distributor-specific zero padding, so compare on the digits alone. */
function normalizeClientCode(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^0+/, "") || trimmed;
}

function normalizeDistributorCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/** True when the owner has ruled this customer a pharmacy despite a store word in its name. */
export function isPharmacyOverride(clientCode: string | null | undefined): boolean {
  const code = normalizeClientCode(clientCode);
  return code !== "" && PHARMACY_OVERRIDE_CLIENT_CODES.has(code);
}

/** True when the owner has ruled this customer a store despite no store word in its name. */
export function isStoreOverride(
  clientCode: string | null | undefined,
  distributorCode: string | null | undefined,
): boolean {
  const code = normalizeClientCode(clientCode);
  const distributor = normalizeDistributorCode(distributorCode);
  return code !== "" && distributor !== "" && STORE_OVERRIDE_CUSTOMER_KEYS.has(`${distributor}|${code}`);
}

/** Human-readable evidence for an owner ruling shown wherever keyword evidence is displayed. */
export function storeOverrideReason(
  clientCode: string | null | undefined,
  distributorCode: string | null | undefined,
): string | null {
  return isStoreOverride(clientCode, distributorCode) ? "Owner-approved store" : null;
}

/**
 * A customer is a HOSPITAL when its name carries a hospital word, else a STORE when it carries one
 * of the six store words, else a PHARMACY. Hospital wins the overlap because a name like
 * "جمعيه ... (ص مستشفى)" carries both, and it is the hospital that identifies the customer.
 * A blank name is evidence of nothing, so it falls to pharmacy — the same side an un-keyworded
 * name lands on.
 *
 * `clientCode` and `distributorCode` are optional so existing keyword-only callers keep working,
 * but pass both wherever they are to hand: both are required for an owner override, and a caller
 * that omits either silently gets the keyword answer.
 */
export function classifyCustomerChannel(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): CustomerChannel {
  const folded = foldName(name);
  if (matchFoldedKeywords(folded, HOSPITAL_NAME_KEYWORDS).length > 0) return "hospital";
  // Delegated so the screen and the closing can never disagree about who is a warehouse. Before
  // 2026-09-06 this repeated the override checks inline, which was already a second copy of the
  // rule; with the trade phrase and four override lists it would have been a fifth.
  return foldedIsStoreCustomer(folded, clientCode, distributorCode) ? "store" : "pharmacy";
}

/**
 * Does this customer carry a STORE word — regardless of whether it also carries a hospital word.
 *
 * Deliberately NOT `classifyCustomerChannel(name) === "store"`. The Monthly Closing's city split
 * (src/lib/sales/store-sales-city-split.ts) asks this question to decide whether a customer's
 * sales get spread across its city's areas. Routing it through the classifier would mean that
 * adding the hospital channel silently stopped splitting every store whose name also mentions a
 * hospital — a UI change quietly moving money between areas in the closing. Keep it keyword-based.
 */
export function isStoreCustomer(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): boolean {
  return foldedIsStoreCustomer(foldName(name), clientCode, distributorCode);
}

/** `isStoreCustomer` against a name folded once, so each step below does not fold it again. */
function foldedIsStoreCustomer(
  folded: FoldedName,
  clientCode?: string | null,
  distributorCode?: string | null,
): boolean {
  // ONE order of precedence, most specific first. Every step is an owner decision, and a step can
  // only ever be reversed by a MORE specific one above it — which is what stops the broad
  // name-matched rules at the bottom from quietly undoing a ruling made about one account.
  //
  //   1. a ruling about one ACCOUNT      (code, or distributor + code)
  //   2. a ruling about one COMPANY      (name)
  //   3. a ruling about a CHAIN          (name)
  //   4. "never a store" words           (pharmacy / hospital / paperwork / government)
  //   5. a WHOLESALE-ONLY DISTRIBUTOR     (every customer of El Qema is a wholesaler)
  //   6. the owner's six store words, or the trade phrase his 167 answers describe
  //
  // The overrides DO apply here, unlike the hospital rule in classifyCustomerChannel: an override
  // says "this either is or is not a warehouse, full stop". Splitting an overridden pharmacy's
  // sales across its city moves its money onto other reps; NOT splitting an overridden store's
  // does the same thing in reverse — both are the exact error the override lists exist to stop.
  if (isPharmacyOverride(clientCode)) return false;
  if (isStoreOverride(clientCode, distributorCode)) return true;
  if (foldedMatchesAnyKeyword(folded, STORE_OVERRIDE_NAMES)) return true;
  if (foldedMatchesAnyKeyword(folded, PHARMACY_OVERRIDE_NAMES)) return false;
  if (foldedMatchesAnyKeyword(folded, PHARMACY_OVERRIDE_CHAINS)) return false;
  if (foldedNeverStoreKeywords(folded).length > 0) return false;
  if (isWholesaleOnlyDistributor(distributorCode)) return true;
  return matchFoldedKeywords(folded, STORE_NAME_KEYWORDS).length > 0
    || matchFoldedPrefixes(folded).length > 0
    || foldedMatchesTradePhrase(folded.squashed);
}

/**
 * The FIRST period the 2026-09-06 rulings apply to — PER LINE, because the lines were published on
 * different days and a published month never moves.
 *
 * WHY A GATE EXISTS AT ALL. Nothing about this classification is stored — it is recomputed from the
 * customer's name on every render, so changing it restates EVERY period at once, published months
 * included. Nothing detects that: the publication drift check compares UNITS, and the city split
 * preserves each line's unit total while moving units between areas, so a restated month reports no
 * drift at all. Same shape as STORE_CITY_SPLIT_FROM_PERIOD, one month earlier.
 *
 * WHY IT BECAME PER-LINE, on 2026-09-07. A single date could not serve both halves of the truth:
 *
 *   · August ANTI INFECTIVE was published and announced that afternoon. Its numbers are frozen by
 *     AGENTS.md §4 — "donot fix any already published an announced month" — so it must keep the
 *     classification it went out with, however provably better the new one is.
 *   · August PEDIA was NOT published. It carries the El Qema Qalubeya money the owner ordered split
 *     across Cairo (الفرسان بنها, 978,912 + 444,787 EGP), and a September start meant that ruling
 *     did nothing to the very file he had just imported.
 *
 * One scalar forced a choice between restating a sent month and ignoring a live instruction. Keyed
 * by line, both are honoured at once. Owner, 2026-09-07: "make the gate per-line", then "no, in
 * pedia split start from aug".
 *
 * 🔴 THE DEFAULT IS THE LATE DATE, AND IT MUST STAY THAT WAY. A line absent from this map — a new
 * roster line, a misspelling, a blank — gets the LATEST cutover, which keeps the OLD classification
 * and therefore cannot restate anything. Defaulting to the early date would silently rewrite history
 * for any line whose name did not match, and nothing downstream would report it. Note this is the
 * opposite of the usual "newest wins" instinct: here, later means safer.
 *
 * CNS is deliberately NOT listed. August CNS is unpublished too, so it COULD start in August — but
 * the owner named Pedia and only Pedia, and a line that stays on the old rule loses nothing that
 * cannot be added later, while a line moved without being asked for cannot be un-moved once its
 * month is published.
 *
 * A plain string compare is correct and deliberate: periods are `YYYY-MM`, which sorts
 * lexicographically in calendar order. Anything malformed or absent falls to NOT active, which
 * keeps the OLD classification — the safe direction, because leaving a number where it already was
 * cannot restate a closing somebody has already sent to their managers.
 */
export const WAREHOUSE_RULE_DEFAULT_FROM_PERIOD = "2026-09";

/** Lines whose cutover differs from the default. Keyed by the normalised official_line. */
export const WAREHOUSE_RULE_FROM_PERIOD_BY_LINE: ReadonlyMap<string, string> = new Map([
  ["pedia", "2026-08"],
]);

/**
 * Normalise an official_line for comparison. The source data carries several spellings of the same
 * line ("Anti Infective", "anti_infective", "Anti-Infective"), and a spelling this does not fold is
 * not a silent wrong answer here — it simply falls to the default, which is the late, safe date.
 */
function warehouseLineKey(officialLine: string | null | undefined): string {
  return String(officialLine ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** The first period the new rulings apply to for this line. */
export function warehouseRuleFromPeriod(officialLine: string | null | undefined): string {
  const key = warehouseLineKey(officialLine);
  return WAREHOUSE_RULE_FROM_PERIOD_BY_LINE.get(key) ?? WAREHOUSE_RULE_DEFAULT_FROM_PERIOD;
}

/**
 * Do the owner's 2026-09-06 rulings apply to this period, on this line?
 *
 * `officialLine` is REQUIRED, deliberately. An optional line would default to "not Pedia" and quietly
 * withhold the August split from the one line that is supposed to have it — a wrong number with no
 * error anywhere. Making it required turns that mistake into a compile failure instead.
 */
export function isWarehouseRuleActive(
  period: string | null | undefined,
  officialLine: string | null | undefined,
): boolean {
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  return trimmed >= warehouseRuleFromPeriod(officialLine);
}

/**
 * The rule EXACTLY as it stood before 2026-09-06: the owner's six words, plus the two code-keyed
 * override lists. Nothing else.
 *
 * Kept as real code rather than reconstructed from git when needed, because August 2026 is a
 * published month and the numbers in it have to stay reproducible from this repository for as long
 * as anybody can ask why an area's figure is what it is. Do not "simplify" it into the new rule —
 * that silently restates every month before the cutover.
 */
export function legacyIsStoreCustomer(
  name: string | null | undefined,
  clientCode?: string | null,
  distributorCode?: string | null,
): boolean {
  if (isPharmacyOverride(clientCode)) return false;
  if (isStoreOverride(clientCode, distributorCode)) return true;
  return matchedStoreKeywords(name).length > 0;
}

/**
 * Is this customer a warehouse **for the purposes of the month being computed**?
 *
 * This is the one the Monthly Closing's city split must ask, and `isStoreCustomer` is the one every
 * other surface asks. They differ ONLY for periods before the cutover, and the difference is the
 * point: a closing is a record of a month, so it answers with the rule that was in force; a screen
 * showing who a customer is today answers with the rule in force today.
 */
export function isStoreCustomerForPeriod(
  name: string | null | undefined,
  clientCode: string | null | undefined,
  distributorCode: string | null | undefined,
  period: string | null | undefined,
  officialLine: string | null | undefined,
): boolean {
  return isWarehouseRuleActive(period, officialLine)
    ? isStoreCustomer(name, clientCode, distributorCode)
    : legacyIsStoreCustomer(name, clientCode, distributorCode);
}

/**
 * Split any list of named customers into the three channels, preserving the incoming order
 * within each side. Generic so the directory rows, an export row, or a future sales row can
 * all use the one rule instead of re-implementing it.
 */
export function splitByCustomerChannel<T>(
  rows: readonly T[],
  nameOf: (row: T) => string | null | undefined,
): { hospitals: T[]; pharmacies: T[]; stores: T[] } {
  const hospitals: T[] = [];
  const pharmacies: T[] = [];
  const stores: T[] = [];
  for (const row of rows) {
    const channel = classifyCustomerChannel(nameOf(row));
    if (channel === "hospital") hospitals.push(row);
    else if (channel === "store") stores.push(row);
    else pharmacies.push(row);
  }
  return { hospitals, pharmacies, stores };
}
