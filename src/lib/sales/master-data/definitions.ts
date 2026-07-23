import type { AuditEntityType } from "@/lib/admin/audit";
import { OFFICIAL_LINE_VALUES } from "@/lib/sales/official-lines";

/**
 * Config-driven definitions for the Source of Sales "Database Mapping" console.
 *
 * Aligned to the LIVE schema (verified against the production project), which
 * stores ONLY codes plus each row's own name/description — there are NO
 * denormalized parent-name columns. Parent names are therefore resolved by
 * lookup for display (see `displayLookups`), never read from the row, and the
 * import only ever writes real columns.
 *
 * Locked rules (confirmed by the product owner):
 *  - Import is ADD + UPDATE only, never deletes.
 *  - `locked` columns (primary key + display name) are protected in the export
 *    and used MATCH-ONLY on import — never overwritten.
 *  - Only non-locked columns may be written on update.
 */

export type MasterKey = "regions" | "areas" | "blocks" | "bricks" | "products" | "distributors";

export type MasterColumnType = "code" | "text" | "number";

/** A master row as returned to the client (DB column -> value). */
export type MasterRowRecord = Record<string, string | number | boolean | null>;

export type MasterColumn = {
  key: string;
  label: string;
  locked: boolean;
  required: boolean;
  type: MasterColumnType;
  /** When set, an imported/entered value must resolve (case/whitespace-insensitive) to one
   *  of these values; unrecognized values are blocked rather than saved verbatim. Used for
   *  fields where a stray label would silently defeat a confidentiality check downstream
   *  (e.g. Product Master "Line" — see access-scope.ts's Head Office strip). */
  allowedValues?: readonly string[];
};

export type ParentRule = {
  parentMaster: MasterKey;
  /** Code column on THIS row validated against the parent (FK check). */
  codeColumn: string;
  parentKeyColumn: string;
  /**
   * Real CODE columns on this table copied from the parent on import
   * (e.g. blocks.region_code is NOT NULL and derived from the parent area).
   * parentColumn -> thisColumn. Names are NOT copied (no such columns exist).
   */
  copyCodes?: Record<string, string>;
  /** When true an empty code is allowed for this parent. */
  optional?: boolean;
};

/**
 * A read-only column resolved from a parent by code (e.g. Region Name from
 * Region Code). NOT stored in the DB: shown in the table by joining the loaded
 * masters, and rendered as a live VLOOKUP formula in the exported workbook.
 */
export type DisplayLookup = {
  key: string;
  label: string;
  type: MasterColumnType;
  /** A managed column on this row holding the code that drives the lookup. */
  viaCodeColumn: string;
  lookupMaster: MasterKey;
  lookupColumn: string;
};

export type MasterDefinition = {
  master: MasterKey;
  table: string;
  keyColumn: string;
  label: string;
  sheetName: string;
  title: string;
  description: string;
  columns: MasterColumn[];
  parents: ParentRule[];
  displayLookups: DisplayLookup[];
  /** Managed columns (normalized_*) derived from the effective row. */
  derive: (row: Record<string, string>) => Record<string, string>;
  auditEntityType: AuditEntityType;
};

// ---------------------------------------------------------------------------
// Normalisation helpers (mirror src/lib/sales/monthly-distributor-import.ts).
// ---------------------------------------------------------------------------

export function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeKey(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeDisplay(value: unknown) {
  return String(value ?? "").trim();
}

export function parseMasterNumber(value: unknown) {
  const text = normalizeDisplay(value);
  if (!text) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// ---------------------------------------------------------------------------
// Master definitions
// ---------------------------------------------------------------------------

const REGIONS: MasterDefinition = {
  master: "regions",
  table: "source_of_sales_regions",
  keyColumn: "region_code",
  label: "Region Master",
  sheetName: "Region Master",
  title: "Region Master",
  description: "Top-level sales regions. Code and name are locked; only the description can be edited.",
  columns: [
    { key: "region_code", label: "Region Code", locked: true, required: true, type: "code" },
    { key: "region_name", label: "Region Name", locked: true, required: true, type: "text" },
    { key: "description", label: "Description", locked: false, required: false, type: "text" },
  ],
  parents: [],
  displayLookups: [],
  derive: (row) => ({ normalized_region_name: normalizeKey(row.region_name) }),
  auditEntityType: "source_of_sales_region",
};

const AREAS: MasterDefinition = {
  master: "areas",
  table: "source_of_sales_areas",
  keyColumn: "area_code",
  label: "Area Master",
  sheetName: "Area Master",
  title: "Area Master",
  description: "Areas mapped to their parent region. Edit Region Code to re-parent an area.",
  columns: [
    { key: "area_code", label: "Area Code", locked: true, required: true, type: "code" },
    { key: "area_name", label: "Area Name", locked: true, required: true, type: "text" },
    { key: "region_code", label: "Region Code", locked: false, required: true, type: "code" },
  ],
  parents: [{ parentMaster: "regions", codeColumn: "region_code", parentKeyColumn: "region_code" }],
  displayLookups: [
    { key: "region_name", label: "Region Name", type: "text", viaCodeColumn: "region_code", lookupMaster: "regions", lookupColumn: "region_name" },
  ],
  derive: (row) => ({ normalized_area_name: normalizeKey(row.area_name) }),
  auditEntityType: "source_of_sales_area",
};

const BLOCKS: MasterDefinition = {
  master: "blocks",
  table: "source_of_sales_blocks",
  keyColumn: "block_code",
  label: "Block Master",
  sheetName: "Block Master",
  title: "Block Master",
  description: "Blocks mapped to their parent area (region is derived from the area). Edit Area Code to re-parent.",
  columns: [
    { key: "block_code", label: "Block Code", locked: true, required: true, type: "code" },
    { key: "area_code", label: "Area Code", locked: false, required: true, type: "code" },
  ],
  parents: [
    {
      parentMaster: "areas",
      codeColumn: "area_code",
      parentKeyColumn: "area_code",
      copyCodes: { region_code: "region_code" },
    },
  ],
  displayLookups: [
    { key: "area_name", label: "Area Name", type: "text", viaCodeColumn: "area_code", lookupMaster: "areas", lookupColumn: "area_name" },
  ],
  derive: () => ({}),
  auditEntityType: "source_of_sales_block",
};

const BRICKS: MasterDefinition = {
  master: "bricks",
  table: "source_of_sales_bricks",
  keyColumn: "brick_id",
  label: "Brick Master",
  sheetName: "Brick Master",
  title: "Brick Master",
  description: "Bricks belong to a block; area and region follow the block automatically (enforced by the database). Edit Block Code to move a brick.",
  columns: [
    { key: "brick_id", label: "Brick ID", locked: true, required: true, type: "code" },
    { key: "brick_name", label: "Brick Name", locked: true, required: true, type: "text" },
    { key: "block_code", label: "Block Code", locked: false, required: true, type: "code" },
  ],
  // Composite FK (block_code, area_code, region_code) -> blocks: area + region
  // MUST match the block, so they are copied from the block, not edited.
  parents: [
    {
      parentMaster: "blocks",
      codeColumn: "block_code",
      parentKeyColumn: "block_code",
      copyCodes: { area_code: "area_code", region_code: "region_code" },
    },
  ],
  displayLookups: [
    { key: "area_code", label: "Area Code", type: "code", viaCodeColumn: "block_code", lookupMaster: "blocks", lookupColumn: "area_code" },
    { key: "region_code", label: "Region Code", type: "code", viaCodeColumn: "block_code", lookupMaster: "blocks", lookupColumn: "region_code" },
    { key: "area_name", label: "Area Name", type: "text", viaCodeColumn: "area_code", lookupMaster: "areas", lookupColumn: "area_name" },
    { key: "region_name", label: "Region Name", type: "text", viaCodeColumn: "region_code", lookupMaster: "regions", lookupColumn: "region_name" },
  ],
  derive: (row) => ({ normalized_brick_name: normalizeKey(row.brick_name) }),
  auditEntityType: "source_of_sales_brick",
};

const PRODUCTS: MasterDefinition = {
  master: "products",
  table: "source_of_sales_products",
  keyColumn: "product_code",
  label: "Product Master",
  sheetName: "Product Master",
  title: "Product Master",
  description: "Product reference. Code, name, family, family code and source are locked; only Line and Factory Price can be edited.",
  columns: [
    { key: "product_code", label: "Product Code", locked: true, required: true, type: "code" },
    { key: "product_name", label: "Product Name", locked: true, required: true, type: "text" },
    { key: "family", label: "Family", locked: true, required: true, type: "text" },
    { key: "family_code", label: "Family Code", locked: true, required: true, type: "code" },
    { key: "source", label: "Source", locked: true, required: true, type: "text" },
    { key: "line", label: "Line", locked: false, required: true, type: "text", allowedValues: OFFICIAL_LINE_VALUES },
    { key: "factory_price", label: "Factory Price", locked: false, required: true, type: "number" },
  ],
  parents: [],
  displayLookups: [],
  derive: (row) => ({
    normalized_product_name: normalizeKey(row.product_name),
    normalized_line: normalizeKey(row.line),
  }),
  auditEntityType: "source_of_sales_product",
};

const DISTRIBUTORS: MasterDefinition = {
  master: "distributors",
  table: "source_of_sales_distributors",
  keyColumn: "distributor_code",
  label: "Distributor Master",
  sheetName: "Distributor Master",
  title: "Distributor Master",
  description: "Distributors. Code and name are locked, so this master is add-only via import.",
  columns: [
    { key: "distributor_code", label: "Distributor Code", locked: true, required: true, type: "code" },
    { key: "distributor_name", label: "Distributor Name", locked: true, required: true, type: "text" },
  ],
  parents: [],
  displayLookups: [],
  derive: (row) => ({ normalized_distributor_name: normalizeKey(row.distributor_name) }),
  auditEntityType: "source_of_sales_distributor",
};

export const MASTER_DEFINITIONS: Record<MasterKey, MasterDefinition> = {
  regions: REGIONS,
  areas: AREAS,
  blocks: BLOCKS,
  bricks: BRICKS,
  products: PRODUCTS,
  distributors: DISTRIBUTORS,
};

export const MASTER_KEYS = Object.keys(MASTER_DEFINITIONS) as MasterKey[];

/** Tab order (top-down hierarchy first). */
export const MASTER_ORDER: MasterKey[] = ["regions", "areas", "blocks", "bricks", "products", "distributors"];

export function isMasterKey(value: string): value is MasterKey {
  return value in MASTER_DEFINITIONS;
}

export function getMasterDefinition(master: string): MasterDefinition | null {
  return isMasterKey(master) ? MASTER_DEFINITIONS[master] : null;
}

export function editableColumns(def: MasterDefinition) {
  return def.columns.filter((column) => !column.locked);
}

export function lockedColumns(def: MasterDefinition) {
  return def.columns.filter((column) => column.locked);
}

export function requiredColumns(def: MasterDefinition) {
  return def.columns.filter((column) => column.required);
}

/** Distinct parent masters whose data powers the display/export lookups. */
export function requiredReferenceMasters(def: MasterDefinition): MasterKey[] {
  return [...new Set(def.displayLookups.map((lookup) => lookup.lookupMaster))];
}
