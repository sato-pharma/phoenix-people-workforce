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
 * The FIRST period the split applies to. Owner ruling 2026-09-04, immediately after the flag was
 * turned on and the retroactive restatement was measured for him: "DONT TOUCH JULY APPLY ON AUGUST
 * AND UPCOMING".
 *
 * WHY THIS EXISTS AT ALL. The closing matrix re-derives every month live, so a bare boolean is
 * retroactive to the first period on record — turning the split on moved 296,444.88 EGP across 34
 * areas in his PUBLISHED July CNS closing, 96,561.67 in July Anti Infective and 27,016.88 in July
 * Pedia, and the publication drift check cannot see any of it (it compares UNITS only, and the
 * split preserves each line's unit total while moving units between areas). July is published and
 * its numbers are the managers' copy; August is the month being reconciled when the rule was
 * turned on. So the rule starts at August.
 *
 * A plain string compare is correct and deliberate: periods are `YYYY-MM`, which sorts
 * lexicographically in calendar order. Anything malformed or absent falls to NOT active — the safe
 * direction, since failing to split leaves a number where it already was, while splitting a month
 * that should not be split silently moves money between reps.
 */
export const STORE_CITY_SPLIT_FROM_PERIOD = "2026-08";

/**
 * Is the wholesaler city split applied to this period? BOTH gates: the master flag and the start
 * period. Every apply point asks this, never the bare flag — a caller that reads
 * STORE_CITY_SPLIT_ENABLED alone would split July.
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
// ONE-WAY, DISTRIBUTOR-SPECIFIC TARGETS — owner, 2026-09-07.
//
// "سوف يتم تقسيم بيع القليوبية على مندوب القليوبية بالإضافة إلى كل مندوبين القاهرة بالتساوى"
// — El Qema's Qalubeya sales spread across Qalubeya AND all six Cairo areas, evenly.
//
// Asked whether it runs both ways and whether it applies to every distributor, he answered
// "one way only, only for el qema". Both halves of that answer are load-bearing:
//
//   ONE WAY. A warehouse IN Qalubeya reaches Cairo. A warehouse in Cairo does NOT reach Qalubeya —
//   there is no `QM|CA*` key, so a Cairo row falls through to the ordinary six-area Cairo city. This
//   is why the rule cannot live in AREA_CITY: city membership is symmetric by construction, and
//   moving D11 into "Cairo" would silently start paying Qalubeya a share of every Cairo wholesaler.
//
//   EL QEMA ONLY. Keyed by distributor, so Overseas or Ibn Sina selling to the same Qalubeya
//   warehouse still splits it the ordinary way — which for a one-area governorate means not at all.
//
// The ORIGIN AREA IS IN ITS OWN TARGET LIST. Qalubeya keeps a seventh, it does not give everything
// away; every other split in this file behaves the same way, and leaving it out would quietly move
// 100% of the money out of the area that made the sale.
//
// WHY A CODE CONSTANT AND NOT A TABLE. This is geography, and geography lives here beside AREA_CITY
// — the same "SINGLE edit point" rule applies. A per-customer registry was considered and rejected
// by the owner the same day: the city rule always wins, except EZ and Office.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type DistributorSplitTarget = {
  /** Shown as the "city" on the Store Split sheet, so the movement says which rule moved it. */
  readonly group: string;
  readonly areas: readonly string[];
};

/** Key is `DISTRIBUTOR|ORIGIN AREA`, both uppercase. */
export const DISTRIBUTOR_SPLIT_TARGETS: ReadonlyMap<string, DistributorSplitTarget> = new Map([
  ["QM|D11", {
    group: "Qalubeya + Cairo (El Qema)",
    areas: ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"],
  }],
]);

function normalizeDistributor(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * The areas this row's money divides across, and the label for the movement.
 *
 * A distributor override wins; everything else falls through to the row's own city. Returns null
 * when there is nothing to divide across — an area outside AREA_CITY, or a city that does not exist
 * — which every caller treats as "leave this row exactly where it is".
 *
 * Deliberately ONE function rather than the three copies that grew here: `isSplitEligible`, the
 * split itself and the detail sheet each derived the area set independently, so an override added to
 * one of them would have produced a workbook whose Matrix and Detail sheet disagreed about the same
 * customer.
 */
export function splitTargetsFor(row: StoreSplitRow): DistributorSplitTarget | null {
  const origin = closingAreaOf(row);
  if (!origin) return null;
  const distributor = normalizeDistributor(row.distributorCode);
  if (distributor) {
    const override = DISTRIBUTOR_SPLIT_TARGETS.get(`${distributor}|${origin}`);
    if (override) return override;
  }
  const city = cityOfArea(origin);
  if (!city) return null;
  const areas = CITY_AREAS.get(city);
  if (!areas || areas.length === 0) return null;
  return { group: city, areas };
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
export function isSplitEligible(row: StoreSplitRow, period?: string | null): boolean {
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
  const targets = splitTargetsFor(row);
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

  for (const row of rows) {
    const eligible = isSplitEligible(row, period);
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
    const targets = splitTargetsFor(row);
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
    const valueShares = evenShares(Number(row.salesValue) || 0, areas.length);
    const qtyShares = evenShares(Number(row.qty) || 0, areas.length);

    const originMovement = movementFor(origin, city, line, productCode);
    originMovement.outQty += Number(row.qty) || 0;
    originMovement.outValue += Number(row.salesValue) || 0;

    areas.forEach((areaCode, index) => {
      const received = movementFor(areaCode, city, line, productCode);
      received.inQty += qtyShares[index];
      received.inValue += valueShares[index];
      // BOTH area fields move to the share's area. A share is a synthetic row that now genuinely
      // belongs to `areaCode`, so leaving `sheetAreaCode` on the origin would make closingAreaOf
      // report every share as still sitting in the area it came from.
      out.push({
        ...row,
        areaCode,
        qty: qtyShares[index],
        salesValue: valueShares[index],
        sheetAreaCode: areaCode,
      });
    });
  }

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
): StoreSplitAreaSummary[] {
  const { movements } = splitStoreSalesAcrossCityAreas(rows, period);
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
  /** The areas of the city this was divided across, in a stable order. */
  sharedWithAreaCodes: readonly string[];
  /** units / value each area received. The last share absorbs the rounding remainder. */
  shareUnits: number;
  shareValue: number;
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
>(rows: readonly T[], period?: string | null): StoreSplitDetailRow[] {
  const areaNames = new Map<string, string>();
  for (const row of rows) {
    const area = normalizeArea(row.areaCode);
    const name = typeof row.areaName === "string" ? row.areaName.trim() : "";
    if (area && name && !areaNames.has(area)) areaNames.set(area, name);
  }

  // Same exemption as the split itself, or the detail sheet would report a store as "split" that
  // the matrix left alone — the two tabs must describe the same operation.
  const detailExempt = customersExemptFromCitySplit(rows);

  const byKey = new Map<string, StoreSplitDetailRow>();
  for (const row of rows) {
    if (!isSplitEligible(row, period) || detailExempt.has(String(row.clientCode ?? "").trim())) continue;
    // The same origin the split itself uses, or this sheet would name a different area as the giver.
    const origin = closingAreaOf(row);
    const targets = splitTargetsFor(row);
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
    byKey.set(key, {
      city,
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
  return [...byKey.values()]
    .map((entry) => {
      const parts = entry.sharedWithAreaCodes.length;
      const share = parts > 0 ? entry.value / parts : 0;
      return {
        ...entry,
        originKeepsValue: round2(share),
        shareUnits: parts > 0 ? Number((entry.units / parts).toFixed(3)) : 0,
        shareValue: round2(share),
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
>(rows: readonly T[], period?: string | null): StoreSplitCustomerSummary[] {
  const byStore = new Map<string, StoreSplitCustomerSummary & { productCodes: Set<string> }>();
  for (const detail of detailStoreSplitByCustomer(rows, period)) {
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
