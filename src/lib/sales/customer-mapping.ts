import {
  loadCustomerDirectoryFilterOptions,
  loadCustomerDirectoryRows,
  type CustomerDirectoryFilterOptions,
  type CustomerDirectoryFilters,
  type CustomerDirectoryRow,
} from "@/lib/sales/customer-directory";

// Customer Mapping — a clean customer→geography crosswalk built from the SAME uploaded distributor
// sales as the Customer Directory (it reuses that engine's read path), with two extra jobs the
// Directory deliberately does NOT do:
//   1. A VLOOKUP-ready export keyed on the customer code (so the geography can be looked up by
//      customer code instead of region code) — see customer-mapping-export.ts.
//   2. Cross-distributor consolidation: the SAME physical pharmacy is sold by several distributors,
//      each under its own customer code. We group those rows into one "master customer" by matching
//      on customer NAME + BRICK + ADDRESS (the three signals the business trusts to identify a real
//      pharmacy). The Directory keeps every distributor row separate on purpose; here we link them.
//
// This module is pure + read-only. It writes nothing and adds no database objects.

export type { CustomerDirectoryFilterOptions, CustomerDirectoryFilters } from "@/lib/sales/customer-directory";

// One row per (customer code + distributor), enriched with the master-customer link.
export type CustomerMappingRow = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  customerAddress: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  distributorName: string;
  /** How many DISTINCT distributors this row's master customer spans. */
  distributorSpan: number;
  /** True when this row's master customer is sold by more than one distributor (i.e. consolidated). */
  matched: boolean;
  /** Stable id shared by every distributor row of the same physical pharmacy. */
  masterCustomerId: string;
  regionCode: string;
  regionName: string;
  totalUnits: number;
  totalValue: number;
};

// One row per master customer (the same pharmacy across all its distributors, merged + summed).
export type ConsolidatedCustomer = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  customerAddress: string;
  customerName: string;
  distributorSpan: number;
  masterCustomerId: string;
  members: { customerCode: string; distributorCode: string; distributorName: string }[];
  regionCode: string;
  regionName: string;
  totalUnits: number;
  totalValue: number;
};

export type CustomerMappingResult = {
  consolidated: ConsolidatedCustomer[];
  /** Masters that span more than one distributor (the ones consolidation actually merged). */
  matchedMasters: number;
  rows: CustomerMappingRow[];
  totalConsolidated: number;
  totalRows: number;
  truncated: boolean;
};

const DISPLAY_LIMIT = 2000;

function round(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

// Normalize free text for identity matching: fold case + diacritics, drop punctuation, collapse
// whitespace. Keeps Unicode letters/numbers so Arabic names/addresses match too.
export function normalizeIdentityText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // latin combining diacritics
    .replace(/[ـً-ٰٟ]/g, "") // arabic tatweel + harakat
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Order-independent, deterministic 8-hex id for a group key (FNV-1a, 32-bit). Same physical pharmacy
// → same master id on every run, regardless of how many rows or what order they arrive in.
export function stableGroupId(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

// The consolidation key: customer NAME + BRICK + ADDRESS. A blank name means we cannot safely claim
// it is "the same pharmacy", so it stays unmatchable (its own solo master).
export function customerMatchKey(input: { brickId: string; customerAddress: string; customerName: string }): string {
  const name = normalizeIdentityText(input.customerName);
  if (!name) return "";
  const brick = normalizeIdentityText(input.brickId);
  const address = normalizeIdentityText(input.customerAddress);
  return [name, brick, address].join("|");
}

// Pure: group the per-distributor rows into master customers and emit both the enriched per-row list
// and the consolidated (one-per-master) list. No I/O — fully unit-testable.
export function consolidateCustomers(input: CustomerDirectoryRow[]): {
  consolidated: ConsolidatedCustomer[];
  rows: CustomerMappingRow[];
} {
  const groups = new Map<string, CustomerDirectoryRow[]>();
  for (const row of input) {
    const key = customerMatchKey({ brickId: row.brickId, customerAddress: row.clientAddress, customerName: row.clientName });
    // Unmatchable rows get a per-row solo key so they never falsely merge with each other.
    const groupKey = key ? `K:${key}` : `S:${row.distributorCode}|${row.clientCode}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(row);
    else groups.set(groupKey, [row]);
  }

  const rows: CustomerMappingRow[] = [];
  const consolidated: ConsolidatedCustomer[] = [];

  for (const [groupKey, members] of groups) {
    const masterCustomerId = `MC-${stableGroupId(groupKey)}`;
    const distributorSpan = new Set(members.map((member) => member.distributorCode)).size;
    const matched = distributorSpan > 1;
    // Representative record (drives the merged name/address/geography) = the biggest member by value.
    const representative = [...members].sort((left, right) => right.totalValue - left.totalValue)[0];

    for (const member of members) {
      rows.push({
        areaCode: member.areaCode,
        areaName: member.areaName,
        brickId: member.brickId,
        brickName: member.brickName,
        customerAddress: member.clientAddress,
        customerCode: member.clientCode,
        customerName: member.clientName,
        distributorCode: member.distributorCode,
        distributorName: member.distributorName,
        distributorSpan,
        matched,
        masterCustomerId,
        regionCode: member.regionCode,
        regionName: member.regionName,
        totalUnits: round(member.totalUnits),
        totalValue: round(member.totalValue),
      });
    }

    consolidated.push({
      areaCode: representative.areaCode,
      areaName: representative.areaName,
      brickId: representative.brickId,
      brickName: representative.brickName,
      customerAddress: representative.clientAddress,
      customerName: representative.clientName,
      distributorSpan,
      masterCustomerId,
      members: members
        .map((member) => ({ customerCode: member.clientCode, distributorCode: member.distributorCode, distributorName: member.distributorName }))
        .sort((left, right) => left.distributorName.localeCompare(right.distributorName) || left.customerCode.localeCompare(right.customerCode)),
      regionCode: representative.regionCode,
      regionName: representative.regionName,
      totalUnits: round(members.reduce((sum, member) => sum + member.totalUnits, 0)),
      totalValue: round(members.reduce((sum, member) => sum + member.totalValue, 0)),
    });
  }

  rows.sort(
    (left, right) =>
      right.totalValue - left.totalValue ||
      left.customerName.localeCompare(right.customerName) ||
      left.distributorCode.localeCompare(right.distributorCode),
  );
  consolidated.sort(
    (left, right) => right.totalValue - left.totalValue || left.customerName.localeCompare(right.customerName),
  );

  return { consolidated, rows };
}

// Full (uncapped) consolidated mapping for the current filters — used by the XLSX export.
export async function loadCustomerMapping(filters: CustomerDirectoryFilters): Promise<{
  consolidated: ConsolidatedCustomer[];
  rows: CustomerMappingRow[];
}> {
  const base = await loadCustomerDirectoryRows(filters);
  return consolidateCustomers(base);
}

// Capped result for the on-screen table (the export keeps the full set).
export async function listCustomerMapping(filters: CustomerDirectoryFilters): Promise<CustomerMappingResult> {
  const { consolidated, rows } = await loadCustomerMapping(filters);
  return {
    consolidated: consolidated.slice(0, DISPLAY_LIMIT),
    matchedMasters: consolidated.reduce((count, master) => count + (master.distributorSpan > 1 ? 1 : 0), 0),
    rows: rows.slice(0, DISPLAY_LIMIT),
    totalConsolidated: consolidated.length,
    totalRows: rows.length,
    truncated: rows.length > DISPLAY_LIMIT || consolidated.length > DISPLAY_LIMIT,
  };
}

export async function loadCustomerMappingFilterOptions(): Promise<CustomerDirectoryFilterOptions> {
  return loadCustomerDirectoryFilterOptions();
}
