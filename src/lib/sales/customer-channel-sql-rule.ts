// The channel rule, packed for SQL.
//
// `customer-channel.ts` is THE single edit point for who is a warehouse — "adding an entry
// re-classifies all history". That promise only holds for the surfaces that ask TypeScript. Three
// SQL functions ask SQL, and each carried its own two-step copy of the rule (hospital stems, store
// stems), frozen at the shape the rule had in August 2026. By 2026-09-07 the real rule had eight
// steps, so the owner's «م - » prefix ruling, his company and chain rulings, the never-store words,
// El Qema's wholesale-only book and the trade phrase all stopped at the database boundary.
//
// This module is that boundary, in one direction: every list travels as ONE payload, built here
// from the exported constants and read by `phx_customer_channel`. A new list added to
// customer-channel.ts becomes a one-line addition here and needs no migration at all.
//
// WHY NOT SIMPLY DO THE CLASSIFICATION IN TYPESCRIPT. These functions aggregate millions of rows
// inside the database and return per-rep totals; pulling the rows out to classify them in Node is
// the shape that made the customer directory slow enough to need a rollup in the first place.

import {
  HOSPITAL_NAME_KEYWORDS,
  NEVER_STORE_KEYWORDS,
  PHARMACY_OVERRIDE_CHAINS,
  PHARMACY_OVERRIDE_CLIENT_CODES,
  PHARMACY_OVERRIDE_NAMES,
  STORE_NAME_KEYWORDS,
  STORE_NAME_PREFIXES,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  STORE_OVERRIDE_NAMES,
  TRADE_BUSINESS_PAIR_STEMS,
  TRADE_BUSINESS_STEMS,
  TRADE_GOODS_STEMS,
  WAREHOUSE_RULE_DEFAULT_FROM_PERIOD,
  WAREHOUSE_RULE_FROM_PERIOD_BY_LINE,
  WHOLESALE_ONLY_DISTRIBUTORS,
  normalizeCustomerName,
  type ChannelNameKeyword,
} from "@/lib/sales/customer-channel";

/**
 * The payload `phx_customer_channel(…, p_rule)` reads.
 *
 * Every key is a list SQL compares one specific way, and the ways are NOT interchangeable — the
 * prefixes in particular must be anchored at the start of the name. «م - » starts 29 customer names
 * and appears somewhere inside 623; comparing it as a substring would turn 594 ordinary pharmacies
 * into warehouses and scatter their sales across their cities, with nothing downstream reporting it
 * (the split moves units between areas while preserving each line's total, so the publication drift
 * check, which compares units, sees nothing).
 */
export type CustomerChannelSqlRule = {
  hospitalStems: string[];
  neverStoreStems: string[];
  pharmacyOverrideCodes: string[];
  pharmacyOverrideNameStems: string[];
  ruleFromPeriodByLine: Record<string, string>;
  ruleFromPeriodDefault: string;
  storeOverrideKeys: string[];
  storeOverrideNameStems: string[];
  storePrefixes: string[];
  storeStems: string[];
  tradeBusinessPair: string[];
  tradeBusinessStems: string[];
  tradeGoodsStems: string[];
  wholesaleOnlyDistributors: string[];
};

/** Fold a keyword list exactly as the name it will be compared against is folded. */
function stems(entries: readonly ChannelNameKeyword[]): string[] {
  return entries.map((entry) => normalizeCustomerName(entry.stem)).filter(Boolean);
}

/**
 * Built fresh on every call rather than frozen into a module constant: the lists are the owner's
 * rulings, and a value captured at import time is one deploy behind the day he changes his mind.
 */
export function customerChannelSqlRule(): CustomerChannelSqlRule {
  return {
    hospitalStems: stems(HOSPITAL_NAME_KEYWORDS),
    neverStoreStems: stems(NEVER_STORE_KEYWORDS),
    pharmacyOverrideCodes: [...PHARMACY_OVERRIDE_CLIENT_CODES],
    // The two pharmacy name lists differ only in why the owner wrote them — one names a company,
    // the other a chain — and SQL treats both the same way, so they travel as one list.
    pharmacyOverrideNameStems: [...stems(PHARMACY_OVERRIDE_NAMES), ...stems(PHARMACY_OVERRIDE_CHAINS)],
    ruleFromPeriodByLine: Object.fromEntries(WAREHOUSE_RULE_FROM_PERIOD_BY_LINE),
    ruleFromPeriodDefault: WAREHOUSE_RULE_DEFAULT_FROM_PERIOD,
    storeOverrideKeys: [...STORE_OVERRIDE_CUSTOMER_KEYS],
    storeOverrideNameStems: stems(STORE_OVERRIDE_NAMES),
    storePrefixes: stems(STORE_NAME_PREFIXES),
    storeStems: stems(STORE_NAME_KEYWORDS),
    // Not folded: the trade stems are compared against the SQUASHED name, and they carry no
    // whitespace or foldable letter of their own. Folding them here would be a no-op that reads
    // like a rule.
    tradeBusinessPair: [...TRADE_BUSINESS_PAIR_STEMS],
    tradeBusinessStems: [...TRADE_BUSINESS_STEMS],
    tradeGoodsStems: [...TRADE_GOODS_STEMS],
    wholesaleOnlyDistributors: [...WHOLESALE_ONLY_DISTRIBUTORS],
  };
}
