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

function matchKeywords(
  name: string | null | undefined,
  keywords: readonly ChannelNameKeyword[],
): string[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return keywords
    .filter((keyword) => normalized.includes(normalizeCustomerName(keyword.stem)))
    .map((keyword) => keyword.label);
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
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return STORE_NAME_PREFIXES
    .filter((entry) => normalized.startsWith(normalizeCustomerName(entry.stem)))
    .map((entry) => entry.label);
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
 */
export const STORE_OVERRIDE_CUSTOMER_KEYS: ReadonlySet<string> = new Set([
  // ابن خلدون — a wholesaler despite carrying no store keyword.
  "IS-S|446299",
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
const TRADE_BUSINESS_STEMS = ["تجار", "توزيع", "توريد"] as const;

/**
 * The goods half: WHAT it trades. `الادي` is not a typo — it catches the real production spelling
 * "الفتح لتجارة وتوزيع الادية", a name the owner confirmed is a warehouse and whose goods word the
 * distributor typed without its و.
 */
const TRADE_GOODS_STEMS = ["ادوي", "دواء", "دوائ", "الادي"] as const;

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
  const squashed = squashCustomerName(name);
  if (!squashed) return false;
  const business = TRADE_BUSINESS_STEMS.filter((stem) => squashed.includes(stem));
  if (business.length === 0) return false;
  if (squashed.includes("تجار") && squashed.includes("توزيع")) return true;
  return TRADE_GOODS_STEMS.some((stem) => squashed.includes(stem));
}

/** True when a "never a store" word appears — checked on both the spaced and squashed forms. */
export function matchedNeverStoreKeywords(name: string | null | undefined): string[] {
  const spaced = normalizeCustomerName(name);
  const squashed = squashCustomerName(name);
  if (!spaced) return [];
  return NEVER_STORE_KEYWORDS.filter((keyword) => {
    const stem = normalizeCustomerName(keyword.stem);
    return spaced.includes(stem) || squashed.includes(stem.replace(/\s+/g, ""));
  }).map((keyword) => keyword.label);
}

function matchesAnyName(
  name: string | null | undefined,
  entries: readonly ChannelNameKeyword[],
): string | null {
  const spaced = normalizeCustomerName(name);
  const squashed = squashCustomerName(name);
  if (!spaced) return null;
  for (const entry of entries) {
    const stem = normalizeCustomerName(entry.stem);
    if (spaced.includes(stem) || squashed.includes(stem.replace(/\s+/g, ""))) return entry.label;
  }
  return null;
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
  if (matchedHospitalKeywords(name).length > 0) return "hospital";
  // Delegated so the screen and the closing can never disagree about who is a warehouse. Before
  // 2026-09-06 this repeated the override checks inline, which was already a second copy of the
  // rule; with the trade phrase and four override lists it would have been a fifth.
  return isStoreCustomer(name, clientCode, distributorCode) ? "store" : "pharmacy";
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
  if (matchesAnyName(name, STORE_OVERRIDE_NAMES)) return true;
  if (matchesAnyName(name, PHARMACY_OVERRIDE_NAMES)) return false;
  if (matchesAnyName(name, PHARMACY_OVERRIDE_CHAINS)) return false;
  if (matchedNeverStoreKeywords(name).length > 0) return false;
  if (isWholesaleOnlyDistributor(distributorCode)) return true;
  return matchedStoreKeywords(name).length > 0
    || matchedStorePrefixes(name).length > 0
    || matchesTradePhrase(name);
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
