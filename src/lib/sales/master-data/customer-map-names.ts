import type { MasterKey, MasterRowRecord } from "@/lib/sales/master-data/definitions";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

// The Database Mapping customer map shows NAMES, never codes (owner rule: human-readable names in
// the UI). The crosswalk row carries only codes (brick_id, area_code, region_code, distributor_code),
// and those codes must stay in the workbook export, because the import matches on them. So the
// screen resolves each code against the master rows the page already holds, which include inactive
// rows: a customer still mapped to a retired brick keeps its brick's name.
//
// A code with no master row falls back to the code itself, marked unresolved, rather than a blank
// or a dash: that customer's territory is real data, and hiding it would hide the mapping defect.

export type CustomerMapNameIndex = Record<"areas" | "bricks" | "distributors" | "regions", Map<string, string>>;

export type CustomerMapCodes = { areaCode: string; brickId: string; distributorCode: string; regionCode: string };

export type ResolvedName = { name: string; resolved: boolean };

export type CustomerMapNames = { area: ResolvedName; brick: ResolvedName; distributor: ResolvedName; region: ResolvedName };

export const CUSTOMER_MAP_NAME_COLUMNS = {
  areas: ["area_code", "area_name"],
  bricks: ["brick_id", "brick_name"],
  distributors: ["distributor_code", "distributor_name"],
  regions: ["region_code", "region_name"],
} as const satisfies Record<keyof CustomerMapNameIndex, readonly [string, string]>;

export function buildCustomerMapNameIndex(rowsByMaster: Partial<Record<MasterKey, MasterRowRecord[]>>): CustomerMapNameIndex {
  const index = {} as CustomerMapNameIndex;
  for (const master of Object.keys(CUSTOMER_MAP_NAME_COLUMNS) as (keyof CustomerMapNameIndex)[]) {
    const [codeColumn, nameColumn] = CUSTOMER_MAP_NAME_COLUMNS[master];
    const names = new Map<string, string>();
    for (const row of rowsByMaster[master] ?? []) {
      const key = normalizeCodeKey(row[codeColumn]);
      const name = String(row[nameColumn] ?? "").trim();
      if (key && name) names.set(key, name);
    }
    index[master] = names;
  }
  return index;
}

function resolve(names: Map<string, string>, code: string): ResolvedName {
  const name = names.get(normalizeCodeKey(code));
  if (name) return { name, resolved: true };
  const raw = code.trim();
  return { name: raw || "—", resolved: raw === "" };
}

export function customerMapNames(index: CustomerMapNameIndex, codes: CustomerMapCodes): CustomerMapNames {
  return {
    area: resolve(index.areas, codes.areaCode),
    brick: resolve(index.bricks, codes.brickId),
    distributor: resolve(index.distributors, codes.distributorCode),
    region: resolve(index.regions, codes.regionCode),
  };
}
