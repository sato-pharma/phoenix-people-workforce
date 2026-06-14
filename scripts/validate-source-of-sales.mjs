// Read-only pre-flight check for Source-of-Sales data integrity.
// Run it after uploading masters and/or monthly sheets to catch mess BEFORE trusting numbers.
//
// Usage:
//   node scripts/validate-source-of-sales.mjs
//
// Checks (all read-only):
//   1. Geography orphans   - areas->regions, blocks->areas, bricks->blocks codes that don't resolve
//   2. Product prices      - products with a missing or zero factory_price (their sales value = 0)
//   3. Distributors        - at least one distributor exists
//   4. Duplicate batches   - more than one VALIDATED batch for the same (distributor, period)
// Exits non-zero if any check FAILS.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
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

loadEnvLocal();
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const supabase = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function fetchAll(table, orderCol, columns = "*") {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const norm = (v) => String(v ?? "").trim().toUpperCase();
const problems = [];
const ok = [];

// Load the (small) master + batch tables.
const [regions, areas, blocks, bricks, products, distributors, batches] = await Promise.all([
  fetchAll("source_of_sales_regions", "region_code", "region_code"),
  fetchAll("source_of_sales_areas", "area_code", "area_code,region_code"),
  fetchAll("source_of_sales_blocks", "block_code", "block_code,area_code"),
  fetchAll("source_of_sales_bricks", "brick_id", "brick_id,block_code"),
  fetchAll("source_of_sales_products", "product_code", "product_code,factory_price"),
  fetchAll("source_of_sales_distributors", "distributor_code", "distributor_code"),
  fetchAll("source_of_sales_import_batches", "id", "distributor_code,period,status"),
]);

const regionCodes = new Set(regions.map((r) => norm(r.region_code)));
const areaCodes = new Set(areas.map((a) => norm(a.area_code)));
const blockCodes = new Set(blocks.map((b) => norm(b.block_code)));
const brickIds = new Set(bricks.map((b) => norm(b.brick_id)));
const productCodes = new Set(products.map((p) => norm(p.product_code)));
const distributorCodes = new Set(distributors.map((d) => norm(d.distributor_code)));

// 1) Geography orphans
const orphanAreas = areas.filter((a) => !regionCodes.has(norm(a.region_code)));
const orphanBlocks = blocks.filter((b) => !areaCodes.has(norm(b.area_code)));
const orphanBricks = bricks.filter((b) => !blockCodes.has(norm(b.block_code)));
const geoOrphans = orphanAreas.length + orphanBlocks.length + orphanBricks.length;
(geoOrphans === 0 ? ok : problems).push(
  `Geography orphans: ${orphanAreas.length} areas w/o region, ${orphanBlocks.length} blocks w/o area, ${orphanBricks.length} bricks w/o block`,
);

// 2) Product prices
const noPrice = products.filter((p) => p.factory_price === null || Number(p.factory_price) <= 0);
(noPrice.length === 0 ? ok : problems).push(
  `Products with missing/zero factory_price: ${noPrice.length}${noPrice.length ? " -> " + noPrice.slice(0, 10).map((p) => p.product_code).join(", ") : ""}`,
);

// 3) Distributors present
(distributors.length > 0 ? ok : problems).push(`Distributors present: ${distributors.length}`);

// 4) Duplicate validated batches per (distributor, period)
const seen = new Map();
for (const b of batches) {
  if (String(b.status) !== "validated") continue;
  const key = `${norm(b.distributor_code)}|${String(b.period ?? "")}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
const dups = [...seen.entries()].filter(([, n]) => n > 1);
(dups.length === 0 ? ok : problems).push(
  `Duplicate validated batches (same distributor+period): ${dups.length}${dups.length ? " -> " + dups.slice(0, 10).map(([k, n]) => `${k} x${n}`).join("; ") : ""}`,
);

// 5) Monthly import_rows orphans — the misleading-zero failure mode.
//    An unmatched product_code makes the value RPCs compute sales = 0 (coalesce(factory_price,0)).
//    Geography codes on rows have NO database FK, so orphans are otherwise undetectable.
//    Direct-channel guard: rows are bucketed under area_code 'DIRECT' (not a real area) and
//    is_direct rows are excluded from brick aggregation — skip geography checks for those.
let scanned = 0, prodOrphan = 0, distOrphan = 0, areaOrphan = 0, brickOrphan = 0, regionOrphan = 0;
const sampleProd = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("source_of_sales_import_rows")
    .select("product_code,distributor_code,region_code,area_code,brick_id,is_direct")
    .order("id", { ascending: true })
    .range(from, from + 999);
  if (error) throw new Error(`import_rows: ${error.message}`);
  const rows = data ?? [];
  for (const r of rows) {
    scanned++;
    if (!productCodes.has(norm(r.product_code))) { prodOrphan++; if (sampleProd.size < 10) sampleProd.add(norm(r.product_code)); }
    if (!distributorCodes.has(norm(r.distributor_code))) distOrphan++;
    const area = norm(r.area_code);
    if (r.is_direct !== true && area && area !== "DIRECT") {
      if (!areaCodes.has(area)) areaOrphan++;
      if (r.brick_id && !brickIds.has(norm(r.brick_id))) brickOrphan++;
      if (!regionCodes.has(norm(r.region_code))) regionOrphan++;
    }
  }
  if (rows.length < 1000) break;
}
(prodOrphan === 0 ? ok : problems).push(
  `Import rows with unmatched product_code (=> sales value 0): ${prodOrphan} of ${scanned}${prodOrphan ? " -> e.g. " + [...sampleProd].join(", ") : ""}`,
);
(distOrphan === 0 ? ok : problems).push(`Import rows with unmatched distributor_code: ${distOrphan} of ${scanned}`);
((areaOrphan + brickOrphan + regionOrphan) === 0 ? ok : problems).push(
  `Import rows with orphan geography (non-Direct): ${areaOrphan} area, ${brickOrphan} brick, ${regionOrphan} region`,
);

console.log("PASS:");
for (const line of ok) console.log("  ok  " + line);
if (problems.length) {
  console.log("\nFAIL:");
  for (const line of problems) console.log("  !!  " + line);
  console.log(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\nAll integrity checks passed.");
