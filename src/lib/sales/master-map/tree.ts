// Master Map — the region -> area -> brick -> customer tree, and the rows it renders to.
//
// Everything here is pure. The Supabase reads live in load.ts and the Google writes in
// sheets-client.ts, so the shape of the sheet can be tested without touching either.
//
// GEOGRAPHY AUTHORITY. Each hop has exactly one source:
//   brick -> area   from the brick master (source_of_sales_bricks)
//   area  -> region from the area master  (source_of_sales_areas)
// The customer rows carry their own denormalised copy of area and region, and 900 of them
// disagree with the brick master. They are ignored on purpose: the owner's standing rule is that
// all Source-of-Sales attributes to TODAY's geography, and the masters are today's geography.
//
// NOTHING IS EVER DROPPED. A brick with no customers, an area with no bricks and a region with no
// areas all still render, labelled as empty — 90 active bricks and 2 whole regions are in that
// state right now, and a master that hides them would read as though they did not exist.

import type { MasterMapCustomer, MasterMapCustomerInput } from "@/lib/sales/master-map/customer-merge";
import { mergeMasterMapCustomers } from "@/lib/sales/master-map/customer-merge";

export type RegionInput = { regionCode: string; regionName: string };
export type AreaInput = { areaCode: string; areaName: string; regionCode: string };
export type BrickInput = { areaCode: string; brickId: string; brickName: string };

export type MasterMapBrick = {
  brickId: string;
  brickName: string;
  customers: MasterMapCustomer[];
};

export type MasterMapArea = {
  areaCode: string;
  areaName: string;
  bricks: MasterMapBrick[];
  customerCount: number;
};

export type MasterMapRegion = {
  areas: MasterMapArea[];
  customerCount: number;
  regionCode: string;
  regionName: string;
};

export type MasterMapTree = {
  /** Customers whose brick is not in the brick master. Zero in production, but never assume. */
  orphanedCustomers: MasterMapCustomer[];
  regions: MasterMapRegion[];
};

function displayName(name: string, code: string): string {
  const clean = String(name ?? "").trim();
  return clean === "" ? code : clean;
}

/** Sort by human-readable name, which is the only order the owner ever reads these in. */
function byName<T>(pick: (value: T) => string) {
  return (left: T, right: T) => pick(left).localeCompare(pick(right));
}

export function buildMasterMapTree(input: {
  areas: readonly AreaInput[];
  bricks: readonly BrickInput[];
  customers: readonly MasterMapCustomerInput[];
  regions: readonly RegionInput[];
}): MasterMapTree {
  const merged = mergeMasterMapCustomers(input.customers);

  const customersByBrick = new Map<string, MasterMapCustomer[]>();
  for (const customer of merged) {
    const bucket = customersByBrick.get(customer.brickId);
    if (bucket) bucket.push(customer);
    else customersByBrick.set(customer.brickId, [customer]);
  }

  const knownBrickIds = new Set(input.bricks.map((brick) => brick.brickId));
  const orphanedCustomers = merged.filter((customer) => !knownBrickIds.has(customer.brickId));

  const bricksByArea = new Map<string, MasterMapBrick[]>();
  for (const brick of input.bricks) {
    const built: MasterMapBrick = {
      brickId: brick.brickId,
      brickName: displayName(brick.brickName, brick.brickId),
      customers: customersByBrick.get(brick.brickId) ?? [],
    };
    const bucket = bricksByArea.get(brick.areaCode);
    if (bucket) bucket.push(built);
    else bricksByArea.set(brick.areaCode, [built]);
  }
  for (const bricks of bricksByArea.values()) bricks.sort(byName((brick) => brick.brickName));

  const areasByRegion = new Map<string, MasterMapArea[]>();
  for (const area of input.areas) {
    const bricks = bricksByArea.get(area.areaCode) ?? [];
    const built: MasterMapArea = {
      areaCode: area.areaCode,
      areaName: displayName(area.areaName, area.areaCode),
      bricks,
      customerCount: bricks.reduce((total, brick) => total + brick.customers.length, 0),
    };
    const bucket = areasByRegion.get(area.regionCode);
    if (bucket) bucket.push(built);
    else areasByRegion.set(area.regionCode, [built]);
  }
  for (const areas of areasByRegion.values()) areas.sort(byName((area) => area.areaName));

  const regions = input.regions
    .map((region): MasterMapRegion => {
      const areas = areasByRegion.get(region.regionCode) ?? [];
      return {
        areas,
        customerCount: areas.reduce((total, area) => total + area.customerCount, 0),
        regionCode: region.regionCode,
        regionName: displayName(region.regionName, region.regionCode),
      };
    })
    .sort(byName((region) => region.regionName));

  return { orphanedCustomers, regions };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * The customer columns. Region, area and brick rows are merged bands spanning all of them.
 *
 * Distributor and code are SEPARATE columns so both can be filtered and looked up on their own.
 * A shop served by more than one distributor keeps its first pairing in those two columns and
 * every remaining pairing in "Also supplied by" — measured on production, 48,733 shops have one
 * code, 1,789 have two, 97 have three and 3 have four, so giving each extra pairing its own pair
 * of columns would add six columns that are blank on 96% of rows.
 */
export const MASTER_MAP_COLUMNS = [
  "Pharmacy",
  "Distributor",
  "Code",
  "Also supplied by",
  "Channel",
  "Address",
  "Where this came from",
] as const;

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------

/**
 * The crosswalk records how each mapping arrived, but as internal slugs — "master-remap-2026-07-28b",
 * "owner-ruling-qena1-2026-07-28", "sheet-verified". The owner's standing rule is human-readable
 * names, never raw codes, so each slug is turned back into the sentence it stands for.
 *
 * Anything unrecognised still renders: the slug is de-kebabed rather than dropped or shown blank,
 * so a source added next month reads sensibly without anyone editing this list.
 */
const SOURCE_PHRASES: ReadonlyArray<{ match: RegExp; phrase: string }> = [
  { match: /^owner-ruling/, phrase: "Your ruling" },
  { match: /^owner-file/, phrase: "Your file" },
  { match: /^final-new-\d*-ruling/, phrase: "Your ruling" },
  { match: /^sheet-verified$/, phrase: "Verified against your sheet" },
  { match: /^admin-import$/, phrase: "Admin import" },
  { match: /^normalizer$/, phrase: "Matched automatically" },
  { match: /^manual$/, phrase: "Entered by hand" },
  { match: /^master-remap\d*/, phrase: "Master sheet remap" },
  { match: /^brick-merge\d*/, phrase: "Duplicate brick merge" },
  { match: /^spelling-merge/, phrase: "Spelling variant merge" },
  { match: /^ot3-split-repair/, phrase: "Others-3 split repair" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function deKebab(value: string): string {
  const words = value.split("-").filter(Boolean).join(" ").trim();
  return words === "" ? "" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Turn one stored source slug into a sentence a person can read. */
export function describeSource(slug: string): string {
  const raw = String(slug ?? "").trim();
  if (raw === "") return "";

  // A trailing YYYY-MM-DD, sometimes with a disambiguating letter glued on ("…-2026-07-28b").
  const dateMatch = raw.match(/-(\d{4})-(\d{2})-(\d{2})[a-z]?$/i);
  let date = "";
  let body = raw;
  if (dateMatch) {
    const month = MONTHS[Number(dateMatch[2]) - 1] ?? dateMatch[2];
    date = `${Number(dateMatch[3])} ${month} ${dateMatch[1]}`;
    body = raw.slice(0, dateMatch.index);
  }

  const known = SOURCE_PHRASES.find((entry) => entry.match.test(body));
  const phrase = known ? known.phrase : deKebab(body);
  const detail = known ? deKebab(body.replace(known.match, "")) : "";

  return [phrase, detail, date].filter(Boolean).join("  ·  ");
}

/** Every distinct provenance behind one shop, already humanised. */
export function describeSources(sources: readonly string[]): string {
  return [...new Set(sources.map(describeSource).filter(Boolean))].join("   |   ");
}

/**
 * Tidy a distributor's stored name for display.
 *
 * source_of_sales_distributors holds them inconsistently — "overseas", "ramco", "sofico", "mec"
 * and "epda" are lower-case while "Ibn sina", "EGD" and "EPDA-BULK" are not. Only words that are
 * entirely lower-case get capitalised, so "EGD" and "EPDA-BULK" survive untouched instead of
 * being flattened to "Egd" and "Epda-bulk" by a naive title-case.
 */
export function prettyDistributorName(name: string): string {
  return String(name ?? "")
    .split(" ")
    .map((word) =>
      word.length > 0 && word === word.toLowerCase()
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word,
    )
    .join(" ");
}

export type MasterMapRow =
  | { cells: string[]; kind: "customer"; unnamed: boolean }
  | { kind: "area"; label: string }
  | { kind: "blank" }
  | { kind: "brick"; label: string }
  | { kind: "empty-note"; label: string }
  | { kind: "header" }
  | { kind: "region"; label: string };

const CHANNEL_LABEL = {
  hospital: "Hospital",
  pharmacy: "Pharmacy",
  store: "Store",
} as const;

/**
 * The four customer-identity cells: name, primary distributor, primary code, and every further
 * distributor/code pairing this same shop is known by.
 *
 * "Primary" is simply the first pairing in the merge's own stable order, so it never changes
 * between syncs for the same data.
 */
export function customerIdentityCells(
  customer: MasterMapCustomer,
  distributorName: (code: string) => string,
): [string, string, string, string] {
  const [primary, ...rest] = customer.codes;
  return [
    // Never blank: a nameless shop is labelled so it reads as a gap to fill, not as an error.
    customer.hasName ? customer.name : "(no name on file)",
    primary ? distributorName(primary.distributorCode) : "",
    primary ? primary.customerCode : "",
    rest.map((code) => `${code.customerCode} (${distributorName(code.distributorCode)})`).join("  ·  "),
  ];
}

function customerRow(
  customer: MasterMapCustomer,
  distributorName: (code: string) => string,
): MasterMapRow {
  const [name, distributor, code, alsoSuppliedBy] = customerIdentityCells(customer, distributorName);
  return {
    cells: [
      name,
      distributor,
      code,
      alsoSuppliedBy,
      CHANNEL_LABEL[customer.channel],
      customer.address,
      describeSources(customer.sources),
    ],
    kind: "customer",
    unnamed: !customer.hasName,
  };
}

/** One region rendered as the grouped, banded rows the owner asked for. */
export function renderRegionRows(
  region: MasterMapRegion,
  distributorName: (code: string) => string,
): MasterMapRow[] {
  const rows: MasterMapRow[] = [{ kind: "region", label: region.regionName }];

  if (region.areas.length === 0) {
    rows.push({ kind: "empty-note", label: "This region has no areas." });
    return rows;
  }

  for (const area of region.areas) {
    rows.push({ kind: "area", label: area.areaName });
    if (area.bricks.length === 0) {
      rows.push({ kind: "empty-note", label: "This area has no bricks." });
      continue;
    }
    for (const brick of area.bricks) {
      rows.push({ kind: "brick", label: `${brick.brickName}  —  ${brick.brickId}` });
      if (brick.customers.length === 0) {
        rows.push({ kind: "empty-note", label: "No customers recorded in this brick." });
        continue;
      }
      rows.push({ kind: "header" });
      for (const customer of brick.customers) rows.push(customerRow(customer, distributorName));
    }
    rows.push({ kind: "blank" });
  }
  return rows;
}

/** Every region, one after another — the master tab. */
export function renderMasterRows(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
): MasterMapRow[] {
  return tree.regions.flatMap((region) => renderRegionRows(region, distributorName));
}

/**
 * The flat lookup tab: one unmerged row per shop, with its geography repeated on every line so
 * VLOOKUP and filters work. No bands, no blanks, no merged cells.
 */
export const MASTER_MAP_FLAT_COLUMNS = [
  "Region",
  "Area",
  "Brick",
  "Brick code",
  "Pharmacy",
  "Distributor",
  "Code",
  "Also supplied by",
  "Channel",
  "Address",
  "Where this came from",
] as const;

export function renderFlatRows(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
): string[][] {
  const rows: string[][] = [];
  for (const region of tree.regions) {
    for (const area of region.areas) {
      for (const brick of area.bricks) {
        for (const customer of brick.customers) {
          rows.push([
            region.regionName,
            area.areaName,
            brick.brickName,
            brick.brickId,
            ...customerIdentityCells(customer, distributorName),
            CHANNEL_LABEL[customer.channel],
            customer.address,
            describeSources(customer.sources),
          ]);
        }
      }
    }
  }
  return rows;
}
