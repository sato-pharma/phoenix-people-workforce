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

import { closingAreaOf, isRebookedRow } from "@/lib/sales/closing-row-area";
import { isStoreCustomer } from "@/lib/sales/customer-channel";

/**
 * OWNER RULING 2026-08-10, RE-APPLIED 2026-08-12: the wholesaler city split is OFF. A wholesaler's
 * sales stay in the area it physically sits in.
 *
 * Measured on July 2026 CNS against his own manual closing, the split was the single largest
 * disagreement between Phoenix and his sheet, and his closing has never applied it. The first
 * disable (cc6edee4) was LOST in the #2015 squash merge, so production kept splitting — which is
 * why the downloaded closing kept diverging from his approved numbers after every data fix.
 *
 * Deliberately a flag at the APPLY points rather than emptying SPLIT_LINE_KEYS or gating
 * isSplitEligible: the pure functions must keep telling the truth (CNS IS a rep line, the split
 * arithmetic IS as tested) so the ~35 assertions covering the geography and the even-share maths
 * stay honest and covered for the day this is switched back on. The maths still runs in tests;
 * it simply is not applied at runtime.
 */
export const STORE_CITY_SPLIT_ENABLED = false;

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
   * customersAlreadySplitAcrossAreas for why the resolved area cannot answer that question.
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
  officialLine: string;
  productCode: string;
  qty: number;
  salesValue: number;
};

/**
 * Customers whose rows ALREADY sit in more than one area — someone distributed them on purpose, so
 * the city split must not distribute them again.
 *
 * The case that forced this (owner, 2026-08-06): client 441164 ريونيون للتجارة والاستثمار returned
 * its whole June purchase in July, -400 units / -34,380.00, and the owner ruled that return splits
 * evenly between Dakahlia 2 and Port Said - Domiat. Its sales rows were split accordingly. But the
 * name marks it a wholesaler, so the city split then took the WHOLE -34,380.00 back out of its
 * customer-map area (Dakahlia 1) and shared it three ways across Dakahlia 1, 2 and 3 — handing a
 * third of a return to Dakahlia 3, which had nothing to do with it, and dropping Port Said entirely
 * because it is a different city. The workbook's Closing Matrix showed fractional units
 * (182.333333) while the frontend, which never runs this split, correctly showed 29.
 *
 * A deliberate distribution beats a rule-of-thumb one. The even city share is an ESTIMATE for a
 * wholesaler nobody has apportioned; once a human has said where the sales go, that answer wins.
 *
 * WHY IT MUST NOT ASK `areaCode`. That field is the RESOLVED area — loadMonthlyClosingDetails sets
 * it to the row's BRICK's master area and only falls back to the sheet's own area when the brick is
 * unmapped. A hand-split is applied to the fact rows, NOT to the brick: 441164's four July rows all
 * still carry brick B186-1, whose master area is Dakahlia 1. So the resolved view of that customer
 * is a single area, the customer looked un-split, and the city rule re-split it anyway — the fix
 * shipped, the migration applied, and the exported workbook did not change. Asking the ORIGINAL
 * allocation is the whole point: it is the only field the human's decision was written to.
 *
 * TWO CONDITIONS, NOT ONE — and the second is what keeps a real wholesaler splitting. "Sits in more
 * than one area" alone cannot tell a deliberate apportionment from a chain that simply trades in two
 * places, and exempting the latter would silently switch the city rule off for a customer nobody has
 * apportioned. The discriminator is `isRebookedRow`: a genuine two-depot store has fact == resolved
 * in each of its areas, while a hand-split has rows pointing AWAY from the single brick they all
 * still carry. So a customer is exempt only when its rows span more than one closing area AND at
 * least one of them was booked somewhere other than its own master location.
 *
 * Measured on live production 2026-08-06, all 153,053 (period, line, client) groups: 6 span more
 * than one closing area, and exactly ONE of those is re-booked — 441164 / 2026-07 / Anti Infective,
 * the case above. The other five are four pharmacies and one Head Office customer; the classifier
 * only ever demotes store → pharmacy and Head Office is an excluded line, so not one of them could
 * ever have been split and dropping their exemption moves no number.
 */
export function customersAlreadySplitAcrossAreas(rows: readonly StoreSplitRow[]): ReadonlySet<string> {
  const closingAreas = new Map<string, Set<string>>();
  const rebooked = new Set<string>();

  for (const row of rows) {
    if (row.isDirect || !row.includedInClosing) continue;
    const code = String(row.clientCode ?? "").trim();
    if (!code) continue;
    const area = closingAreaOf(row);
    if (area) {
      let seen = closingAreas.get(code);
      if (!seen) {
        seen = new Set<string>();
        closingAreas.set(code, seen);
      }
      seen.add(area);
    }
    if (isRebookedRow(row)) rebooked.add(code);
  }

  const exempt = new Set<string>();
  closingAreas.forEach((areas, code) => {
    if (areas.size > 1 && rebooked.has(code)) exempt.add(code);
  });
  return exempt;
}

/** A row is only moved when it is a store, on a split line, has a city, and feeds the closing. */
export function isSplitEligible(row: StoreSplitRow): boolean {
  if (row.isDirect) return false;
  if (!row.includedInClosing) return false;
  if (!isSplitEligibleLine(row.officialLine)) return false;
  // The client code is passed so an owner override can be honoured. Without it the override is
  // inert here and an overridden pharmacy's sales would still be scattered across its city.
  if (!isStoreCustomer(row.clientName, row.clientCode, row.distributorCode)) return false;
  // The CLOSING area, not the resolved one: the split moves money the Closing Matrix actually holds,
  // and the Matrix books by the fact area. Taking a re-booked row's city from its brick would
  // subtract the money from an area that never carried it — the phantom the 441164 case produced.
  // Identical to `areaCode` on every row in production except a hand-apportioned one.
  const city = cityOfArea(closingAreaOf(row));
  if (!city) return false;
  // A city of one area splits to itself — nothing moves, so skip the work entirely.
  return (CITY_AREAS.get(city)?.length ?? 0) > 1;
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
 */
export function splitStoreSalesAcrossCityAreas<T extends StoreSplitRow>(
  rows: readonly T[],
): StoreSplitResult<T> {
  const out: T[] = [];

  // A customer already distributed across areas by hand is never redistributed by the city rule.
  // See customersAlreadySplitAcrossAreas for the case that forced this.
  const exemptCustomers = customersAlreadySplitAcrossAreas(rows);
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
    const eligible = isSplitEligible(row);
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
    const city = cityOfArea(origin);
    // isSplitEligible already proved both of these; the guard keeps the types honest.
    const areas = city ? CITY_AREAS.get(city) : undefined;
    if (!city || !areas || areas.length === 0) {
      out.push(row);
      continue;
    }

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
): StoreSplitAreaSummary[] {
  const { movements } = splitStoreSalesAcrossCityAreas(rows);
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
>(rows: readonly T[]): StoreSplitDetailRow[] {
  const areaNames = new Map<string, string>();
  for (const row of rows) {
    const area = normalizeArea(row.areaCode);
    const name = typeof row.areaName === "string" ? row.areaName.trim() : "";
    if (area && name && !areaNames.has(area)) areaNames.set(area, name);
  }

  // Same exemption as the split itself, or the detail sheet would report a store as "split" that
  // the matrix left alone — the two tabs must describe the same operation.
  const detailExempt = customersAlreadySplitAcrossAreas(rows);

  const byKey = new Map<string, StoreSplitDetailRow>();
  for (const row of rows) {
    if (!isSplitEligible(row) || detailExempt.has(String(row.clientCode ?? "").trim())) continue;
    // The same origin the split itself uses, or this sheet would name a different area as the giver.
    const origin = closingAreaOf(row);
    const city = cityOfArea(origin);
    const areas = city ? CITY_AREAS.get(city) : undefined;
    if (!city || !areas || areas.length === 0) continue;

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
>(rows: readonly T[]): StoreSplitCustomerSummary[] {
  const byStore = new Map<string, StoreSplitCustomerSummary & { productCodes: Set<string> }>();
  for (const detail of detailStoreSplitByCustomer(rows)) {
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
