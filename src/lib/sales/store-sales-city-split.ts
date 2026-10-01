// Store sales, split evenly across the areas of the store's city.
//
// THE RULE (owner, 2026-08-04). A wholesaler/warehouse customer — a STORE, see
// src/lib/sales/customer-channel.ts — does not sell only into the area it physically sits in. It
// supplies the whole city. So crediting 100% of its sell-in to the one rep whose area happens to
// contain it overstates that rep and understates every colleague in the same city. Instead: take
// the store's sales PER PRODUCT PER MONTH and divide them EVENLY across the AREAS of that store's
// city. Each area's share then reaches whoever holds that area's line seat through the existing
// attribution; a vacant seat keeps its share on the area, exactly as the closing already handles
// vacancies.
//
// WHY THE AREA AND NOT THE REP. Dividing by rep headcount looks equivalent and is not: 20
// city×line pairs have NO rep at all (Cairo has no Pedia rep anywhere), so a headcount divisor is
// zero and the money would have nowhere to go. Areas always exist, so the area divisor is never
// zero and the total is always preserved.
//
// SCOPE. Pedia / Anti Infective / CNS only — Head Office is deliberately excluded (it is 93% of
// store value and has no rep line at all; the owner is handling it separately). Pharmacies are
// untouched. Direct rows carry no area and are already attributed to line+region only, so they
// are passed through untouched too.

import { closingAreaOf } from "@/lib/sales/closing-row-area";
import { isStoreCustomerForPeriod } from "@/lib/sales/customer-channel";

/**
 * OWNER RULING 2026-09-04: the wholesaler city split is ON, on EVERY city. His words, in Arabic:
 * "شغل تقسيم المخازن على كل المدن" — turn the store split on for all the cities.
 *
 * WHAT DECIDED IT. Reconciling August 2026 Anti Infective against his manual closing, the manual
 * sheet split five Menoufia wholesalers 50/50 (مخزن القادسية, مخزن العربية, جي زد فارما, التوأمان
 * فارم in شبين الكوم and الرساله فارم in أشمون) while Phoenix booked each whole to its own brick.
 * That one district was the largest single disagreement between the two files: Menoufia 1 short
 * 15,017.10 and Menoufia 2 long 16,128.60. Nationally his sheet held 30 store rows across 24
 * wholesalers, and only those 7 Menoufia rows were split — 23 rows across 10 other cities were
 * not. So the manual applied the rule in exactly one district. Asked whether to make it uniform,
 * he chose to make it uniform by turning the rule ON everywhere rather than off in Menoufia.
 *
 * THE RULE IS NOT PERIOD-AWARE, AND THAT IS THE THING TO KNOW BEFORE TOUCHING THIS. The closing
 * matrix re-derives every month live, so this flag restates EVERY period at once, published ones
 * included. It is the same shape as a factory-price edit — see
 * a-price-fix-silently-restates-every-published-closing. Nothing detects it either: the
 * publication drift check compares UNITS only, and the split preserves units per line while moving
 * them between areas, so a restated month reports no drift.
 *
 * THERE ARE NOW TWO PERIOD GATES, and they are separate on purpose. STORE_CITY_SPLIT_FROM_PERIOD
 * below decides WHETHER a month splits at all (August 2026 onward, every line). warehouseRuleFromPeriod
 * in customer-channel.ts decides WHICH rule says who is a warehouse — and that one is PER LINE:
 * August for Pedia, September for everything else, because August Anti Infective was published and
 * announced while August Pedia never was.
 *
 * So August splits on Anti Infective under the OLD classification and on Pedia under the NEW one,
 * in the same month, from the same code. That combination looks like a half-finished migration and
 * is not: it is two published-state facts about two lines. Read warehouseRuleFromPeriod before
 * "tidying" either gate. Both exist for the same underlying reason — this whole layer is recomputed
 * live, so any change to it is retroactive unless a date stops it.
 *
 * PREVIOUS STATE, kept because it explains the shape of the code. It was OFF from 2026-08-10,
 * re-applied 2026-08-12 after the first disable (cc6edee4) was LOST in the #2015 squash merge.
 * Measured then on July 2026 CNS, the split was the single largest disagreement with his sheet.
 *
 * Deliberately a flag at the APPLY points rather than emptying SPLIT_LINE_KEYS or gating
 * isSplitEligible: the pure functions must keep telling the truth (CNS IS a rep line, the split
 * arithmetic IS as tested) so the ~35 assertions covering the geography and the even-share maths
 * stay honest and covered either way. Flipping this is an OWNER decision in both directions —
 * never a code cleanup, and never a fix for a red reconciliation.
 */
export const STORE_CITY_SPLIT_ENABLED = true;

/**
 * The FIRST period the split applies to. Owner ruling 2026-10-02: **"FIX JULY"** — July 2026 takes
 * the wholesaler city split too, so this moves from `2026-08` to `2026-07`.
 *
 * 🔴 JUNE AND EARLIER ARE DELIBERATELY UNTOUCHED, and that is why this is `2026-07` and not a bare
 * boolean. The gate is a FLOOR (`period >= this`), so `2026-07` reaches exactly July, August and
 * September and leaves January–June as published. Measured on live data 2026-10-02, the months this
 * does NOT reach would each have moved between areas: Jan 262,846.70, Feb 252,084.29,
 * Mar 301,764.29, Apr 1,807,659.82, May 573,326.77, Jun 936,655.07 EGP. Setting this to `2026-01`,
 * or removing it in favour of the bare flag, restates all six at once with no signal anywhere — see
 * WHY A DATE EXISTS below. He asked for July; only July moves.
 *
 * WHAT IT COSTS IN JULY, measured the same day through this module on the live July rows:
 * Anti Infective 18 warehouses / 55,198.09 EGP across 18 areas; CNS 79 / 264,197.76 across 34;
 * Pedia 13 / 35,859.37 across 18. In Menoufia — the district that prompted the ruling — Menoufia 1
 * goes 142.86% → 81.78% and Menoufia 2 goes 73.99% → 126.82%. Dakahlia 2 goes slightly NEGATIVE
 * (10,806.60 → −650.07), because ريونيون للتجارةوالاستثمار's −34,370.00 July return sits whole on
 * Dakahlia 1 and the split spreads it outward. The owner was shown all of that before deciding.
 *
 * 🔴 THIS CONSTANT ALONE DOES NOT MOVE THE ACHIEVEMENT, AND THAT IS THE TRAP. The attribution
 * engine does not recompute the split: `au.f_monthly_attribution` READS `au.monthly_store_split_net`,
 * and `phx_write_monthly_store_split_net` REFUSES a period that has a live publication row — it
 * returns 0 with a notice, not an error (the freeze of 20260927213000). July is published, so until
 * it is unpublished the net stays empty; and an empty frozen net makes
 * `loadFrozenStoreSplitIfPublished` fall through to the LIVE recompute, so the Closing tab and the
 * export would show July split while the keycard, the boards, Employee 360 and the incentive still
 * read the announced number. Shipping this constant is step 2 of 5, never the whole fix. The order
 * that avoids that divergence: owner unpublishes July → this ships → backfill the net
 * (`scripts/backfill-attribution-store-split.ts --apply 2026-07`) → re-stamp the rollup
 * (`au.f_refresh_monthly_attribution('2026-07')`) → owner re-publishes July.
 *
 * WHY A DATE EXISTS AT ALL, kept because it is still true of every month before July. The closing
 * matrix re-derives every month live, so a bare boolean is retroactive to the first period on
 * record, and the publication drift check cannot see it: that check compares UNITS only, and the
 * split preserves each line's unit total while moving units between areas. A restated month
 * therefore reports no drift at all.
 *
 * PREVIOUS STATE. `2026-08` from 2026-09-04 to 2026-10-02, on his ruling that day — "DONT TOUCH
 * JULY APPLY ON AUGUST AND UPCOMING" — made immediately after the retroactive cost was first
 * measured for him (296,444.88 EGP across 34 areas in July CNS alone). He reversed it on 2026-10-02
 * after auditing which customers and which months the split had actually touched. Moving this
 * constant in EITHER direction is an owner decision, never a code cleanup and never a way to make a
 * reconciliation go green.
 *
 * A plain string compare is correct and deliberate: periods are `YYYY-MM`, which sorts
 * lexicographically in calendar order. Anything malformed or absent falls to NOT active — the safe
 * direction, since failing to split leaves a number where it already was, while splitting a month
 * that should not be split silently moves money between reps.
 */
export const STORE_CITY_SPLIT_FROM_PERIOD = "2026-07";

/**
 * Is the wholesaler city split applied to this period? BOTH gates: the master flag and the start
 * period. Every apply point asks this, never the bare flag — a caller that reads
 * STORE_CITY_SPLIT_ENABLED alone would split June 2026 and every month before it, which are
 * published and which the owner's 2026-10-02 "FIX JULY" ruling deliberately did not reach.
 */
export function isStoreCitySplitActive(period: string | null | undefined): boolean {
  if (!STORE_CITY_SPLIT_ENABLED) return false;
  const trimmed = String(period ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return false;
  return trimmed >= STORE_CITY_SPLIT_FROM_PERIOD;
}

/** The three rep-carrying lines. Head Office is excluded on purpose — see the header. */
const SPLIT_LINE_KEYS = new Set(["pedia", "anti infective", "antiinfective", "anti inf", "cns"]);

/** Normalise an official_line for comparison — the source data carries several spellings. */
function lineKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

export function isSplitEligibleLine(officialLine: string | null | undefined): boolean {
  const key = lineKey(officialLine);
  return SPLIT_LINE_KEYS.has(key) || SPLIT_LINE_KEYS.has(key.replace(/\s+/g, ""));
}

// Area -> city. Derived from the area names, with the line organogram
// (au.line_area_map.operational_region_code) breaking the one genuine tie: Helwan-Maadi maps to GZ
// on all three lines, so it belongs to Giza and not to Cairo. Aswan (Legacy) OT3 is absent from
// the current organogram — retired — so it is deliberately not listed here.
//
// This is the SINGLE edit point for the grouping. An area missing from this map is never split;
// its sales stay exactly where they are, which is the safe direction.
export const AREA_CITY: ReadonlyMap<string, string> = new Map([
  ["AB1", "Alexandria"], ["AB2", "Alexandria"], ["AB3", "Alexandria"],
  ["AB4", "Behira"], ["AB5", "Behira"],
  ["CA1", "Cairo"], ["CA2", "Cairo"], ["CA3", "Cairo"], ["CA4", "Cairo"], ["CA5", "Cairo"], ["CA6", "Cairo"],
  ["D11", "Qalubeya"],
  ["D12", "Menoufia"], ["D13", "Menoufia"],
  ["D14", "Gharbia"], ["D15", "Gharbia"],
  ["D16", "Kafr El-Sheikh"], ["D17", "Kafr El-Sheikh"],
  ["D21", "Dakahlia"], ["D22", "Dakahlia"], ["D23", "Dakahlia"],
  ["D24", "Sharkia"], ["D25", "Sharkia"],
  ["D26", "Port Said - Damietta"],
  ["GZ1", "Giza"], ["GZ2", "Giza"], ["GZ3", "Giza"], ["GZ4", "Giza"], ["GZ5", "Giza"], ["GZ7", "Giza"],
  ["GZ6", "Fayoum"],
  ["UE9", "Beni Suef"],
  ["UE1", "Minia"], ["UE2", "Minia"],
  ["UE3", "Assiut"], ["UE4", "Assiut"],
  ["UE5", "Sohag"], ["UE6", "Sohag"],
  ["UE7", "Qena"], ["UE8", "Qena"],
  ["OT1", "North Sinai"], ["OT10", "South Sinai"], ["OT2", "Suez"], ["OT7", "Aswan"],
  ["OT4", "New Valley"], ["OT5", "Red Sea"], ["OT8", "Red Sea"], ["OT6", "Luxor"], ["OT9", "Ismailia"],
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AREAS THAT EXIST BUT ARE DELIBERATELY OUTSIDE THE CITY LIST.
//
// AREA_CITY above is hand-maintained, and "missing" is its safe direction: an unlisted area never
// splits and its sales stay exactly where the file put them. That safety has a cost — a NEW area
// is silently unlisted from the day it is created, so the split simply does not happen and nothing
// says why.
//
// 🔴 THE FAILURE THIS GUARDS, in the owner's own words (2026-09-07): "in pedia fayoum and bani suef
// is one area so no splitting here, but in future if fayoum and bani suef hired in them more than 1
// area, split." Beni Suef (UE9) and Fayoum (GZ6) hold exactly ONE area each today, so neither
// splits — correct. The day a second one is hired, TWO things break at once and both are silent:
// the new area is not in AREA_CITY so its own wholesalers do not split, AND the existing area still
// reads as a one-area city so it does not start splitting either. One line added to AREA_CITY fixes
// both; the whole problem is that nobody is told to add it.
//
// So this map is what lets a guard tell "a new area nobody has classified yet" from "an area we
// deliberately never split". Without it the warning fires every single month on Main Store and
// becomes wallpaper — which is exactly how a guard that fires at the normal working level dies.
//
// Both entries are real and verified live on 2026-09-07: they are the ONLY two of the 51 live areas
// absent from AREA_CITY.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const AREAS_DELIBERATELY_NOT_SPLIT: ReadonlyMap<string, string> = new Map([
  ["OT3", "Aswan (Legacy) — retired from the organogram; OT7 Aswan replaced it"],
  ["OTMS", "Main Store — real sales, but no rep, no DM and no target, so it is not a territory to spread across"],
]);

/**
 * True when this area carries sales but the city list has never heard of it — neither grouped into
 * a city nor deliberately excluded above. In practice that means someone created an area and the
 * city list has not caught up, which is the one case a human needs to be told about.
 */
export function isUnlistedArea(areaCode: string | null | undefined): boolean {
  const area = normalizeArea(areaCode);
  if (!area) return false;
  return !AREA_CITY.has(area) && !AREAS_DELIBERATELY_NOT_SPLIT.has(area);
}

/** Every area of a city, in a stable order. Built once from AREA_CITY so the two cannot drift. */
export const CITY_AREAS: ReadonlyMap<string, readonly string[]> = (() => {
  const byCity = new Map<string, string[]>();
  for (const [area, city] of AREA_CITY) {
    const list = byCity.get(city) ?? [];
    list.push(area);
    byCity.set(city, list);
  }
  for (const list of byCity.values()) list.sort();
  return byCity;
})();

function normalizeArea(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE WAREHOUSE SPLIT (تقسيمة المخازن) — owner, 2026-09-08.
//
// Replaces the Qalubeya→Cairo rule of 2026-09-07, which he retired the next day in favour of this.
// His words, both halves:
//
//   "اي مخزن لحد 200 علبة per product يوزع علي مندوبين المحافظة وليس له علاقه بتوزيع الجمهورية"
//   "اي مخزن فوق 200 باي كميه يوزع 50 % علي مندوبين المحافظة وباقي ال 50% يوزع علي باقي الجمهورية
//    بالتساوي ماعدا مندوبين نفس المحافظة اللي اتطبع فيها الاوردر"
//
// Per warehouse, per product, per month:
//   * up to 200 packs — the governorate's own areas only, exactly as every other city split works,
//     and explicitly nothing to do with the national spread ("وليس له علاقه بتوزيع الجمهورية").
//   * above 200 packs — HALF across the governorate's own areas, HALF evenly across every other
//     area in the country, the origin governorate excluded from that second half.
//
// 🔴 SCOPE IS EL QEMA, AND EL QEMA IS NOT ITSELF THE WAREHOUSE. Asked directly whether the 200-pack
// rule runs on every distributor, he answered: "any warehouse only in el qema distrbutor .. consider
// el qema distbutor not warehouse and the customers in it vare the warehouses golden r=ule". El Qema
// is a distributor whose whole book is wholesale — which is what WHOLESALE_ONLY_DISTRIBUTORS already
// encodes — so every customer under it is a warehouse and is judged by the threshold. The same
// warehouse reached through Ibn Sina or Overseas keeps the plain city split. Do NOT generalise this
// to other distributors without asking him again; "اي مخزن" is scoped by that answer, not open.
//
// 🔴 THE DIVISOR IS AREAS, NOT REPS — carried forward unchanged from 2026-09-07, where he ruled on
// exactly this question against his own manual sheet: "down town should be included because we split
// in reference to areas not actual reps". He writes "مندوبين" (reps) here too; it means territories.
// So a vacant seat, and an area with no seat at all, both keep their share. AREA_CITY is the whole
// universe, which is also why Main Store and retired OT3 are outside it — see
// AREAS_DELIBERATELY_NOT_SPLIT, they are not territories to spread across.
//
// 🔴 THE THRESHOLD IS TAKEN ON THE AGGREGATE, NEVER ON ONE ROW. One customer and one product can
// arrive as several rows — several bricks, several invoices in the month. Judging each row on its
// own qty would read three 100-pack rows as three sub-threshold orders and never send the national
// half: 300 packs would sit in the governorate, with no error and nothing downstream reporting it
// (the split preserves each line's total, so the publication drift check cannot see it).
// `warehouseSplitQtyByKey` sums the set first, and the whole set is judged on that one number.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Packs. At or below this, a warehouse's product stays inside its own governorate. */
export const WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY = 200;

/** The share that stays in the origin governorate in the MIDDLE band, 201 to 699 packs. */
export const WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION = 0.5;

/**
 * Packs. At or above this, the local block stops being privileged and the whole quantity spreads
 * FLAT across every area the line has — owner, 2026-09-09, giving the rule as three ordered steps:
 *
 *   1. up to 200            → the governorate's reps only
 *   2. 201 to 699           → half the governorate, half the rest of the country
 *   3. 700 and above        → "يقسم علي مندوبي الجمهوريه بالتساوي وليس Others"
 *
 * ⚠ HE FIRST SET THIS BOUNDARY AT 1,000 AND MOVED IT TO 700 ON 2026-09-10 — his words that evening
 * were "201 to 699 ... 700 and above". Only the boundary moved; all three steps are otherwise
 * unchanged, and his original Arabic still reads 999 and 1000 because it is a dated quote. On
 * August 2026 the change is a NO-OP, measured: no warehouse-and-product total lands between 700 and
 * 999, so the band mix stays 1,164 / 960 / 6,644 packs. It bites from September onward.
 *
 * 🔴 STEP THREE IS NOT A BIGGER STEP TWO. Step two says "باقي الجمهورية", the REST of the
 * country, against a privileged home half. Step three drops the word باقي: every area takes the
 * same share and the origin is simply one of them. Asked directly on 2026-09-09 whether the
 * warehouse's own governorate still takes an equal share, he answered that it does. So a 5,600-pack
 * Benha product leaves Qalubeya with the same amount as every other area in play, not with half the
 * book. (Not the same as Aswan: Pedia parks Aswan in Others, and step three says "وليس Others", so
 * Aswan takes nothing at all.)
 *
 * Reading step three as "half stays, half spreads, but wider" is the mistake this note exists to
 * stop: it looks like the natural continuation of step two and it silently keeps ~2,800 packs in a
 * governorate the owner has just said should hold one thirty-seventh of them (one thirty-ninth from
 * September, when Qena 2 and Luxor join Upper Egypt 2).
 */
export const WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY = 700;

/**
 * The fraction of a sale that stays in the local block, for a quantity and a plan's two block sizes.
 *
 * 🔴 ONE FUNCTION BECAUSE THERE ARE TWO CALLERS AND THEY MUST NEVER DISAGREE. splitTargetsFor
 * builds the plan the Matrix applies; storeSplitDetailRows rebuilds the same arithmetic to report
 * it on the Store Split sheet. Before the third band those two could each hold `0.5` and stay
 * correct — the detail sheet read the fraction off `awayParts > 0` alone, with a comment saying that
 * was what kept them from drifting. That stopped being true the moment the fraction began to depend
 * on the QUANTITY as well as the shape, and a sheet disagreeing with the Matrix about the same
 * customer is exactly the failure the comment was guarding against.
 *
 * Flat is expressed as a fraction rather than as a separate code path so `planShares` needs no
 * change at all: homeParts / (homeParts + awayParts) hands each block its own headcount's worth, so
 * every area — home or away — comes out with an identical share.
 */
export function warehouseHomeFraction(qty: number, homeParts: number, awayParts: number): number {
  if (awayParts <= 0) return 1;
  if (qty >= WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY) return homeParts / (homeParts + awayParts);
  return WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION;
}

/**
 * Distributors whose customers are judged by the 200-pack rule — El Qema only, owner 2026-09-08.
 *
 * Deliberately a second set rather than a reuse of WHOLESALE_ONLY_DISTRIBUTORS, even though both
 * hold exactly `QM` today: one answers "is this customer a warehouse", the other "does the national
 * threshold apply to it". A future distributor could be wholesale-only without taking this rule, and
 * merging the two would grant it silently.
 */
export const WAREHOUSE_THRESHOLD_DISTRIBUTORS: ReadonlySet<string> = new Set(["QM"]);

/**
 * 🔒 EL QEMA IS PEDIA ONLY — owner golden rule, 2026-09-08, in those words.
 *
 * Asked what happens when a warehouse's own governorate is an Others area — which is real on Anti
 * Infective, where Qalubeya itself sits in OT — he answered that the question cannot arise: El Qema
 * sells Pedia and nothing else. Their whole book is Lacto Advanced 1 and 2, both Pedia.
 *
 * So the threshold rule is gated on the LINE as well as the distributor. An El Qema row arriving on
 * any other line does NOT take the national split — it falls back to the ordinary city split, which
 * is the unchanged, safe behaviour, rather than applying a rule the owner scoped to Pedia to a line
 * he never scoped it to.
 */
export const WAREHOUSE_THRESHOLD_LINES: ReadonlySet<string> = new Set(["pedia"]);

/**
 * Lines whose split excludes the areas their organogram parks in Others — owner, 2026-09-08:
 * "you will follow the EU organogram of PEDIA LINE and exclude in distribution the areas in others".
 *
 * 🔴 THIS IS A LINE RULE, NOT A DISTRIBUTOR RULE, and the difference is the whole reason this set
 * exists separately from WAREHOUSE_THRESHOLD_DISTRIBUTORS. It first shipped scoped to El Qema alone,
 * on the reading that he was talking about El Qema's distribution. He was not: measured on August
 * Pedia the next day, El Qema sent 0.000 packs into Others while OTHER distributors still sent
 * 79.667 — 44.167 into Down town and 35.500 into Kafr El-Sheikh 2 — and he replied "NOT APPLIED EL
 * QEMA RULE". An area in Others receives nothing on this line, whoever sold it.
 *
 * The 200-pack national split stays El Qema's alone. These are two different rules that happen to
 * have arrived in the same sentence: WHO spreads nationwide, and WHERE nobody may receive.
 */
export const OTHERS_EXCLUDED_LINES: ReadonlySet<string> = new Set(["pedia"]);

export type SplitRegions = {
  /** Areas the line parks in Others. They receive nothing, but always keep what they sold. */
  others: ReadonlySet<string>;
  /** Operational region code to its areas, for this line and period. */
  areasByRegion: ReadonlyMap<string, ReadonlySet<string>>;
};

/** No organogram loaded. Splits exactly as the code did before any of these rules existed. */
export const NO_SPLIT_REGIONS: SplitRegions = { areasByRegion: new Map(), others: new Set() };

/**
 * 🔴 THE CAIRO + QALUBEYA RULE STANDS — it was never replaced, and removing it was an error.
 *
 * Owner 2026-09-07: "سوف يتم تقسيم بيع القليوبية على مندوب القليوبية بالإضافة إلى كل مندوبين القاهرة
 * بالتساوى" — El Qema's Qalubeya sales reach Qalubeya AND Cairo. When he introduced the 200-pack
 * warehouse split the next day with "we will change the concept of the qema distribution into
 * تقسيمة المخازن", that was read as REPLACING this rule. It was not. Told plainly on 2026-09-09:
 * "YOU ARE NOT APPLYING THE CAIRO AND QALUBEYA RULE + THE NEW RULE" — both, together.
 *
 * They compose cleanly because they answer different questions. This map says WHAT COUNTS AS LOCAL
 * for a warehouse: Benha is on Cairo's edge and supplies it, so Qalubeya's local catchment is
 * Qalubeya plus the six Cairo areas rather than Qalubeya alone. The 200-pack rule then works on that
 * block exactly as it works on any governorate — under 200 the whole sale stays local, over 200 half
 * stays local and half crosses the country.
 *
 * WITHOUT THIS, Qalubeya is a ONE-AREA governorate, so a Benha warehouse keeps the entire local half
 * itself and Cairo receives nothing — which is precisely the state he rejected.
 *
 * Keyed `DISTRIBUTOR|ORIGIN AREA`, so it is El Qema's alone and one-way: there is no `QM|CA*` entry,
 * so a Cairo warehouse still treats Cairo as its own local block and never reaches Qalubeya.
 */
export type LocalBlockOverride = {
  label: string;
  areas: readonly string[];
  /**
   * One area takes this fraction of the local block and the rest share what is left, evenly.
   *
   * 🔴 THE REMAINDER IS SPREAD OVER THE SURVIVORS, NOT OVER THE ORIGINAL LIST. Down town is a
   * Cairo area that Pedia parks in Others, so the Cairo half is divided by FIVE, not six. Writing
   * the weights as a fixed per-area table would silently lose Down town's eighth of the block the
   * day the organogram moved it, and nothing downstream would report the shortfall.
   */
  primaryArea?: string;
  primaryFraction?: number;
};

export const LOCAL_BLOCK_OVERRIDES: ReadonlyMap<string, LocalBlockOverride> = new Map([
  ["QM|D11", {
    areas: ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"],
    label: "Qalubeya + Cairo",
    // NO WEIGHTING. Owner, 2026-09-09 evening, restating step 2 in full: "50% يقسم علي مندوبي
    // المحافظة والكلام ده ينطبق علي القليوبية (القليوبية + القاهرة)". He named the BLOCK and named no
    // split inside it, so the local half divides evenly across it — Benha keeps a sixth, not a
    // three-quarters.
    //
    // 🔴 THE 60/40 AND THEN 75/25 HE ASKED FOR EARLIER THE SAME DAY ARE GONE, with the priority
    // ladder and everything else his "remove any current rule and implement those" removed. Putting
    // a weighting back here is a one-line change (primaryArea + primaryFraction below), and it is
    // the lever to reach for if the contribution table does not come out the way he wants — but it
    // is HIS call, not an inference from the constraint he set.
  }],
]);

/** Every area the split can reach, in a stable order. AREA_CITY's keys ARE the universe. */
export const ALL_SPLIT_AREAS: readonly string[] = [...AREA_CITY.keys()].sort();

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * OTHERS ARE EXCLUDED FROM THE DISTRIBUTION — owner, 2026-09-08.
 *
 * "you will follow the EU organogram of pedia line and exclude in distribution the areas in others"
 *
 * The EU Organogram is already the closing's source of truth for this line (owner, 2026-08-07 —
 * see CLOSING_ORGANOGRAM_REGION_LINES). It parks an area in the Others territory (`OT`) when the
 * line has no district of its own for it. Those areas now receive NO share of a split.
 *
 * 🔴 OTHERS IS PER LINE AND IS NOT A GEOGRAPHY. On Pedia it holds Down town (CA5), Kafr El-Sheikh 2
 * (D17), Qena 2 (UE8) and the nine OT areas — 13 of 50 in August; Qena 2 and Luxor (OT6) leave it for
 * Upper Egypt 2 on 2026-09-01 (see UPPER_EGYPT_AREAS). On Anti Infective it holds Qalubeya. So the
 * set can only come from the organogram, per line, per month; it can never be derived from an area
 * code. It is passed IN rather than read here, because this module is pure geography and the
 * organogram is live data that flips the moment a seat is created or filled.
 *
 * 🔴 THIS REVERSES THE DOWN TOWN RULING OF 2026-09-07, and the owner was asked in those words before
 * it was written: on 09-07 he ruled Down town INTO the Cairo split because the divisor is areas and
 * not reps; on 09-08, shown that the Pedia organogram files Down town under Others, he confirmed it
 * comes out with the rest. The divisor is still areas — there are simply fewer of them.
 *
 * SCOPE: THE WHOLE LINE, EVERY DISTRIBUTOR — owner, 2026-09-09 (#3575). This exclusion first shipped
 * on 09-08 scoped to El Qema alone, on the reading that he was asking about El Qema's distribution.
 * He was not: measured on August Pedia, other distributors' wholesalers were still sending shares
 * into Down town and Kafr El-Sheikh 2, and he answered "NOT APPLIED EL QEMA RULE". So on Pedia no
 * Others area receives a share of ANY wholesaler's split, whoever sold it — see
 * OTHERS_EXCLUDED_LINES, and `splitTargetsFor`, which applies it before the El Qema gate. What stays
 * El Qema's alone is the 200-pack national split, the Qalubeya + Cairo block, the صعيد pass and the
 * lead guarantee.
 *
 * An EMPTY set is the safe direction and means 'split as before' — a caller that could not read the
 * organogram must never silently strip areas out of a distribution.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
const NO_AREAS: ReadonlySet<string> = new Set<string>();

export type SplitPlan = {
  /** Shown as the "city" on the Store Split sheet, so the movement says which rule moved it. */
  readonly group: string;
  /** The origin governorate's own areas. Never empty. */
  readonly homeAreas: readonly string[];
  /** The rest of the country. EMPTY unless the national half applies. */
  readonly awayAreas: readonly string[];
  /** Fraction that stays home: 1 below the threshold, 0.5 above it. */
  readonly homeFraction: number;
  /**
   * How the home block divides internally, aligned with `homeAreas`. Absent means evenly, which is
   * EVERY block today — El Qema's Qalubeya carried a 75/25 for one afternoon and no longer does.
   */
  readonly homeWeights?: readonly number[];
  /**
   * The FINAL fraction of the row each entry of `areas` takes, summing to 1. When present it
   * decides everything and `homeFraction` / `homeWeights` become description only.
   *
   * 🔴 ONLY El Qema's Upper Egypt redistribution sets this, and it is what lets that pass live
   * inside `splitTargetsFor` rather than in the split loop. Every surface — the Matrix, the net,
   * the attribution, the Detail sheet and the import preview — reads ONE plan, so a redistribution
   * applied in the loop would have been invisible to four of the five. That is the exact shape of
   * the Matrix-versus-Detail disagreement this file's header warns about.
   */
  readonly weights?: readonly number[];
  /** Every area this row reaches — home first, then away. The flat list callers read. */
  readonly areas: readonly string[];
};

function normalizeDistributor(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * The key the 200-pack threshold is measured over: one warehouse, one product, one month, in the
 * area the closing books it in.
 *
 * AREA IS PART OF THE KEY. One client code can appear in two areas — distributors reuse codes for
 * different venues — and those are two different warehouses in two different governorates. Summing
 * them would let one venue's volume push another venue's small order over the threshold and scatter
 * it nationwide.
 */
export function warehouseSplitKey(row: StoreSplitRow): string {
  return [
    normalizeDistributor(row.distributorCode),
    String(row.clientCode ?? "").trim().toUpperCase(),
    lineKey(row.officialLine),
    normalizeArea(closingAreaOf(row)),
    String(row.productCode ?? "").trim().toUpperCase(),
  ].join("|");
}

/**
 * Total packs per `warehouseSplitKey` across a whole closing, so the threshold is judged once on the
 * month's real quantity rather than on whichever row happens to be in hand.
 *
 * Direct rows and rows the closing excludes are left out: they move no closing money, so counting
 * them would let money the closing never shows decide where money it does show goes.
 */
export function warehouseSplitQtyByKey(rows: readonly StoreSplitRow[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.isDirect) continue;
    if (!row.includedInClosing) continue;
    const key = warehouseSplitKey(row);
    totals.set(key, (totals.get(key) ?? 0) + (Number(row.qty) || 0));
  }
  return totals;
}

/**
 * The areas this row's money divides across, how it is weighted, and the label for the movement.
 *
 * `thresholdQty` is the month's total for this warehouse and product — pass it from
 * `warehouseSplitQtyByKey`. It defaults to the row's own qty, which is right only when the key holds
 * exactly one row; every caller holding the whole set passes the aggregate.
 *
 * Returns null when there is nothing to divide across — an area outside AREA_CITY, or a city that
 * does not exist — which every caller treats as "leave this row exactly where it is".
 *
 * Deliberately ONE function rather than the three copies that grew here: `isSplitEligible`, the
 * split itself and the detail sheet each derived the area set independently, so a rule added to one
 * of them would have produced a workbook whose Matrix and Detail sheet disagreed about the same
 * customer.
 */
export function splitTargetsFor(
  row: StoreSplitRow,
  thresholdQty?: number,
  regions?: SplitRegions,
): SplitPlan | null {
  const origin = closingAreaOf(row);
  if (!origin) return null;
  const city = cityOfArea(origin);
  if (!city) return null;
  const cityAreas = CITY_AREAS.get(city);
  if (!cityAreas || cityAreas.length === 0) return null;

  // The rule is the owner's El Qema rule, on the owner's El Qema line. Anything else falls through
  // to the plain city split it has always had — see WAREHOUSE_THRESHOLD_LINES.
  const line = lineKey(row.officialLine);
  const distributor = normalizeDistributor(row.distributorCode);
  const ruleApplies = WAREHOUSE_THRESHOLD_DISTRIBUTORS.has(distributor)
    && WAREHOUSE_THRESHOLD_LINES.has(line);

  // The quantity decides the band, and from 2026-09-09 it also decides the local BLOCK, so it has to
  // be resolved before the block rather than after it.
  const qty = Number.isFinite(thresholdQty) ? Number(thresholdQty) : Number(row.qty) || 0;
  const overThreshold = qty > WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY;

  // What counts as LOCAL for this warehouse: its governorate, unless an owner override widens it.
  //
  // LOCAL_BLOCK_OVERRIDES is unconditional — Benha reaches Cairo at any quantity, because that map
  // says what Qalubeya's reps ARE. It is the owner's Cairo + Qalubeya rule.
  //
  // ⚠ UPPER EGYPT IS NOT HANDLED HERE. His صعيد rule is a SECOND pass over whatever the bands
  // produce, and it runs at the bottom of this function — see `redistributeUpperEgypt`. An earlier
  // version of that rule was a POOL sitting beside this line, levelling Fayoum + Beni Suef and the
  // Upper Egypt areas into one member before the bands ran; it was deleted in #3606 and the shape
  // that replaced it is deliberately different, so do not restore the pool from git history.
  //
  // ⚠ NEITHER RULE PRESERVES "fayoum-banisuef one region", which he asked for on the morning of
  // 2026-09-09. Fayoum (GZ6) and Beni Suef (UE9) are two areas taking two shares, and the closing
  // folds them into one row further downstream (CLOSING_AREA_MERGES) purely for display. Under the
  // صعيد pass they land on identical numbers anyway, which is as close to his morning rule as the
  // evening one gets.
  const override = ruleApplies ? LOCAL_BLOCK_OVERRIDES.get(`${distributor}|${origin}`) : undefined;
  const localBlock = override?.areas ?? cityAreas;
  // The Store Split sheet names the rule that moved the money, so a reader never has to guess why
  // Cairo gained from a Benha warehouse.
  const localLabel = override?.label ?? city;
  // The exclusion is keyed on the LINE alone — every warehouse on it, not just El Qema's. The
  // threshold above is the distributor's rule; this one is the organogram's.
  const excluded = OTHERS_EXCLUDED_LINES.has(line) ? (regions?.others ?? NO_AREAS) : NO_AREAS;

  // The ORIGIN is never excluded from its own sale. An area is barred from receiving a share of
  // somebody else's money, not from keeping what it sold itself — and without this a warehouse
  // sitting in an Others area would have a home half with nowhere at all to go.
  const keep = (area: string) => !excluded.has(area) || area === origin;
  const homeAreas = localBlock.filter(keep);
  const localSet = new Set(localBlock);

  // The weighted split of the home block, when the owner gave one for this block. `undefined`
  // everywhere else, which planShares reads as "evenly".
  const weightsFor = (block: readonly string[]): readonly number[] | undefined => {
    const primary = override?.primaryArea;
    const fraction = override?.primaryFraction;
    if (!primary || typeof fraction !== "number" || !block.includes(primary)) return undefined;
    const others = block.length - 1;
    if (others <= 0) return undefined;
    const rest = (1 - fraction) / others;
    return block.map((area) => (area === primary ? fraction : rest));
  };

  const home: SplitPlan = {
    areas: homeAreas,
    awayAreas: [],
    group: localLabel,
    homeAreas,
    homeFraction: 1,
    homeWeights: weightsFor(homeAreas),
  };

  if (!ruleApplies) return home;

  // Everything the local block does NOT already hold. Testing the block rather than the city is what
  // stops Cairo being paid twice when it is part of Qalubeya's local block.
  const awayAreas = ALL_SPLIT_AREAS.filter((area) => !localSet.has(area) && keep(area));

  // Band two keeps half at home; band three keeps only a headcount's worth, which is what makes
  // every area equal. The label follows, so the Store Split sheet names which step moved the money
  // rather than leaving a reader to infer it from the numbers.
  const homeFraction = warehouseHomeFraction(qty, homeAreas.length, awayAreas.length);
  const flat = qty >= WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY;

  const banded: SplitPlan = !overThreshold || awayAreas.length === 0
    ? home
    : {
      areas: [...homeAreas, ...awayAreas],
      awayAreas,
      group: flat ? "nationwide, equal shares" : `${localLabel} + nationwide`,
      homeAreas,
      homeFraction,
      // Band 3 pays every area the same by his own words, so the home weighting stops there.
      // Carrying it in would make Qalubeya larger than every other area in the one band that exists
      // to make them all equal. Nothing sets a home weighting today — see LOCAL_BLOCK_OVERRIDES.
      homeWeights: flat ? undefined : weightsFor(homeAreas),
    };

  // 🔒 AND THEN الصعيد. The bands answer first and the redistribution works on their result, which
  // is the order he gave it in: three numbered steps, then "بالنسبه لتقسيم القمه للصعيد".
  //
  // 🔴 IT RUNS IN EVERY BAND, INCLUDING THE FIRST. He wrote "كل البيع اللي محسوب للصعيد" — ALL the
  // sales credited to Upper Egypt — and band 1's sales are credited to it like any other. So a
  // small Minia warehouse does reach the country through this pass, even though band 1 on its own
  // says it does not. That is his second rule acting on the first rule's output, not a conflict.
  return redistributeUpperEgypt(
    banded,
    upperEgyptAreasFor(regions),
    ALL_SPLIT_AREAS.filter(keep),
  );
}

/**
 * 🔒 THE LEAD GUARANTEE — Qalubeya, Tanta and Mahalla MUST top the contribution table.
 *
 *   "مع الحفاظ على منطقة القليوبية الاولى و الثانية طنطا لابد ان يكونوا اكبر نسبة contribution"
 *
 * Owner, 2026-09-09, twice: once inside the ruling that set the three bands, and again when the
 * first build reported the three ranked 22nd, 20th and 21st instead of making it so. **"لابد" is
 * a requirement, not a preference**, and it is the one part of this rule that is stated as an
 * OUTCOME. So it is enforced as an outcome: whatever the bands and the صعيد pass produce, these
 * three areas finish above every other area, and the size of the step is his own
 * "exceeding them, but with a very small scale".
 *
 * 🔴 IT CANNOT LIVE IN `splitTargetsFor`, AND THE ARITHMETIC IS WHY — not preference. A plan is
 * one customer's sale; contribution is the MONTH. A per-row floor is infeasible on a small plan:
 * a 150-pack Alexandria sale divides across three areas, and no three OTHER areas can each hold
 * more than the largest of three shares of one. So the guarantee runs once over the finished
 * landing, per line and per product.
 *
 * 🔴 PER PRODUCT, NEVER ACROSS PRODUCTS. A unit total is only meaningful for one product, and
 * leading on every product implies leading on the line: sum a floor that holds product by product
 * and it still holds over the sum, because Σ max ≥ max Σ.
 *
 * ⚠ The Store Split Detail sheet and the import preview describe one customer's sale being
 * divided, which is the band plus the صعيد pass. They do NOT show this step, because a month-level
 * adjustment is not a property of any one sale. The Matrix, the attribution net and the closing all
 * do. That is a real difference between those surfaces and it is stated rather than hidden.
 */
export const QEMA_LEAD_TIERS: readonly (readonly string[])[] = [
  ["D11"],          // Qalubeya — first, on its own
  ["D14", "D15"],   // Gharbia 1 (Tanta) and Gharbia 2 (Mahalla), level with each other behind it
];

/**
 * 🔒 QALUBEYA IS FIRST, NOT JOINT-FIRST — owner, 2026-09-09, in two words: "Qalubeya number 1".
 *
 * The first build of the guarantee put all three on ONE figure and left the display order to the
 * sort, so Qalubeya read third of three at the same percentage. He wants a rank, so the tiers above
 * are a ladder: each takes one step more than the tier below, and the tier below takes one step
 * more than the field. Within a tier the members are LEVEL — Tanta never sits behind Mahalla.
 */
export const QEMA_LEAD_AREAS: readonly string[] = QEMA_LEAD_TIERS.flat();

/** One step between tiers, and between the bottom tier and the field. His "very small scale". */
export const QEMA_LEAD_STEP = 0.02;

/**
 * The totals each area must end this line and product on, or null when nothing needs to move.
 *
 * Pure and exported so a test can derive the answer without a whole split. `totals` is what the
 * bands and the صعيد pass landed; the returned map covers exactly the same areas plus any lead
 * area that landed nothing, and sums to the same total.
 */
export function qemaLeadTargets(
  totals: ReadonlyMap<string, number>,
  tiers: readonly (readonly string[])[],
): Map<string, number> | null {
  const ladder = tiers
    .map((tier) => tier.map(normalizeArea).filter((area) => area.length > 0))
    .filter((tier) => tier.length > 0);
  if (ladder.length === 0) return null;
  const leadSet = new Set(ladder.flat());

  let pool = 0;
  let topOther = 0;
  for (const [area, amount] of totals) {
    if (leadSet.has(area)) continue;
    pool += amount;
    if (amount > topOther) topOther = amount;
  }
  if (pool <= 0) return null;

  /**
   * The floor each tier must reach, given what the field is worth once the lift has been paid for.
   *
   * Read from the BOTTOM up, so every tier clears the one under it by a step and the lowest clears
   * the field. A tier whose own strongest member already sits above its floor pulls the whole tier
   * up to that member rather than leaving one of them behind — within a tier they are level.
   */
  const floorsFor = (keep: number): number[] => {
    const floors: number[] = new Array(ladder.length).fill(0);
    let under = topOther * keep;
    for (let index = ladder.length - 1; index >= 0; index -= 1) {
      const strongest = Math.max(...ladder[index].map((area) => totals.get(area) ?? 0));
      const floor = Math.max(under * (1 + QEMA_LEAD_STEP), strongest);
      floors[index] = floor;
      under = floor;
    }
    return floors;
  };

  const needFor = (floors: readonly number[]): number => ladder.reduce(
    (sum, tier, index) => sum + tier.reduce(
      (tierSum, area) => tierSum + Math.max(0, floors[index] - (totals.get(area) ?? 0)),
      0,
    ),
    0,
  );

  // 🔴 THE STEPS ARE MEASURED AFTER THE MONEY MOVES, WHICH MAKES THE FLOORS A FIXED POINT.
  // Lifting the named areas is paid for by everyone else, so the field they have to clear is
  // SMALLER once they have been paid. Taking the step against the field as it stood before
  // overshoots — measured on August, it put them 5.4% clear when he asked for a very small scale.
  // Twenty passes settle it to double precision; the sequence is a contraction from any start.
  let keep = 1;
  let floors = floorsFor(keep);
  let need = needFor(floors);
  for (let pass = 0; pass < 20 && need > 0 && need < pool; pass += 1) {
    const next = (pool - need) / pool;
    if (Math.abs(next - keep) <= Number.EPSILON * 8) break;
    keep = next;
    floors = floorsFor(keep);
    need = needFor(floors);
  }
  if (need <= 0) return null;

  // Clamped at the pool. It cannot bind on any real month — the named areas need a few percent of
  // the book and the rest of the country holds ninety — but a product sold entirely inside one
  // other city would otherwise ask for money that does not exist. At the clamp the others reach
  // zero, which satisfies the ladder by itself.
  const take = Math.min(need, pool);
  const survivorShare = (pool - take) / pool;

  const out = new Map<string, number>();
  for (const [area, amount] of totals) {
    if (!leadSet.has(area)) out.set(area, amount * survivorShare);
  }
  // The last named area absorbs the rounding, exactly as evenShares and planShares do, so the
  // adjusted landing sums back to the untouched one bit for bit.
  const flat = ladder.flatMap((tier, index) => tier.map((area) => ({ area, floor: floors[index] })));
  let given = 0;
  flat.forEach(({ area, floor }, index) => {
    const own = totals.get(area) ?? 0;
    const wanted = Math.max(0, floor - own);
    const share = index < flat.length - 1 ? (take * wanted) / need : take - given;
    given += share;
    out.set(area, own + share);
  });
  return out;
}

/**
 * 🔒 EL QEMA'S UPPER EGYPT REDISTRIBUTION (تقسيم القمه للصعيد) — owner, 2026-09-09 evening.
 *
 *   "هناخد كل البيع اللي محسوب للصعيد و نعيد توزيعوا 50% منه لكل محافظات الصعيد بالتساوى،
 *    وال 50% الباقيه يوزع علي الجمهورية"
 *
 * Everything the three bands credit to Upper Egypt is taken back into one pool. Half returns evenly
 * across the Upper Egypt areas; half spreads over the country.
 *
 * 🔴 "الجمهورية", NOT "باقي الجمهورية" — he wrote the second half as THE REPUBLIC, where step 2 of
 * the bands says the REST of it. So an Upper Egypt area is in both halves and takes a share of each.
 * Reading it as "the rest" would move money out of the region the sentence exists to protect.
 *
 * 🔴 PER ROW IS THE SAME ANSWER AS PER MONTH. Every step above this is linear in the row's value,
 * so redistributing each row equals redistributing the month's total — which is how he described it.
 * Doing it here, as a weight on the plan, is what keeps all five surfaces reading one operation.
 */
export const UPPER_EGYPT_HOME_FRACTION = 0.5;

/**
 * The governorates of الصعيد, as area codes.
 *
 * 🔴 THE ORGANOGRAM ALONE CANNOT ANSWER THIS IN AUGUST, and reading it alone is the mistake to
 * expect. On Pedia the `UE` operational region holds only Minia 1-2, Assuit 1-2, Sohag 1-2 and
 * Qena 1 — Fayoum (GZ6) and Beni Suef (UE9) sit in the GIZA region until the Upper Egypt split
 * dates in on 2026-09-01. He named both by name as Upper Egypt earlier the same day
 * ("look fayoum bani suef and all upper egypt regions"), so a region-code read would drop exactly
 * the two areas he was thinking of.
 *
 * This list is the SAME membership the August / Upper Egypt golden rule pins for UE-1 and UE-2, so
 * the two cannot drift: UE-1 is Fayoum, Beni Suef, Minia 1-2, Assuit 1-2; UE-2 is Sohag 1-2,
 * Qena 1, Qena 2 and Luxor. Aswan is not Upper Egypt for this purpose — it stays in Others.
 *
 * ⚠ Qena 2 (UE8) and Luxor (OT6) are parked in Others for August and join Upper Egypt 2 on
 * 2026-09-01. They are listed here anyway: `upperEgyptAreasFor` subtracts Others, so August pools
 * over nine areas and September over eleven with no code change on the day.
 */
export const UPPER_EGYPT_AREAS: readonly string[] = [
  "GZ6", "UE9",               // Fayoum, Beni Suef — in the GIZA region until 2026-09-01
  "UE1", "UE2", "UE3", "UE4", // Minia 1-2, Assuit 1-2
  "UE5", "UE6", "UE7", "UE8", // Sohag 1-2, Qena 1, Qena 2
  "OT6",                      // Luxor — rides in Others until 2026-09-01
];

/** True for the operational region code of Upper Egypt, before or after the 2026-09-01 split. */
export function isUpperEgyptRegion(regionCode: string | null | undefined): boolean {
  return /^UE([-_ ]?\d+)?$/.test(String(regionCode ?? "").trim().toUpperCase());
}

/**
 * The Upper Egypt areas this line actually has in play — the named governorates above, widened by
 * anything the organogram files under an Upper Egypt region, minus everything parked in Others.
 *
 * Both sources on purpose: the list carries the two areas August's region codes do not know about,
 * and the region read carries any area added to Upper Egypt after this file was written.
 */
export function upperEgyptAreasFor(regions: SplitRegions | undefined): ReadonlySet<string> {
  const excluded = regions?.others ?? NO_AREAS;
  const out = new Set<string>();
  const consider = (value: string) => {
    const code = normalizeArea(value);
    if (code && AREA_CITY.has(code) && !excluded.has(code)) out.add(code);
  };
  UPPER_EGYPT_AREAS.forEach(consider);
  for (const [regionCode, areas] of regions?.areasByRegion ?? []) {
    if (!isUpperEgyptRegion(regionCode)) continue;
    for (const area of areas) consider(area);
  }
  return out;
}

/**
 * Apply the redistribution to a finished band plan. Returns the plan untouched when nothing of this
 * row reached Upper Egypt, which is the common case and the safe direction.
 *
 * `homeAreas` and `awayAreas` survive as DESCRIPTION — they are what the Store Split Detail sheet
 * names as "the governorate" and "the rest of the country", and the sheet reads its numbers from the
 * weights, so the two blocks stay truthful labels for a distribution they no longer decide.
 */
export function redistributeUpperEgypt(
  plan: SplitPlan,
  upperEgypt: ReadonlySet<string>,
  inPlay: readonly string[],
): SplitPlan {
  if (upperEgypt.size === 0 || inPlay.length === 0) return plan;
  const ue = inPlay.filter((area) => upperEgypt.has(area));
  if (ue.length === 0) return plan;

  const base = planShares(plan, 1);
  const weightByArea = new Map<string, number>();
  let pooled = 0;
  plan.areas.forEach((area, index) => {
    const weight = base[index] ?? 0;
    if (upperEgypt.has(area)) {
      pooled += weight;
      // Kept in the map at zero so the area holds its place in the output order.
      weightByArea.set(area, weightByArea.get(area) ?? 0);
      return;
    }
    weightByArea.set(area, (weightByArea.get(area) ?? 0) + weight);
  });
  // Nothing of this row was credited to Upper Egypt, so there is nothing to take back.
  if (pooled <= 0) return plan;

  const add = (area: string, weight: number) => {
    weightByArea.set(area, (weightByArea.get(area) ?? 0) + weight);
  };
  const home = pooled * UPPER_EGYPT_HOME_FRACTION;
  ue.forEach((area) => add(area, home / ue.length));
  inPlay.forEach((area) => add(area, (pooled - home) / inPlay.length));

  const entries = [...weightByArea.entries()];
  const areas = entries.map(([area]) => area);
  const homeSet = new Set(plan.homeAreas);
  return {
    ...plan,
    areas,
    awayAreas: areas.filter((area) => !homeSet.has(area)),
    group: `${plan.group}, Upper Egypt redistributed`,
    homeAreas: areas.filter((area) => homeSet.has(area)),
    weights: entries.map(([, weight]) => weight),
  };
}

/**
 * Divide `total` across a plan's areas, home block first, in the same order as `plan.areas`.
 *
 * The two halves are taken as `total * 0.5` and `total - home`, never as two independent halvings:
 * multiplying a float by 0.5 is exact in binary, and the subtraction then closes any gap, so the
 * shares sum back to `total` bit-for-bit. `evenShares` gives the same guarantee inside each block.
 */
export function planShares(plan: SplitPlan, total: number): number[] {
  // The home block divides by weight when the owner gave one. Taken as `total - assigned` on the
  // last element, exactly as the even path does, so a weighted block still sums back to `total`.
  const homeShareAt = (index: number, pool: number): number => (
    plan.homeWeights ? pool * plan.homeWeights[index] : pool / plan.homeAreas.length
  );

  // A general weight vector answers on its own, home and away alike. Same running remainder as
  // every other path here, so the shares sum back to `total` bit-for-bit.
  if (plan.weights) {
    const weights = plan.weights;
    if (weights.length === 0) return [];
    const weighted: number[] = [];
    let taken = 0;
    for (let index = 0; index < weights.length - 1; index += 1) {
      const share = total * weights[index];
      weighted.push(share);
      taken += share;
    }
    weighted.push(total - taken);
    return weighted;
  }

  if (plan.awayAreas.length === 0) {
    if (!plan.homeWeights) return evenShares(total, plan.homeAreas.length);
    const shares: number[] = [];
    let running = 0;
    for (let index = 0; index < plan.homeAreas.length - 1; index += 1) {
      const share = homeShareAt(index, total);
      shares.push(share);
      running += share;
    }
    shares.push(total - running);
    return shares;
  }

  // ONE running remainder across BOTH blocks, never two independent evenShares calls concatenated.
  // evenShares guarantees its own block sums back exactly only when that block is summed from zero;
  // append a second block behind it and the compensations no longer line up — measured, 700 into
  // 1 + 48 came back 699.9999999999993. So the last area of the away block absorbs the remainder for
  // the whole row, exactly as evenShares does for a single block.
  const home = total * plan.homeFraction;
  const away = total - home;
  const awayShare = away / plan.awayAreas.length;
  const count = plan.homeAreas.length + plan.awayAreas.length;

  const shares: number[] = [];
  let assigned = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const share = index < plan.homeAreas.length ? homeShareAt(index, home) : awayShare;
    shares.push(share);
    assigned += share;
  }
  shares.push(total - assigned);
  return shares;
}

export function cityOfArea(areaCode: string | null | undefined): string | null {
  return AREA_CITY.get(normalizeArea(areaCode)) ?? null;
}

/** The minimum a row needs for the split. Matches ClosingDetailRow's shape structurally. */
export type StoreSplitRow = {
  /**
   * The RESOLVED area — brick/master geography where the row has a mapped brick. This is the area
   * the row is booked against, and the only one the split ever writes to.
   */
  areaCode: string;
  /**
   * The area the SOURCE fact row itself carries, before the brick/master lookup overwrote it
   * (`ClosingDetailRow.sheetAreaCode`). Optional — a caller without it falls back to `areaCode`.
   *
   * Read for ONE purpose: detecting that a human already apportioned this customer by hand. It is
   * never booked against, never returned on a split row, and changes no area total. See
   * customersExemptFromCitySplit for what survives of that question.
   */
  sheetAreaCode?: string;
  /**
   * The row's brick. Optional, and read only to report which bricks an EXEMPT customer's store
   * money sits on — see `exemptStoreValueByBrick`. It never affects whether or how a row splits.
   */
  brickId?: string;
  /** Required, not optional: it is the key an owner override is matched on, and a caller that
   *  omits it would silently split a customer the owner has ruled is a pharmacy. */
  clientCode: string;
  clientName: string;
  /** Distributor is part of customer identity; owner overrides never apply by code alone. */
  distributorCode?: string;
  includedInClosing: boolean;
  isDirect: boolean;
  /**
   * True when this customer and line sit in the even-split registry (`sos_even_split_customers`),
   * meaning the database has ALREADY dealt these units out across areas by a rule of their own.
   *
   * Set by the row builder in monthly-closing-details.ts from the live registry, so every caller
   * inherits it rather than having to remember. Optional only so hand-built rows in tests stay
   * valid; absent means "not registered", which is what every ordinary customer is.
   *
   * It cannot be inferred from the rows. See even-split-registry.ts for why the existing
   * hand-apportioned tell, removed 2026-09-07, was blind to this case.
   */
  evenSplitApplied?: boolean;
  officialLine: string;
  productCode: string;
  qty: number;
  salesValue: number;
};

/**
 * The ONLY customers the city split leaves alone.
 *
 * 🔒 OWNER RULE, 2026-09-07: **the city rule always wins, except EZ and Office on CNS.** Asked
 * directly whether he wanted the ability to override the even city share for a named customer, he
 * answered that he did not. So there is exactly one exemption left, and it is not a judgement about
 * where a customer's goods went — it is arithmetic: a customer the DATABASE has ALREADY distributed
 * must not be distributed a second time.
 *
 * `evenSplitApplied` marks such a customer — the even-split registry, EZ (client 1011654) today.
 * The flag cannot be inferred from these rows: this function reads the raw invoice, where EZ is a
 * single Cairo East 1 row for the whole month, while the distribution it is exempt for happens later,
 * in the rollup the Closing Matrix reads. See even-split-registry.ts.
 *
 * OFFICE NEEDS NO ENTRY HERE and that is not an oversight — it is excluded twice over. Office rows
 * carry no customer at all (`clientCode` is null by construction), so `isStoreCustomer` answers false
 * and `isSplitEligible` never reaches this function; and `loadMonthlyClosingPartsWithStoreSplit`
 * passes the `office` grid through without applying any net. Adding Office here would be a third
 * copy of a rule already stated twice.
 *
 * ── WHAT WAS REMOVED ON 2026-09-07, AND WHY IT IS NOT COMING BACK ────────────────────────────────
 * Until this date a SECOND route existed: a customer whose rows spanned more than one closing area
 * AND had at least one row booked away from its own brick was read as "a human apportioned this by
 * hand" and exempted. It existed for one case — client 441164 ريونيون للتجارةوالاستثمار, whose July
 * 2026 return the owner ruled on 2026-08-06 should split between Dakahlia 2 and Port Said - Domiat.
 *
 * It is gone for two independent reasons, and either alone would be enough:
 *
 *   1. IT MATCHED NOTHING. The hand-split lived in the fact ROWS, and a re-import of the Ibn
 *      Sina-Sato July file on 2026-08-09 rewrote them — the day after July Anti Infective was
 *      published. Swept live on 2026-09-06 across ALL 323,952 non-Office non-direct import rows:
 *      every single one has fact area == its brick's master area. Zero re-booked rows exist, so the
 *      condition could not fire for anybody.
 *   2. THE OWNER RETIRED THE IDEA. He was shown the measured cost of restoring 441164 (Dakahlia 1
 *      +34,370.00, Dakahlia 2 -17,185.00, Port Said -17,185.00, one rep's July achievement moving
 *      -22.0% to +41.9%) and declined, both because July is published — see
 *      never-fix-a-published-and-announced-month — and because the city rule is the rule.
 *
 * So do NOT reintroduce a per-customer apportionment override, and do not read the 441164 history in
 * git as unfinished work. The even city share is no longer "an estimate until a human says otherwise";
 * it IS the answer. A customer whose goods genuinely leave its city is a business fact the owner has
 * chosen not to model.
 */
export function customersExemptFromCitySplit(rows: readonly StoreSplitRow[]): ReadonlySet<string> {
  const exempt = new Set<string>();
  for (const row of rows) {
    if (row.isDirect || !row.includedInClosing) continue;
    if (!row.evenSplitApplied) continue;
    const code = String(row.clientCode ?? "").trim();
    if (code) exempt.add(code);
  }
  return exempt;
}

/**
 * A row is only moved when it is a store, on a split line, has a city, and feeds the closing.
 *
 * `period` decides WHICH warehouse rule answers "is it a store" — the owner's 2026-09-06 rulings,
 * or the six words alone before the cutover (customer-channel.ts, warehouseRuleFromPeriod). It is
 * optional so the pure-arithmetic tests can keep calling this with a row alone, and OMITTING IT
 * MEANS THE OLD RULE: the safe direction, since a month that fails to adopt the new classification
 * keeps the numbers it was published with, while one that adopts it early restates a closing already
 * sent to managers.
 *
 * The cutover is PER LINE, and the row's own `officialLine` is what selects it — August Pedia takes
 * the new rulings while August Anti Infective, published and announced, keeps the old ones. The line
 * is read from the row rather than passed in, so the two can never disagree about which month this
 * row belongs to.
 */
export function isSplitEligible(
  row: StoreSplitRow,
  period?: string | null,
  thresholdQty?: number,
  regions?: SplitRegions,
): boolean {
  if (row.isDirect) return false;
  if (!row.includedInClosing) return false;
  if (!isSplitEligibleLine(row.officialLine)) return false;
  // The client code is passed so an owner override can be honoured. Without it the override is
  // inert here and an overridden pharmacy's sales would still be scattered across its city.
  if (
    !isStoreCustomerForPeriod(row.clientName, row.clientCode, row.distributorCode, period, row.officialLine)
  ) {
    return false;
  }
  // The CLOSING area, not the resolved one: the split moves money the Closing Matrix actually holds,
  // and the Matrix books by the fact area. Taking a re-booked row's city from its brick would
  // subtract the money from an area that never carried it — the phantom the 441164 case produced.
  // Identical to `areaCode` on every row in production except a hand-apportioned one.
  const targets = splitTargetsFor(row, thresholdQty, regions);
  if (!targets) return false;
  // One target splits to itself — nothing moves, so skip the work entirely.
  return targets.areas.length > 1;
}

// Kept per PRODUCT as well as per area and line: the Closing Matrix is an area x product grid, so
// adjusting it needs the movement at that grain. The Store Split sheet aggregates back up to
// area+line for readability.
export type StoreSplitAreaMovement = {
  areaCode: string;
  city: string;
  line: string;
  productCode: string;
  /** Store sales that originated in this area and were moved away. */
  outQty: number;
  outValue: number;
  /** This area's share of its city's store pool. */
  inQty: number;
  inValue: number;
};

export type StoreSplitResult<T> = {
  /** Rows to feed the matrix: eligible store rows replaced by their per-area shares. */
  rows: T[];
  /** Per area and line, what left and what arrived — this is the "store split" column. */
  movements: StoreSplitAreaMovement[];
  /** How many source rows were redistributed. */
  splitRowCount: number;
  /**
   * Per (brick, area) — key `${brickId}|${closingArea}`, both uppercase — the store money belonging
   * to a customer that WAS eligible to split there but was exempted as hand-apportioned.
   *
   * Exists for the Channel Breakdown's brick grid, which takes a brick's store money off whenever
   * the brick's area gave money up. That grid reads its own figures rather than these rows (see
   * store-split-channel-breakdown.ts for why), so without this it cannot tell that part of a
   * brick's store money never moved, and would debit a brick for a customer the Matrix left alone.
   *
   * KEYED BY AREA AS WELL AS BRICK, not by brick alone. The grid's own brick_area figures are grained
   * that way (one row per brick PER area), and an exempt customer can have more than one ELIGIBLE
   * leg on the same brick in DIFFERENT areas. Summing those legs into one per-brick total and
   * subtracting it from whichever single area's grid figure happens to exist would cancel a debit
   * that has nothing to do with that other leg — under-crediting an unrelated eligible seller who
   * happens to share the brick. Per-(brick, area) is the smallest key that cannot do that.
   */
  exemptStoreValueByBrick: Map<string, number>;
};

/**
 * Divide a fixed total into `parts` shares that sum back to EXACTLY the total.
 * Plain `value / parts` repeated `parts` times does not: 100/3 summed three times is 100.00000000000001.
 * The last share absorbs the remainder, so the matrix cannot drift by a piastre.
 */
export function evenShares(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  if (parts === 1) return [total];
  const share = total / parts;
  const shares: number[] = [];
  let assigned = 0;
  for (let index = 0; index < parts - 1; index += 1) {
    shares.push(share);
    assigned += share;
  }
  shares.push(total - assigned);
  return shares;
}

/**
 * Replace each eligible store row with one row per area of its city, each carrying an equal share
 * of the qty and value. Every other row passes through byte-for-byte. The returned rows always sum
 * to the same qty and value as the input — that is the invariant the whole change rests on.
 *
 * Generic over the row type so the caller keeps its own richer row shape (ClosingDetailRow) rather
 * than being narrowed to StoreSplitRow.
 *
 * `period` selects which warehouse rule decides who is a store — see isSplitEligible. Omitting it
 * means the pre-2026-09 rule.
 */
export function splitStoreSalesAcrossCityAreas<T extends StoreSplitRow>(
  rows: readonly T[],
  period?: string | null,
  regions?: SplitRegions,
): StoreSplitResult<T> {
  const out: T[] = [];

  // A customer already distributed across areas by hand is never redistributed by the city rule.
  // The one exemption left: a customer the database has already distributed. See
  // customersExemptFromCitySplit for why it is the only one.
  const exemptCustomers = customersExemptFromCitySplit(rows);
  const movements = new Map<string, StoreSplitAreaMovement>();
  const exemptStoreValueByBrick = new Map<string, number>();
  let splitRowCount = 0;

  const movementFor = (
    areaCode: string,
    city: string,
    line: string,
    productCode: string,
  ): StoreSplitAreaMovement => {
    // "|" is a safe separator: area codes and product codes are alphanumeric and line names are
    // plain words, so no two different triples can collide on one key.
    const key = `${areaCode}|${line}|${productCode}`;
    const found = movements.get(key);
    if (found) return found;
    const created: StoreSplitAreaMovement = {
      areaCode, city, line, productCode, inQty: 0, inValue: 0, outQty: 0, outValue: 0,
    };
    movements.set(key, created);
    return created;
  };

  // The 200-pack threshold is a property of the warehouse month, not of whichever row is in
  // hand, so it is summed ONCE here and every row of that key is judged on the same number.
  const thresholdByKey = warehouseSplitQtyByKey(rows);

  // Every share El Qema's rule landed, kept for the lead guarantee below. Collected here rather
  // than re-derived from `out` afterwards because an El Qema row that did NOT split is in `out`
  // too and must not be rescaled — nothing in the row itself tells the two apart.
  const qemaLanded: QemaLandedShare<T>[] = [];

  for (const row of rows) {
    const rowThreshold = thresholdByKey.get(warehouseSplitKey(row));
    const eligible = isSplitEligible(row, period, rowThreshold, regions);
    if (!eligible || exemptCustomers.has(String(row.clientCode ?? "").trim())) {
      // An exempt row that WOULD otherwise have split is store money sitting on a brick that the
      // matrix never moved. The brick grid has to know, or it debits the brick anyway. Keyed by
      // area too — see the field doc on exemptStoreValueByBrick for why brick alone is not enough.
      if (eligible) {
        const brick = normalizeArea(row.brickId);
        const area = closingAreaOf(row);
        if (brick && area) {
          const key = `${brick}|${area}`;
          exemptStoreValueByBrick.set(
            key,
            (exemptStoreValueByBrick.get(key) ?? 0) + (Number(row.salesValue) || 0),
          );
        }
      }
      out.push(row);
      continue;
    }
    // The area the CLOSING books this row in — see isSplitEligible, which picked the city the same
    // way. Money must leave the area that actually holds it.
    const origin = closingAreaOf(row);
    const targets = splitTargetsFor(row, rowThreshold, regions);
    // isSplitEligible already proved this; the guard keeps the types honest.
    if (!targets) {
      out.push(row);
      continue;
    }
    const city = targets.group;
    const areas = targets.areas;

    splitRowCount += 1;
    const line = String(row.officialLine ?? "").trim();
    const productCode = String(row.productCode ?? "").trim().toUpperCase();
    // planShares, not evenShares: above the threshold the governorate block and the national
    // block carry different weights, and an even division would quietly pay them the same.
    const plannedValue = planShares(targets, Number(row.salesValue) || 0);
    const plannedQty = planShares(targets, Number(row.qty) || 0);

    // No pass of any kind here. El Qema's bands AND its Upper Egypt redistribution are both decided
    // by splitTargetsFor, so this loop only spends the plan. A second pass over `rows` here would be
    // invisible to isSplitEligible, the Detail sheet and the import preview, which read the plan.
    const levelled = { areas, qtyShares: plannedQty, valueShares: plannedValue };

    const originMovement = movementFor(origin, city, line, productCode);
    originMovement.outQty += Number(row.qty) || 0;
    originMovement.outValue += Number(row.salesValue) || 0;

    const isQemaRule = WAREHOUSE_THRESHOLD_DISTRIBUTORS.has(normalizeDistributor(row.distributorCode))
      && WAREHOUSE_THRESHOLD_LINES.has(lineKey(row.officialLine));

    const { areas: landing, qtyShares, valueShares } = levelled;
    landing.forEach((areaCode, index) => {
      const received = movementFor(areaCode, city, line, productCode);
      received.inQty += qtyShares[index];
      received.inValue += valueShares[index];
      // BOTH area fields move to the share's area. A share is a synthetic row that now genuinely
      // belongs to `areaCode`, so leaving `sheetAreaCode` on the origin would make closingAreaOf
      // report every share as still sitting in the area it came from.
      const landed = {
        ...row,
        areaCode,
        qty: qtyShares[index],
        salesValue: valueShares[index],
        sheetAreaCode: areaCode,
      };
      out.push(landed);
      if (isQemaRule) qemaLanded.push({ row: landed, area: areaCode, city, line, product: productCode });
    });
  }

  applyQemaLeadGuarantee(qemaLanded, movementFor, (created) => out.push(created), regions);

  return {
    exemptStoreValueByBrick,
    rows: out,
    movements: [...movements.values()].sort(
      (left, right) => left.city.localeCompare(right.city)
        || left.line.localeCompare(right.line)
        || left.areaCode.localeCompare(right.areaCode),
    ),
    splitRowCount,
  };
}

/**
 * 🔒 Rank Qalubeya first, Tanta and Mahalla level behind it, all three above the field.
 *
 * Runs per line and per product over the shares El Qema's rule already landed, and moves money
 * between areas without changing what any line or product totals. The rows and the movements are
 * adjusted from ONE target map, so the Matrix and the attribution net cannot disagree.
 *
 * 🔴 A LEAD AREA THAT LANDED NOTHING STILL HAS TO END ON TOP, so this creates a share for it by
 * cloning the largest row of that line and product. That row carries a customer identity, which is
 * why it is only ever done for El Qema — whose identity is blanked in every closing detail anyway
 * (`closing-source-mask.ts`). Any other distributor reaching this code would put a real customer's
 * name on a sale it never made.
 *
 * ⚠ An area the organogram parks in Others is dropped from the guarantee rather than lifted.
 * Others take nothing is his rule too, and it is the older of the two.
 */
type QemaLandedShare<T> = {
  row: T;
  area: string;
  city: string;
  line: string;
  product: string;
};

function applyQemaLeadGuarantee<T extends StoreSplitRow>(
  landed: readonly QemaLandedShare<T>[],
  movementFor: (areaCode: string, city: string, line: string, productCode: string) => StoreSplitAreaMovement,
  pushRow: (row: T) => void,
  regions: SplitRegions | undefined,
): void {
  if (landed.length === 0) return;

  const groups = new Map<string, QemaLandedShare<T>[]>();
  for (const entry of landed) {
    const key = `${entry.line}|${entry.product}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  for (const group of groups.values()) {
    const line = lineKey(group[0].line);
    const excluded = OTHERS_EXCLUDED_LINES.has(line) ? (regions?.others ?? NO_AREAS) : NO_AREAS;
    const ladder = QEMA_LEAD_TIERS
      .map((tier) => tier.filter((area) => !excluded.has(area)))
      .filter((tier) => tier.length > 0);
    if (ladder.length === 0) continue;

    const rowsByArea = new Map<string, QemaLandedShare<T>[]>();
    const qtyByArea = new Map<string, number>();
    const valueByArea = new Map<string, number>();
    for (const entry of group) {
      const bucket = rowsByArea.get(entry.area);
      if (bucket) bucket.push(entry);
      else rowsByArea.set(entry.area, [entry]);
      qtyByArea.set(entry.area, (qtyByArea.get(entry.area) ?? 0) + (Number(entry.row.qty) || 0));
      valueByArea.set(entry.area, (valueByArea.get(entry.area) ?? 0) + (Number(entry.row.salesValue) || 0));
    }

    // Units and money are targeted separately. They move together on every El Qema row today
    // because one product carries one price, and they would not on a product priced two ways —
    // deriving money from the unit ratio would then quietly reprice it.
    const qtyTargets = qemaLeadTargets(qtyByArea, ladder);
    const valueTargets = qemaLeadTargets(valueByArea, ladder);
    if (!qtyTargets && !valueTargets) continue;

    // The biggest row of the group is the template for a lead area that landed nothing.
    const template = group.reduce(
      (biggest, entry) => ((Number(entry.row.qty) || 0) > (Number(biggest.row.qty) || 0) ? entry : biggest),
      group[0],
    );

    const areas = new Set<string>([
      ...rowsByArea.keys(),
      ...(qtyTargets?.keys() ?? []),
      ...(valueTargets?.keys() ?? []),
    ]);
    for (const area of areas) {
      const beforeQty = qtyByArea.get(area) ?? 0;
      const beforeValue = valueByArea.get(area) ?? 0;
      const afterQty = qtyTargets?.get(area) ?? beforeQty;
      const afterValue = valueTargets?.get(area) ?? beforeValue;
      if (afterQty === beforeQty && afterValue === beforeValue) continue;

      let bucket = rowsByArea.get(area);
      if (!bucket) {
        // Nothing landed here, so there is no row to scale. Clone the template into this area, at
        // zero, and let the loop below fill it — one code path for both cases.
        const created: QemaLandedShare<T> = {
          ...template,
          area,
          row: { ...template.row, areaCode: area, qty: 0, salesValue: 0, sheetAreaCode: area },
        };
        pushRow(created.row);
        bucket = [created];
        rowsByArea.set(area, bucket);
      }

      // Scaled by ratio where there is something to scale, and put wholly on the last row where
      // there is not. The last row absorbs the remainder either way, so the area lands EXACTLY on
      // its target rather than on the sum of several roundings.
      let placedQty = 0;
      let placedValue = 0;
      bucket.forEach((entry, index) => {
        const last = index === bucket.length - 1;
        const qty = last
          ? afterQty - placedQty
          : (beforeQty > 0 ? ((Number(entry.row.qty) || 0) * afterQty) / beforeQty : afterQty / bucket.length);
        const value = last
          ? afterValue - placedValue
          : (beforeValue > 0
            ? ((Number(entry.row.salesValue) || 0) * afterValue) / beforeValue
            : afterValue / bucket.length);
        placedQty += qty;
        placedValue += value;
        entry.row.qty = qty;
        entry.row.salesValue = value;
      });

      // The movement is adjusted by the DELTA, never overwritten: an area+line+product cell can
      // hold another distributor's split as well, and this rule is El Qema's alone.
      const movement = movementFor(area, bucket[0].city, bucket[0].line, bucket[0].product);
      movement.inQty += afterQty - beforeQty;
      movement.inValue += afterValue - beforeValue;
    }
  }
}

/** Net effect on an area+line: positive means the area gains from the split. */
export function netStoreSplit(movement: StoreSplitAreaMovement): { qty: number; value: number } {
  return {
    qty: movement.inQty - movement.outQty,
    value: movement.inValue - movement.outValue,
  };
}

/** Key for the per-cell net map. Area and product are both alphanumeric, so "|" cannot collide. */
export function areaProductKey(areaCode: string, productCode: string): string {
  return `${normalizeArea(areaCode)}|${String(productCode ?? "").trim().toUpperCase()}`;
}

/**
 * Net movement per area AND product — the grain the Closing Matrix needs, since it is an
 * area x product grid. Positive means that cell gains.
 *
 * Summed across every area, the net for any one product is ZERO: a store's sale leaves its origin
 * area and is distributed, in full and for the same product, among the areas of the same city.
 * That is why applying this to the matrix cannot move the grand total.
 */
export function netStoreSplitByAreaProduct(
  movements: readonly StoreSplitAreaMovement[],
): Map<string, { qty: number; value: number }> {
  const net = new Map<string, { qty: number; value: number }>();
  for (const movement of movements) {
    const key = areaProductKey(movement.areaCode, movement.productCode);
    const entry = net.get(key) ?? { qty: 0, value: 0 };
    entry.qty += movement.inQty - movement.outQty;
    entry.value += movement.inValue - movement.outValue;
    net.set(key, entry);
  }
  return net;
}

/** One display row of the Store Split sheet — the owner's "separate column", per area and line. */
export type StoreSplitAreaSummary = {
  areaCode: string;
  areaName: string;
  city: string;
  line: string;
  /** The area's closing sales as they stand today, before anything moves. */
  beforeQty: number;
  beforeValue: number;
  /** Store sales that physically happened here and were shared out to the city. */
  movedOutQty: number;
  movedOutValue: number;
  /** This area's equal share of its city's store pool. */
  receivedQty: number;
  receivedValue: number;
  /** received − movedOut. Positive means this area gains. */
  netQty: number;
  netValue: number;
  /** before + net. What the area would carry once the split is applied. */
  afterQty: number;
  afterValue: number;
};

/**
 * Per area and line: what the area books today, what the store split moves, and what it would
 * book after. Built from the SAME rows the workbook's Data sheet shows, so the two can never
 * disagree. Areas untouched by any store are omitted — there is nothing to say about them.
 */
export function summariseStoreSplitByArea<T extends StoreSplitRow & { areaName?: string }>(
  rows: readonly T[],
  period?: string | null,
  regions?: SplitRegions,
  // When supplied, the split is NOT recomputed from `rows` — these movements are folded instead. A
  // PUBLISHED month passes its FROZEN movements here (loadClosingStoreSplit) so the sheet's net ties
  // to the frozen Closing Matrix rather than to a live recompute that drifted after publish. `before`
  // still comes from `rows` (the area's raw closing position), so `before + net = after` reconciles.
  movementsOverride?: readonly StoreSplitAreaMovement[],
): StoreSplitAreaSummary[] {
  const movements = movementsOverride ?? splitStoreSalesAcrossCityAreas(rows, period, regions).movements;
  if (movements.length === 0) return [];

  // The area's current closing position, from the untouched rows.
  const before = new Map<string, { qty: number; value: number }>();
  const areaNames = new Map<string, string>();
  for (const row of rows) {
    if (row.isDirect || !row.includedInClosing) continue;
    // The area's CLOSING position, so "before" is the number the Closing Matrix shows for that area
    // and `before + net = after` reconciles against the sheet rather than against the brick map.
    const area = closingAreaOf(row);
    const key = `${area} ${String(row.officialLine ?? "").trim()}`;
    const entry = before.get(key) ?? { qty: 0, value: 0 };
    entry.qty += Number(row.qty) || 0;
    entry.value += Number(row.salesValue) || 0;
    before.set(key, entry);
    // Names stay keyed on the RESOLVED area: `areaName` is the brick's area name, so filing it
    // under a re-booked row's closing area would label that area with another area's name.
    const name = typeof row.areaName === "string" ? row.areaName.trim() : "";
    const named = normalizeArea(row.areaCode);
    if (name && named && !areaNames.has(named)) areaNames.set(named, name);
  }

  // Movements are per product; the sheet reads per area and line, so fold the products together.
  const byAreaLine = new Map<string, StoreSplitAreaMovement>();
  for (const movement of movements) {
    const area = normalizeArea(movement.areaCode);
    const key = `${area}|${movement.line}`;
    const found = byAreaLine.get(key);
    if (!found) {
      byAreaLine.set(key, { ...movement, areaCode: area, productCode: "" });
      continue;
    }
    found.inQty += movement.inQty;
    found.inValue += movement.inValue;
    found.outQty += movement.outQty;
    found.outValue += movement.outValue;
  }

  const round = (value: number) => Number(value.toFixed(2));
  return [...byAreaLine.values()].map((movement) => {
    const area = movement.areaCode;
    const base = before.get(`${area} ${movement.line}`) ?? { qty: 0, value: 0 };
    const net = netStoreSplit(movement);
    return {
      areaCode: area,
      areaName: areaNames.get(area) ?? area,
      city: movement.city,
      line: movement.line,
      beforeQty: round(base.qty),
      beforeValue: round(base.value),
      movedOutQty: round(movement.outQty),
      movedOutValue: round(movement.outValue),
      receivedQty: round(movement.inQty),
      receivedValue: round(movement.inValue),
      netQty: round(net.qty),
      netValue: round(net.value),
      afterQty: round(base.qty + net.qty),
      afterValue: round(base.value + net.value),
    };
  });
}

// ── The detailed report: WHICH store, WHICH product, and where each share went ───────────────
//
// `summariseStoreSplitByArea` above answers "what did this area gain or lose". It cannot answer
// the question the owner actually asks of a moved number — "which shop caused this, on what
// product, and who received it" — because by then every store of a city has been folded together.
// This section keeps the store's own identity all the way through (owner request, 2026-08-05).

/** One store's sales of one product, and the shares the city's areas each received. */
export type StoreSplitDetailRow = {
  clientCode: string;
  clientName: string;
  /** The area the store physically sits in — where the sale was booked before the split. */
  originAreaCode: string;
  originAreaName: string;
  city: string;
  line: string;
  productCode: string;
  productName: string;
  /** Exactly as imported, before anything moved. */
  units: number;
  value: number;
  /** Every area this was divided across, in a stable order — governorate first, then national. */
  sharedWithAreaCodes: readonly string[];
  /** The origin governorate own areas — the half that always stays local. */
  homeAreaCodes: readonly string[];
  /** Areas outside the governorate taking the national half. EMPTY below the 200-pack rule. */
  awayAreaCodes: readonly string[];
  /**
   * units / value each area of the ORIGIN GOVERNORATE received. Below the threshold that is
   * every area on the row; above it, the governorate block splits half the sale between them.
   */
  shareUnits: number;
  shareValue: number;
  /** units / value ONE area outside the governorate received. 0 when the sale never left it. */
  awayShareUnits: number;
  awayShareValue: number;
  /** What the origin area keeps of its own sale — its single share, not the whole. */
  originKeepsValue: number;
};

/** One store, all its products folded together — the "which stores are split" headline. */
export type StoreSplitCustomerSummary = {
  clientCode: string;
  clientName: string;
  originAreaCode: string;
  originAreaName: string;
  city: string;
  line: string;
  products: number;
  units: number;
  value: number;
  areasSharedWith: number;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Every store sale the split moved, at store × product grain, with the share each area received.
 *
 * Built from the SAME eligibility rule the split itself uses (`isSplitEligible`), so a row appears
 * here if and only if it actually moved — the report can never claim a split that did not happen,
 * nor miss one that did.
 */
export function detailStoreSplitByCustomer<
  T extends StoreSplitRow & { areaName?: string; clientCode?: string; productName?: string },
>(
  rows: readonly T[],
  period?: string | null,
  regions?: SplitRegions,
): StoreSplitDetailRow[] {
  const areaNames = new Map<string, string>();
  for (const row of rows) {
    const area = normalizeArea(row.areaCode);
    const name = typeof row.areaName === "string" ? row.areaName.trim() : "";
    if (area && name && !areaNames.has(area)) areaNames.set(area, name);
  }

  // Same exemption as the split itself, or the detail sheet would report a store as "split" that
  // the matrix left alone — the two tabs must describe the same operation.
  const detailExempt = customersExemptFromCitySplit(rows);

  // The SAME aggregate the split judges the threshold on. Deriving it separately here is how the
  // Matrix and this sheet would come to disagree about which customers crossed 200.
  const detailThresholdByKey = warehouseSplitQtyByKey(rows);

  const byKey = new Map<string, StoreSplitDetailRow>();
  // The PLAN each entry's numbers come from. Kept beside the entries rather than on them:
  // StoreSplitDetailRow is exported and rendered, and nothing downstream needs the plan itself.
  //
  // 🔴 THIS SHEET USED TO RE-DERIVE THE BAND from a quantity, which is how it and the Matrix could
  // come to describe the same customer differently — and with El Qema's Upper Egypt redistribution
  // it no longer could, because that pass is a weight on the plan and no quantity implies it.
  // Reading the plan is what keeps the two tabs describing one operation.
  const planByKey = new Map<string, SplitPlan>();
  for (const row of rows) {
    const rowThreshold = detailThresholdByKey.get(warehouseSplitKey(row));
    if (
      !isSplitEligible(row, period, rowThreshold, regions)
      || detailExempt.has(String(row.clientCode ?? "").trim())
    ) continue;
    // The same origin the split itself uses, or this sheet would name a different area as the giver.
    const origin = closingAreaOf(row);
    const targets = splitTargetsFor(row, rowThreshold, regions);
    if (!targets) continue;
    const city = targets.group;
    const areas = targets.areas;

    const productCode = String(row.productCode ?? "").trim().toUpperCase();
    const clientCode = String(row.clientCode ?? "").trim();
    const clientName = String(row.clientName ?? "").trim();
    // Keyed on the customer AND the origin area: the same chain trading in two areas is two
    // different splits, and folding them together would misreport where the money came from.
    const key = `${clientCode || clientName}|${origin}|${row.officialLine}|${productCode}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.units += Number(row.qty) || 0;
      existing.value += Number(row.salesValue) || 0;
      continue;
    }
    planByKey.set(key, targets);
    byKey.set(key, {
      awayAreaCodes: targets.awayAreas,
      awayShareUnits: 0,
      awayShareValue: 0,
      city,
      homeAreaCodes: targets.homeAreas,
      clientCode: clientCode || "—",
      clientName: clientName || "(no customer name)",
      line: String(row.officialLine ?? "").trim(),
      originAreaCode: origin,
      originAreaName: areaNames.get(origin) ?? origin,
      originKeepsValue: 0,
      productCode,
      productName: String(row.productName ?? "").trim() || productCode,
      shareUnits: 0,
      shareValue: 0,
      sharedWithAreaCodes: areas,
      units: Number(row.qty) || 0,
      value: Number(row.salesValue) || 0,
    });
  }

  // Shares are derived AFTER the products of a store are summed, so they describe the sale as the
  // split actually divides it rather than per invoice line.
  return [...byKey.entries()]
    .map(([key, entry]) => {
      const homeParts = entry.homeAreaCodes.length;
      const awayParts = entry.awayAreaCodes.length;
      // Straight from the plan the split itself used — never a second derivation from a quantity.
      // The plan was built on the warehouse-and-product aggregate, so a customer trading in two
      // areas is banded on its month total here exactly as the Matrix banded it.
      const plan = planByKey.get(key);
      const fractions = plan ? planShares(plan, 1) : [];
      const homeSet = new Set(entry.homeAreaCodes);
      let homeFraction = 0;
      let originFraction = 0;
      plan?.areas.forEach((area, index) => {
        const fraction = fractions[index] ?? 0;
        if (homeSet.has(area)) homeFraction += fraction;
        if (area === entry.originAreaCode) originFraction += fraction;
      });
      const homeValue = entry.value * homeFraction;
      const homeUnits = entry.units * homeFraction;
      const awayValue = entry.value - homeValue;
      const awayUnits = entry.units - homeUnits;
      const homeShareValue = homeParts > 0 ? homeValue / homeParts : 0;
      const homeShareUnits = homeParts > 0 ? homeUnits / homeParts : 0;
      return {
        ...entry,
        awayShareUnits: awayParts > 0 ? Number((awayUnits / awayParts).toFixed(3)) : 0,
        awayShareValue: awayParts > 0 ? round2(awayValue / awayParts) : 0,
        // The origin's OWN weight, not the home block's average. They are the same number in every
        // band, and differ once the Upper Egypt redistribution has touched the row.
        originKeepsValue: round2(entry.value * originFraction),
        shareUnits: Number(homeShareUnits.toFixed(3)),
        shareValue: round2(homeShareValue),
        units: round2(entry.units),
        value: round2(entry.value),
      };
    })
    .sort(
      (left, right) => right.value - left.value
        || left.clientName.localeCompare(right.clientName)
        || left.productName.localeCompare(right.productName),
    );
}

/** The same movement folded to one row per store — which stores are split, and by how much. */
export function summariseStoreSplitByCustomer<
  T extends StoreSplitRow & { areaName?: string; clientCode?: string; productName?: string },
>(
  rows: readonly T[],
  period?: string | null,
  regions?: SplitRegions,
): StoreSplitCustomerSummary[] {
  const byStore = new Map<string, StoreSplitCustomerSummary & { productCodes: Set<string> }>();
  for (const detail of detailStoreSplitByCustomer(rows, period, regions)) {
    const key = `${detail.clientCode}|${detail.clientName}|${detail.originAreaCode}|${detail.line}`;
    const existing = byStore.get(key);
    if (existing) {
      existing.units = round2(existing.units + detail.units);
      existing.value = round2(existing.value + detail.value);
      existing.productCodes.add(detail.productCode);
      existing.products = existing.productCodes.size;
      continue;
    }
    byStore.set(key, {
      areasSharedWith: detail.sharedWithAreaCodes.length,
      city: detail.city,
      clientCode: detail.clientCode,
      clientName: detail.clientName,
      line: detail.line,
      originAreaCode: detail.originAreaCode,
      originAreaName: detail.originAreaName,
      productCodes: new Set([detail.productCode]),
      products: 1,
      units: detail.units,
      value: detail.value,
    });
  }
  return [...byStore.values()]
    .map(({ productCodes: _productCodes, ...summary }) => summary)
    .sort((left, right) => right.value - left.value || left.clientName.localeCompare(right.clientName));
}
