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
// areas all still render, labelled as empty — 90 active bricks are in that state right now, and a
// master that hides them would read as though they did not exist.
//
// THE ORGANOGRAM OVERLAY. Two of the nine regions own no geography at all: Upper Egypt 1 and
// Upper Egypt 2 have zero areas in the area master. They are not broken and they are not empty —
// they are the Anti Infective line's two district territories inside Upper Egypt, and they exist
// only in the People Organogram. Every other region carries all three lines; Upper Egypt is the
// one place where Anti Infective is split in two while CNS and Pedia are not, which is exactly
// what `closing-organogram-regions.ts` already documents for the Monthly Closing.
//
// So a region with no areas of its own BORROWS them from the organogram — from the same
// au_v_line_area_map the closing reads, resolved live rather than listed here, so the day the
// owner moves an area between districts the sheet follows on its own.
//
// Those regions are marked `fromOrganogram` and are then EXCLUDED from the master tab, the flat
// tab and the gaps tab. Their shops already appear there under the region they physically sit in,
// and counting them twice would put the flat tab above the 50,622 shops that actually exist. They
// keep their own tabs, which say plainly that they are a second view of the same shops.
//
// PER LINE, NEVER POOLED. The organogram is a line × area map, and two lines can file the same area
// under DIFFERENT districts: from 2026-09-01 Assuit 1 and Assuit 2 are Upper Egypt 1 on Pedia and
// Upper Egypt 2 on Anti Infective. Pooling every line's claim put both Assuits on both tabs with no
// line named, so a reader could not tell which district actually runs them. An organogram tab is
// therefore cut into one section per line, and every area on every tab carries the region each line
// files it under, beside that line's manager — an area that is Giza on the map can be Others on CNS
// and Upper Egypt 1 on Pedia, and the sheet has to say all three.

import type { MasterMapCustomer, MasterMapCustomerInput } from "@/lib/sales/master-map/customer-merge";
import { mergeMasterMapCustomers, mergeMasterMapCustomersYielding } from "@/lib/sales/master-map/customer-merge";

export type RegionInput = { regionCode: string; regionName: string };
export type AreaInput = { areaCode: string; areaName: string; regionCode: string };
export type BrickInput = { areaCode: string; brickId: string; brickName: string };

/**
 * One row of the organogram's line × area → district map, already humanised.
 *
 * `lineName` arrives spelled out rather than as a code because this module stays free of database
 * calls and the owner's rule is that a code never reaches a screen. load.ts resolves it through the
 * one shared `lineName()` helper, so the sheet cannot disagree with the closing about what
 * "anti_infective" is called.
 */
export type OrganogramAreaInput = { areaCode: string; lineName: string; regionCode: string };

/**
 * Who runs one area on one line, already resolved to a person's name or to a plain-words reason
 * there is nobody: "Vacant", "Sales only, no manager" for the Others buckets. Never a blank.
 */
export type AreaManagerInput = { areaCode: string; lineName: string; manager: string };

/**
 * The sales lines, in the order their manager columns appear.
 *
 * A SHOP DOES NOT HAVE ONE DISTRICT MANAGER — it has one per line, and they are different people.
 * The pharmacy in Minia 1 is Nosiba's on Anti Infective, Amgad's on CNS and Yehya's on Pedia. One
 * "District manager" column would therefore have to pick a winner, and every reader would assume
 * the wrong one. Hence three columns.
 *
 * Listed rather than derived so the columns never move when the organogram is briefly unreadable,
 * and matching `au.lines` — the same three the closing and the target engine already hardcode.
 */
export const MASTER_MAP_MANAGER_LINES = ["Anti Infective", "CNS", "Pedia"] as const;

/** An area the organogram has no row for at all. Only "Main Store" is in this state, with 0 bricks. */
export const UNKNOWN_MANAGER = "Not in the organogram";

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
  /** Line name -> the region that line's organogram files this area under, spelled out. */
  lineRegions: ReadonlyMap<string, string>;
  /** Line name -> the district manager who runs this area on that line. */
  managers: ReadonlyMap<string, string>;
};

/** One line's share of an organogram tab: the areas THAT line files under the region. */
export type MasterMapLineSection = {
  areas: MasterMapArea[];
  customerCount: number;
  lineName: string;
};

export type MasterMapRegion = {
  /** Every area the region holds; on an organogram tab, each area once whatever lines claim it. */
  areas: MasterMapArea[];
  customerCount: number;
  /**
   * Organogram tabs only: the areas again, one section per line, in column order. Empty on a
   * region that owns its own geography. An area two lines both file here is in both sections.
   */
  lineSections: MasterMapLineSection[];
  /**
   * True when this region owns no areas in the area master and borrows them from the organogram.
   * Its shops are the SAME shops as some other region's — see the overlay note in the header.
   */
  fromOrganogram: boolean;
  /** Organogram areas this region claims that the area master does not have. Never hidden. */
  missingAreaCodes: string[];
  /** The lines whose structure puts those areas here, spelled out. */
  organogramLines: string[];
  regionCode: string;
  regionName: string;
  /** The regions those borrowed areas physically sit in, spelled out. */
  sitsIn: string[];
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

/** Lines in the same order as their columns; a line nobody listed goes last, by name. */
function byLineOrder(left: string, right: string): number {
  const rank = (line: string) => {
    const index = (MASTER_MAP_MANAGER_LINES as readonly string[]).indexOf(line);
    return index === -1 ? MASTER_MAP_MANAGER_LINES.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

/** area code -> line name -> one picked value, skipping rows with nothing to say. */
function perAreaPerLine<T extends { areaCode: string; lineName: string }>(
  entries: readonly T[],
  pick: (entry: T) => string,
): Map<string, Map<string, string>> {
  const byArea = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    const value = pick(entry);
    if (!entry.areaCode || !entry.lineName || !value) continue;
    let byLine = byArea.get(entry.areaCode);
    if (!byLine) {
      byLine = new Map();
      byArea.set(entry.areaCode, byLine);
    }
    byLine.set(entry.lineName, value);
  }
  return byArea;
}

export type MasterMapTreeInput = {
  /** Optional: absent means every area reports its managers as unknown rather than as blank. */
  areaManagers?: readonly AreaManagerInput[];
  areas: readonly AreaInput[];
  bricks: readonly BrickInput[];
  customers: readonly MasterMapCustomerInput[];
  /** Optional: absent or empty simply means no region borrows anything, which is a valid sheet. */
  organogramAreas?: readonly OrganogramAreaInput[];
  regions: readonly RegionInput[];
};

export function buildMasterMapTree(input: MasterMapTreeInput): MasterMapTree {
  return treeOfMerged(input, mergeMasterMapCustomers(input.customers));
}

/**
 * The same tree, for the web server: the customer merge — nearly all of the build — pauses between
 * slices so a new container's first Master Map check never holds every page (14 Nov 2026). What is left
 * after the merge is grouping by brick, area and region, well under a tenth of a second.
 */
export async function buildMasterMapTreeYielding(
  input: MasterMapTreeInput,
  pause: () => Promise<void>,
): Promise<MasterMapTree> {
  const merged = await mergeMasterMapCustomersYielding(input.customers, pause);
  await pause();
  return treeOfMerged(input, merged);
}

function treeOfMerged(input: MasterMapTreeInput, merged: MasterMapCustomer[]): MasterMapTree {

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

  const regionNameByCode = new Map(
    input.regions.map((region) => [region.regionCode, displayName(region.regionName, region.regionCode)]),
  );

  const managersByArea = perAreaPerLine(input.areaManagers ?? [], (entry) => entry.manager);
  const lineRegionsByArea = perAreaPerLine(input.organogramAreas ?? [], (entry) =>
    entry.regionCode ? (regionNameByCode.get(entry.regionCode) ?? entry.regionCode) : "",
  );

  const areasByRegion = new Map<string, MasterMapArea[]>();
  const areaByCode = new Map<string, MasterMapArea>();
  const homeRegionByArea = new Map<string, string>();
  for (const area of input.areas) {
    const bricks = bricksByArea.get(area.areaCode) ?? [];
    const built: MasterMapArea = {
      areaCode: area.areaCode,
      areaName: displayName(area.areaName, area.areaCode),
      bricks,
      customerCount: bricks.reduce((total, brick) => total + brick.customers.length, 0),
      lineRegions: lineRegionsByArea.get(area.areaCode) ?? new Map(),
      managers: managersByArea.get(area.areaCode) ?? new Map(),
    };
    areaByCode.set(area.areaCode, built);
    homeRegionByArea.set(area.areaCode, area.regionCode);
    const bucket = areasByRegion.get(area.regionCode);
    if (bucket) bucket.push(built);
    else areasByRegion.set(area.regionCode, [built]);
  }
  for (const areas of areasByRegion.values()) areas.sort(byName((area) => area.areaName));

  // The organogram's claim on each region, PER LINE (region -> line -> area codes), collected before
  // any region is built so a region can be asked "does the org chart give you areas?" in one lookup.
  // Kept per line rather than pooled — see "PER LINE, NEVER POOLED" in the header.
  const claimedByRegion = new Map<string, Map<string, Set<string>>>();
  for (const entry of input.organogramAreas ?? []) {
    if (!entry.regionCode || !entry.areaCode || !entry.lineName) continue;
    let byLine = claimedByRegion.get(entry.regionCode);
    if (!byLine) {
      byLine = new Map();
      claimedByRegion.set(entry.regionCode, byLine);
    }
    const codes = byLine.get(entry.lineName);
    if (codes) codes.add(entry.areaCode);
    else byLine.set(entry.lineName, new Set([entry.areaCode]));
  }

  const knownAreas = (codes: Iterable<string>) =>
    [...codes]
      .map((code) => areaByCode.get(code))
      .filter((area): area is MasterMapArea => area !== undefined)
      .sort(byName((area) => area.areaName));

  const regions = input.regions
    .map((region): MasterMapRegion => {
      const name = displayName(region.regionName, region.regionCode);
      const own = areasByRegion.get(region.regionCode) ?? [];
      const total = (areas: MasterMapArea[]) =>
        areas.reduce((sum, area) => sum + area.customerCount, 0);

      // A region with geography of its own is never overlaid. The overlay is the answer to "this
      // region has no areas", not a second opinion about a region that already has them — and it
      // retires itself the moment the area master gives this region real areas.
      const claim = own.length === 0 ? claimedByRegion.get(region.regionCode) : undefined;
      if (!claim) {
        return {
          areas: own,
          customerCount: total(own),
          fromOrganogram: false,
          lineSections: [],
          missingAreaCodes: [],
          organogramLines: [],
          regionCode: region.regionCode,
          regionName: name,
          sitsIn: [],
        };
      }

      const claimed = [...new Set([...claim.values()].flatMap((codes) => [...codes]))].sort();
      const areas = knownAreas(claimed);
      // An area the org chart names and the area master has never heard of is REPORTED, not
      // quietly skipped — the tab prints the codes so a broken link reads as a broken link.
      const missingAreaCodes = claimed.filter((code) => !areaByCode.has(code));
      const lineSections = [...claim.keys()]
        .sort(byLineOrder)
        .map((lineName): MasterMapLineSection => {
          const sectionAreas = knownAreas(claim.get(lineName) ?? []);
          return { areas: sectionAreas, customerCount: total(sectionAreas), lineName };
        })
        .filter((section) => section.areas.length > 0);

      return {
        areas,
        customerCount: total(areas),
        fromOrganogram: areas.length > 0,
        lineSections,
        missingAreaCodes,
        organogramLines: [...claim.keys()].sort(),
        regionCode: region.regionCode,
        regionName: name,
        sitsIn: [
          ...new Set(
            areas
              .map((area) => regionNameByCode.get(homeRegionByArea.get(area.areaCode) ?? ""))
              .filter((home): home is string => Boolean(home) && home !== name),
          ),
        ].sort(),
      };
    })
    .sort(byName((region) => region.regionName));

  return { orphanedCustomers, regions };
}

/**
 * The regions that OWN their shops — every region except the organogram views.
 *
 * The master tab, the flat tab and the gaps tab all read through this. Upper Egypt 1 and Upper
 * Egypt 2 hold the same shops as Upper Egypt and Giza, so counting them here would report ~4,300
 * shops that do not exist and would put two copies of each of them in the finder.
 */
export function shopOwningRegions(tree: MasterMapTree): MasterMapRegion[] {
  return tree.regions.filter((region) => !region.fromOrganogram);
}

/**
 * How many rows "All customers" holds, without building them.
 *
 * The hidden helper sizes its grid from this, and it is called on a tab that needs none of the
 * rows themselves — rendering 63,510 of them to read `.length` would be the expensive way to
 * count. Same population as renderFlatRows by construction: both walk shopOwningRegions.
 */
export function flatShopCount(tree: MasterMapTree): number {
  return shopOwningRegions(tree).reduce((total, region) => total + region.customerCount, 0);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * The provenance column's header, named once because its POSITION is not stable.
 *
 * It is the last column on the grouped tabs and the eleventh on the flat and gaps tabs, and the
 * renderer has to find it to paint it in its quiet grey small print. Finding it by counting from
 * the right is what broke when the three manager columns were appended: the small print landed on
 * a district manager's name instead. Anything appended after this column must leave it alone, so
 * every renderer looks it up by this name.
 */
export const MASTER_MAP_PROVENANCE_HEADER = "Where this came from";

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
  MASTER_MAP_PROVENANCE_HEADER,
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
  | { kind: "line"; label: string }
  | { kind: "managers"; label: string }
  | { kind: "region"; label: string };

/**
 * One cell per line, in column order — the person who runs this area on that line.
 *
 * Never blank. A blank cell in a manager column reads as "nobody bothered to fill this in"; the
 * words the organogram actually supports — "Vacant", "Sales only, no manager" — say which of the
 * several different reasons applies.
 */
export function areaManagerCells(area: MasterMapArea): string[] {
  return MASTER_MAP_MANAGER_LINES.map((line) => area.managers.get(line) ?? UNKNOWN_MANAGER);
}

/**
 * One cell per line, in column order — the organogram region that line files this area under.
 *
 * NOT the region the tab or the Region column shows. Those are geography, from the area master;
 * this is structure, from the organogram, and on 37 line × area pairs the two differ today.
 */
export function areaLineRegionCells(area: MasterMapArea): string[] {
  return MASTER_MAP_MANAGER_LINES.map((line) => area.lineRegions.get(line) ?? UNKNOWN_MANAGER);
}

/** Region and manager per line as one line of prose, for the band under an area on the grouped tabs. */
function managerBandLabel(area: MasterMapArea): string {
  const managers = areaManagerCells(area);
  const regions = areaLineRegionCells(area);
  return `Organogram   ·   ${MASTER_MAP_MANAGER_LINES.map((line, index) => {
    const region = regions[index];
    const manager = managers[index];
    // Said once, not "Not in the organogram, Not in the organogram".
    const fact = region === UNKNOWN_MANAGER && manager === UNKNOWN_MANAGER
      ? UNKNOWN_MANAGER
      : `${region}, ${manager}`;
    return `${line}: ${fact}`;
  }).join("   ·   ")}`;
}

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

/**
 * "1,234 shops" — the size of whatever the band is sitting above.
 *
 * On the band itself rather than in a column, because the bands are merged across the full width
 * and a merged cell shows only its top-left value. This is also the one number the owner asks for
 * first when he opens an area, and counting it by eye means scrolling to the next band.
 */
function shopCount(total: number): string {
  if (total === 0) return "no shops";
  return `${total.toLocaleString("en-US")} ${total === 1 ? "shop" : "shops"}`;
}

/** "Giza and Upper Egypt" — a list a person reads, never a comma-joined array. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One region rendered as the grouped, banded rows the owner asked for. */
export function renderRegionRows(
  region: MasterMapRegion,
  distributorName: (code: string) => string,
): MasterMapRow[] {
  const rows: MasterMapRow[] = [
    { kind: "region", label: `${region.regionName}   ·   ${shopCount(region.customerCount)}` },
  ];

  // Said at the top of the tab, not buried in a footnote: without it these totals look like shops
  // the rest of the workbook is missing, and someone adds them to a national figure.
  if (region.fromOrganogram) {
    const lines = joinNames(region.organogramLines);
    const homes = joinNames(region.sitsIn);
    const districts = region.organogramLines.length === 1 ? "district" : "districts";
    rows.push({
      kind: "empty-note",
      label:
        `Organogram structure, not geography — ${lines ? `the ${lines} ${districts}` : "a district"} of the sales organisation, listed line by line because each line files its own areas here. ` +
        `Every shop below also appears under ${homes || "its own region"}, so this tab is a second view of the same shops and never extra ones.`,
    });
  }
  if (region.missingAreaCodes.length > 0) {
    rows.push({
      kind: "empty-note",
      label: `The organogram also puts ${joinNames(region.missingAreaCodes)} here, and the area master has no such area. Nothing for them is shown below.`,
    });
  }

  if (region.areas.length === 0) {
    rows.push({ kind: "empty-note", label: "This region has no areas." });
    return rows;
  }

  if (region.fromOrganogram) {
    for (const section of region.lineSections) {
      const areaCount = `${section.areas.length} ${section.areas.length === 1 ? "area" : "areas"}`;
      rows.push({
        kind: "line",
        label: `${section.lineName}   ·   ${areaCount}   ·   ${shopCount(section.customerCount)}`,
      });
      pushAreaRows(rows, section.areas, distributorName);
    }
    return rows;
  }

  pushAreaRows(rows, region.areas, distributorName);
  return rows;
}

function pushAreaRows(
  rows: MasterMapRow[],
  areas: readonly MasterMapArea[],
  distributorName: (code: string) => string,
): void {
  for (const area of areas) {
    rows.push({ kind: "area", label: `${area.areaName}   ·   ${shopCount(area.customerCount)}` });
    // Directly under the area, not on every shop row: it is the same three names for all 951 of
    // them, and three more columns would push the address off the grouped tabs entirely.
    rows.push({ kind: "managers", label: managerBandLabel(area) });
    if (area.bricks.length === 0) {
      rows.push({ kind: "empty-note", label: "This area has no bricks." });
      continue;
    }
    for (const brick of area.bricks) {
      rows.push({
        kind: "brick",
        label: `${brick.brickName}  —  ${brick.brickId}   ·   ${shopCount(brick.customers.length)}`,
      });
      if (brick.customers.length === 0) {
        rows.push({ kind: "empty-note", label: "No customers recorded in this brick." });
        continue;
      }
      rows.push({ kind: "header" });
      for (const customer of brick.customers) rows.push(customerRow(customer, distributorName));
    }
    rows.push({ kind: "blank" });
  }
}

/** Every region that owns its shops, one after another — the master tab. */
export function renderMasterRows(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
): MasterMapRow[] {
  return shopOwningRegions(tree).flatMap((region) => renderRegionRows(region, distributorName));
}

/**
 * The flat lookup tab: one unmerged row per shop, with its geography repeated on every line so
 * VLOOKUP and filters work. No bands, no blanks, no merged cells.
 *
 * The manager columns sit at the END, after provenance, on purpose.
 *
 * "Find a pharmacy" addresses this tab by column LETTER — region is A, pharmacy is E, address is J.
 * Inserting the three managers next to Area, where they read better, would shift every letter after
 * it and quietly re-point the search box and all four dropdowns at the wrong columns. Appending
 * costs nothing: the finder chooses what it displays, and this tab is a lookup surface with a
 * filter row, not something anybody reads left to right.
 */
export const MASTER_MAP_FLAT_COLUMNS: readonly string[] = [
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
  MASTER_MAP_PROVENANCE_HEADER,
  ...MASTER_MAP_MANAGER_LINES.map((line) => `${line} manager`),
  // Appended after the managers for the same reason the managers were: the finder's letters hold.
  ...MASTER_MAP_MANAGER_LINES.map((line) => `${line} region`),
];

// ---------------------------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------------------------

/**
 * The two things in this master that are missing rather than wrong.
 *
 * They are kept apart from the main tabs on purpose. A nameless shop still renders in its brick,
 * amber, saying "(no name on file)" — that is honest but useless for fixing, because the 7,407 of
 * them are spread across 697 bricks and nobody is going to find them by scrolling. Same for the
 * bricks holding nothing: on their own tab they are one line each, and a run of them in the same
 * area is the shape of a mapping that failed rather than of genuinely empty territory.
 *
 * NOTHING HERE IS A DEFECT REPORT. A brick can legitimately have no customers and a shop can
 * legitimately reach us without a name. This tab says "here they are", not "these are broken".
 */
export const MASTER_MAP_GAP_COLUMNS: readonly string[] = [
  "Region",
  "Area",
  "Brick",
  "Brick code",
  "Distributor",
  "Code",
  "Also supplied by",
  "Channel",
  "Address",
  MASTER_MAP_PROVENANCE_HEADER,
  // Chasing a nameless shop means asking somebody who it is, and these are the somebodies.
  ...MASTER_MAP_MANAGER_LINES.map((line) => `${line} manager`),
  ...MASTER_MAP_MANAGER_LINES.map((line) => `${line} region`),
];

export const MASTER_MAP_EMPTY_BRICK_COLUMNS = ["Region", "Area", "Brick", "Brick code"] as const;

/**
 * Every shop with no name, led by its codes.
 *
 * There is no "Pharmacy" column, because it would read "(no name on file)" 7,407 times. The
 * distributor and code ARE the identity of these rows — they are what you take to the distributor
 * to ask who this actually is.
 */
export function renderUnnamedRows(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
): string[][] {
  const rows: string[][] = [];
  for (const region of shopOwningRegions(tree)) {
    for (const area of region.areas) {
      for (const brick of area.bricks) {
        for (const customer of brick.customers) {
          if (customer.hasName) continue;
          const [, distributor, code, alsoSuppliedBy] = customerIdentityCells(
            customer,
            distributorName,
          );
          rows.push([
            region.regionName,
            area.areaName,
            brick.brickName,
            brick.brickId,
            distributor,
            code,
            alsoSuppliedBy,
            CHANNEL_LABEL[customer.channel],
            customer.address,
            describeSources(customer.sources),
            ...areaManagerCells(area),
            ...areaLineRegionCells(area),
          ]);
        }
      }
    }
  }
  return rows;
}

/** Every brick the master knows about that holds no customers at all. */
export function renderEmptyBrickRows(tree: MasterMapTree): string[][] {
  const rows: string[][] = [];
  for (const region of shopOwningRegions(tree)) {
    for (const area of region.areas) {
      for (const brick of area.bricks) {
        if (brick.customers.length > 0) continue;
        rows.push([region.regionName, area.areaName, brick.brickName, brick.brickId]);
      }
    }
  }
  return rows;
}

export function renderFlatRows(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
): string[][] {
  const rows: string[][] = [];
  for (const region of shopOwningRegions(tree)) {
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
            ...areaManagerCells(area),
            ...areaLineRegionCells(area),
          ]);
        }
      }
    }
  }
  return rows;
}
