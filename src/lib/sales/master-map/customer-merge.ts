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

/**
 * Anything `replace(/\s+/g, " ").trim()` would change: a whitespace character other than a plain
 * space, two spaces together, or a space at either end. Most names and addresses are already clean,
 * and skipping the replace for them is the whole saving — the answer is the same string either way,
 * because `\s` and `trim()` read the same set of whitespace characters.
 */
const NEEDS_CLEANING = /[^\S ]| {2}|^ | $/;

function cleanText(value: string | null | undefined): string {
  const text = String(value ?? "");
  return NEEDS_CLEANING.test(text) ? text.replace(/\s+/g, " ").trim() : text;
}

/**
 * `localeCompare` with no arguments, built once. ECMA-402 defines `a.localeCompare(b)` as a new
 * `Intl.Collator(undefined, undefined)` comparing the two, so this is the same order — without
 * constructing that collator again for each of the ~1.7 million comparisons the final sort makes.
 */
const collate = new Intl.Collator().compare;

/**
 * Rows between two pauses when the merge runs inside the web server (`mergeMasterMapCustomersYielding`).
 * About ten to thirty milliseconds of work on the production rows.
 */
const MERGE_SLICE = 2_000;

/**
 * GUARD 2 — which (name, brick, distributor) triples does a single distributor hold more than one
 * customer code for?
 *
 * If Ibnsina has two codes for "صيدلية النور" in the same brick, Ibnsina is telling us those are
 * two different customers. It is the only party that actually knows, and overruling it merges two
 * real shops. 139 groups in production hit this.
 */
function distributorKey(folded: string, row: MasterMapCustomerInput): string {
  return `${folded}\u001F${row.brickId}\u001F${row.distributorCode}`;
}

/**
 * The merge key for one row. Exported so the tests can pin each guard independently rather than
 * inferring it from a row count.
 */
export function masterMapMergeKey(
  row: MasterMapCustomerInput,
  distinguished: ReadonlySet<string>,
): string {
  return mergeKeyOfFolded(row, normalizeCustomerName(row.customerName), distinguished);
}

/** The merge key, for a row whose name is already folded — the merge folds each name once. */
function mergeKeyOfFolded(row: MasterMapCustomerInput, folded: string, distinguished: ReadonlySet<string>): string {
  // GUARD 1 — a nameless row never merges. Matching "" against "" is not evidence of anything,
  // and 7,407 production rows would otherwise collapse into 477.
  if (!folded) return selfKey(row);

  // GUARD 2 — this distributor already says these are two customers. Believe it.
  if (distinguished.has(distributorKey(folded, row))) {
    return selfKey(row);
  }

  return nameKey(folded, row.brickId);
}

/** Longest first, so the fullest spelling and the most detailed address win. Stable on ties. */
function byInformationDensity(left: string, right: string): number {
  return right.length - left.length || collate(left, right);
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
  const steps = mergeSteps(rows);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The same merge, pausing every `MERGE_SLICE` rows (owner's stall alert, 14 Nov 2026).
 *
 * 🔴 THE MERGE WAS THE WHOLE MASTER MAP FREEZE ON A NEW SERVER. A fresh container has no cached tree,
 * so the sheet's first hourly check builds one: ~105,000 distributor rows merged into ~98,500 shops in
 * ONE block of 1.6–2.6 s on production (03:04, 04:10 and 05:14 Cairo on 14 Nov 2026, each the only
 * heavy request in its minute), with every page on the site waiting behind it. Same rows in, same
 * shops out, in the same order — only the pauses are new. `mergeMasterMapCustomers` runs the very
 * same steps without them.
 */
export async function mergeMasterMapCustomersYielding(
  rows: readonly MasterMapCustomerInput[],
  pause: () => Promise<void>,
): Promise<MasterMapCustomer[]> {
  const steps = mergeSteps(rows);
  let step = steps.next();
  while (!step.done) {
    await pause();
    step = steps.next();
  }
  return step.value;
}

/** The merge, as steps: each `yield` is a place the web server may answer someone else. */
function* mergeSteps(rows: readonly MasterMapCustomerInput[]): Generator<void, MasterMapCustomer[], void> {
  // Each distinct name folded ONCE. The guard and the key both need every row's folded name, and the
  // same shop's name repeats across its distributors; folding it was most of the merge's time.
  const foldedOf = new Map<string, string>();
  const folded: string[] = new Array(rows.length);
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index].customerName ?? "";
    let value = foldedOf.get(raw);
    if (value === undefined) {
      value = normalizeCustomerName(raw);
      foldedOf.set(raw, value);
    }
    folded[index] = value;
    if ((index + 1) % MERGE_SLICE === 0) yield;
  }
  yield;

  // GUARD 2's evidence, from every row.
  const seen = new Map<string, Set<string>>();
  for (let index = 0; index < rows.length; index += 1) {
    if (folded[index]) {
      const key = distributorKey(folded[index], rows[index]);
      const codes = seen.get(key) ?? new Set<string>();
      codes.add(rows[index].customerCode);
      seen.set(key, codes);
    }
    if ((index + 1) % MERGE_SLICE === 0) yield;
  }
  const distinguished = new Set<string>();
  for (const [key, codes] of seen) if (codes.size > 1) distinguished.add(key);
  yield;

  const groups = new Map<string, MasterMapCustomerInput[]>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = mergeKeyOfFolded(row, folded[index], distinguished);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
    if ((index + 1) % MERGE_SLICE === 0) yield;
  }
  yield;

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
          collate(left.distributorCode, right.distributorCode) ||
          collate(left.customerCode, right.customerCode),
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
    if (merged.length % MERGE_SLICE === 0) yield;
  }
  yield;

  // Named shops first, alphabetically; the nameless ones gather at the end of their brick where
  // they read as the punch list they are.
  merged.sort(
    (left, right) =>
      Number(right.hasName) - Number(left.hasName) ||
      collate(left.name, right.name) ||
      collate(left.codes[0]?.customerCode ?? "", right.codes[0]?.customerCode ?? ""),
  );
  return merged;
}
