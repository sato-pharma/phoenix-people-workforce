// Master Map — collapsing distributor customer rows into one row per real shop.
//
// Source-of-Sales has no single identity for "a pharmacy". A customer is a
// (distributor + customer code) pair, so the same shop appears once per distributor that serves
// it. The owner asked for one row per shop with the codes listed together, which means inferring
// that two rows are the same shop. That inference is the dangerous part of this whole feature,
// so the rule below is deliberately narrow and carries two hard guards.
//
// Measured against production on 2026-08-16 (52,614 active rows):
//   - naive "same folded name + same brick"      -> 43,513 rows, and it FUSES 6,930 real
//     pharmacies, because 7,407 rows carry no name at all and empty matched empty. The worst
//     single group merged 68 different pharmacies, with 68 different codes, into one line.
//   - the guarded rule below                     -> 50,622 rows, 1,886 genuine consolidations.
//
// Both guards exist because a wrong merge is invisible: two shops silently become one row and
// nobody can tell by looking. An unmerged duplicate, by contrast, is obvious and harmless.

import {
  classifyCustomerChannel,
  normalizeCustomerName,
  type CustomerChannel,
} from "@/lib/sales/customer-channel";

export type MasterMapCustomerInput = {
  address: string | null;
  brickId: string;
  customerCode: string;
  customerName: string | null;
  distributorCode: string;
  /** How this mapping got into the database — the `source` column on the crosswalk. */
  source: string | null;
};

export type MasterMapCustomerCode = {
  customerCode: string;
  distributorCode: string;
};

export type MasterMapCustomer = {
  /** The most detailed address seen across the merged rows. Empty when none carried one. */
  address: string;
  brickId: string;
  channel: CustomerChannel;
  /** Every distributor code this shop is known by, ordered for stable display. */
  codes: MasterMapCustomerCode[];
  /**
   * Other distinct addresses the merged rows disagreed on. Kept rather than discarded so a bad
   * merge is visible in the data instead of being smoothed over.
   */
  conflictingAddresses: string[];
  /** False when no distributor has ever given this customer a name. Shown, never dropped. */
  hasName: boolean;
  /** The fullest spelling seen. Blank-named customers report "" and are labelled by the renderer. */
  name: string;
  /**
   * Every distinct provenance behind this shop, in stable order. Usually one; a merged shop can
   * carry two when its distributors' rows arrived by different routes, and both are kept so the
   * sheet never claims a single origin it cannot support.
   */
  sources: string[];
};

/*
 * Composite keys below are joined on the ASCII unit separator (escaped as u001F), never on a space
 * or a pipe.
 *
 * Pharmacy names here contain spaces, dashes, colons and pipes — "ص:د: سناء عرابى خليفة" and
 * "السلطان حسين - مجموعه الدواء" are both real rows. Any PRINTABLE separator can therefore turn up
 * inside a field and let two different rows build the same key, and in this file an accidental key
 * collision means two different pharmacies quietly becoming one line. The unit separator cannot
 * occur in the data.
 */

/** A row that must never be merged is keyed by its own identity, so it can only ever match itself. */
function selfKey(row: MasterMapCustomerInput): string {
  return `CODE\u001F${row.distributorCode}\u001F${row.customerCode}`;
}

function nameKey(foldedName: string, brickId: string): string {
  return `NAME\u001F${foldedName}\u001F${brickId}`;
}

function cleanText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * GUARD 2 — which (name, brick, distributor) triples does a single distributor hold more than one
 * customer code for?
 *
 * If Ibnsina has two codes for "صيدلية النور" in the same brick, Ibnsina is telling us those are
 * two different customers. It is the only party that actually knows, and overruling it merges two
 * real shops. 139 groups in production hit this.
 */
function distributorDistinguishedKeys(rows: readonly MasterMapCustomerInput[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const folded = normalizeCustomerName(row.customerName);
    if (!folded) continue;
    const key = `${folded}\u001F${row.brickId}\u001F${row.distributorCode}`;
    const codes = seen.get(key) ?? new Set<string>();
    codes.add(row.customerCode);
    seen.set(key, codes);
  }
  const distinguished = new Set<string>();
  for (const [key, codes] of seen) if (codes.size > 1) distinguished.add(key);
  return distinguished;
}

/**
 * The merge key for one row. Exported so the tests can pin each guard independently rather than
 * inferring it from a row count.
 */
export function masterMapMergeKey(
  row: MasterMapCustomerInput,
  distinguished: ReadonlySet<string>,
): string {
  const folded = normalizeCustomerName(row.customerName);

  // GUARD 1 — a nameless row never merges. Matching "" against "" is not evidence of anything,
  // and 7,407 production rows would otherwise collapse into 477.
  if (!folded) return selfKey(row);

  // GUARD 2 — this distributor already says these are two customers. Believe it.
  if (distinguished.has(`${folded}\u001F${row.brickId}\u001F${row.distributorCode}`)) {
    return selfKey(row);
  }

  return nameKey(folded, row.brickId);
}

/** Longest first, so the fullest spelling and the most detailed address win. Stable on ties. */
function byInformationDensity(left: string, right: string): number {
  return right.length - left.length || left.localeCompare(right);
}

/**
 * Collapse raw customer rows into one row per shop, applying both guards.
 *
 * Input order does not affect the output: every field is chosen by an order-independent rule, so
 * the same data always renders the same sheet. That matters because this runs hourly and a sheet
 * that reshuffles itself for no reason looks broken.
 */
export function mergeMasterMapCustomers(
  rows: readonly MasterMapCustomerInput[],
): MasterMapCustomer[] {
  const distinguished = distributorDistinguishedKeys(rows);

  const groups = new Map<string, MasterMapCustomerInput[]>();
  for (const row of rows) {
    const key = masterMapMergeKey(row, distinguished);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const merged: MasterMapCustomer[] = [];
  for (const group of groups.values()) {
    const names = group.map((row) => cleanText(row.customerName)).filter(Boolean);
    names.sort(byInformationDensity);

    const addresses = [...new Set(group.map((row) => cleanText(row.address)).filter(Boolean))];
    addresses.sort(byInformationDensity);

    const codes = group
      .map((row) => ({ customerCode: row.customerCode, distributorCode: row.distributorCode }))
      .sort(
        (left, right) =>
          left.distributorCode.localeCompare(right.distributorCode) ||
          left.customerCode.localeCompare(right.customerCode),
      );

    const name = names[0] ?? "";
    // Channel is derived from the name on every read, exactly as the Customer Directory does it,
    // so adding a keyword re-classifies the whole sheet on the next sync with no backfill.
    // The first code is passed because the owner's overrides are keyed by code, not by name.
    const channel = classifyCustomerChannel(name, codes[0]?.customerCode, codes[0]?.distributorCode);

    merged.push({
      address: addresses[0] ?? "",
      brickId: group[0].brickId,
      channel,
      codes,
      conflictingAddresses: addresses.slice(1),
      hasName: name !== "",
      name,
      sources: [...new Set(group.map((row) => cleanText(row.source)).filter(Boolean))].sort(),
    });
  }

  // Named shops first, alphabetically; the nameless ones gather at the end of their brick where
  // they read as the punch list they are.
  merged.sort(
    (left, right) =>
      Number(right.hasName) - Number(left.hasName) ||
      left.name.localeCompare(right.name) ||
      (left.codes[0]?.customerCode ?? "").localeCompare(right.codes[0]?.customerCode ?? ""),
  );
  return merged;
}
