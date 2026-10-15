// Seed Vlookup-Masterrr.xlsx → Supabase reference tables
//
// Populates (in FK order):
//   1. source_of_sales_regions  (derived from Areas tab)
//   2. source_of_sales_areas    (Areas tab)
//   3. source_of_sales_blocks   (Blocks tab + any missing from Bricks tab)
//   4. source_of_sales_bricks   (Bricks tab)
//   5. source_of_sales_distributors (no code-only additions)
//   6. source_of_sales_customer_map (~47k records: IS/SF/RM/EG/POS tabs)
//   7. source_of_sales_product_aliases (Products tab Arabic aliases)
//
// Usage:
//   node scripts/seed-vlookup-master.mjs [--dry-run] [--production] [--excel path/to/Vlookup-Masterrr.xlsx]
//
//   --dry-run     Print what would be inserted without touching the DB
//   --production  Target production Supabase (default = staging cifwmndunmlxjhyjugxa)
//   --excel       Optional workbook path; defaults to Desktop/Mapping/Vlookup-Masterrr.xlsx

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { readFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "seed-vlookup-master",
  entry: import.meta.url,
  known: ["--dry-run", "--production", "--excel"],
});

// ── Config ──────────────────────────────────────────────────────────────────────

const CHUNK = 500;

// Current staging project (see AGENTS.md § Stable Environment Facts). The previous staging
// ref izhmxvgiktiafqusolot was decommissioned and no longer resolves.
const STAGING_URL = "https://cifwmndunmlxjhyjugxa.supabase.co";
const STAGING_REF = "cifwmndunmlxjhyjugxa";

// Staging URL + service-role key are read as a matched pair so a key can never end up paired
// with a different project's URL. PHOENIX_NEW_STAGING_* is a historical name from the
// 2026-07-11 staging migration and still points at the archived project in some local
// .env.staging.rls.local files, so it is consulted last.
const STAGING_ENV_SOURCES = [
  { url: "STAGING_SUPABASE_URL", key: "STAGING_SERVICE_ROLE_KEY" },
  { url: "PHOENIX_STAGING_SUPABASE_URL", key: "PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY" },
  { url: "PHOENIX_NEW_STAGING_SUPABASE_URL", key: "PHOENIX_NEW_STAGING_SUPABASE_SERVICE_ROLE_KEY" },
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USE_PRODUCTION = args.includes("--production");
const explicitExcelPath = argValue("--excel");
const DEFAULT_EXCEL_PATHS = [
  "C:/Users/satoh/OneDrive/Desktop/Mapping/Vlookup-Masterrr.xlsx",
  "C:/Users/satoh/OneDrive/Desktop/Vlookup-Masterrr.xlsx",
];
const EXCEL_PATH = explicitExcelPath ?? DEFAULT_EXCEL_PATHS.find((candidate) => existsSync(candidate)) ?? DEFAULT_EXCEL_PATHS[0];
const SOURCE_FILE = basename(EXCEL_PATH);

function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

// ── Distributor tab name → canonical distributor code ─────────────────────────
// The tab name in the Excel vs the distributor_code column value vs our DB code.
// Some tabs have the code in the data column directly; we use the data column value.
const TAB_DISTRIBUTOR_MAP = {
  IS: "IS",
  SF: "SF",
  RM: "RM",
  EG: "EG",
  POS: "PS",
};

const PRODUCT_ALIAS_DISTRIBUTOR_MAP = {
  "": "PS",
  POS: "PS",
  "IBN SINA": "IS",
  "IBN-SINA": "IS",
  IS: "IS",
  EGD: "EG",
  SOFICO: "SF",
  RAMCO: "RM",
  MEC: "MC",
};

// ── Normalization helpers (mirrors src/lib/sales/normalizer/resolvers.ts) ──────

function normalizeAliasKey(value) {
  return String(value ?? "")
    .replace(/ـ/g, "") // tatweel
    .replace(/[إأآا]/g, "ا") // unify alef forms
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeCodeKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function productAliasDistributorCode(label) {
  const normalized = normalizeCodeKey(label);
  return PRODUCT_ALIAS_DISTRIBUTOR_MAP[normalized] ?? normalized;
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function formatCounts(map) {
  if (map.size === 0) return "none";
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} x${count}`)
    .join(", ");
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return "";
  // ExcelJS formula cell: { formula: '=VLOOKUP(...)', result: 'CA1', date1904: false }
  if (typeof v === "object" && v !== null && "result" in v) return String(v.result ?? "").trim();
  // Rich text
  if (typeof v === "object" && v !== null && "richText" in v) {
    return v.richText.map((r) => r.text ?? "").join("").trim();
  }
  // Shared-string text
  if (typeof v === "object" && v !== null && "text" in v) return String(v.text).trim();
  return String(v).trim();
}

// ── Load env ───────────────────────────────────────────────────────────────────

function loadEnvFile(fileName) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env.staging.rls.local");

// ── Resolve Supabase connection ────────────────────────────────────────────────

function projectRefFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? "").trim());
  return match ? match[1] : "";
}

// Legacy Supabase service-role keys are JWTs whose payload names the project they belong to.
// Reading that claim lets us refuse a key issued for a different (e.g. archived) project
// before any write happens. Only the ref is ever logged — never the key itself.
function projectRefFromServiceRoleKey(key) {
  const parts = String(key ?? "").split(".");
  if (parts.length !== 3) return ""; // opaque sb_secret_* key — carries no embedded ref
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.ref === "string" ? payload.ref : "";
  } catch {
    return "";
  }
}

function assertKeyMatchesProject(key, expectedRef, label) {
  const keyRef = projectRefFromServiceRoleKey(key);
  if (!keyRef) {
    console.warn(`WARN: could not read a project ref from the ${label} service-role key — relying on the target URL guard.`);
    return;
  }
  if (keyRef !== expectedRef) {
    console.error(`ERROR: the ${label} service-role key belongs to project ${keyRef}, but the target is ${expectedRef}. Refusing to run.`);
    process.exit(1);
  }
}

function resolveConnection() {
  const prodUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prodKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (USE_PRODUCTION) {
    if (!prodUrl || !prodKey) {
      console.error("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for production.");
      process.exit(1);
    }
    const prodRef = projectRefFromUrl(prodUrl);
    if (prodRef) assertKeyMatchesProject(prodKey, prodRef, "production");
    return { url: prodUrl, key: prodKey, label: "PRODUCTION" };
  }

  // Staging: take the first configured (URL, key) pair, skipping any pair whose URL names a
  // project other than STAGING_REF. There is deliberately no fall back to the production
  // SUPABASE_SERVICE_ROLE_KEY — it can never be a valid credential for the staging project.
  let stagingUrl = "";
  let stagingKey = "";
  let stagingKeyVar = "";
  for (const source of STAGING_ENV_SOURCES) {
    const url = (process.env[source.url] ?? "").trim();
    const key = (process.env[source.key] ?? "").trim();
    if (!key) continue;
    if (url && !url.includes(STAGING_REF)) continue; // pair belongs to another project
    stagingUrl = url || STAGING_URL;
    stagingKey = key;
    stagingKeyVar = source.key;
    break;
  }

  if (!stagingKey) {
    const names = STAGING_ENV_SOURCES.map((source) => source.key).join(" or ");
    console.error(`ERROR: Missing a service-role key for staging ${STAGING_REF}. Set ${names} (alongside its matching *_URL) in .env.staging.rls.local.`);
    process.exit(1);
  }
  if (!stagingUrl.includes(STAGING_REF)) {
    console.error(`ERROR: Refusing non-production run because target URL is not staging ${STAGING_REF}.`);
    process.exit(1);
  }
  assertKeyMatchesProject(stagingKey, STAGING_REF, `staging (${stagingKeyVar})`);

  return { url: stagingUrl, key: stagingKey, label: `STAGING (${STAGING_REF} via ${stagingKeyVar})` };
}

// ── Upsert helper with chunking ────────────────────────────────────────────────

async function upsertChunked(supabase, table, rows, onConflict, label, opts = {}) {
  if (rows.length === 0) {
    console.log(`  ${label}: 0 rows — skipped`);
    return { inserted: 0, errors: 0 };
  }

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] ${label}: would upsert ${rows.length} rows into ${table}`);
    if (rows.length <= 3) console.log("   ", JSON.stringify(rows, null, 2));
    else console.log("    Sample:", JSON.stringify(rows[0]));
    return { inserted: rows.length, errors: 0 };
  }

  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const upsertOpts = opts.ignoreDuplicates
      ? (opts.conflictColumns
          ? { onConflict: opts.conflictColumns, ignoreDuplicates: true }
          : { ignoreDuplicates: true })
      : { onConflict };
    const { error } = await supabase.from(table).upsert(chunk, upsertOpts);
    if (error) {
      console.error(`  ERROR in ${label} chunk ${Math.floor(i / CHUNK) + 1}:`, error.message);
      errors += chunk.length;
    } else {
      inserted += chunk.length;
    }
    process.stdout.write(`\r  ${label}: ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`\r  ${label}: ${inserted} upserted, ${errors} errors`);
  return { inserted, errors };
}

async function fetchCodeSet(supabase, table, column) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .order(column, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return new Set(rows.map((row) => normalizeCodeKey(row[column])));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Seed Vlookup-Masterrr.xlsx → Supabase ===`);

  if (!existsSync(EXCEL_PATH)) {
    console.error(`ERROR: Excel file not found at ${EXCEL_PATH}`);
    process.exit(1);
  }

  const conn = resolveConnection();
  console.log(`Target: ${conn.label}`);
  if (DRY_RUN) console.log("Mode: DRY-RUN (no DB writes)\n");
  else console.log("Mode: LIVE (will write to DB)\n");

  const supabase = createClient(conn.url, conn.key, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── Load workbook ────────────────────────────────────────────────────────────
  console.log("Reading Excel file...");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  console.log(`Loaded ${wb.worksheets.length} sheets: ${wb.worksheets.map((s) => s.name).join(", ")}\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 1: Regions + Areas (from Areas tab)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("── Step 1: Regions + Areas ──");
  const areasSheet = wb.getWorksheet("Areas");
  if (!areasSheet) { console.error("ERROR: 'Areas' sheet not found"); process.exit(1); }

  const regionRows = new Map(); // region_code → { region_code, region_name, normalized_region_name }
  const areaRows = []; // { area_code, region_code, area_name, ... }
  const areaToRegion = new Map(); // area_code → region_code (for block lookup)

  for (let r = 2; r <= areasSheet.rowCount; r++) {
    const row = areasSheet.getRow(r);
    const areaCode = normalizeCodeKey(cellText(row.getCell(1)));
    const regionCode = normalizeCodeKey(cellText(row.getCell(2)));
    const areaName = cellText(row.getCell(3));
    const regionName = cellText(row.getCell(4)); // "Description" column = region full name

    if (!areaCode || !regionCode) continue;

    areaToRegion.set(areaCode, regionCode);

    if (!regionRows.has(regionCode)) {
      regionRows.set(regionCode, {
        region_code: regionCode,
        region_name: regionName || regionCode,
        normalized_region_name: normalizeAliasKey(regionName || regionCode),
        description: regionName || "",
        active: true,
        source_file: SOURCE_FILE,
        source_sheet: "Areas",
        source_row_number: r,
      });
    }

    areaRows.push({
      area_code: areaCode,
      region_code: regionCode,
      area_name: areaName,
      normalized_area_name: normalizeAliasKey(areaName),
      description: regionName || "",
      active: true,
      source_file: SOURCE_FILE,
      source_sheet: "Areas",
      source_row_number: r,
    });
  }

  console.log(`  Found ${regionRows.size} unique regions, ${areaRows.length} areas`);
  const mockSupabase = DRY_RUN ? makeDryRunClient() : supabase;

  await upsertChunked(mockSupabase, "source_of_sales_regions", [...regionRows.values()], "region_code", "Regions");
  await upsertChunked(mockSupabase, "source_of_sales_areas", areaRows, "area_code", "Areas");

  // Also upsert into legacy source_of_sales_area_regions (used by older crosswalk queries)
  const legacyAreaRegions = areaRows.map((a) => {
    const reg = regionRows.get(a.region_code);
    return {
      area_code: a.area_code,
      area_name: a.area_name,
      normalized_area_name: a.normalized_area_name,
      region_code: a.region_code,
      region_name: reg?.region_name ?? a.region_code,
      normalized_region_name: reg?.normalized_region_name ?? normalizeAliasKey(a.region_code),
      source_file: SOURCE_FILE,
      source_sheet: "Areas",
      source_row_number: a.source_row_number,
      active: true,
    };
  });
  await upsertChunked(mockSupabase, "source_of_sales_area_regions", legacyAreaRegions, "area_code", "Legacy area_regions");

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 2: Blocks (from Blocks tab + supplement from Bricks tab)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── Step 2: Blocks ──");
  const blocksSheet = wb.getWorksheet("Blocks");
  const blockMap = new Map(); // block_code → { block_code, area_code, region_code, description }

  if (blocksSheet) {
    for (let r = 2; r <= blocksSheet.rowCount; r++) {
      const row = blocksSheet.getRow(r);
      const blockCode = normalizeCodeKey(cellText(row.getCell(1)));
      const areaCode = normalizeCodeKey(cellText(row.getCell(2)));
      const description = cellText(row.getCell(3));
      if (!blockCode || !areaCode) continue;

      const regionCode = areaToRegion.get(areaCode);
      if (!regionCode) {
        console.warn(`  WARN: Block ${blockCode} area ${areaCode} has no region — skipping`);
        continue;
      }

      blockMap.set(blockCode, {
        block_code: blockCode,
        area_code: areaCode,
        region_code: regionCode,
        description: description || blockCode,
        normalized_description: normalizeAliasKey(description || blockCode),
        active: true,
        source_file: SOURCE_FILE,
        source_sheet: "Blocks",
        source_row_number: r,
      });
    }
    console.log(`  Found ${blockMap.size} blocks from Blocks tab`);
  } else {
    console.log("  WARN: Blocks tab not found — will derive blocks from Bricks tab");
  }

  // We'll supplement blockMap from Bricks tab below (after reading bricks)

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 3: Bricks (from Bricks tab)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── Step 3: Bricks ──");
  const bricksSheet = wb.getWorksheet("Bricks");
  if (!bricksSheet) { console.error("ERROR: 'Bricks' sheet not found"); process.exit(1); }

  // All brick rows including repeated brick_ids — each repeat is a different distributor alias
  // for the same brick (e.g. IS calls B2-30 "مصر الجديدة" while EG calls it "هليوبوليس الشرقية").
  // We keep ONE canonical row per brick_id for source_of_sales_bricks, and write ALL name
  // variants (canonical + alternates) into source_of_sales_territory_aliases so the normalizer
  // can match any distributor's text label back to the correct brick.
  const brickCanonical = new Map(); // brick_id → first row (canonical)
  const brickTerritoryAliases = []; // ALL (alias, brick_id) pairs including duplicates
  const territoryAliasSeen = new Set(); // dedup on (normalized_alias, brick_id) — same name same brick = skip
  let bricksSkipped = 0;

  for (let r = 2; r <= bricksSheet.rowCount; r++) {
    const row = bricksSheet.getRow(r);
    const brickId = normalizeCodeKey(cellText(row.getCell(1)));
    const brickName = cellText(row.getCell(2));
    const blockCode = normalizeCodeKey(cellText(row.getCell(4)));
    const areaCode = normalizeCodeKey(cellText(row.getCell(5)));
    const regionCode = normalizeCodeKey(cellText(row.getCell(6)));

    if (!brickId || !brickName || !blockCode || !areaCode || !regionCode) {
      bricksSkipped++;
      continue;
    }

    // Supplement blockMap with any blocks found in Bricks tab but not in Blocks tab
    if (!blockMap.has(blockCode)) {
      blockMap.set(blockCode, {
        block_code: blockCode,
        area_code: areaCode,
        region_code: regionCode,
        description: blockCode,
        normalized_description: normalizeAliasKey(blockCode),
        active: true,
        source_file: SOURCE_FILE,
        source_sheet: "Bricks",
        source_row_number: r,
      });
    }

    // Canonical brick row (first occurrence per brick_id)
    if (!brickCanonical.has(brickId)) {
      brickCanonical.set(brickId, {
        brick_id: brickId,
        brick_name: brickName,
        normalized_brick_name: normalizeAliasKey(brickName),
        block_code: blockCode,
        area_code: areaCode,
        region_code: regionCode,
        source_area_code: areaCode,
        source_region_code: regionCode,
        description: brickName,
        normalized_description: normalizeAliasKey(brickName),
        active: true,
        source_file: SOURCE_FILE,
        source_sheet: "Bricks",
        source_row_number: r,
      });
    }

    // Territory alias — every name variant (canonical + alternates) for text-based resolution
    const normalizedName = normalizeAliasKey(brickName);
    if (normalizedName) {
      const aliasKey = `${normalizedName}\x1F${brickId}`;
      if (!territoryAliasSeen.has(aliasKey)) {
        territoryAliasSeen.add(aliasKey);
        brickTerritoryAliases.push({
          alias: brickName,
          normalized_alias: normalizedName,
          target_type: "brick",
          target_code: brickId,
          active: true,
          source_file: SOURCE_FILE,
          source_sheet: "Bricks",
        });
      }
    }
  }

  const uniqueBricks = brickCanonical.size;
  const alternateNames = brickTerritoryAliases.length - uniqueBricks;
  console.log(`  Found ${uniqueBricks} unique bricks, ${alternateNames} alternate distributor names → ${brickTerritoryAliases.length} territory aliases total`);
  console.log(`  Skipped: ${bricksSkipped} rows (missing fields)`);
  console.log(`  Total blocks (including derived from Bricks): ${blockMap.size}`);

  await upsertChunked(mockSupabase, "source_of_sales_blocks", [...blockMap.values()], "block_code", "Blocks");
  await upsertChunked(mockSupabase, "source_of_sales_bricks", [...brickCanonical.values()], "brick_id", "Bricks");
  // territory_aliases unique constraint: (normalized_alias, target_type, target_code) — ignoreDuplicates is safe
  await upsertChunked(mockSupabase, "source_of_sales_territory_aliases", brickTerritoryAliases, null, "BrickTerritoryAliases", {
    ignoreDuplicates: true,
    conflictColumns: "normalized_alias,target_type,target_code",
  });

  // Update brickById to use canonical bricks (area/region from canonical row)
  const brickById = new Map();
  for (const b of brickCanonical.values()) {
    brickById.set(b.brick_id, { areaCode: b.area_code, regionCode: b.region_code, brickId: b.brick_id });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 4: Distributors
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── Step 4: Distributors ──");
  const distSheet = wb.getWorksheet("Distbutors");
  const distRows = [];

  if (distSheet) {
    for (let r = 2; r <= distSheet.rowCount; r++) {
      const row = distSheet.getRow(r);
      const code = normalizeCodeKey(cellText(row.getCell(1)));
      const name = cellText(row.getCell(2));
      if (!code || !name) continue;
      // Distributor master rows are managed by the foundation data and admin tools.
      // This seed step intentionally avoids re-adding retired or ad hoc channels.
    }
  }

  await upsertChunked(mockSupabase, "source_of_sales_distributors", distRows, "distributor_code", "Distributors");

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 5: Customer map (IS, SF, RM, EG, POS tabs)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── Step 5: Customer Map ──");
  // brickById was built above from brickCanonical (canonical area/region per brick)

  let totalCustomers = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const [tabName, defaultDistCode] of Object.entries(TAB_DISTRIBUTOR_MAP)) {
    const sheet = wb.getWorksheet(tabName);
    if (!sheet) { console.log(`  ${tabName}: sheet not found — skipped`); continue; }

    const customerRows = [];
    const seen = new Set();

    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      // Col 1: Distributor, Col 2: Customer Code, Col 3: Customer Name, Col 4: Address, Col 5: Brick ID
      const distCode = normalizeCodeKey(cellText(row.getCell(1))) || defaultDistCode;
      const custCode = cellText(row.getCell(2));
      const custName = cellText(row.getCell(3));
      const address = cellText(row.getCell(4));
      const brickIdRaw = normalizeCodeKey(cellText(row.getCell(5)));

      if (!custCode && !brickIdRaw) continue; // blank row

      const canonicalDist = normalizeCodeKey(distCode);
      const canonicalCust = custCode.trim();
      if (!canonicalDist || !canonicalCust) { totalSkipped++; continue; }
      if (!brickIdRaw) { totalSkipped++; continue; } // no brick mapping yet

      const brick = brickById.get(brickIdRaw);
      if (!brick) {
        // Brick not in our master — use area/region from sheet columns if available
        const areaCode = normalizeCodeKey(cellText(row.getCell(6)));
        const regionCode = normalizeCodeKey(cellText(row.getCell(7)));
        if (!areaCode || !regionCode) { totalSkipped++; continue; }
        const key = `${canonicalDist}\x1F${canonicalCust}`;
        if (seen.has(key)) continue;
        seen.add(key);
        customerRows.push({
          distributor_code: canonicalDist,
          customer_code: canonicalCust,
          customer_name: custName || null,
          address: address || null,
          brick_id: brickIdRaw,
          area_code: areaCode,
          region_code: regionCode,
          source: "vlookup-master",
          active: true,
        });
        continue;
      }

      const key = `${canonicalDist}\x1F${canonicalCust}`;
      if (seen.has(key)) continue;
      seen.add(key);

      customerRows.push({
        distributor_code: canonicalDist,
        customer_code: canonicalCust,
        customer_name: custName || null,
        address: address || null,
        brick_id: brick.brickId,
        area_code: brick.areaCode,
        region_code: brick.regionCode,
        source: "vlookup-master",
        active: true,
      });
    }

    const result = await upsertChunked(
      mockSupabase,
      "source_of_sales_customer_map",
      customerRows,
      "distributor_code,customer_code",
      `CustomerMap[${tabName}]`,
    );
    totalCustomers += result.inserted;
    totalErrors += result.errors;
  }

  console.log(`  Customer map total: ${totalCustomers} upserted, ${totalSkipped} skipped (no brick), ${totalErrors} errors`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 6: Product aliases (Products tab Arabic names)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── Step 6: Product Aliases ──");
  const productsSheet = wb.getWorksheet("Products");
  // The Products tab has multiple rows per product_code — each row is a different distributor's
  // alias for that product (e.g. IS writes "ايفيرونك شراب 100 مل", EG writes "Ivyronc 100ml").
  // All unique aliases should be kept per distributor. Skip rows that would violate
  // product/distributor FKs and skip duplicate distributor + normalized alias pairs.
  const aliasRows = [];
  const skippedMissingProducts = new Map();
  const skippedMissingDistributors = new Map();
  const skippedDuplicateAliases = new Map();
  const seenDistributorAliases = new Set();

  if (productsSheet) {
    const [knownProductCodes, knownDistributorCodes] = await Promise.all([
      fetchCodeSet(supabase, "source_of_sales_products", "product_code"),
      fetchCodeSet(supabase, "source_of_sales_distributors", "distributor_code"),
    ]);

    for (let r = 2; r <= productsSheet.rowCount; r++) {
      const row = productsSheet.getRow(r);
      const alias = cellText(row.getCell(1));
      const productCode = normalizeCodeKey(cellText(row.getCell(2)));
      const sourceLabel = cellText(row.getCell(3));
      const distributorCode = productAliasDistributorCode(sourceLabel);

      if (!alias || !productCode) continue;
      const normalizedAlias = normalizeAliasKey(alias);
      if (!normalizedAlias) continue;

      if (!knownProductCodes.has(productCode)) {
        incrementCount(skippedMissingProducts, productCode);
        continue;
      }
      if (!knownDistributorCodes.has(distributorCode)) {
        incrementCount(skippedMissingDistributors, distributorCode || "<blank>");
        continue;
      }

      const dupeKey = `${distributorCode}\x1F${normalizedAlias}`;
      if (seenDistributorAliases.has(dupeKey)) {
        incrementCount(skippedDuplicateAliases, `${distributorCode}:${normalizedAlias}`);
        continue;
      }
      seenDistributorAliases.add(dupeKey);

      aliasRows.push({
        alias: alias,
        normalized_alias: normalizedAlias,
        distributor_code: distributorCode,
        product_code: productCode,
        source_labels: sourceLabel ? [sourceLabel] : [],
        source_row_numbers: [r],
        active: true,
        source_file: SOURCE_FILE,
        source_sheet: "Products",
      });
    }
    console.log(`  Prepared ${aliasRows.length} product aliases (distributor-scoped)`);
    console.log(`  Skipped missing product codes: ${formatCounts(skippedMissingProducts)}`);
    console.log(`  Skipped missing distributor codes: ${formatCounts(skippedMissingDistributors)}`);
    console.log(`  Skipped duplicate distributor aliases: ${formatCounts(skippedDuplicateAliases)}`);
    // The current unique index is distributor_code + normalized_alias, so use that conflict target.
    // ignoreDuplicates — inserts new aliases, skips any already in the table.
    await upsertChunked(mockSupabase, "source_of_sales_product_aliases", aliasRows, null, "ProductAliases", {
      conflictColumns: "distributor_code,normalized_alias",
      ignoreDuplicates: true,
    });
  } else {
    console.log("  Products sheet not found — skipping aliases");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`
=== Done ===
  Regions:              ${regionRows.size}
  Areas:                ${areaRows.length}
  Blocks:               ${blockMap.size}
  Bricks (canonical):   ${brickCanonical.size}
  Territory aliases:    ${brickTerritoryAliases.length} (${brickTerritoryAliases.length - brickCanonical.size} alternate distributor names)
  Customer map:         ${totalCustomers} (${totalSkipped} skipped — no brick assigned)
  Product aliases:      ${aliasRows.length}
${DRY_RUN ? "\nDRY-RUN — no changes were made to the database." : `\nDatabase: ${conn.label}`}
`);
}

// ── Dry-run stub ───────────────────────────────────────────────────────────────
function makeDryRunClient() {
  return {
    from: () => ({
      upsert: async () => ({ error: null }),
    }),
  };
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
