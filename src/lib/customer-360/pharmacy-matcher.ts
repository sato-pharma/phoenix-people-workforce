/**
 * Which shop a pharmacy NAMED ON A VISIT is — the owner's rule, as a pure function.
 *
 * His words (2026-10-18): "if you find the same pharmacy name in the same brick where the doctor is
 * validated, then automatic validate. If uncertain, make another tab in the same module for me, the
 * admin, to confirm it … you must show the location of the validated customer and the address of the
 * pharmacy and show full data."
 *
 * An ITEM is one folded name in one brick — every visit, by any rep, naming that shop from a clinic
 * in that brick is the same item, so tomorrow's visit naming it is tied at once.
 *
 * 🔴 AUTOMATIC only when the Monthly Closing's customer map holds EXACTLY ONE SHOP of that folded
 * name in that brick: one code per distributor (one shop bought from several distributors is still
 * one shop, and all its pairs are tied). Everything else waits for him:
 *   · two shops of that name at one distributor in the brick;
 *   · only a near name in the brick (one folded name inside the other);
 *   · the exact name only in another brick of the same area;
 *   · no candidate at all, or a visit place with no brick.
 *
 * 🔴 HIS DECISION OUTRANKS THE RULE. A confirmed or "none of these" decision on the item stands
 * whatever the map says now; withdrawing it (Undo) hands the item back to the rule.
 *
 * 🔴 WAREHOUSES ARE NEVER CANDIDATES. A wholesaler is not a pharmacy a doctor sends patients to, and
 * `classifyCustomerChannel` is the one authority on who is one.
 *
 * The name key is `pharmacyNameKey` — Phoenix CRM's own fold for a typed pharmacy name (the word
 * "pharmacy" dropped wherever it stands, the alef / ya / ta-marbuta forms folded), the same fold that
 * files a named pharmacy on a rep's list. Never a second copy.
 */

import { pharmacyNameKey } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { classifyCustomerChannel } from "@/lib/sales/customer-channel";

/** Shorter folded names than this never match as a NEAR name — "نور" inside everything. */
export const NEAR_NAME_MIN_KEY = 4;

export type MapShopRow = {
  distributorCode: string;
  customerCode: string;
  customerName: string;
  address: string | null;
  brickId: string | null;
  areaCode: string | null;
};

/** One distributor's code for a shop — the unit the closing's sales are found by. */
export type MatchPair = {
  distributorCode: string;
  customerCode: string;
  customerName: string;
  brickId: string | null;
};

export type MatchStatus = "auto" | "confirmed" | "rejected" | "waiting";

/** Why an item waits — the words the confirm tab prints. */
export type WaitReason = "two_shops_one_distributor" | "near_name_only" | "other_brick_only" | "no_candidate" | "no_brick";

export const WAIT_REASON_TEXT: Record<WaitReason, string> = {
  no_brick: "The visit's place has no brick, so the rule cannot look for the shop.",
  no_candidate: "No shop with this name is in the brick or its area.",
  near_name_only: "Only a similar name is in the brick.",
  other_brick_only: "The same name is only in another brick of the same area.",
  two_shops_one_distributor: "Two shops with this name are at one distributor in the brick.",
};

export type MatchCandidate = MatchPair & {
  address: string | null;
  areaCode: string | null;
  /** Why this row is offered. */
  why: "same_name_same_brick" | "near_name_same_brick" | "same_name_other_brick";
};

export type StoredDecision = {
  status: "auto" | "confirmed" | "rejected";
  pairs: MatchPair[];
  decidedByHrId: string | null;
  decidedAt: string | null;
};

export type MatchResult = {
  status: MatchStatus;
  /** The pairs tied to the item — empty unless `auto` or `confirmed`. */
  pairs: MatchPair[];
  /** What the confirm tab offers, best first. Empty for an auto tie. */
  candidates: MatchCandidate[];
  reason: WaitReason | null;
  decision: StoredDecision | null;
};

/** The key an item is stored and found by. A brick id holds no bar; a folded name might. */
export function matchItemKey(nameKey: string, brickId: string): string {
  return `${brickId}|${nameKey}`;
}

// One fold and one warehouse test per shop, however many items look at it: an area's shops are
// offered to every item in that area, and folding thousands of Arabic names per item measured at
// over two minutes for one build on 2026-10-18.
const foldedKeys = new WeakMap<object, string>();
const warehouses = new WeakMap<object, boolean>();

function shopKey(row: MapShopRow): string {
  let key = foldedKeys.get(row);
  if (key === undefined) {
    key = pharmacyNameKey(row.customerName ?? "");
    foldedKeys.set(row, key);
  }
  return key;
}

function isWarehouse(row: MapShopRow): boolean {
  let flag = warehouses.get(row);
  if (flag === undefined) {
    flag = classifyCustomerChannel(row.customerName, row.customerCode, row.distributorCode) === "store";
    warehouses.set(row, flag);
  }
  return flag;
}

function toPair(row: MapShopRow): MatchPair {
  return {
    brickId: row.brickId,
    customerCode: row.customerCode.trim(),
    customerName: row.customerName,
    distributorCode: row.distributorCode.trim().toUpperCase(),
  };
}

function nearName(left: string, right: string): boolean {
  if (!left || !right || left === right) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= NEAR_NAME_MIN_KEY && longer.includes(shorter);
}

/**
 * The live rule for one item.
 *
 * `brickShops` are the active map rows of the item's brick; `areaShops` those of the other bricks of
 * the same area (shown only — they never tie by themselves).
 */
export function matchNamedPharmacy(input: {
  nameKey: string;
  brickId: string | null;
  brickShops: readonly MapShopRow[];
  areaShops: readonly MapShopRow[];
  decision?: StoredDecision | null;
}): MatchResult {
  const decision = input.decision ?? null;
  if (decision && (decision.status === "confirmed" || decision.status === "rejected")) {
    return {
      candidates: [],
      decision,
      pairs: decision.status === "confirmed" ? decision.pairs : [],
      reason: null,
      status: decision.status,
    };
  }
  if (!input.brickId) {
    return { candidates: [], decision, pairs: [], reason: "no_brick", status: "waiting" };
  }

  // Name first, warehouse second: the channel test is the expensive one, and only a shop whose name
  // already fits needs it.
  const shops = input.brickShops.filter((row) => row.customerCode.trim() && row.distributorCode.trim());
  const exact = shops.filter((row) => shopKey(row) === input.nameKey && !isWarehouse(row));

  if (exact.length > 0) {
    const codesByDistributor = new Map<string, Set<string>>();
    for (const row of exact) {
      const distributor = row.distributorCode.trim().toUpperCase();
      const codes = codesByDistributor.get(distributor) ?? new Set<string>();
      codes.add(row.customerCode.trim());
      codesByDistributor.set(distributor, codes);
    }
    const oneShop = [...codesByDistributor.values()].every((codes) => codes.size === 1);
    if (oneShop) {
      const seen = new Set<string>();
      const pairs = exact.map(toPair).filter((pair) => {
        const key = `${pair.distributorCode}|${pair.customerCode}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { candidates: [], decision, pairs, reason: null, status: "auto" };
    }
    return {
      candidates: exact.map((row) => ({ ...toPair(row), address: row.address, areaCode: row.areaCode, why: "same_name_same_brick" as const })),
      decision,
      pairs: [],
      reason: "two_shops_one_distributor",
      status: "waiting",
    };
  }

  const near = shops
    .filter((row) => nearName(shopKey(row), input.nameKey) && !isWarehouse(row))
    .map((row) => ({ ...toPair(row), address: row.address, areaCode: row.areaCode, why: "near_name_same_brick" as const }));
  const elsewhere = input.areaShops
    .filter((row) => row.brickId !== input.brickId && shopKey(row) === input.nameKey && !isWarehouse(row))
    .map((row) => ({ ...toPair(row), address: row.address, areaCode: row.areaCode, why: "same_name_other_brick" as const }));

  const candidates = [...near, ...elsewhere].slice(0, 12);
  const reason: WaitReason = near.length > 0 ? "near_name_only" : elsewhere.length > 0 ? "other_brick_only" : "no_candidate";
  return { candidates, decision, pairs: [], reason, status: "waiting" };
}
